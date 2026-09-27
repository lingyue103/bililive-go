// Package pause 提供「全局暂停闸门」，用于实现需求8 的软重启。
//
// 软重启语义（已与用户确认）：
//   - 切断所有直播连接：停止录制器（断开已建立的下载连接），并且立即停止向平台发起请求 ——
//     **包括已经在途的请求**（Pause 会取消它们的 ctx，连接随之中断），不只是拦住新请求；
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
	"context"
	"io"
	"net/http"
	"sync"
	"time"
)

// Gate 是并发安全的暂停闸门。
type Gate struct {
	mu      sync.RWMutex
	started time.Time // 本次暂停的开始时刻（零值表示未暂停）
	until   time.Time // 本次暂停的结束时刻
	reason  string    // 暂停原因（用于日志与前端展示）

	// abortCh 是「当前代际」的掐断信号通道。
	//
	// 每次 Pause 都会先 close 它 —— 让所有已绑定该代际的在途 HTTP 请求立刻被取消 ——
	// 再创建一个新通道供后续请求绑定。这样软重启既能拦住新请求，
	// 也能**立即掐断已经在途的请求**，而不是等它们自然结束。
	abortCh chan struct{}
}

// NewGate 创建一个未暂停的闸门。
//
// 关键：这里就初始化 abortCh，而不是等到第一次 Pause 时才创建 ——
// 否则"第一次暂停之前"绑定的在途请求会绑定到 nil 通道，导致**第一次**软重启
// 掐不断它们（第二次才生效）。这个坑由 TestBindRequestAbortedOnPause 守住。
func NewGate() *Gate {
	return &Gate{abortCh: make(chan struct{})}
}

// Pause 从现在起暂停 d 时长。d <= 0 等价于立即恢复。
//
// 进入暂停的瞬间会 close 当前代际的掐断通道，使所有已绑定该代际的
// 在途 HTTP 请求立即被取消（连接被中断），实现"立即掐断"而非"等它自然结束"。
func (g *Gate) Pause(d time.Duration, reason string) {
	if d <= 0 {
		g.Resume()
		return
	}
	now := time.Now()
	g.mu.Lock()
	// 掐断在途请求：关闭当前代际通道，并开启新代际供恢复后的请求绑定
	if g.abortCh != nil {
		close(g.abortCh)
	}
	g.abortCh = make(chan struct{})
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

// BindRequest 把一个请求的 context 与本闸门绑定。
//
// 返回的 ctx 会在「下一次进入暂停」时被立即取消 —— 这就是"掐断在途请求"的实现：
// 软重启触发 → Pause 关闭当前代际通道 → 所有已绑定请求的 ctx 被取消 →
// HTTP 传输层随即中断连接，不再等待对端响应。
//
// 若本闸门从未进入过暂停，则等价于 context.WithCancel(parent)。
// 调用方必须调用返回的 cancel 以释放资源。
func (g *Gate) BindRequest(parent context.Context) (context.Context, context.CancelFunc) {
	if parent == nil {
		parent = context.Background()
	}
	g.mu.RLock()
	ch := g.abortCh
	g.mu.RUnlock()

	ctx, cancel := context.WithCancel(parent)
	if ch == nil {
		return ctx, cancel
	}
	// 每个在途请求一个等待 goroutine；请求结束（cancel 或父 ctx 取消）后自动退出，不会泄漏
	go func() {
		select {
		case <-ch:
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}

// cancelRoundTripper 是给 http.Client 用的「可掐断」传输层。
//
// 为什么选在这一层实现，而不是让每个平台实现都接收 context：
// live.Live.GetInfo() 的接口签名不接受 ctx，而平台实现有二十多个，
// 逐个改造既侵入又容易漏；但它们全部经由 BaseLive.RequestSession（基于 *http.Client）发请求，
// 因此在 Transport 这一层统一注入，可一次覆盖所有平台，对平台代码零侵入。
type cancelRoundTripper struct {
	base http.RoundTripper
}

func (t *cancelRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx, cancel := Default().BindRequest(req.Context())
	resp, err := t.base.RoundTrip(req.WithContext(ctx))
	if err != nil {
		// 请求本身失败，立即释放
		cancel()
		return nil, err
	}
	// 关键：**不能**在 RoundTrip 返回时就 cancel。
	// 调用方（http.Client 的使用者）是在 RoundTrip 返回**之后**才读取 resp.Body 的，
	// 此时若 ctx 已被取消，传输层会关闭连接，导致响应体读取失败 ——
	// 小体积 JSON 因为已进入缓冲区才侥幸正常，慢响应/大响应则会中断。
	// 因此把 cancel 推迟到 Body.Close()。
	resp.Body = &cancelOnCloseBody{ReadCloser: resp.Body, cancel: cancel}
	return resp, nil
}

// cancelOnCloseBody 在响应体关闭时释放闸门绑定的 context。
type cancelOnCloseBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *cancelOnCloseBody) Close() error {
	err := b.ReadCloser.Close()
	// context.CancelFunc 幂等，重复调用安全
	b.cancel()
	return err
}

// WrapTransport 用闸门包装一个 http.RoundTripper，
// 使其发出的所有请求都能被软重启「立即掐断」。base 为 nil 时使用 http.DefaultTransport。
func WrapTransport(base http.RoundTripper) http.RoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	return &cancelRoundTripper{base: base}
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
