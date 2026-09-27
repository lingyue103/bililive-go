package recorders

// 需求4：直播文件小文件合并。
//
// 背景：原本每次录制片段结束后会立即进入后处理（转码 MP4 等）。启用本功能后，片段先进入
// 一个「等待窗口」（configs.SegmentMergeConfig.WaitMinutes 分钟）：
//   - 窗口内同一直播间再次录制完成 → 把多段合并为一个文件后再统一走后处理；
//   - 窗口结束仍无新片段 → 就按原来的方式处理已收集到的片段（单段直接后处理）。
//
// 两条硬性约束：
//  1. 直播间名称（房间名）发生变化时不合并：两次开播已经是不同的房间/主题，强行合并会张冠李戴，
//     旧队列立即冲刷，新文件另起一个队列；
//  2. 坏片段防护：部分 flv 可能根本无法播放，把「1GB 正常文件 + 200KB 坏文件」合并会让整个
//     文件报废。因此 VerifySegments 开启时（默认开启）会先用 ffprobe 逐个校验，剔除无法解码的
//     片段，只合并可正常解码的片段（详见 verifySegment 的注释）。
//
// 生命周期说明（很重要）：合并队列必须比单个 recorder 活得更久。直播间停播时 recorder 会被
// 回收（recorders.Manager 在 LiveEnd 时 RemoveRecorder → recorder.Close），而等待窗口恰恰要
// 跨越「停播 → 再次开播（新的 recorder）」这一过程。因此队列放在包级单例 defaultSegmentMerger
// 中，绝不能挂在 recorder 上，也绝不能在 recorder 关闭时冲刷队列。

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/bililive-go/bililive-go/src/configs"
	blog "github.com/bililive-go/bililive-go/src/log"
	"github.com/bililive-go/bililive-go/src/pkg/utils"
	"github.com/bililive-go/bililive-go/src/types"
)

const (
	// ffprobeVerifyTimeout 单个片段校验的超时时间；超时视为坏片段（避免偶发的 ffprobe 卡死拖住合并）
	ffprobeVerifyTimeout = 30 * time.Second
	// segmentMergeTimeout ffmpeg concat 合并的整体超时时间。合并只是流拷贝（-c copy），
	// 但大文件（数 GB）在机械盘/网络存储上仍然较慢，给足余量
	segmentMergeTimeout = 30 * time.Minute
	// defaultSegmentMergeWaitMinutes 配置异常（WaitMinutes <= 0）时的兜底等待分钟数
	defaultSegmentMergeWaitMinutes = 10
	// mergedFileSuffix 合并产物的文件名后缀（与项目既有的 _PART000 后缀风格一致）
	mergedFileSuffix = "_merged"
)

// segmentFlushFunc 是队列冲刷（窗口结束/房间名变化/主动冲刷）时调用的后处理回调。
//
// files 为需要走后处理的文件列表：
//   - 队列里只有一个片段（未发生合并）→ 该片段自身；
//   - 多个片段合并成功 → 合并产物（单个文件）；
//   - 合并失败、或校验后无可用片段 → 回退为原始片段列表（绝不因为合并失败而丢掉后处理）。
//
// sources 非空时表示 files 是由这些原始片段合并而来（仅合并成功场景），调用方据此按项目既有
// 的 DeleteFlvAfterConvert 语义决定是否清理原始片段；未发生合并时为 nil。
type segmentFlushFunc func(files []string, sources []string)

// mergeQueue 单个直播间的待合并队列。
// 队列的所有字段都只在 SegmentMerger.mu 保护下读写（含 timer 与 gen），
// 一旦队列被从 map 中摘除（冲刷），该队列即由冲刷方独占，不再需要额外加锁。
type mergeQueue struct {
	liveID   types.LiveID
	roomName string   // 参与合并的片段所属房间名；与后续片段的房间名不一致时不再合并
	files    []string // 待合并的片段（按录制完成顺序）
	// ffmpegPath 该直播间生效的 ffmpeg 路径（房间级配置可能覆盖全局），用于定位同目录下的 ffprobe
	ffmpegPath string
	cfg        configs.SegmentMergeConfig // 最近一次提交时的配置（窗口时长/是否校验以最新配置为准）
	flush      segmentFlushFunc           // 最近一次提交时的后处理回调
	timer      *time.Timer
	// gen 每次追加文件/重置定时器时自增。定时器回调会带上派发时的 gen 进行校验，
	// 避免「定时器已触发但尚未执行、此刻又有新文件到来并重置了定时器」导致的提前冲刷。
	gen uint64
}

