// Package softrestart 实现需求8 的「定时软重启」。
//
// 软重启语义（已与用户确认）：
//   - 切断所有直播连接：停止录制器（断开已建立的下载连接），并且不再向平台发起任何请求；
//   - 等待可配置的时长后自动恢复，重新开始请求数据。
//
// 实现要点：
//   - 「切断流量」由 pkg/pause 的全局闸门完成，分两层生效：
//     ① live 层请求调度器里的检查点 —— 拦住**新**请求；
//     ② http.Client 传输层的可掐断 RoundTripper —— **立即取消已在途**的请求（连接随之中断）；
//     因此本包只需"关门 / 开门"，无需销毁重建任何对象，天然规避了四个架构坑；
//   - 软重启开始时主动停止所有录制器，否则已建立的流仍在持续拉取，并未真正"切断"；
//   - **恢复后必须主动补录**：暂停期间没有任何请求，直播状态不会发生变化，
//     也就不会触发 LiveStart 事件；若不主动补建录制器，正在进行的直播会一直不被录制。
package softrestart

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/bililive-go/bililive-go/src/configs"
	"github.com/bililive-go/bililive-go/src/instance"
	"github.com/bililive-go/bililive-go/src/live"
	applog "github.com/bililive-go/bililive-go/src/log"
	"github.com/bililive-go/bililive-go/src/pkg/pause"
	"github.com/bililive-go/bililive-go/src/pkg/timeslot"
	"github.com/bililive-go/bililive-go/src/recorders"
	"github.com/bililive-go/bililive-go/src/types"
)

const (
	// scheduleCheckInterval 计划轮询间隔。计划精度只到分钟，30 秒足够及时。
	scheduleCheckInterval = 30 * time.Second
	// scheduleHitWindow 计划命中窗口宽度。
	//
	// 取 2 个轮询周期而不是 1 个：Ticker 丢一次 tick 或相位漂移时，
	// 单周期窗口会让当天这条计划整天漏执行；配合"当天已执行"标记，
	// 放宽到 2 个周期不会造成重复执行。
	scheduleHitWindow = 2 * scheduleCheckInterval
	// defaultRecoveryMinutes 配置缺省时的恢复时长
	defaultRecoveryMinutes = 10
)

// Manager 定时软重启管理器
type Manager struct {
	ctx  context.Context
	gate *pause.Gate

	mu      sync.Mutex
	running bool // 是否正在执行一次软重启
	stopCh  chan struct{}
	once    sync.Once
	// cancelCh 用于中止正在等待恢复窗口的软重启，让用户能手动提前恢复。
	// 带 1 个缓冲，重复 Cancel 不会阻塞。
	cancelCh chan struct{}

	// scheduleMu 保护"当天该计划是否已执行"的标记。
	// firedDate 记录标记所属日期，跨天时整表作废（无需额外的重置定时器）；
	// fired 的键为 "计划时间"（HH:MM），值为空结构体。
	scheduleMu sync.Mutex
	firedDate  string
	fired      map[string]struct{}
}

// NewManager 创建软重启管理器。gate 为 nil 时使用进程级默认闸门。
func NewManager(ctx context.Context, gate *pause.Gate) *Manager {
	if gate == nil {
		gate = pause.Default()
	}
	return &Manager{
		ctx:      ctx,
		gate:     gate,
		stopCh:   make(chan struct{}),
		cancelCh: make(chan struct{}, 1),
	}
}

// Start 启动计划调度循环（非阻塞）
func (m *Manager) Start() {
	go m.loop()
	applog.GetLogger().Info("定时软重启调度已启动（本轮仅实现软重启）")
}

// Close 停止调度并解除暂停状态
func (m *Manager) Close() {
	m.once.Do(func() { close(m.stopCh) })
	m.gate.Resume()
}

