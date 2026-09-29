package recorders

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/bililive-go/bililive-go/src/configs"
	"github.com/bililive-go/bililive-go/src/instance"
	"github.com/bililive-go/bililive-go/src/interfaces"
	"github.com/bililive-go/bililive-go/src/listeners"
	"github.com/bililive-go/bililive-go/src/live"
	"github.com/bililive-go/bililive-go/src/pkg/events"
	"github.com/bililive-go/bililive-go/src/pkg/pause"
	bilisentry "github.com/bililive-go/bililive-go/src/pkg/sentry"
	"github.com/bililive-go/bililive-go/src/pkg/timeslot"
	"github.com/bililive-go/bililive-go/src/types"
)

const (
	// recordScheduleCheckInterval 录制时间段补录检查周期。
	//
	// LiveStart 回调只在开播那一刻判定一次录制时段，因此"开播在时段外、
	// 之后才进入时段"的直播会整场漏录。这里以低频（约每分钟一次）补一次
	// 与 LiveStart 完全相同的判定，避免整场丢失；不需要更密。
	recordScheduleCheckInterval = time.Minute
)

// BroadcastRecorderStatusFunc 是用于广播录制器状态的回调函数类型
type BroadcastRecorderStatusFunc func(liveId types.LiveID, status map[string]interface{})

// OnRecordingEndFunc 是录制结束时的回调函数类型
type OnRecordingEndFunc func(ctx context.Context)

// BroadcastDanmakuFunc 是用于广播弹幕消息的回调函数类型
type BroadcastDanmakuFunc func(liveId types.LiveID, msgType, username, content string, extra map[string]interface{})

var (
	// broadcastRecorderStatusFunc 全局广播函数，由 servers 包设置
	broadcastRecorderStatusFunc BroadcastRecorderStatusFunc
	// onRecordingEndFunc 录制结束时的回调函数，用于触发优雅更新检查
	onRecordingEndFunc OnRecordingEndFunc
	// broadcastDanmakuFunc 全局弹幕广播函数，由 servers 包设置
	broadcastDanmakuFunc BroadcastDanmakuFunc
)

// SetBroadcastRecorderStatusFunc 设置录制器状态广播函数
func SetBroadcastRecorderStatusFunc(fn BroadcastRecorderStatusFunc) {
	broadcastRecorderStatusFunc = fn
}

// SetOnRecordingEndFunc 设置录制结束回调函数
func SetOnRecordingEndFunc(fn OnRecordingEndFunc) {
	onRecordingEndFunc = fn
}

// SetBroadcastDanmakuFunc 设置弹幕广播函数
func SetBroadcastDanmakuFunc(fn BroadcastDanmakuFunc) {
	broadcastDanmakuFunc = fn
}

func NewManager(ctx context.Context) Manager {
	rm := &manager{
		savers:       make(map[types.LiveID]Recorder),
		statusStopCh: make(chan struct{}),
	}
	instance.GetInstance(ctx).RecorderManager = rm

	return rm
}

type Manager interface {
	interfaces.Module
	AddRecorder(ctx context.Context, live live.Live) error
	RemoveRecorder(ctx context.Context, liveId types.LiveID) error
	RestartRecorder(ctx context.Context, liveId live.Live) error
	GetRecorder(ctx context.Context, liveId types.LiveID) (Recorder, error)
	HasRecorder(ctx context.Context, liveId types.LiveID) bool
	// GetAllParserPIDs 获取所有活动录制器的 parser PID 列表
	GetAllParserPIDs() []int
	// GetRecorderStatus 获取指定直播间录制器的状态
	// 实现 iostats.RecorderStatusProvider 接口
	GetRecorderStatus(ctx context.Context, liveId types.LiveID) (map[string]interface{}, error)
	// GetActiveRecordingsCount 获取当前活跃的录制数量
	GetActiveRecordingsCount() int
	// WaitForNotifications 等待所有异步通知 goroutine 完成（关闭流程中使用）
	WaitForNotifications()
}

// for test
var (
	newRecorder = NewRecorder
)