// SegmentMerger 小文件合并管理器（并发安全）。
type SegmentMerger struct {
	mu     sync.Mutex
	queues map[types.LiveID]*mergeQueue
}

// defaultSegmentMerger 进程级单例，理由见文件头「生命周期说明」。
var defaultSegmentMerger = NewSegmentMerger()

// NewSegmentMerger 创建合并管理器。
func NewSegmentMerger() *SegmentMerger {
	return &SegmentMerger{
		queues: make(map[types.LiveID]*mergeQueue),
	}
}

// FlushAllSegmentMergers 立即冲刷全局合并管理器的所有队列，保证退出时不丢后处理。
// 供进程优雅关闭流程调用（外部包无法访问包级单例，故提供该函数）。
// 注意不要在单个直播间结束（LiveEnd）时调用：recorder 在停播时即被回收，
// 此时冲刷会让等待窗口彻底失效（该窗口的意义正是跨「停播 → 再次开播」）。
func FlushAllSegmentMergers() {
	defaultSegmentMerger.FlushAll()
}

// Submit 提交一个录制完成的文件。
// 返回 true = 已被接管（调用方不要再做后处理）；
// 返回 false = 调用方应立即自行后处理（未启用合并、或没有可入队的文件）。
// 等价于 SubmitFiles(liveID, []string{filePath}, roomName, "", cfg, flush)（不解房间级 ffmpeg 路径）。
func (m *SegmentMerger) Submit(liveID types.LiveID, filePath, roomName string, cfg configs.SegmentMergeConfig, flush segmentFlushFunc) bool {
	return m.SubmitFiles(liveID, []string{filePath}, roomName, "", cfg, flush)
}

// SubmitFiles 提交本次录制产出的一个或多个文件（录播姬下载器可能产出多个 _PARTxxx 分段文件）。
// roomName 为本次录制时的房间名；ffmpegPath 为该直播间生效的 ffmpeg 路径（可为空，空则用全局配置）。
//
// 返回值语义：
//   - 未启用合并（cfg.Enable == false）→ false，调用方按原有逻辑立即后处理（保证关闭时行为不变）；
//   - 没有可入队的文件（文件不存在/为空）→ false，交回调用方保留原有的告警与跳过行为；
//   - 其余情况（含房间名变化时先冲刷旧队列）→ true，本次文件已进入新队列，调用方不要再做后处理。
func (m *SegmentMerger) SubmitFiles(
	liveID types.LiveID,
	filePaths []string,
	roomName, ffmpegPath string,
	cfg configs.SegmentMergeConfig,
	flush segmentFlushFunc,
) bool {
	if !cfg.Enable {
		return false
	}
	if flush == nil {
		// 没有后处理回调就无从冲刷，交回调用方按原逻辑处理
		return false
	}

	// 过滤掉不存在/空文件（0 字节文件已被上层的 removeEmptyFile 清理，这里再兜一层）
	valid := make([]string, 0, len(filePaths))
	for _, f := range filePaths {
		if f == "" {
			continue
		}
		fi, statErr := os.Stat(f)
		if statErr != nil || fi.IsDir() || fi.Size() == 0 {
			continue
		}
		valid = append(valid, f)
	}
	if len(valid) == 0 {
		return false
	}

	wait := time.Duration(cfg.WaitMinutes) * time.Minute
	if cfg.WaitMinutes <= 0 {
		wait = defaultSegmentMergeWaitMinutes * time.Minute
	}

	var conflict *mergeQueue

	m.mu.Lock()
	q := m.queues[liveID]
	if q != nil && q.roomName != roomName {
		// 房间名变化：不合并。旧队列立即冲刷（在锁外执行），当前文件另起一个新队列。
		blog.GetLogger().WithField("live_id", string(liveID)).Warnf(
			"房间名已变化（%s → %s），不参与合并，立即冲刷旧队列（%d 个片段）",
			q.roomName, roomName, len(q.files))
		if q.timer != nil {
			q.timer.Stop()
		}
		delete(m.queues, liveID)
		conflict = q
		q = nil
	}
	if q == nil {
		q = &mergeQueue{
			liveID:   liveID,
			roomName: roomName,
		}
		m.queues[liveID] = q
	}
	q.roomName = roomName
	q.cfg = cfg
	q.flush = flush
	q.ffmpegPath = ffmpegPath
	q.files = append(q.files, valid...)
	// 窗口内有新文件到来：重置定时器，把冲刷时间往后延
	q.gen++
	gen := q.gen
	if q.timer != nil {
		q.timer.Stop()
	}
	q.timer = time.AfterFunc(wait, func() {
		m.onTimer(liveID, q, gen)
	})
	m.mu.Unlock()

	if conflict != nil {
		// 旧队列的冲刷放到 goroutine 中执行：后处理（尤其 legacy 自定义命令）可能耗时很久，
		// 不能阻塞本次录制流程。此队列已被摘除，不会再被 Submit/定时器触碰，无竞态。
		go m.flushQueue(conflict)
	}
	return true
}