// loop 计划调度主循环
func (m *Manager) loop() {
	ticker := time.NewTicker(scheduleCheckInterval)
	defer ticker.Stop()

	// 启动时立即补偿检查一次：进程在计划窗口内启动/重启时，
	// 不必再等一个轮询周期（相位漂移时甚至可能整天错过）。
	// 写法与 one_time_manager 的"启动即检查一次"一致。
	m.tick()

	for {
		select {
		case <-m.ctx.Done():
			return
		case <-m.stopCh:
			return
		case <-ticker.C:
			m.tick()
		}
	}
}

// tick 检查当前是否命中某条尚未执行的计划，命中则触发软重启
func (m *Manager) tick() {
	cfg := configs.GetCurrentConfig()
	if cfg == nil || !cfg.AutoRestart.Enable {
		return
	}

	// 已有软重启（手动触发或上一条计划）正在执行时，不消费本次计划窗口：
	// hitSchedule 不会记录执行标记，等下一次 tick 再试，
	// 避免计划在与手动 SoftRestartNow 撞车时被静默吞掉。
	m.mu.Lock()
	running := m.running
	m.mu.Unlock()
	if running {
		return
	}

	if m.hitSchedule(cfg.AutoRestart.Schedules, time.Now()) {
		go m.SoftRestartNow("定时计划触发")
	}
}

// hitSchedule 判断 now 是否落在任一条计划尚未执行的命中窗口内。
//
// 窗口取「[目标时刻, 目标时刻+2 个轮询周期)」，而不是要求秒级精确相等 ——
// 30 秒轮询周期丢一次 tick 或相位漂移时，单周期窗口会整天漏执行。
// 放宽窗口后，用"当天该计划是否已执行"的标记来保证不会重复触发；
// 标记按日期作废，跨天自动重置。
func (m *Manager) hitSchedule(schedules []configs.AutoRestartSchedule, now time.Time) bool {
	day := now.Format("2006-01-02")

	m.scheduleMu.Lock()
	defer m.scheduleMu.Unlock()
	if m.firedDate != day {
		// 跨天：清空全部执行标记（含手动重启留下的无关状态）
		m.firedDate = day
		m.fired = make(map[string]struct{}, len(schedules))
	}
	if m.fired == nil {
		m.fired = make(map[string]struct{}, len(schedules))
	}

	for i := range schedules {
		sc := &schedules[i]
		minutes, err := timeslot.ParseHHMM(sc.Time)
		if err != nil {
			continue
		}
		if !timeslot.DayMatches(sc.Days, int(now.Weekday())) {
			continue
		}
		target := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).
			Add(time.Duration(minutes) * time.Minute)
		since := now.Sub(target)
		if since < 0 || since >= scheduleHitWindow {
			continue
		}
		// 该计划当天已执行过：不重复触发
		if _, done := m.fired[sc.Time]; done {
			continue
		}
		m.fired[sc.Time] = struct{}{}
		return true
	}
	return false
}

// NextRunAt 计算下一次计划执行时刻；未启用或无有效计划时返回零值。
func (m *Manager) NextRunAt() time.Time {
	cfg := configs.GetCurrentConfig()
	if cfg == nil || !cfg.AutoRestart.Enable {
		return time.Time{}
	}
	return nextRunAt(cfg.AutoRestart.Schedules, time.Now())
}

// nextRunAt 在给定计划中找出最近一次未来的执行时刻。
func nextRunAt(schedules []configs.AutoRestartSchedule, now time.Time) time.Time {
	var best time.Time
	for i := range schedules {
		sc := &schedules[i]
		minutes, err := timeslot.ParseHHMM(sc.Time)
		if err != nil {
			continue
		}
		// 最多向后找 8 天，足以覆盖任意星期组合
		for dayOffset := 0; dayOffset <= 7; dayOffset++ {
			day := now.AddDate(0, 0, dayOffset)
			if !timeslot.DayMatches(sc.Days, int(day.Weekday())) {
				continue
			}
			t := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, now.Location()).
				Add(time.Duration(minutes) * time.Minute)
			if !t.After(now) {
				continue
			}
			if best.IsZero() || t.Before(best) {
				best = t
			}
			break
		}
	}
	return best
}