type manager struct {
	lock         sync.RWMutex
	savers       map[types.LiveID]Recorder
	statusTicker *time.Ticker
	statusStopCh chan struct{}
	statusWg     sync.WaitGroup // 用于等待广播 goroutine 退出
	notifyWg     sync.WaitGroup // 跟踪异步通知 goroutine（sendAccumulatedSummary），关闭时等待
	// recordCheckTicker 录制时段补录检查的 ticker（与状态广播共用同一个 goroutine 生命周期）
	recordCheckTicker *time.Ticker
	// restartingCount 追踪正在执行 CloseForRestart 的旧 recorder 数量。
	// RestartRecorder 在释放锁后才执行 oldRecorder.CloseForRestart()，
	// 此期间 map 中只有新 recorder，但旧 recorder 仍在收尾运行。
	// 如果此时 LiveEnd 删掉新 recorder，GetActiveRecordingsCount() 仅看 map
	// 会误判为"无活跃录制"导致优雅更新被提前触发。
	// 通过 restartingCount 将收尾中的旧 recorder 也计入活跃数量。
	restartingCount atomic.Int32
}

func (m *manager) registryListener(ctx context.Context, ed events.Dispatcher) {
	ed.AddEventListener(listeners.LiveStart, events.NewEventListener(func(event *events.Event) {
		live := event.Object.(live.Live)

		if cfg := configs.GetCurrentConfig(); cfg != nil {
			if room, err := cfg.GetLiveRoomByUrl(live.GetRawUrl()); err == nil {
				// 仅提醒模式：跳过自动录制
				if room.NotifyOnly {
					live.GetLogger().Info("Room is notify-only, skipping auto-recording")
					return
				}
				// 需求1：一次性录制进入"待删除"后不可逆，期间只提醒不录制
				if room.IsPendingDelete() {
					live.GetLogger().Info("一次性录制已进入待删除状态，仅提醒不录制")
					return
				}
				// 需求6：配置了录制时间段且当前不在时段内 → 只监控不录制。
				//
				// 注意本回调只在 LiveStart（开播）时触发，因此时间段仅决定"是否开始录制"；
				// 已经开始的录制不会因为到达结束时刻而在中途被打断，会等它自然结束。
				if slots := room.ResolveRecordSlots(cfg.RecordScheduleTemplates); len(slots) > 0 {
					if !timeslot.IsActive(timeslot.Compile(slots), time.Now()) {
						live.GetLogger().Info("当前不在配置的录制时间段内，仅监控不录制")
						return
					}
				}
			}
		}

		if err := m.AddRecorder(ctx, live); err != nil {
			live.GetLogger().Errorf("failed to add recorder, err: %v", err)
		}
	}))

	ed.AddEventListener(listeners.RoomNameChanged, events.NewEventListener(func(event *events.Event) {
		live := event.Object.(live.Live)
		if !m.HasRecorder(ctx, live.GetLiveId()) {
			return
		}
		if err := m.RestartRecorder(ctx, live); err != nil {
			live.GetLogger().Errorf("failed to cronRestart recorder, err: %v", err)
		}
	}))

	removeEvtListener := events.NewEventListener(func(event *events.Event) {
		live := event.Object.(live.Live)
		if !m.HasRecorder(ctx, live.GetLiveId()) {
			return
		}
		if err := m.RemoveRecorder(ctx, live.GetLiveId()); err != nil {
			live.GetLogger().Errorf("failed to remove recorder, err: %v", err)
		}
	})
	ed.AddEventListener(listeners.LiveEnd, removeEvtListener)
	ed.AddEventListener(listeners.ListenStop, removeEvtListener)
	// RecorderStopRequested 仅表示 recorder 自身遇到不可重试错误，需要被回收；
	// 它不具有 LiveEnd 的全局直播状态语义，避免错误结束仍在进行的直播会话。
	ed.AddEventListener(RecorderStopRequested, removeEvtListener)
}

func (m *manager) Start(ctx context.Context) error {
	inst := instance.GetInstance(ctx)
	if cfg := configs.GetCurrentConfig(); (cfg != nil && cfg.RPC.Enable) || inst.Lives.Len() > 0 {
		inst.WaitGroup.Add(1)
	}
	m.registryListener(ctx, inst.EventDispatcher.(events.Dispatcher))

	// 启动定期广播录制器状态的 goroutine
	m.startStatusBroadcaster(ctx)

	return nil
}

func (m *manager) Close(ctx context.Context) {
	// 停止状态广播器
	if m.statusTicker != nil {
		m.statusTicker.Stop()
	}
	if m.recordCheckTicker != nil {
		m.recordCheckTicker.Stop()
	}
	if m.statusStopCh != nil {
		close(m.statusStopCh)
		// 等待广播 goroutine 退出
		m.statusWg.Wait()
	}

	m.lock.Lock()
	defer m.lock.Unlock()
	for id, recorder := range m.savers {
		recorder.Close()
		delete(m.savers, id)
	}
	inst := instance.GetInstance(ctx)
	inst.WaitGroup.Done()
}

