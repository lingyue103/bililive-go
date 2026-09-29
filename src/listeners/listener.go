//go:generate go run go.uber.org/mock/mockgen -package listeners -destination mock_test.go github.com/bililive-go/bililive-go/src/listeners Listener,Manager
package listeners

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/bililive-go/bililive-go/src/configs"
	"github.com/bililive-go/bililive-go/src/consts"
	"github.com/bililive-go/bililive-go/src/instance"
	"github.com/bililive-go/bililive-go/src/live"
	applog "github.com/bililive-go/bililive-go/src/log"
	"github.com/bililive-go/bililive-go/src/notify"
	"github.com/bililive-go/bililive-go/src/pkg/events"
	"github.com/bililive-go/bililive-go/src/pkg/pause"
	bilisentry "github.com/bililive-go/bililive-go/src/pkg/sentry"
	"github.com/bililive-go/bililive-go/src/pkg/timeslot"
)

const (
	begin uint32 = iota
	pending
	running
	stopped
)

// listenerErrLogSummaryInterval 同一房间、同一错误文本被抑制时的汇总输出间隔。
//
// 平台轮询失败（例如抖音反爬让本地工具对每个房间都返回 500）会按房间刷屏：
// 210 个房间 × 每分钟一条 ≈ 每天 30 万行日志。这里改为"首次立即记、之后最多
// 每 10 分钟汇总一条"，运维仍能看出"一直在失败、失败了多少次"。
const listenerErrLogSummaryInterval = 10 * time.Minute

type Listener interface {
	Start() error
	StartWithInfo(info *live.Info) error
	Close()
	CloseSync()
}

func NewListener(ctx context.Context, live live.Live) Listener {
	inst := instance.GetInstance(ctx)
	// 创建一个可取消的 context，用于控制 run 循环中的等待
	runCtx, cancel := context.WithCancel(ctx)
	return &listener{
		Live:      live,
		status:    status{},
		stop:      make(chan struct{}),
		ed:        inst.EventDispatcher.(events.Dispatcher),
		state:     begin,
		runCtx:    runCtx,
		runCancel: cancel,
	}
}

type listener struct {
	Live   live.Live
	status status
	ed     events.Dispatcher

	state     uint32
	stop      chan struct{}
	runCtx    context.Context    // 用于控制 run 循环中的等待
	runCancel context.CancelFunc // 取消 runCtx

	// ---------- 错误日志抑制状态（仅针对"获取直播间信息失败"这一高频日志） ----------
	//
	// 状态挂在 listener 自身而不是包级 map 上：每个房间一个 listener，
	// 房间被删除后整个对象随之被 GC，天然不会无界增长，也不需要按时间淘汰。
	// 用互斥锁保护以满足并发安全（正常情况下同一房间只有 run 一个 goroutine）。
	errLogMu sync.Mutex
	// errLogText 当前正在抑制的错误文本（空串表示当前没有未恢复的错误）
	errLogText string
	// errLogSuppressed 自上次输出该错误日志以来被抑制的条数
	errLogSuppressed int
	// errLogStreak 本段错误（文本未变化期间）累计被抑制的条数，用于恢复日志
	errLogStreak int
	// errLogLastEmit 上次输出该错误日志的时刻
	errLogLastEmit time.Time
}

func (l *listener) Start() error {
	return l.start(nil)
}

// StartWithInfo 使用已经获取到的直播间信息启动监听器，避免初始化交接后立即重复请求平台。
func (l *listener) StartWithInfo(info *live.Info) error {
	return l.start(info)
}

func (l *listener) start(initialInfo *live.Info) error {
	if !atomic.CompareAndSwapUint32(&l.state, begin, pending) {
		return nil
	}
	defer atomic.CompareAndSwapUint32(&l.state, pending, running)

	l.ed.DispatchEvent(events.NewEvent(ListenStart, l.Live))

	// 首次信息获取放到后台执行。调用方 manager.AddListener 全程持有管理器的全局锁，
	// 而 refresh 是一次真实的网络请求，还要排队等待平台访问频率限制；
	// 几百个直播间串行下来会把锁占用好几分钟，期间任何增删直播间的操作都会被卡住。
	bilisentry.Go(func() {
		if !l.isStopped() {
			if initialInfo != nil {
				l.processInfo(initialInfo)
			} else {
				l.refresh()
			}
		}
		l.run()
	})
	return nil
}

