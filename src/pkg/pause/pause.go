// Package pause 提供「全局暂停闸门」，用于实现需求8 的软重启。
//
// 软重启语义（已与用户确认）：
//   - 切断所有直播连接：停止录制器（断开已建立的下载连接），并且不再向平台发起任何请求；
//   - 等待可配置的时长后恢复，重新开始请求数据。
//
// 为什么用「闸门」而不是「销毁 listener/recorder 再重建」：
// 现有架构下销毁重建会踩四个坑 ——
//  1. listeners/recorders Manager 的 Close 不反注册事件监听，对同一 dispatcher 二次 Start 会重复注册；
//  2. Manager 的 WaitGroup 记账不对称（Start 条件 Add、Close 恒 Done），特定路径下会 panic；
//  3. 应用级 rootCtx 一旦 cancel 不可复用；
//  4. WrappedLive.startScheduler 用了 sync.Once，Live 对象 Close 过就无法重新开始轮询。
//
// 闸门方案不改动任何对象的生命周期，只在「发起请求之前」拦一道，
// 恢复后既有轮询循环会自动继续，天然规避上述全部问题。
package pause

import (
	"sync"
	"time"
)

// Gate 是并发安全的暂停闸门。
type Gate struct {
	mu      sync.RWMutex
	started time.Time // 本次暂停的开始时刻（零值表示未暂停）
	until   time.Time // 本次暂停的结束时刻
	reason  string    // 暂停原因（用于日志与前端展示）
}

// NewGate 创建一个未暂停的闸门。
func NewGate() *Gate {
	return &Gate{}
}

// Pause 从现在起暂停 d 时长。d <= 0 等价于立即恢复。
func (g *Gate) Pause(d time.Duration, reason string) {
	if d <= 0 {
		g.Resume()
		return
	}
	now := time.Now()
	g.mu.Lock()
	g.started = now
	g.until = now.Add(d)
	g.reason = reason
	g.mu.Unlock()
}

// PauseUntil 暂停到指定时刻。t 已过则立即恢复。
func (g *Gate) PauseUntil(t time.Time, reason string) {
	g.Pause(time.Until(t), reason)
}

// Resume 立即结束暂停。
func (g *Gate) Resume() {
	g.mu.Lock()
	g.started = time.Time{}
	g.until = time.Time{}
	g.reason = ""
	g.mu.Unlock()
}

// Remaining 返回剩余暂停时长；未暂停或已到期返回 0。
func (g *Gate) Remaining() time.Duration {
	g.mu.RLock()
	until := g.until
	g.mu.RUnlock()
	if until.IsZero() {
		return 0
	}
	if d := time.Until(until); d > 0 {
		return d
	}
	return 0
}

// IsPaused 判断当前是否处于暂停中（已到期的暂停视为未暂停）。
func (g *Gate) IsPaused() bool {
	return g.Remaining() > 0
}

// Status 是闸门状态快照，供 HTTP API 下发给前端。
type Status struct {
	Paused           bool   `json:"paused"`
	Reason           string `json:"reason,omitempty"`
	StartedAt        int64  `json:"started_at,omitempty"` // unix 秒
	UntilAt          int64  `json:"until_at,omitempty"`   // unix 秒
	RemainingSeconds int64  `json:"remaining_seconds"`
}

// Snapshot 返回当前状态快照。
func (g *Gate) Snapshot() Status {
	g.mu.RLock()
	started, until, reason := g.started, g.until, g.reason
	g.mu.RUnlock()

	st := Status{Paused: false, Reason: reason}
	if until.IsZero() {
		return st
	}
	remaining := time.Until(until)
	if remaining <= 0 {
		return st
	}
	st.Paused = true
	st.RemainingSeconds = int64(remaining.Seconds())
	if !started.IsZero() {
		st.StartedAt = started.Unix()
	}
	st.UntilAt = until.Unix()
	return st
}

// defaultGate 是进程级默认闸门。
//
// 之所以提供包级单例：闸门的检查点位于 live 层的请求调度器内部，
// 那一层拿不到应用上下文（instance），逐层注入依赖会牵动大量构造函数签名；
// 而「全局暂停」本身就是进程级语义，用单例是自然且安全的。
var defaultGate = NewGate()

// Default 返回进程级默认闸门。
func Default() *Gate {
	return defaultGate
}