// RecoveryDuration 返回当前配置的恢复时长。
func (m *Manager) RecoveryDuration() time.Duration {
	minutes := defaultRecoveryMinutes
	if cfg := configs.GetCurrentConfig(); cfg != nil && cfg.AutoRestart.RecoveryMinutes > 0 {
		minutes = cfg.AutoRestart.RecoveryMinutes
	}
	return time.Duration(minutes) * time.Minute
}

// SoftRestartNow 立即执行一次软重启。
//
// 该方法是阻塞的（会等待整个恢复窗口），调用方（HTTP handler 或调度 goroutine）
// 应放在独立 goroutine 中执行。
func (m *Manager) SoftRestartNow(reason string) {
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		applog.GetLogger().Warn("已有软重启正在执行，忽略本次触发")
		return
	}
	m.running = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.running = false
		m.mu.Unlock()
	}()

	recovery := m.RecoveryDuration()
	applog.GetLogger().Infof("软重启开始（%s）：切断所有直播连接，%s 后恢复", reason, recovery)

	// 1) 关门：立即停止所有平台请求 ——
	//    Pause 会关闭当前代际的掐断通道，使所有已绑定的在途 HTTP 请求的 ctx 立刻被取消
	//    （连接随之中断），而不仅仅是"不再发起新请求"。
	m.gate.Pause(recovery, reason)

	// 2) 停止所有录制器：断开设已建立的下载连接，否则流仍在被持续拉取。
	//    快照必须在停止动作**之前**做：这批房间在恢复阶段要无条件补录 ——
	//    已经开始的录制不应因为软重启（或期间抵达时段结束时刻）而丢失。
	recordingBefore := m.snapshotRecordingLiveIDs()
	stopped := m.stopAllRecorders()

	// 3) 等待恢复时刻（可被 Close / 进程退出提前中断）
	timer := time.NewTimer(recovery)
	defer timer.Stop()
	select {
	case <-m.ctx.Done():
		applog.GetLogger().Warn("软重启等待期间应用正在退出，提前恢复闸门")
	case <-m.stopCh:
		applog.GetLogger().Warn("软重启等待期间收到停止信号，提前恢复闸门")
	case <-m.cancelCh:
		applog.GetLogger().Info("软重启被手动取消，提前恢复请求")
	case <-timer.C:
	}

	// 4) 开门：恢复平台请求
	m.gate.Resume()

	// 5) 补录：见包注释 —— 暂停期间不会有 LiveStart 事件，必须主动补建录制器
	resumed := m.resumeRecording(recordingBefore)

	applog.GetLogger().Infof("软重启完成（%s）：已停止 %d 个录制器，恢复 %d 个房间的录制", reason, stopped, resumed)
}

// Cancel 立刻中止正在进行的软重启（提前恢复请求）。
// 返回 true 表示确实中止了一次进行中的软重启；false 表示当前没有在执行。
// 注意：SoftRestartNow 会在收到取消信号后照常走"恢复闸门 + 补录"流程，
// 因此取消后正在直播的房间依然会被正确恢复录制。
func (m *Manager) Cancel() bool {
	m.mu.Lock()
	running := m.running
	m.mu.Unlock()

	if !running {
		// 没有进行中的软重启时，仅确保闸门是打开的（幂等）
		m.gate.Resume()
		return false
	}
	select {
	case m.cancelCh <- struct{}{}:
	default: // 已有待处理的取消信号
	}
	return true
}