// WaitForNotifications 等待所有异步通知 goroutine 完成
// 应在 PipelineManager.Close 之后调用，确保所有 pipeline 回调触发的通知已完成
func (m *manager) WaitForNotifications() {
	m.notifyWg.Wait()
}

func (m *manager) AddRecorder(ctx context.Context, live live.Live) error {
	m.lock.Lock()
	defer m.lock.Unlock()
	return m.addRecorderLocked(ctx, live)
}

// addRecorderLocked 是 AddRecorder 的内部实现，调用者必须已持有 m.lock
func (m *manager) addRecorderLocked(ctx context.Context, live live.Live) error {
	if _, ok := m.savers[live.GetLiveId()]; ok {
		return ErrRecorderExist
	}
	rec, err := newRecorder(ctx, live)
	if err != nil {
		return err
	}
	// 设置通知 WaitGroup，使异步摘要发送 goroutine 可被关闭流程等待
	if recTyped, ok := rec.(*recorder); ok {
		recTyped.notifyWg = &m.notifyWg
	}
	m.savers[live.GetLiveId()] = rec

	cfg := configs.GetCurrentConfig()
	if cfg != nil {
		if maxDur := cfg.VideoSplitStrategies.MaxDuration; maxDur != 0 {
			bilisentry.GoWithContext(ctx, func(ctx context.Context) { m.cronRestart(ctx, live) })
		}
	}
	if err := rec.Start(ctx); err != nil {
		// Start 失败时从 map 删除并异步 Close 新 recorder，防止泄漏/僵尸实例
		// 使用异步 Close 避免在持锁时执行耗时操作（如等待 ffmpeg 进程退出），
		// 防止长时间阻塞其他 manager 操作
		delete(m.savers, live.GetLiveId())
		bilisentry.Go(rec.Close)
		return err
	}
	return nil
}

func (m *manager) cronRestart(ctx context.Context, live live.Live) {
	recorder, err := m.GetRecorder(ctx, live.GetLiveId())
	if err != nil {
		return
	}
	cfg := configs.GetCurrentConfig()
	if cfg == nil {
		return
	}
	if time.Since(recorder.StartTime()) < cfg.VideoSplitStrategies.MaxDuration {
		time.AfterFunc(time.Minute/4, func() {
			m.cronRestart(ctx, live)
		})
		return
	}
	if err := m.RestartRecorder(ctx, live); err != nil {
		return
	}
}

func (m *manager) RestartRecorder(ctx context.Context, live live.Live) error {
	// 1. 在锁内完成 map 操作：取出旧 recorder，创建并放入新 recorder
	// 这样外部观察者（如 LiveEnd 事件处理器）始终能看到录制器存在，不会出现中间状态
	m.lock.Lock()
	oldRecorder, ok := m.savers[live.GetLiveId()]
	if !ok {
		m.lock.Unlock()
		return ErrRecorderNotExist
	}
	// 从 map 中移除旧 recorder 并立即添加新 recorder，保持锁贯穿整个替换操作
	delete(m.savers, live.GetLiveId())
	if err := m.addRecorderLocked(ctx, live); err != nil {
		// 添加新 recorder 失败，恢复旧 recorder 避免僵尸状态
		m.savers[live.GetLiveId()] = oldRecorder
		m.lock.Unlock()
		return err
	}
	newRec := m.savers[live.GetLiveId()]
	// 设置分段重启摘要屏障：阻止新 recorder 在 Pipeline 状态转移前发送摘要
	if newRecTyped, ok := newRec.(*recorder); ok {
		newRecTyped.transferWg = &sync.WaitGroup{}
		newRecTyped.transferWg.Add(1)
	}
	// restartingCount 必须在释放锁之前递增，否则 Unlock 到 Add(1) 之间
	// LiveEnd 可能移除新 recorder 并看到 restartingCount==0，
	// 导致 GetActiveRecordingsCount() 误判为"无活跃录制"触发优雅更新
	m.restartingCount.Add(1)
	m.lock.Unlock()

	// 2. 锁外执行耗时操作：关闭旧 recorder 并获取累积文件
	// restartingCount 保证 CloseForRestart 期间旧 recorder 仍被计入活跃数量
	defer func() {
		m.restartingCount.Add(-1)
		// 收尾完成后检查是否有等待中的优雅更新：
		// 如果 LiveEnd 在 CloseForRestart 期间移除了新 recorder，
		// 那次 CheckGracefulUpdate 会因 restartingCount>0 而跳过，
		// 此处递减后需要再触发一次检查，避免优雅更新永久卡住。
		if onRecordingEndFunc != nil {
			bilisentry.GoWithContext(ctx, func(ctx context.Context) { onRecordingEndFunc(ctx) })
		}
	}()
	oldFiles := oldRecorder.CloseForRestart()
	live.GetLogger().Infof("分段重启录制，携带 %d 个历史文件", len(oldFiles))

	// 3. 将旧文件传递给新 recorder（在锁下确认 recorder 仍存在且为预期实例）
	if len(oldFiles) > 0 {
		m.lock.RLock()
		currentRec, stillExists := m.savers[live.GetLiveId()]
		m.lock.RUnlock()
		if stillExists && currentRec == newRec {
			newRec.SetInitialRecordedFiles(oldFiles)
		} else {
			live.GetLogger().Warnf("分段重启时新 recorder 已被移除，跳过 %d 个历史文件传递", len(oldFiles))
		}
	}

	// 4. 转移 Pipeline 状态（确保旧分段的 Pipeline 结果不丢失）
	if newRecTyped, ok := newRec.(*recorder); ok {
		if oldRecTyped, ok := oldRecorder.(*recorder); ok {
			newRecTyped.TransferPipelineState(oldRecTyped)
		}
		// 释放摘要屏障：转移已完成（或无需转移），允许新 recorder 发送摘要
		newRecTyped.transferWg.Done()
	}

	return nil
}

