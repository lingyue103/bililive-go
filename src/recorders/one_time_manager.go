package recorders

import (
	"context"
	"sync"
	"time"

	"github.com/bililive-go/bililive-go/src/configs"
	"github.com/bililive-go/bililive-go/src/instance"
	"github.com/bililive-go/bililive-go/src/listeners"
	"github.com/bililive-go/bililive-go/src/live"
	applog "github.com/bililive-go/bililive-go/src/log"
	"github.com/bililive-go/bililive-go/src/pkg/events"
	bilisentry "github.com/bililive-go/bililive-go/src/pkg/sentry"
	"github.com/bililive-go/bililive-go/src/types"
)

// ============================================================================
// 需求1：一次性录制的状态机
//
// 状态迁移（已与用户确认）：
//
//	(新增链接, 勾选一次性)
//	        │
//	        ▼
//	waiting_first_live ──首次开播──▶ recording
//	        ▲                            │
//	        │                    停播超过"未开播阈值"
//	        │                            ▼
//	        └── 不会回退 ──────  pending_delete（不可逆终态, 只提醒不录制）
//	                                     │
//	                          超过"删除链接延迟"
//	                                     ▼
//	                          删除链接（不删文件）
//
// 关键语义：
//   - 从未开播过的链接**不会**进入待删除，会一直等待首次直播（用户确认）。
//   - 进入 pending_delete 后**即使重新开播也不回退**；只能由用户在前端通过
//     "重置为一次性"（configs.ResetOneTimeState）或"转为永久"（ApplyOneTimeFlag(false)）挽留。
//   - 待删除期间"只提醒不录制"由录制管理器在 LiveStart 时跳过创建录制器实现
//     （见 manager.go 的 registryListener），不修改用户的 notify_only 配置。
//   - 删除计时起点 = 最后一次停播 + 未开播阈值，即"进入待删除的时刻"。
// ============================================================================

const (
	// oneTimeCheckInterval 后台检查周期
	oneTimeCheckInterval = 5 * time.Minute
	// oneTimeUpdateRetries 配置写入的重试次数（与项目其它调用点保持一致）
	oneTimeUpdateRetries = 3
	// oneTimeUpdateBackoff 配置写入重试退避
	oneTimeUpdateBackoff = 10 * time.Millisecond
)

// OneTimeManager 一次性录制的状态机管理器
type OneTimeManager struct {
	stopCh chan struct{}
	once   sync.Once

	// onRoomDeleted 房间因一次性录制到期被自动删除时的回调（由 servers 包注入，
	// 用于广播 SSE 让前端立即刷新列表）。允许为 nil。
	onRoomDeleted func(liveID types.LiveID, rawURL string)
}

// NewOneTimeManager 创建一次性录制管理器
func NewOneTimeManager() *OneTimeManager {
	return &OneTimeManager{stopCh: make(chan struct{})}
}

// SetOnRoomDeleted 注入"房间被自动删除"的通知回调
func (m *OneTimeManager) SetOnRoomDeleted(fn func(liveID types.LiveID, rawURL string)) {
	m.onRoomDeleted = fn
}

// Start 注册事件监听并启动后台检查循环
func (m *OneTimeManager) Start(ctx context.Context) error {
	inst := instance.GetInstance(ctx)
	ed := inst.EventDispatcher.(events.Dispatcher)

	// 开播：waiting_first_live → recording
	ed.AddEventListener(listeners.LiveStart, events.NewEventListener(func(event *events.Event) {
		l, ok := event.Object.(live.Live)
		if !ok {
			return
		}
		m.handleLiveStart(l)
	}))

	// 停播：记录停播时间，用于后续判定"未开播阈值"
	ed.AddEventListener(listeners.LiveEnd, events.NewEventListener(func(event *events.Event) {
		l, ok := event.Object.(live.Live)
		if !ok {
			return
		}
		m.handleLiveEnd(l)
	}))

	bilisentry.GoWithContext(ctx, func(ctx context.Context) {
		ticker := time.NewTicker(oneTimeCheckInterval)
		defer ticker.Stop()

		// 启动后立即检查一次：处理"上次运行期间已经超时"的房间，
		// 否则程序重启后这些房间要再等一个检查周期才会被标记。
		m.checkOnce(ctx)

		for {
			select {
			case <-ctx.Done():
				return
			case <-m.stopCh:
				return
			case <-ticker.C:
				m.checkOnce(ctx)
			}
		}
	})

	applog.GetLogger().Info("一次性录制状态机已启动")
	return nil
}