// FlushAll 立即冲刷所有队列（进程退出/收尾时调用），保证不丢后处理。
// 同步串行执行，调用返回时所有后处理回调都已触发。
func (m *SegmentMerger) FlushAll() {
	m.mu.Lock()
	queues := make([]*mergeQueue, 0, len(m.queues))
	for liveID, q := range m.queues {
		if q.timer != nil {
			q.timer.Stop()
		}
		queues = append(queues, q)
		delete(m.queues, liveID)
	}
	m.mu.Unlock()

	for _, q := range queues {
		m.flushQueue(q)
	}
}

// onTimer 等待窗口到期：取出队列并冲刷。
func (m *SegmentMerger) onTimer(liveID types.LiveID, q *mergeQueue, gen uint64) {
	m.mu.Lock()
	cur, ok := m.queues[liveID]
	if !ok || cur != q || cur.gen != gen {
		// 队列已被冲刷/替换，或该次到期已被后续提交重置：本次到期作废
		m.mu.Unlock()
		return
	}
	delete(m.queues, liveID)
	m.mu.Unlock()

	m.flushQueue(q)
}

// flushQueue 冲刷一个已从 map 中摘除的队列。
// 单个片段直接后处理；多个片段先校验（可选）再合并，合并失败必须回退为原始文件列表。
func (m *SegmentMerger) flushQueue(q *mergeQueue) {
	flush := q.flush
	if flush == nil || len(q.files) == 0 {
		return
	}
	files := append([]string(nil), q.files...)
	logger := blog.GetLogger().WithField("live_id", string(q.liveID))

	if len(files) == 1 {
		logger.Infof("合并窗口结束：仅 1 个片段，直接进入后处理：%s", files[0])
		flush(files, nil)
		return
	}

	mergeList := files
	if q.cfg.VerifySegments {
		mergeList = m.filterPlayableSegments(q, files)
		switch {
		case len(mergeList) == 0:
			// 所有片段都判定为无法播放：不能因此丢掉后处理，回退为原始列表（Pipeline 的 fix_flv
			// 阶段或用户的自定义命令仍有机会处理它们）
			logger.Warnf("校验后没有可解码的片段（共 %d 个），回退为按原始文件列表后处理", len(files))
			flush(files, nil)
			return
		case len(mergeList) == 1:
			// 只剩一个可解码片段，无需合并；坏片段按需求被剔除，不进入后处理
			logger.Warnf("校验后仅剩 1 个可解码片段（原有 %d 个），跳过合并直接后处理", len(files))
			flush(mergeList, nil)
			return
		case len(mergeList) < len(files):
			logger.Warnf("校验后剔除 %d 个无法播放的片段，合并剩余 %d 个",
				len(files)-len(mergeList), len(mergeList))
		}
	}

	logger.Infof("合并窗口结束：开始合并 %d 个片段", len(mergeList))
	merged, err := m.mergeSegments(q, mergeList)
	if err != nil {
		// 合并失败必须回退为原始文件列表：绝不能因为合并失败而丢掉后处理
		logger.WithError(err).Errorf("片段合并失败，回退为按原始文件列表后处理（%d 个片段）", len(files))
		flush(files, nil)
		return
	}
	logger.Infof("片段合并成功：%s（由 %d 个片段合并）", merged, len(mergeList))
	flush([]string{merged}, mergeList)
}