func (m *manager) RemoveRecorder(ctx context.Context, liveId types.LiveID) error {
	m.lock.Lock()
	defer m.lock.Unlock()
	return m.removeRecorderLocked(ctx, liveId)
}

// removeRecorderLocked 是 RemoveRecorder 的内部实现，调用者必须已持有 m.lock
func (m *manager) removeRecorderLocked(ctx context.Context, liveId types.LiveID) error {
	recorder, ok := m.savers[liveId]
	if !ok {
		return ErrRecorderNotExist
	}
	recorder.Close()
	delete(m.savers, liveId)

	// 录制结束后，检查是否有等待中的优雅更新
	if onRecordingEndFunc != nil {
		bilisentry.GoWithContext(ctx, func(ctx context.Context) { onRecordingEndFunc(ctx) })
	}

	return nil
}

func (m *manager) GetRecorder(ctx context.Context, liveId types.LiveID) (Recorder, error) {
	m.lock.RLock()
	defer m.lock.RUnlock()
	r, ok := m.savers[liveId]
	if !ok {
		return nil, ErrRecorderNotExist
	}
	return r, nil
}

func (m *manager) HasRecorder(ctx context.Context, liveId types.LiveID) bool {
	m.lock.RLock()
	defer m.lock.RUnlock()
	_, ok := m.savers[liveId]
	return ok
}

// RecordingLiveIDs 返回当前存在录制器的直播间 ID 列表（只读快照，一次加锁读全量）。
//
// 供软重启在"停止所有录制器之前"快照需要在恢复阶段无条件补录的房间：
// 已经开始的录制不应因为软重启（或期间到达录制时段的结束时刻）而丢失。
//
// 注意：刻意不加入导出的 Manager 接口 —— 该接口已有生成的 mock
// （src/recorders/mock_test.go），加方法会让 mock 不再满足接口而编译失败。
// 调用方用本地小接口做类型断言即可（见 pkg/softrestart）。
func (m *manager) RecordingLiveIDs() []string {
	m.lock.RLock()
	defer m.lock.RUnlock()
	ids := make([]string, 0, len(m.savers))
	for id := range m.savers {
		ids = append(ids, string(id))
	}
	return ids
}

// startStatusBroadcaster 启动定期广播录制器状态的 goroutine
func (m *manager) startStatusBroadcaster(ctx context.Context) {
	// 每5秒广播一次录制器状态
	m.statusTicker = time.NewTicker(5 * time.Second)
	// 录制时段补录检查：低频（约每分钟）跑一次
	m.recordCheckTicker = time.NewTicker(recordScheduleCheckInterval)

	m.statusWg.Add(1)
	bilisentry.Go(func() {
		defer m.statusWg.Done()
		// 使用回调函数避免循环依赖
		// 回调在 server 初始化时由 SetBroadcastRecorderStatusFunc 设置
		for {
			select {
			case <-m.statusStopCh:
				return
			case <-m.statusTicker.C:
				m.broadcastAllRecorderStatus(ctx)
			case <-m.recordCheckTicker.C:
				m.recordScheduleCatchUp(ctx)
			}
		}
	})
}

