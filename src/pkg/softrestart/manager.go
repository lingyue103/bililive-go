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

// tick 检查当前是否命中某条计划，命中则触发软重启
func (m *Manager) tick() {
	cfg := configs.GetCurrentConfig()
	if cfg == nil || !cfg.AutoRestart.Enable {
		return
	}
	if m.hitSchedule(cfg.AutoRestart.Schedules, time.Now()) {
		go m.SoftRestartNow("定时计划触发")
	}
}

// hitSchedule 判断 now 是否落在任一条计划的命中窗口内。
//
// 用「[目标时刻, 目标时刻+轮询间隔)」作为命中窗口，而不是要求秒级精确相等 ——
// 否则 30 秒轮询周期很容易整点错过。窗口内重复命中由 running 标志与闸门状态兜住。
func (m *Manager) hitSchedule(schedules []configs.AutoRestartSchedule, now time.Time) bool {
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
		if since := now.Sub(target); since >= 0 && since < scheduleCheckInterval {
			return true
		}
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

	// 2) 停止所有录制器：断开设已建立的下载连接，否则流仍在被持续拉取
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
	resumed := m.resumeRecording()

	applog.GetLogger().Infof("软重启完成（%s）：已停止 %d 个录制器，恢复 %d 个仍在直播的房间", reason, stopped, resumed)
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

// resumeRecording 为"仍在直播且应当录制"的直播间补建录制器，返回补建数量。
func (m *Manager) resumeRecording() int {
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
	inst.Lives.Range(func(id types.LiveID, l live.Live) bool {
		if mgr.HasRecorder(m.ctx, id) {
			return true
		}
		if !m.shouldRecord(inst, cfg, l) {
			return true
		}
		if err := mgr.AddRecorder(m.ctx, l); err != nil {
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