// isStopped 返回 listener 是否已经被关闭
func (l *listener) isStopped() bool {
	select {
	case <-l.stop:
		return true
	default:
		return false
	}
}

func (l *listener) Close() {
	l.close(false)
}

// CloseSync 同步完成 ListenStop 的所有处理器，仅用于初始化 listener 的交接路径。
// 普通关闭仍保持异步，避免改变其他调用方的延迟语义。
func (l *listener) CloseSync() {
	l.close(true)
}

func (l *listener) close(syncEvent bool) {
	if !atomic.CompareAndSwapUint32(&l.state, running, stopped) {
		return
	}
	l.runCancel() // 先取消等待并标记停止，禁止并发请求结果继续发布事件
	close(l.stop)
	event := events.NewEvent(ListenStop, l.Live)
	if syncEvent {
		l.ed.DispatchEventSync(event)
	} else {
		l.ed.DispatchEvent(event)
	}
}

// sendLiveNotification 发送直播状态变更通知
func (l *listener) sendLiveNotification(hostName, status string) {
	// 区分三态：真在录制 / 仅提醒（notify_only）/ 当前不会录制（并给出原因）。
	// 否则 pending_delete 或"不在录制时段"的房间也会被通知成"正在录制中"。
	notifyOnly, skipReason := l.resolveRecordingState()

	// 发送通知
	if err := notify.SendNotificationEx(
		l.Live.GetLogger(),
		hostName,
		l.Live.GetPlatformCNName(),
		l.Live.GetRawUrl(),
		status,
		notifyOnly,
		skipReason,
	); err != nil {
		l.Live.GetLogger().WithError(err).WithField("host", hostName).Error("failed to send notification")
	}
}

// resolveRecordingState 计算该房间当前的录制状态，返回 (是否仅提醒, 当前不录制的原因)。
//
// 判定条件与 recorders.manager 的 registryListener（LiveStart 时的决策点）保持一致，
// 避免出现"通知说在录制、实际没录"的矛盾文案。原因只在开播通知里有意义。
func (l *listener) resolveRecordingState() (bool, string) {
	cfg := configs.GetCurrentConfig()
	if cfg == nil {
		return false, ""
	}
	room, err := cfg.GetLiveRoomByUrl(l.Live.GetRawUrl())
	if err != nil || room == nil {
		return false, ""
	}
	// 仅提醒模式：本来就不录制
	if room.NotifyOnly {
		return true, ""
	}
	// 需求1：一次性录制进入"待删除"后只提醒不录制
	if room.IsPendingDelete() {
		return false, "一次性录制已进入待删除状态"
	}
	// 需求6：配置了录制时间段但当前不在时段内 → 只监控不录制
	if slots := room.ResolveRecordSlots(cfg.RecordScheduleTemplates); len(slots) > 0 {
		if !timeslot.IsActive(timeslot.Compile(slots), time.Now()) {
			return false, "当前不在配置的录制时间段内"
		}
	}
	return false, ""
}

// refresh 用于启动时的第一次信息获取（不等待间隔）
func (l *listener) refresh() {
	info, err := l.Live.GetInfo()
	if err != nil {
		l.logGetInfoError(err)
		return
	}
	l.logGetInfoSuccess()
	l.processInfo(info)
}