// Close 停止后台检查
func (m *OneTimeManager) Close() {
	m.once.Do(func() { close(m.stopCh) })
}

// handleLiveStart 处理开播事件：把"等待首次直播"推进为"一次性录制中"
func (m *OneTimeManager) handleLiveStart(l live.Live) {
	_, err := configs.UpdateWithRetry(func(c *configs.Config) error {
		room, rerr := c.GetLiveRoomByUrl(l.GetRawUrl())
		if rerr != nil || room == nil || !room.IsOneTime {
			return nil
		}
		if room.OneTimeStatus == configs.OneTimeStatusWaitingFirstLive {
			room.OneTimeStatus = configs.OneTimeStatusRecording
			applog.GetLogger().Infof("一次性录制：%s 首次开播，状态置为录制中", room.Url)
		}
		// pending_delete 不可逆，这里刻意不做任何回退
		return nil
	}, oneTimeUpdateRetries, oneTimeUpdateBackoff)
	if err != nil {
		applog.GetLogger().Warnf("更新一次性录制开播状态失败: %v", err)
	}
}

// handleLiveEnd 处理停播事件：记录停播时间
func (m *OneTimeManager) handleLiveEnd(l live.Live) {
	_, err := configs.UpdateWithRetry(func(c *configs.Config) error {
		room, rerr := c.GetLiveRoomByUrl(l.GetRawUrl())
		if rerr != nil || room == nil || !room.IsOneTime {
			return nil
		}
		// 已是终态则不再更新计时
		if room.OneTimeStatus == configs.OneTimeStatusPendingDelete {
			return nil
		}
		room.OneTimeLastLiveEnd = time.Now().Unix()
		if room.OneTimeStatus == "" {
			// 兜底：一次性标记存在但状态缺失（例如手工编辑过配置文件）
			room.OneTimeStatus = configs.OneTimeStatusRecording
		}
		return nil
	}, oneTimeUpdateRetries, oneTimeUpdateBackoff)
	if err != nil {
		applog.GetLogger().Warnf("更新一次性录制停播时间失败: %v", err)
	}
}

// pendingDeletion 待删除的直播间
type pendingDeletion struct {
	liveID types.LiveID
	rawURL string
}