// snapshotRecordingLiveIDs 快照"当前正在录制"的直播间 ID 集合。
//
// 优先使用 RecorderManager 提供的只读快照接口（一次加锁读全量）；
// 若实现未提供（例如测试里的假实现），回退到遍历 LiveMap + HasRecorder，
// 结果语义完全一致，只是可能多几次加锁。
func (m *Manager) snapshotRecordingLiveIDs() []types.LiveID {
	inst := instance.GetInstance(m.ctx)
	mgr, ok := inst.RecorderManager.(recorders.Manager)
	if !ok || mgr == nil {
		return nil
	}

	type recordingIDProvider interface {
		RecordingLiveIDs() []string
	}
	if p, hasProvider := mgr.(recordingIDProvider); hasProvider {
		raw := p.RecordingLiveIDs()
		ids := make([]types.LiveID, 0, len(raw))
		for _, s := range raw {
			ids = append(ids, types.LiveID(s))
		}
		return ids
	}

	var ids []types.LiveID
	inst.Lives.Range(func(id types.LiveID, _ live.Live) bool {
		if mgr.HasRecorder(m.ctx, id) {
			ids = append(ids, id)
		}
		return true
	})
	return ids
}

// stopAllRecorders 停止当前所有录制器，返回停止的数量。
func (m *Manager) stopAllRecorders() int {
	inst := instance.GetInstance(m.ctx)
	mgr, ok := inst.RecorderManager.(recorders.Manager)
	if !ok || mgr == nil {
		return 0
	}

	var ids []types.LiveID
	inst.Lives.Range(func(id types.LiveID, _ live.Live) bool {
		if mgr.HasRecorder(m.ctx, id) {
			ids = append(ids, id)
		}
		return true
	})

	stopped := 0
	for _, id := range ids {
		if err := mgr.RemoveRecorder(m.ctx, id); err != nil {
			applog.GetLogger().Warnf("软重启停止录制失败 %s: %v", id, err)
			continue
		}
		stopped++
	}
	return stopped
}

// resumeRecording 补建录制器，返回补建数量。
//
// priority 是软重启开始前"正在录制"的直播间 ID 快照：这批房间**无条件先恢复**，
// 不再跑 shouldRecord（时段/待删除/仅提醒只决定"是否开始录制"，
// 而它们早已开始录制，不应因为软重启或期间到达时段结束时刻而整场丢失）。
// 其余房间再按 shouldRecord 判定补录。
func (m *Manager) resumeRecording(priority []types.LiveID) int {
	inst := instance.GetInstance(m.ctx)
	mgr, ok := inst.RecorderManager.(recorders.Manager)
	if !ok || mgr == nil {
		return 0
	}
	cfg := configs.GetCurrentConfig()
	if cfg == nil {
		return 0
	}

	resumed := 0

	// 1) 无条件恢复"软重启前正在录制"的房间。
	//    仅保留一个必要前提：该房间在配置中仍然存在（否则不应再建录制器）。
	for _, id := range priority {
		// 已存在录制器（例如闸门恢复后 LiveStart 恰好抢先建好）时直接跳过
		if mgr.HasRecorder(m.ctx, id) {
			continue
		}
		l, found := inst.Lives.Get(id)
		if !found || l == nil {
			continue
		}
		if room, err := cfg.GetLiveRoomByUrl(l.GetRawUrl()); err != nil || room == nil {
			continue
		}
		if err := mgr.AddRecorder(m.ctx, l); err != nil {
			if errors.Is(err, recorders.ErrRecorderExist) {
				continue
			}
			applog.GetLogger().Warnf("软重启恢复录制失败 %s: %v", l.GetRawUrl(), err)
			continue
		}
		applog.GetLogger().Infof("软重启：已恢复软重启前正在录制的房间 %s", l.GetRawUrl())
		resumed++
	}

	// 2) 其余房间按统一判定补录
	inst.Lives.Range(func(id types.LiveID, l live.Live) bool {
		if mgr.HasRecorder(m.ctx, id) {
			return true
		}
		if !m.shouldRecord(inst, cfg, l) {
			return true
		}
		if err := mgr.AddRecorder(m.ctx, l); err != nil {
			// 闸门已放开，LiveStart 事件可能抢先建好录制器，这属于正常情况
			if errors.Is(err, recorders.ErrRecorderExist) {
				return true
			}
			applog.GetLogger().Warnf("软重启恢复录制失败 %s: %v", l.GetRawUrl(), err)
			return true
		}
		applog.GetLogger().Infof("软重启：已为 %s 恢复录制", l.GetRawUrl())
		resumed++
		return true
	})
	return resumed
}