// logGetInfoError 记录获取直播间信息失败的日志。
// 依赖工具尚未就绪不是异常状况（工具还在下载/启动中，稍后调度器会自动恢复），
// 几百个直播间同时报错只会淹没日志，因此降级为 debug。
// 软重启暂停闸门期间"本轮请求被主动跳过"（ErrSoftRestartPaused / 闸门处于暂停中）
// 同样降级为 debug —— 那也不是故障。
//
// 对平台轮询类失败做"同房间 + 同错误文本"的抑制（见 noteGetInfoError）：
// 首次立即记 Error；相同错误重复出现不再逐条记录，最多每
// listenerErrLogSummaryInterval 汇总一条（带 suppressed 计数）；
// 错误文本变化时立即记新错误；恢复时记一条 info 恢复日志。
// 这样既不会把容器日志刷爆，又保留了"一直在失败、失败了多少次"的可诊断性。
func (l *listener) logGetInfoError(err error) {
	// 需求8（软重启）：暂停闸门期间"本轮平台请求被主动跳过"不是故障，
	// 降到 Debug（不静默：debug 打开时仍可诊断，debug 关闭时不输出，
	// 避免一次 10 分钟的软重启把 210 个房间的日志重新刷爆）。
	//
	// 判定用两道口径：闸门本身（权威，覆盖错误被其它路径包装/替换的情况）
	// 与哨兵错误（覆盖"在暂停期间产生、恢复后才打日志"的情况）。
	// 这里刻意不动错误抑制状态：被跳过的轮次不该算作一次失败，
	// 也不该触发"错误恢复"的 info 日志。
	if pause.Default().IsPaused() || errors.Is(err, live.ErrSoftRestartPaused) {
		l.Live.GetLogger().
			WithError(err).
			WithField("url", l.Live.GetRawUrl()).
			Debug("skip loading room info")
		return
	}

	if errors.Is(err, live.ErrPlatformToolsNotReady) {
		l.Live.GetLogger().
			WithError(err).
			WithField("url", l.Live.GetRawUrl()).
			Debug("skip loading room info")
		return
	}

	d := l.noteGetInfoError(err.Error())

	// 错误文本变化时，先补一条汇总，说明上一段错误累计被抑制了多少条
	if d.prevText != "" && d.prevSuppressed > 0 {
		l.Live.GetLogger().
			WithField("url", l.Live.GetRawUrl()).
			WithField("prev_error", d.prevText).
			WithField("suppressed", d.prevSuppressed).
			Info("上一个错误已被抑制的重复日志条数汇总")
	}

	if !d.emit {
		return
	}

	entry := l.Live.GetLogger().WithError(err).WithField("url", l.Live.GetRawUrl())
	if d.suppressed > 0 {
		// 汇总日志：明确标注此前被抑制的重复条数，避免运维误以为只失败过一次
		entry = entry.WithField("suppressed", d.suppressed)
	}
	entry.Error("failed to load room info")
}

// errLogDecision 一次错误日志的抑制决策
type errLogDecision struct {
	// emit 是否输出本次日志
	emit bool
	// suppressed 本次输出需要标注的、此前被抑制的重复条数
	suppressed int
	// prevText 上一段错误的文本（错误文本发生变化时非空）
	prevText string
	// prevSuppressed 上一段错误累计被抑制的条数（错误文本发生变化时才有意义）
	prevSuppressed int
}

// noteGetInfoError 依据"同房间 + 同错误文本"的抑制策略决定是否输出日志。
func (l *listener) noteGetInfoError(errText string) errLogDecision {
	now := time.Now()

	l.errLogMu.Lock()
	defer l.errLogMu.Unlock()

	// 错误文本发生变化（例如从 500 变成 timeout，或首次出错）：
	// 必须立即输出，不能因为之前抑制过就把新错误也吞掉。
	if l.errLogText != errText {
		d := errLogDecision{
			emit:           true,
			prevText:       l.errLogText,
			prevSuppressed: l.errLogStreak,
		}
		l.errLogText = errText
		l.errLogSuppressed = 0
		l.errLogStreak = 0
		l.errLogLastEmit = now
		return d
	}

	// 同一错误文本：距上次输出已满汇总间隔，则输出一条带计数的汇总日志
	if now.Sub(l.errLogLastEmit) >= listenerErrLogSummaryInterval {
		d := errLogDecision{emit: true, suppressed: l.errLogSuppressed}
		l.errLogSuppressed = 0
		l.errLogLastEmit = now
		return d
	}

	// 否则仅累计，不输出
	l.errLogSuppressed++
	l.errLogStreak++
	return errLogDecision{}
}

