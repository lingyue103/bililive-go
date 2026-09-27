// Package foldersize 提供「录制文件夹大小」的统计与缓存能力（需求3）。
//
// 线上输出目录形如 {平台名}/{主播名}/{录制文件}，同一直播间改名会新建目录，
// 因此一个 live_id 往往对应多个历史目录；群晖还会生成 @eaDir / #recycle 等噪音目录。
//
// 本包职责：
//   - 后台每 30 分钟扫描一次输出目录，把「目录归属 + 大小 + 最早出现时间」缓存到内存与 JSON 文件；
//   - 提供同步的 Refresh 供 HTTP 手动刷新（尊重 ctx 取消，并用互斥锁串行化并发刷新）；
//   - 提供 WriteRoomIDFile 供录制器在主播目录写入归属标识，避免后续只能靠名字猜测。
//
// 本包不依赖 configs / live 等上层包（避免循环导入）；调用方通过 SetRoomIndex 传入
// 「live_id -> 主播名候选列表」，本包不会自行猜测主播名。
package foldersize

import (
	"context"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

const (
	// ScanInterval 后台自动扫描间隔：30 分钟
	ScanInterval = 30 * time.Minute
	// appDataDirName 输出目录下的应用数据目录，缓存文件放在这里面
	appDataDirName = ".appdata"
	// CacheFileName 大小缓存的文件名，完整路径为 {outputPath}/.appdata/folder_size_cache.json
	CacheFileName = "folder_size_cache.json"
	// RoomIDFileName 记录目录归属的标识文件名：第一行为 live_id，第二行为原始 URL
	RoomIDFileName = ".bililive-room-id"
)

// Manager 录制文件夹大小管理器。
//
// 内部结构：
//   - sizes / firstSeen：live_id -> 字节数 / live_id -> 最早出现的目录时间（unix 秒）
//   - roomIndex：live_id -> 主播名候选列表，用于没有标识文件的存量目录按名兜底
//   - mu：保护上面三张表（读多写少，用 RWMutex，GetSize / GetFirstSeenAt 走读锁）
//   - scanMu：串行化扫描，后台定时扫描与 HTTP 手动 Refresh 共用，避免多份全量扫描同时跑
//   - lifeMu：保护 Start / Stop 的生命周期状态
type Manager struct {
	outputPath string // 录制输出根目录
	cachePath  string // 缓存 JSON 的绝对路径，outputPath 为空时为空串（表示不落盘）

	mu        sync.RWMutex
	sizes     map[string]int64
	firstSeen map[string]int64
	roomIndex map[string][]string

	scanMu sync.Mutex

	lifeMu  sync.Mutex
	cancel  context.CancelFunc
	started bool
	wg      sync.WaitGroup
}

// NewManager 创建管理器，并同步加载上一次的扫描缓存。
//
// 加载缓存是刻意同步做的：缓存文件很小（每个直播间一条记录），
// 这样进程重启后前端立刻就有数据可显示，不必等首次全量扫描完成。
// 缓存只是加速手段，任何加载失败都降级为「空缓存」，不影响功能。
func NewManager(outputPath string) *Manager {
	m := &Manager{
		outputPath: outputPath,
		sizes:      make(map[string]int64),
		firstSeen:  make(map[string]int64),
		roomIndex:  make(map[string][]string),
	}
	if strings.TrimSpace(outputPath) != "" {
		m.cachePath = filepath.Join(outputPath, appDataDirName, CacheFileName)
	}
	m.loadCache()
	return m
}

// Start 启动后台扫描：首次立即扫描一次，之后每 ScanInterval（30 分钟）一次。
//
// 扫描全部在后台 goroutine 中执行，本函数立即返回——调用方处于启动流程，对阻塞极其敏感。
// ctx 取消后后台循环自动退出；重复调用 Start 是安全的（只有第一次生效）。
func (m *Manager) Start(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}

	m.lifeMu.Lock()
	if m.started {
		m.lifeMu.Unlock()
		return
	}
	runCtx, cancel := context.WithCancel(ctx)
	m.started = true
	m.cancel = cancel
	// 在释放 lifeMu 之前完成 WaitGroup 记账，避免与并发的 Stop 抢跑
	m.wg.Add(1)
	m.lifeMu.Unlock()

	go m.loop(runCtx)
}