// shouldRecord 判定一个直播间当前是否应当录制。
//
// 判定条件与 recorders.manager 的 registryListener（LiveStart 时的决策点）保持一致，
// 否则会出现"软重启后录了本来不该录的房间"这类不一致行为。
func (m *Manager) shouldRecord(inst *instance.Instance, cfg *configs.Config, l live.Live) bool {
	room, err := cfg.GetLiveRoomByUrl(l.GetRawUrl())
	if err != nil || room == nil {
		return false
	}
	if !room.IsListening {
		return false
	}
	// 仅提醒模式不录制
	if room.NotifyOnly {
		return false
	}
	// 一次性录制进入"待删除"后只提醒不录制
	if room.IsPendingDelete() {
		return false
	}
	// 录制时间段：不在时段内只监控不录制
	if slots := room.ResolveRecordSlots(cfg.RecordScheduleTemplates); len(slots) > 0 {
		if !timeslot.IsActive(timeslot.Compile(slots), time.Now()) {
			return false
		}
	}
	// 必须确实处于直播中（从监听缓存读取，暂停期间该值不会被刷新，恢复后即为最新判定依据）
	obj, err := inst.Cache.Get(l)
	if err != nil || obj == nil {
		return false
	}
	info, ok := obj.(*live.Info)
	return ok && info.Status
}

// Status 软重启状态快照（供 HTTP API 下发给前端）
type Status struct {
	// Enabled 是否启用了定时软重启
	Enabled bool `json:"enabled"`
	// Running 是否正在执行一次软重启
	Running bool `json:"running"`
	// Paused 闸门是否处于暂停中（切断流量中）
	Paused bool `json:"paused"`
	// RemainingSeconds 距离恢复还有多少秒
	RemainingSeconds int64 `json:"remaining_seconds"`
	// UntilAt 恢复时刻（unix 秒）
	UntilAt int64 `json:"until_at,omitempty"`
	// NextRunAt 下次计划执行时刻（unix 秒），0 表示无计划
	NextRunAt int64 `json:"next_run_at,omitempty"`
	// NextRunAtText 下次计划执行时刻的可读文本
	NextRunAtText string `json:"next_run_at_text,omitempty"`
	// RecoveryMinutes 当前生效的恢复时长（分钟）
	RecoveryMinutes int `json:"recovery_minutes"`
	// Reason 当前暂停的原因
	Reason string `json:"reason,omitempty"`
}

// Status 返回当前状态快照。
func (m *Manager) Status() Status {
	m.mu.Lock()
	running := m.running
	m.mu.Unlock()

	cfg := configs.GetCurrentConfig()
	enabled := cfg != nil && cfg.AutoRestart.Enable

	gateSnap := m.gate.Snapshot()
	st := Status{
		Enabled:          enabled,
		Running:          running,
		Paused:           gateSnap.Paused,
		RemainingSeconds: gateSnap.RemainingSeconds,
		UntilAt:          gateSnap.UntilAt,
		RecoveryMinutes:  int(m.RecoveryDuration().Minutes()),
		Reason:           gateSnap.Reason,
	}
	if next := m.NextRunAt(); !next.IsZero() {
		st.NextRunAt = next.Unix()
		st.NextRunAtText = next.Format("2006-01-02 15:04")
	}
	return st
}