// checkOnce 执行一次全量检查：
//  1. recording 且停播超时 → 标记 pending_delete
//  2. pending_delete 且超过删除延迟 → 从配置中删除链接（只删链接，不删文件）
func (m *OneTimeManager) checkOnce(ctx context.Context) {
	cfg := configs.GetCurrentConfig()
	if cfg == nil {
		return
	}
	global := cfg.OneTimeRecord
	now := time.Now().Unix()

	var (
		newlyPending []string
		toDelete     []pendingDeletion
	)

	_, err := configs.UpdateWithRetry(func(c *configs.Config) error {
		// mutator 可能被重试执行多次，必须重置收集切片
		newlyPending = newlyPending[:0]
		toDelete = toDelete[:0]

		for i := range c.LiveRooms {
			room := &c.LiveRooms[i]
			if !room.IsOneTime {
				continue
			}
			switch room.OneTimeStatus {
			case configs.OneTimeStatusWaitingFirstLive:
				// 从未开播：按用户确认的规则，不进入待删除，一直等待首次直播
				continue

			case configs.OneTimeStatusRecording:
				if room.OneTimeLastLiveEnd <= 0 {
					continue
				}
				hours := room.EffectiveOneTimePendingDeleteHours(global)
				if now-room.OneTimeLastLiveEnd >= int64(hours)*3600 {
					room.OneTimeStatus = configs.OneTimeStatusPendingDelete
					room.OneTimePendingDeleteAt = now
					newlyPending = append(newlyPending, room.Url)
				}

			case configs.OneTimeStatusPendingDelete:
				if room.OneTimePendingDeleteAt <= 0 {
					// 数据异常（例如手工编辑过配置），补上标记时刻，下轮再判定
					room.OneTimePendingDeleteAt = now
					continue
				}
				days := room.EffectiveOneTimeDeleteLinkDays(global)
				if now-room.OneTimePendingDeleteAt >= int64(days)*86400 {
					toDelete = append(toDelete, pendingDeletion{liveID: room.LiveId, rawURL: room.Url})
				}
			}
		}

		// 在同一个事务内移除到期的房间，保证内存快照与磁盘一致。
		//
		// 注意：这里必须就地过滤传入的克隆 c，不能调用包级的 configs.RemoveLiveRoomByUrl
		// —— 它内部会再发起一次 Update，在 mutator 里嵌套提交会导致版本冲突甚至死锁。
		if len(toDelete) > 0 {
			kept := c.LiveRooms[:0]
			for i := range c.LiveRooms {
				drop := false
				for _, d := range toDelete {
					if c.LiveRooms[i].Url == d.rawURL {
						drop = true
						break
					}
				}
				if !drop {
					kept = append(kept, c.LiveRooms[i])
				}
			}
			c.LiveRooms = kept
		}
		return nil
	}, oneTimeUpdateRetries, oneTimeUpdateBackoff)
	if err != nil {
		applog.GetLogger().Warnf("一次性录制后台检查失败: %v", err)
		return
	}

	for _, url := range newlyPending {
		applog.GetLogger().Infof("一次性录制：%s 停播已超过阈值，标记为待删除（此后只提醒不录制，且不可逆）", url)
	}

	// 运行时清理：停监听、停录制、移出 LiveMap
	for _, d := range toDelete {
		m.deleteRoomRuntime(ctx, d.liveID, d.rawURL)
	}
}

// deleteRoomRuntime 从运行时移除直播间（只删链接，保留已录制的文件）
func (m *OneTimeManager) deleteRoomRuntime(ctx context.Context, liveID types.LiveID, rawURL string) {
	inst := instance.GetInstance(ctx)

	l, ok := inst.Lives.Get(liveID)
	if !ok || l == nil {
		// LiveId 未初始化或已变化时按 URL 回退匹配
		inst.Lives.Range(func(_ types.LiveID, v live.Live) bool {
			if v.GetRawUrl() == rawURL {
				l = v
				return false
			}
			return true
		})
	}

	if l == nil {
		applog.GetLogger().Warnf("一次性录制到期：未找到运行中的直播间 %s，仅从配置移除", rawURL)
		if m.onRoomDeleted != nil {
			m.onRoomDeleted(liveID, rawURL)
		}
		return
	}

	id := l.GetLiveId()
	if mgr, ok := inst.ListenerManager.(listeners.Manager); ok {
		if err := mgr.RemoveListener(ctx, id); err != nil {
			applog.GetLogger().Warnf("删除到期链接时停止监听失败 %s: %v", rawURL, err)
		}
	}
	if mgr, ok := inst.RecorderManager.(Manager); ok {
		if err := mgr.RemoveRecorder(ctx, id); err != nil {
			applog.GetLogger().Warnf("删除到期链接时停止录制失败 %s: %v", rawURL, err)
		}
	}
	inst.Lives.Delete(id)

	applog.GetLogger().Infof("一次性录制到期：已删除链接 %s（录制文件保留在磁盘上）", rawURL)
	if m.onRoomDeleted != nil {
		m.onRoomDeleted(id, rawURL)
	}
}