// filterPlayableSegments 逐个校验片段，返回可正常解码的片段列表。
// 一旦发现 ffprobe 不可用，则整体回退为「全部视为可播放」（不因工具缺失而丢弃用户文件）。
func (m *SegmentMerger) filterPlayableSegments(q *mergeQueue, files []string) []string {
	ffprobePath, probeErr := resolveFFprobePath(context.Background(), q.ffmpegPath)
	if probeErr != nil {
		// 保守回退：ffprobe 不可用时绝不会因为「校验」而剔除任何文件，
		// 宁可放过坏片段（合并失败后仍会回退到原始文件列表，不会丢文件），也不误删用户的好文件。
		blog.GetLogger().WithField("live_id", string(q.liveID)).WithError(probeErr).
			Warn("未找到 ffprobe，跳过片段校验（所有片段均视为可播放）")
		return files
	}

	playable := make([]string, 0, len(files))
	for _, f := range files {
		if m.verifySegment(f, ffprobePath) {
			playable = append(playable, f)
			continue
		}
		blog.GetLogger().WithField("live_id", string(q.liveID)).
			Warnf("片段校验未通过（无法解码/时长为 0/超时），不参与合并：%s", f)
	}
	return playable
}

// verifySegment 用 ffprobe 校验单个片段是否可正常播放。
//
// 判定规则（全部满足才算「好片段」）：
//  1. ffprobe 正常退出（退出码 0）。退出码非 0 通常意味着容器/码流损坏
//     （"Invalid data found when processing input"），这正是用户担心的「无法播放的 flv」；
//  2. 至少有一条音视频流（codec_type 为 video 或 audio）；
//  3. 时长 > 0（优先取 format.duration；个别录制中断的 FLV 没有容器时长，
//     则退化为取各流时长中的最大值，避免把好文件误判为坏文件）。
//
// 例外与权衡：
//   - ffprobe 不存在 / 无法启动（exec.ErrNotFound 等）→ 视为「好片段」。
//     理由：工具缺失属于环境问题，不能因此丢弃用户文件；此时合并仍会执行，
//     若真的合并失败，上层会回退为按原始文件列表后处理，不会丢数据。
//   - 超时（默认 30 秒）→ 视为坏片段。
func (m *SegmentMerger) verifySegment(file, ffprobePath string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), ffprobeVerifyTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, ffprobePath,
		"-v", "error",
		"-show_entries", "stream=codec_type,duration:format=duration",
		"-of", "json",
		file)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errorsIsNotExist(err) {
			// ffprobe 二进制不可用（例如刚被删除）：按「无法使用工具」处理，视为好片段
			blog.GetLogger().WithError(err).Warnf("ffprobe 无法启动，跳过校验（视为可播放）：%s", file)
			return true
		}
		// ffprobe 正常执行但报错：文件损坏，视为坏片段
		blog.GetLogger().Debugf("ffprobe 校验失败（%s）：%v，stderr=%s",
			file, err, strings.TrimSpace(stderr.String()))
		return false
	}

	var result struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			Duration  string `json:"duration"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if jsonErr := json.Unmarshal(stdout.Bytes(), &result); jsonErr != nil {
		// 无法解析探测结果：说明 ffprobe 输出异常，保守起见不剔除该文件
		blog.GetLogger().WithError(jsonErr).Warnf("ffprobe 输出无法解析，跳过校验（视为可播放）：%s", file)
		return true
	}

	hasAV := false
	maxStreamDuration := 0.0
	for _, s := range result.Streams {
		if s.CodecType == "video" || s.CodecType == "audio" {
			hasAV = true
		}
		if d := parseFFprobeDuration(s.Duration); d > maxStreamDuration {
			maxStreamDuration = d
		}
	}
	if !hasAV {
		blog.GetLogger().Debugf("片段没有音视频流，视为坏片段：%s", file)
		return false
	}

	duration := parseFFprobeDuration(result.Format.Duration)
	if duration <= 0 {
		duration = maxStreamDuration
	}
	if duration <= 0 {
		blog.GetLogger().Debugf("片段时长为 0 或不可用，视为坏片段：%s", file)
		return false
	}
	return true
}

// parseFFprobeDuration 解析 ffprobe 返回的时长字符串（秒）。
// ffprobe 在时长不可用时返回 "N/A"，此处统一按 0 处理。
func parseFFprobeDuration(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" || s == "N/A" {
		return 0
	}
	var d float64
	if _, err := fmt.Sscanf(s, "%f", &d); err != nil {
		return 0
	}
	return d
}

// mergeSegments 使用 ffmpeg concat demuxer 把多个片段合并为一个文件（流拷贝，不重新编码）。
// 成功返回合并产物路径；失败时会清理临时清单与半成品输出，绝不残留 0 字节文件
// （0 字节文件是本项目已知的恶性 BUG，任何失败路径都必须清理干净）。
func (m *SegmentMerger) mergeSegments(q *mergeQueue, files []string) (string, error) {
	ffmpegPath, err := m.resolveFFmpegPath(q)
	if err != nil {
		return "", fmt.Errorf("未找到 ffmpeg: %w", err)
	}

	output := mergedOutputPath(files[0])
	listFile, err := writeConcatList(files)
	if err != nil {
		return "", fmt.Errorf("生成 concat 清单失败: %w", err)
	}
	// 临时清单文件必须清理
	defer os.Remove(listFile)

	ctx, cancel := context.WithTimeout(context.Background(), segmentMergeTimeout)
	defer cancel()

	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, ffmpegPath,
		"-f", "concat",
		"-safe", "0",
		"-i", listFile,
		"-c", "copy",
		"-y", output)
	cmd.Stdout = utils.NewDebugControlledWriter(os.Stdout)
	cmd.Stderr = &stderr
	if runErr := cmd.Run(); runErr != nil {
		// 清理半成品输出，避免残留损坏/0 字节文件
		os.Remove(output)
		return "", fmt.Errorf("ffmpeg concat 执行失败: %w, stderr: %s", runErr, tailString(stderr.String(), 800))
	}
	// 兜底：产物必须存在且非空，否则视为失败并清理
	if fi, statErr := os.Stat(output); statErr != nil || fi.Size() == 0 {
		os.Remove(output)
		return "", fmt.Errorf("合并产物为空或不存在: %s", output)
	}
	return output, nil
}

// resolveFFmpegPath 解析本次合并要使用的 ffmpeg：优先直播间生效的路径，其次回退全局查找。
func (m *SegmentMerger) resolveFFmpegPath(q *mergeQueue) (string, error) {
	if q.ffmpegPath != "" {
		if fi, err := os.Stat(q.ffmpegPath); err == nil && !fi.IsDir() {
			return q.ffmpegPath, nil
		}
	}
	return utils.GetFFmpegPath(context.Background())
}

// resolveFFprobePath 定位 ffprobe 可执行文件。
// 项目只提供 ffmpeg 路径解析工具（utils.GetFFmpegPath / GetFFmpegPathForLive），而 ffprobe
// 在官方发行包中与 ffmpeg 同目录，因此解析顺序为：
//  1. 本直播间生效的 ffmpeg 同目录下的 ffprobe（房间级 ffmpeg_path 覆盖时同样适用）；
//  2. 全局 ffmpeg（utils.GetFFmpegPath，包含 remotetools 下载的工具）同目录下的 ffprobe；
//  3. 系统 PATH（以及工作目录，与 utils.LookupSystemFFmpeg 的策略保持一致）。
func resolveFFprobePath(ctx context.Context, ffmpegPath string) (string, error) {
	probeName := "ffprobe"
	if runtime.GOOS == "windows" {
		probeName = "ffprobe.exe"
	}

	var candidates []string
	addSibling := func(ff string) {
		if ff == "" {
			return
		}
		candidates = append(candidates, filepath.Join(filepath.Dir(ff), probeName))
	}
	addSibling(ffmpegPath)
	if globalFFmpeg, err := utils.GetFFmpegPath(ctx); err == nil {
		addSibling(globalFFmpeg)
	}
	for _, c := range candidates {
		if fi, err := os.Stat(c); err == nil && !fi.IsDir() {
			return c, nil
		}
	}
	if p, err := exec.LookPath(probeName); err == nil {
		return p, nil
	}
	if p, err := exec.LookPath("./" + probeName); err == nil {
		return p, nil
	}
	return "", fmt.Errorf("未找到 %s（已尝试 ffmpeg 同目录与 PATH）", probeName)
}

// writeConcatList 生成 ffmpeg concat demuxer 所需的清单文件。
// 清单放在第一个片段所在目录（与合并产物同目录），文件名带随机串，用完即删。
func writeConcatList(files []string) (string, error) {
	dir := filepath.Dir(files[0])
	f, err := os.CreateTemp(dir, ".segment_merge_*.txt")
	if err != nil {
		return "", err
	}
	for _, p := range files {
		abs, absErr := filepath.Abs(p)
		if absErr != nil {
			abs = p
		}
		// concat 清单的路径使用绝对路径，避免 demuxer 以清单文件所在目录为基准解析相对路径
		if _, wErr := fmt.Fprintf(f, "file '%s'\n", escapeConcatListPath(abs)); wErr != nil {
			f.Close()
			os.Remove(f.Name())
			return "", wErr
		}
	}
	if closeErr := f.Close(); closeErr != nil {
		os.Remove(f.Name())
		return "", closeErr
	}
	return f.Name(), nil
}

// escapeConcatListPath 按 ffmpeg concat demuxer 的规则转义路径：
//  1. 反斜杠统一换成斜杠（Windows 路径；ffmpeg 在 Windows 上同样接受正斜杠，
//     而反斜杠在 ffmpeg 的转义规则中是转义字符）；
//  2. 路径被单引号包裹，路径内部的单引号按 ffmpeg 规则拆成「闭合引号 + 反斜杠 + 单引号 + 重新开启引号」。
func escapeConcatListPath(p string) string {
	p = filepath.ToSlash(p)
	return strings.ReplaceAll(p, "'", `'\''`)
}

// mergedOutputPath 生成合并产物的路径：与第一个片段同目录、命名风格保持一致，
// 追加 _merged 后缀；若同名文件已存在则追加 _1、_2 … 序号，绝不覆盖已有文件。
func mergedOutputPath(firstFile string) string {
	dir := filepath.Dir(firstFile)
	ext := filepath.Ext(firstFile)
	base := strings.TrimSuffix(filepath.Base(firstFile), ext)

	candidate := filepath.Join(dir, base+mergedFileSuffix+ext)
	if !fileExists(candidate) {
		return candidate
	}
	for i := 1; i < 1000; i++ {
		candidate = filepath.Join(dir, fmt.Sprintf("%s%s_%d%s", base, mergedFileSuffix, i, ext))
		if !fileExists(candidate) {
			return candidate
		}
	}
	// 极端情况（同名文件过多）用时间戳兜底，保证绝不覆盖
	return filepath.Join(dir, fmt.Sprintf("%s%s_%s%s",
		base, mergedFileSuffix, time.Now().Format("20060102-150405"), ext))
}

// fileExists 判断路径是否存在且不是目录。
func fileExists(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && !fi.IsDir()
}

// tailString 截取字符串末尾若干字符，用于日志中展示 ffmpeg 的错误输出片段。
func tailString(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return "..." + s[len(s)-max:]
}

// errorsIsNotExist 判断 ffprobe 是否属于「可执行文件不存在/不可用」（而非被测文件有问题）。
func errorsIsNotExist(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
		return true
	}
	// Windows 下可执行文件不存在时可能只返回路径错误而非 exec.ErrNotFound
	return strings.Contains(strings.ToLower(err.Error()), "executable file not found")
}