// loop 后台扫描主循环：先立即扫一次，再按固定间隔扫描。
func (m *Manager) loop(ctx context.Context) {
	defer m.wg.Done()

	// 首次立即扫描（此时缓存已在 NewManager 中加载，前端无需等它）
	m.runScan(ctx, nil)

	ticker := time.NewTicker(ScanInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.runScan(ctx, nil)
		}
	}
}

// Stop 停止后台扫描并等待当前扫描退出。重复调用是安全的。
func (m *Manager) Stop() {
	m.lifeMu.Lock()
	cancel := m.cancel
	m.cancel = nil
	m.started = false
	m.lifeMu.Unlock()

	if cancel != nil {
		cancel()
	}
	m.wg.Wait()
}

// GetSize 返回该直播间所有归属目录的大小之和（字节）。
//
// 第二个返回值为 false 表示「还没统计到」（例如完全没有录制目录），
// 调用方应据此把前端显示成空/「-」，而不是 0。
func (m *Manager) GetSize(liveID string) (int64, bool) {
	if liveID == "" {
		return 0, false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	size, ok := m.sizes[liveID]
	return size, ok
}

// GetFirstSeenAt 返回该直播间最早出现的录制目录时间（unix 秒），0 表示未知。
//
// 用途：存量链接没有「添加链接时间」记录时，用录制文件夹的时间兜底显示。
// 取的是该 live_id 所有历史目录中最早的目录 ModTime；目录 ModTime 会随写入变大，
// 所以内部只保留「历史上观察到的最小值」，不会随每次扫描向后漂移。
func (m *Manager) GetFirstSeenAt(liveID string) int64 {
	if liveID == "" {
		return 0
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.firstSeen[liveID]
}

// SetRoomIndex 设置「live_id -> 该直播间的主播名候选列表」，用于没有标识文件的存量目录按名兜底。
//
// 本包不会自行猜测主播名，只用这里传入的候选名。可重复调用（整份替换，不做增量合并）。
func (m *Manager) SetRoomIndex(index map[string][]string) {
	next := make(map[string][]string, len(index))
	for id, names := range index {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		candidates := make([]string, 0, len(names))
		for _, name := range names {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			candidates = append(candidates, name)
		}
		if len(candidates) > 0 {
			next[id] = candidates
		}
	}

	m.mu.Lock()
	m.roomIndex = next
	m.mu.Unlock()
}

// Refresh 同步地重新扫描输出目录，并返回这批 live_id 的最新大小（字节）。
//
//   - ids 为空（nil 或空切片）表示刷新全部，返回值包含所有已统计到的 live_id；
//   - ids 非空时只重新统计这批直播间，其余直播间的缓存保持原值，
//     返回值只包含「确实统计到」的 live_id（没统计到的不出现在 map 里，便于前端显示为空）；
//   - 会尊重 ctx：递归统计途中一旦 ctx 取消就立即中止，并保留原有缓存；
//   - 同一时刻的并发 Refresh 由内部锁串行化，避免多份全量扫描同时打满磁盘 IO。
func (m *Manager) Refresh(ctx context.Context, ids []string) map[string]int64 {
	if ctx == nil {
		ctx = context.Background()
	}

	// runScan 内部串行化；ctx 已取消时它直接返回，我们照旧返回内存里的旧值
	m.runScan(ctx, ids)

	m.mu.RLock()
	defer m.mu.RUnlock()

	if len(ids) == 0 {
		out := make(map[string]int64, len(m.sizes))
		for id, size := range m.sizes {
			out[id] = size
		}
		return out
	}

	out := make(map[string]int64, len(ids))
	for _, id := range ids {
		if size, ok := m.sizes[id]; ok {
			out[id] = size
		}
	}
	return out
}

// runScan 串行化地执行一次扫描；ids 为空表示全量。
func (m *Manager) runScan(ctx context.Context, ids []string) {
	m.scanMu.Lock()
	defer m.scanMu.Unlock()

	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		// 已经被取消：不扫描，也不破坏缓存
		logrus.WithError(err).Debug("文件夹大小扫描已取消")
		return
	}
	m.scanAndStore(ctx, ids)
}

// scanAndStore 执行一次扫描，把结果合并进内存缓存，最后原子落盘。
//
// ids 为 nil 表示全量重建；否则只覆盖这批 live_id，其余保留原值。
func (m *Manager) scanAndStore(ctx context.Context, ids []string) {
	// 取 roomIndex 快照：SetRoomIndex 是整份替换（不原地修改），所以这里取引用即可
	m.mu.RLock()
	roomIndex := m.roomIndex
	oldCount := len(m.sizes)
	m.mu.RUnlock()

	var idSet map[string]bool
	if len(ids) > 0 {
		idSet = make(map[string]bool, len(ids))
		for _, id := range ids {
			if id != "" {
				idSet[id] = true
			}
		}
		if len(idSet) == 0 {
			// 传进来的全是空串：按「刷新全部」处理更安全
			idSet = nil
		}
	}

	res, err := m.scanTree(ctx, roomIndex, idSet)
	if err != nil {
		if errors.Is(err, errRootUnavailable) {
			// 输出目录还不存在（首次启动/挂载未就绪）：不动缓存，等下一次扫描
			logrus.WithField("output_path", m.outputPath).Debug("输出目录暂不可用，跳过本次文件夹大小扫描")
			return
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			logrus.WithError(err).Debug("文件夹大小扫描中断，保留原有缓存")
			return
		}
		logrus.WithError(err).Warn("文件夹大小扫描失败，保留原有缓存")
		return
	}

	m.mu.Lock()
	if idSet == nil {
		m.sizes = res.sizes
	} else {
		// 局部刷新：只覆盖本次请求的 live_id，其余保持原值
		for id := range idSet {
			if size, ok := res.sizes[id]; ok {
				m.sizes[id] = size
			} else {
				// 该直播间的目录已经不存在了
				delete(m.sizes, id)
			}
		}
	}
	// firstSeen 全程只取更小的值：目录 ModTime 会随写入变大，
	// 若不加约束，「最早出现时间」会随每次扫描不断向后漂移。
	for id, ts := range res.firstSeen {
		if ts <= 0 {
			continue
		}
		if old, ok := m.firstSeen[id]; !ok || ts < old {
			m.firstSeen[id] = ts
		}
	}
	newCount := len(m.sizes)

	sizesSnap := make(map[string]int64, len(m.sizes))
	for id, size := range m.sizes {
		sizesSnap[id] = size
	}
	seenSnap := make(map[string]int64, len(m.firstSeen))
	for id, ts := range m.firstSeen {
		seenSnap[id] = ts
	}
	m.mu.Unlock()

	m.saveCache(sizesSnap, seenSnap)

	// 只在条目数变化时打日志，避免每 30 分钟刷一条无意义的信息
	if newCount != oldCount {
		logrus.WithFields(logrus.Fields{
			"entries": newCount,
			"before":  oldCount,
		}).Info("文件夹大小缓存已更新")
	}
}

// HumanSize 把字节数格式化为人可读的字符串：1024 进制，单位 B/kB/MB/GB/TB。
//
// 风格与前端 Utils.byteSizeToHumanReadableFileSize 保持一致：保留两位小数后
// 去掉多余的尾随 0（12.40 GB -> "12.4 GB"、1.00 kB -> "1 kB"）；
// 0 或负数返回 "0"（与前端一致）；超过 TB 的部分仍以 TB 计。
func HumanSize(bytes int64) string {
	if bytes <= 0 {
		return "0"
	}

	units := [...]string{"B", "kB", "MB", "GB", "TB"}
	value := float64(bytes)
	idx := 0
	for value >= 1024 && idx < len(units)-1 {
		value /= 1024
		idx++
	}

	text := strconv.FormatFloat(value, 'f', 2, 64)
	text = strings.TrimRight(text, "0")
	text = strings.TrimRight(text, ".")
	if text == "" {
		// 极小的非零值四舍五入到 0.00 时，与前端 Number(x).toString() 一样显示 0
		text = "0"
	}
	return text + " " + units[idx]
}