// noteGetInfoSuccess 在本次信息获取成功时清理抑制状态。
// 返回本段错误累计被抑制的条数（0 表示无需输出恢复日志）。
func (l *listener) noteGetInfoSuccess() int {
	l.errLogMu.Lock()
	defer l.errLogMu.Unlock()

	if l.errLogText == "" {
		return 0
	}
	total := l.errLogStreak
	l.errLogText = ""
	l.errLogSuppressed = 0
	l.errLogStreak = 0
	l.errLogLastEmit = time.Time{}
	return total
}

// logGetInfoSuccess 在本轮获取成功后清理抑制状态；
// 若此前确实有错误被抑制，补一条 info 级恢复日志，让运维知道故障已经结束。
func (l *listener) logGetInfoSuccess() {
	if n := l.noteGetInfoSuccess(); n > 0 {
		l.Live.GetLogger().
			WithField("url", l.Live.GetRawUrl()).
			WithField("suppressed", n).
			Info("房间信息获取已恢复（suppressed 为此前被抑制的重复错误日志条数）")
	}
}

func (l *listener) run() {
	// 使用 GetInfoWithInterval 来处理等待和请求
	// 它会自动获取配置的间隔时间，并在尊重平台速率限制的前提下等待后发送请求
	for {
		select {
		case <-l.stop:
			return
		default:
			// 使用 GetInfoWithInterval，它会等待配置的间隔时间后再发送请求
			info, err := l.Live.GetInfoWithInterval(l.runCtx)
			if err != nil {
				// 如果是 context 取消导致的错误，说明 listener 正在关闭
				if l.runCtx.Err() != nil {
					return
				}
				l.logGetInfoError(err)
				continue
			}
			l.logGetInfoSuccess()
			l.processInfo(info)
		}
	}
}

// processInfo 处理获取到的直播间信息，检测状态变化并触发事件
func (l *listener) processInfo(info *live.Info) {
	// 初始化完成回调可能在 GetInfo 返回前同步替换并关闭当前 listener。
	// 已关闭的旧 listener 不得再发布 LiveStart/LiveEnd，否则会与新 listener 的事件竞态。
	if l.isStopped() {
		return
	}

	// 尝试从缓存中获取主播姓名，以防API调用失败
	hostName := info.HostName
	if hostName == "" {
		if wrappedLive, ok := l.Live.(*live.WrappedLive); ok {
			if cachedInfo, found := wrappedLive.GetCachedInfo(); found {
				hostName = cachedInfo.HostName
			}
		}
	}

	var (
		latestStatus = status{roomName: info.RoomName, roomStatus: info.Status}
		evtTyp       events.EventType
		logInfo      string
		fields       = map[string]any{
			"room": info.RoomName,
			"host": info.HostName,
		}
	)
	defer func() { l.status = latestStatus }()

	isStatusChanged := true
	switch l.status.Diff(latestStatus) {
	case 0:
		isStatusChanged = false
	case statusToTrueEvt:
		l.Live.SetLastStartTime(time.Now())
		evtTyp = LiveStart
		logInfo = "Live Start"
		// 发送开播提醒和录像通知
		l.sendLiveNotification(hostName, consts.LiveStatusStart)

	case statusToFalseEvt:
		evtTyp = LiveEnd
		logInfo = "Live end"
		// 发送结束直播提醒和录像通知
		l.sendLiveNotification(hostName, consts.LiveStatusStop)
	case roomNameChangedEvt:
		cfg := configs.GetCurrentConfig()
		if cfg == nil {
			return
		}
		if !cfg.VideoSplitStrategies.OnRoomNameChanged {
			return
		}
		evtTyp = RoomNameChanged
		logInfo = "Room name was changed"
	}
	if isStatusChanged {
		l.ed.DispatchEvent(events.NewEvent(evtTyp, l.Live))
		applog.GetLogger().WithFields(fields).Info(logInfo)
	}
}