// recordScheduleCatchUp 为"开播时不在录制时段、之后才进入时段"的直播间补建录制器。
//
// LiveStart 回调（registryListener）只在开播那一刻判定一次时段，这类直播会整场漏录。
// 这里的判定条件与 registryListener 完全一致，并且只对"当前没有录制器"的房间生效，
// 真正的重复保护仍由 addRecorderLocked 在锁内完成（返回 ErrRecorderExist）。
func (m *manager) recordScheduleCatchUp(ctx context.Context) {
	cfg := configs.GetCurrentConfig()
	if cfg == nil {
		return
	}
	inst := instance.GetInstance(ctx)
	if inst == nil {
		return
	}
	// 软重启切断流量期间不新建录制器：恢复阶段会统一补录，
	// 此刻建出来的录制器也发不出任何请求，只会徒增状态抖动。
	if pause.Default().IsPaused() {
		return
	}

	now := time.Now()
	for id, l := range inst.Lives.Snapshot() {
		if l == nil {
			continue
		}
		if m.HasRecorder(ctx, id) {
			continue
		}
		room, err := cfg.GetLiveRoomByUrl(l.GetRawUrl())
		if err != nil || room == nil {
			continue
		}
		// 与 registryListener 相同的跳过条件（IsListening 额外兜一道：
		// 已停止监控的房间不应被周期性补录重新拉起）
		if !room.IsListening || room.NotifyOnly || room.IsPendingDelete() {
			continue
		}
		// 只处理"配置了录制时段"的房间：未配时段的房间在开播时已经建过录制器，
		// 此处再判只会重复劳动（真正漏录的场景一定是时段判定导致的）。
		slots := room.ResolveRecordSlots(cfg.RecordScheduleTemplates)
		if len(slots) == 0 {
			continue
		}
		if !timeslot.IsActive(timeslot.Compile(slots), now) {
			continue
		}
		// 必须确实处于直播中（与软重启补录一样读监听缓存，不发起任何请求）
		if inst.Cache == nil {
			continue
		}
		obj, cerr := inst.Cache.Get(l)
		if cerr != nil || obj == nil {
			continue
		}
		info, ok := obj.(*live.Info)
		if !ok || !info.Status {
			continue
		}
		if err := m.AddRecorder(ctx, l); err != nil {
			// 并发下已被 LiveStart 建好录制器属于正常情况，不必刷错误日志
			if !errors.Is(err, ErrRecorderExist) {
				l.GetLogger().Warnf("进入录制时间段后补建录制器失败: %v", err)
			}
			continue
		}
		l.GetLogger().Info("已进入配置的录制时间段，补建录制器开始录制")
	}
}

// broadcastAllRecorderStatus 广播所有录制器的状态
func (m *manager) broadcastAllRecorderStatus(ctx context.Context) {
	m.lock.RLock()
	defer m.lock.RUnlock()

	// 如果没有设置广播函数，直接返回
	if broadcastRecorderStatusFunc == nil {
		return
	}

	// 遍历所有录制器并广播状态
	for liveId, recorder := range m.savers {
		status, err := recorder.GetStatus()
		if err == nil && status != nil {
			broadcastRecorderStatusFunc(liveId, status)
		}
	}
}

// GetAllParserPIDs 获取所有活动录制器的 parser PID 列表
func (m *manager) GetAllParserPIDs() []int {
	m.lock.RLock()
	defer m.lock.RUnlock()

	pids := make([]int, 0, len(m.savers))
	for _, recorder := range m.savers {
		if pid := recorder.GetParserPID(); pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}

// GetRecorderStatus 获取指定直播间录制器的状态
// 实现 iostats.RecorderStatusProvider 接口
func (m *manager) GetRecorderStatus(ctx context.Context, liveId types.LiveID) (map[string]interface{}, error) {
	recorder, err := m.GetRecorder(ctx, liveId)
	if err != nil {
		return nil, err
	}
	return recorder.GetStatus()
}

// GetActiveRecordingsCount 获取当前活跃的录制数量
// 包含 map 中的录制器和正在执行 CloseForRestart 收尾的旧录制器
func (m *manager) GetActiveRecordingsCount() int {
	m.lock.RLock()
	defer m.lock.RUnlock()
	return len(m.savers) + int(m.restartingCount.Load())
}
