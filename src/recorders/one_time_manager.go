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
//
// 同时必须把 OneTimeLastLiveEnd 归零：它记的是**上一场**的停播时刻，
// 若本场直播跨过了「上次停播 + N 小时」（默认 3 小时），后台检查会误判为
// 长期未开播并把房间标记为不可逆的 pending_delete（见 checkOnce）。
func (m *OneTimeManager) handleLiveStart(l live.Live) {
	rawURL := l.GetRawUrl()

	// 先在内存中比对是否真的有字段变化；没有变化就不落盘。
	// 磁盘异常（如磁盘已满）时 UpdateWithRetry 的重试只会白白刷错误日志。
	cfg := configs.GetCurrentConfig()
	if cfg == nil {
		return
	}
	room, rerr := cfg.GetLiveRoomByUrl(rawURL)
	if rerr != nil || room == nil {
		// 这里绝不能静默返回：查不到配置会让"首次开播"这一步整体失效，
		// 而房间看起来仍在正常录制（registryListener 在查不到配置时是"放行录制"的），
		// 结果就是状态永远停在 waiting_first_live、且没有任何日志可查。
		applog.GetLogger().Warnf("一次性录制：找不到直播间配置，跳过开播处理 url=%s err=%v", rawURL, rerr)
		return
	}
	if !room.IsOneTime {
		return
	}
	needStatus := room.OneTimeStatus == configs.OneTimeStatusWaitingFirstLive
	needResetEnd := room.OneTimeLastLiveEnd != 0
	if !needStatus && !needResetEnd {
		return
	}

	_, err := configs.UpdateWithRetry(func(c *configs.Config) error {
		cur, cerr := c.GetLiveRoomByUrl(rawURL)
		if cerr != nil || cur == nil || !cur.IsOneTime {
			return nil
		}
		if cur.OneTimeStatus == configs.OneTimeStatusWaitingFirstLive {
			cur.OneTimeStatus = configs.OneTimeStatusRecording
			applog.GetLogger().Infof("一次性录制：%s 首次开播，状态置为录制中", cur.Url)
		}
		// 本场已开播：清空上一场的停播计时，避免直播进行中被误判为"超时未开播"。
		if cur.OneTimeLastLiveEnd != 0 {
			cur.OneTimeLastLiveEnd = 0
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
	rawURL := l.GetRawUrl()

	// 同样先做内存比对：房间不存在、非一次性、或已处于终态时直接返回，
	// 完全跳过全量写盘（这些情况下 mutator 本来也不会改动任何字段）。
	cfg := configs.GetCurrentConfig()
	if cfg == nil {
		return
	}
	room, rerr := cfg.GetLiveRoomByUrl(rawURL)
	if rerr != nil || room == nil {
		// 同 handleLiveStart：停播时间写不进去会让倒计时永远不开始，必须留下痕迹。
		applog.GetLogger().Warnf("一次性录制：找不到直播间配置，跳过停播处理 url=%s err=%v", rawURL, rerr)
		return
	}
	if !room.IsOneTime {
		return
	}
	if room.OneTimeStatus == configs.OneTimeStatusPendingDelete {
		return
	}

	_, err := configs.UpdateWithRetry(func(c *configs.Config) error {
		cur, cerr := c.GetLiveRoomByUrl(rawURL)
		if cerr != nil || cur == nil || !cur.IsOneTime {
			return nil
		}
		// 已是终态则不再更新计时
		if cur.OneTimeStatus == configs.OneTimeStatusPendingDelete {
			return nil
		}
		// 兜底：有停播就说明本场开播确实发生过。状态若还停在 waiting_first_live
		// （典型场景：链接是在直播进行中添加/改为一次性的，"首次开播"事件早已过去且不会再补发），
		// 必须先提升为 recording —— 否则 checkOnce 会一直跳过它，
		// 该链接永远不会进入"待删除"、也就永远不会被自动清理。
		if cur.OneTimeStatus == configs.OneTimeStatusWaitingFirstLive {
			cur.OneTimeStatus = configs.OneTimeStatusRecording
			applog.GetLogger().Infof("一次性录制：%s 检测到停播但状态仍是「等待首次直播」，已修正为「一次性录制中」并开始计时", cur.Url)
		}
		cur.OneTimeLastLiveEnd = time.Now().Unix()
		if cur.OneTimeStatus == "" {
			// 兜底：一次性标记存在但状态缺失（例如手工编辑过配置文件）
			cur.OneTimeStatus = configs.OneTimeStatusRecording
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

// LiveRoomURLs 收集"当前正在直播"的房间原始 URL 集合。
//
// 判定取两层依据的并集（任一成立即视为在播）：
//   - 该 LiveId 上存在录制器（录制器只在直播中被创建）；
//   - 监听器缓存里的 Info.Status 为 true（软重启暂停期间录制器被停掉，
//     但缓存状态仍是"直播中"，这一层兜住）。
//
// 只读 inst.Lives / inst.Cache，不修改任何状态、不发起任何平台请求。
// 导出给 API 入口共用：添加/改为一次性录制时需要判断"是不是正在直播"。
func LiveRoomURLs(ctx context.Context) map[string]struct{} {
	urls := make(map[string]struct{})
	inst := instance.GetInstance(ctx)
	if inst == nil {
		return urls
	}
	mgr, _ := inst.RecorderManager.(Manager)
	inst.Lives.Range(func(id types.LiveID, l live.Live) bool {
		if l == nil {
			return true
		}
		if mgr != nil && mgr.HasRecorder(ctx, id) {
			urls[l.GetRawUrl()] = struct{}{}
			return true
		}
		if inst.Cache == nil {
			return true
		}
		if obj, err := inst.Cache.Get(l); err == nil && obj != nil {
			if info, ok := obj.(*live.Info); ok && info.Status {
				urls[l.GetRawUrl()] = struct{}{}
			}
		}
		return true
	})
	return urls
}

// collectLiveRoomURLs 包装 LiveRoomURLs，保留包内既有的方法调用形式。
func (m *OneTimeManager) collectLiveRoomURLs(ctx context.Context) map[string]struct{} {
	return LiveRoomURLs(ctx)
}

// EverLiveRoomURLs 收集"曾经开播过"的房间原始 URL 集合。
//
// 依据是监听对象上的 LastStartTime（应用启动时会由 livestate 从数据库恢复，
// 因此重启后依然有效）。用途：判断一个 waiting_first_live 的房间其实早已开播过 ——
// 典型场景是链接在直播进行中添加/改为一次性，那一刻的 LiveStart 事件不会再补发，
// 状态机就会永远停在"等待首次直播"（详见 checkOnce 的状态自愈）。
//
// 只读遍历，不发任何请求。
func EverLiveRoomURLs(ctx context.Context) map[string]struct{} {
	urls := make(map[string]struct{})
	inst := instance.GetInstance(ctx)
	if inst == nil {
		return urls
	}
	inst.Lives.Range(func(_ types.LiveID, l live.Live) bool {
		if l != nil && !l.GetLastStartTime().IsZero() {
			urls[l.GetRawUrl()] = struct{}{}
		}
		return true
	})
	return urls
}

// OneTimeLiveNowURLs 已移除：设置一次性标记时只需要判断"此刻是否正在直播"
// （见 LiveRoomURLs）；"曾经开播过"只用于状态自愈，且必须走 checkOnce 那条路径 ——
// 只有在那里才能在提升状态的同时补上停播时间、真正启动倒计时。
// 若在 API 入口把"曾经开播过"也当成 liveNow，会得到 recording + 停播时间 0 的组合，
// 房间会在超时判定里被永久跳过。

// oneTimeNeedsUpdate 在内存中判断是否存在需要写盘的一次性录制状态变化。
//
// 只读当前内存配置，不做任何写入。用于避免"没有任何变化也全量写盘"：
// 磁盘写失败（例如磁盘已满）时，周期性的空转写盘只会白白刷错误日志。
func oneTimeNeedsUpdate(
	cfg *configs.Config,
	global configs.OneTimeRecordConfig,
	now int64,
	liveURLs map[string]struct{},
	everLiveURLs map[string]struct{},
) bool {
	if cfg == nil {
		return false
	}
	for i := range cfg.LiveRooms {
		room := &cfg.LiveRooms[i]
		if !room.IsOneTime {
			continue
		}
		switch room.OneTimeStatus {
		case configs.OneTimeStatusWaitingFirstLive:
			// 需要自愈（见 checkOnce 的详细说明）：正在直播、曾经开播过、或已有停播时间时，
			// 必须写盘把状态推进到 recording，否则这个房间会被永久跳过。
			if _, live := liveURLs[room.Url]; live || room.OneTimeLastLiveEnd > 0 {
				return true
			}
			if _, ever := everLiveURLs[room.Url]; ever {
				return true
			}
		case configs.OneTimeStatusRecording:
			if room.OneTimeLastLiveEnd <= 0 {
				continue
			}
			// 正在直播的房间不会进入待删除，因此也不构成"需要写盘的变化"
			if _, live := liveURLs[room.Url]; live {
				continue
			}
			hours := room.EffectiveOneTimePendingDeleteHours(global)
			if now-room.OneTimeLastLiveEnd >= int64(hours)*3600 {
				return true
			}
		case configs.OneTimeStatusPendingDelete:
			if room.OneTimePendingDeleteAt <= 0 {
				// 数据异常需要补写标记时刻
				return true
			}
			days := room.EffectiveOneTimeDeleteLinkDays(global)
			if now-room.OneTimePendingDeleteAt >= int64(days)*86400 {
				return true
			}
		}
	}
	return false
}

// checkOnce 执行一次全量检查：
//  1. recording 且停播超时（且当前不在直播中）→ 标记 pending_delete
//  2. pending_delete 且超过删除延迟 → 从配置中删除链接（只删链接，不删文件）
func (m *OneTimeManager) checkOnce(ctx context.Context) {
	cfg := configs.GetCurrentConfig()
	if cfg == nil {
		return
	}
	global := cfg.OneTimeRecord
	now := time.Now().Unix()

	// 正在直播的房间集合：上一场的停播计时若跨过本场直播，会在直播进行中
	// 把房间误标为待删除（不可逆），因此这类房间必须排除在超时判定之外。
	liveURLs := m.collectLiveRoomURLs(ctx)
	// 曾经开播过的房间集合：仅用于"waiting_first_live 状态自愈"。
	// 不能和 liveURLs 混用 —— 后者会把房间排除在超时判定之外，混用会让
	// "曾经播过但早已停播"的房间永远不被标记待删除。
	everLiveURLs := EverLiveRoomURLs(ctx)

	// 先在内存中比对是否真的有字段变化（OneTimeStatus / OneTimeLastLiveEnd /
	// OneTimePendingDeleteAt）。没有任何变化就直接返回，完全不落盘 ——
	// 否则每 5 分钟一次的全量写盘在磁盘写失败（例如磁盘已满）时会白白刷错误日志，
	// 甚至拖慢 handleLiveStart/handleLiveEnd 真正需要落盘的状态变更。
	if !oneTimeNeedsUpdate(cfg, global, now, liveURLs, everLiveURLs) {
		return
	}

	var (
		newlyPending []string
		toDelete     []pendingDeletion
		healed       []string
	)

	_, err := configs.UpdateWithRetry(func(c *configs.Config) error {
		// mutator 可能被重试执行多次，必须重置收集切片
		newlyPending = newlyPending[:0]
		toDelete = toDelete[:0]
		healed = healed[:0]

		for i := range c.LiveRooms {
			room := &c.LiveRooms[i]
			if !room.IsOneTime {
				continue
			}
			// 状态自愈：waiting_first_live 的语义是"还没等到首次开播"，
			// 但下面两种情况其实已经开播过了，必须提升为 recording：
			//   1) 链接是在直播进行中添加/改为一次性的 —— 那一刻的 LiveStart
			//      早已发生且不会再补发，状态机就永远等不到"首次开播"；
			//   2) 已经记录到过停播时间（有停播必有开播）。
			// 不修正的话下面的 switch 会直接 continue 跳过它，
			// 结果是该链接永远不会被标记"待删除"、也永远不会被自动清理。
			if room.OneTimeStatus == configs.OneTimeStatusWaitingFirstLive {
				_, live := liveURLs[room.Url]
				_, everLive := everLiveURLs[room.Url]
				switch {
				case live:
					// 正在直播：本次直播还没结束，停播时间保持 0，
					// 倒计时交给 handleLiveEnd（本场真正结束时才开始）。
					room.OneTimeStatus = configs.OneTimeStatusRecording
					healed = append(healed, room.Url)
				case room.OneTimeLastLiveEnd > 0 || everLive:
					// 已经播过（且当前不在直播）或已有停播时间：补上停播时间并开始倒计时，
					// 否则这个房间会永远停在"等待首次直播"、链接永远不会被清理。
					room.OneTimeStatus = configs.OneTimeStatusRecording
					if room.OneTimeLastLiveEnd <= 0 {
						room.OneTimeLastLiveEnd = now
					}
					healed = append(healed, room.Url)
				default:
					// 确实从未开播：按用户确认的规则，不进入待删除，一直等待首次直播
					continue
				}
			}
			switch room.OneTimeStatus {
			case configs.OneTimeStatusWaitingFirstLive:
				// 从未开播：按用户确认的规则，不进入待删除，一直等待首次直播
				continue

			case configs.OneTimeStatusRecording:
				if room.OneTimeLastLiveEnd <= 0 {
					continue
				}
				// 当前正在直播的房间不参与"未开播超时"判定：
				// 否则「上次停播时刻 + N 小时」落在本场直播期间时会被误标为
				// pending_delete，且不可逆 —— 本场结束后即使立刻再开播也永不录制。
				if _, live := liveURLs[room.Url]; live {
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

	for _, url := range healed {
		applog.GetLogger().Infof("一次性录制：%s 状态自愈为「一次性录制中」（此前卡在「等待首次直播」但实际已开播过），倒计时将按其停播时间计算", url)
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
	// 必须显式 Close 掉 Live 对象：它的请求调度 goroutine 只有 Close 才能退出，
	// 否则每个被自动删除的房间都会永久泄漏一个（无等待者时每 100ms 空转的）goroutine。
	// 放在从 LiveMap 移除之前执行，保证此处拿到的仍然是同一个实例；
	// WrappedLive.Close 自身幂等（取消 context + 带保护的 close），重复调用不会 panic。
	if l != nil {
		l.Close()
	}
	inst.Lives.Delete(id)

	applog.GetLogger().Infof("一次性录制到期：已删除链接 %s（录制文件保留在磁盘上）", rawURL)
	if m.onRoomDeleted != nil {
		m.onRoomDeleted(id, rawURL)
	}
}
