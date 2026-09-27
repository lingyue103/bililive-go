package pause

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestBindRequestAbortedOnPause 验证 Pause 会立即取消「已绑定」的请求 ctx。
// 这是"掐断在途请求"的核心机制。
func TestBindRequestAbortedOnPause(t *testing.T) {
	g := NewGate()

	// 暂停之前先绑定一个请求（模拟已在途的请求）
	ctx, cancel := g.BindRequest(context.Background())
	defer cancel()

	// 未暂停时不应被取消
	select {
	case <-ctx.Done():
		t.Fatal("未暂停时 ctx 不应被取消")
	case <-time.After(50 * time.Millisecond):
	}

	g.Pause(time.Minute, "test")

	select {
	case <-ctx.Done():
		// 期望：已绑定的请求被立即掐断
	case <-time.After(time.Second):
		t.Fatal("Pause 后已绑定的 ctx 应立即被取消（掐断在途请求）")
	}

	// Resume 后新绑定的请求不应该再受上一次暂停影响
	g.Resume()
	ctx2, cancel2 := g.BindRequest(context.Background())
	defer cancel2()
	select {
	case <-ctx2.Done():
		t.Fatal("Resume 后新绑定的 ctx 不应被取消")
	case <-time.After(50 * time.Millisecond):
	}
}

// TestWrapTransportAbortsInflightRequest 验证传输层包装能真正中断「在途」的 HTTP 请求：
// 服务端故意不响应，Pause 之后客户端的请求应当迅速失败，而不是等到超时。
func TestWrapTransportAbortsInflightRequest(t *testing.T) {
	// 用独立的 gate 替换进程级默认闸门，让 WrapTransport 使用它
	g := NewGate()
	oldGate := defaultGate
	defaultGate = g
	defer func() { defaultGate = oldGate }()

	started := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-started:
		default:
			close(started)
		}
		// 故意长时间不响应，模拟"请求已发出但对端还没回"
		select {
		case <-r.Context().Done():
		case <-time.After(10 * time.Second):
		}
	}))
	defer srv.Close()

	client := &http.Client{Transport: WrapTransport(http.DefaultTransport)}

	errCh := make(chan error, 1)
	go func() {
		resp, err := client.Get(srv.URL)
		if resp != nil {
			_ = resp.Body.Close()
		}
		errCh <- err
	}()

	// 等请求真正发到服务端（确认它确实"在途"）
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("请求未能发出")
	}

	begin := time.Now()
	g.Pause(time.Minute, "test")

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("期望在途请求被中断，实际却成功返回")
		}
		elapsed := time.Since(begin)
		if elapsed > 2*time.Second {
			t.Fatalf("在途请求中断耗时过长: %v（应接近立即）", elapsed)
		}
		t.Logf("在途请求已被立即掐断：耗时 %v，错误=%v", elapsed, err)
	case <-time.After(5 * time.Second):
		t.Fatal("Pause 后 5 秒仍未中断在途请求")
	}
}

// TestWrapTransportKeepsBodyReadable 验证请求成功后，响应体在整个读取期间都可正常读取。
//
// 这是一个曾经存在的缺陷：若在 RoundTrip 返回时就直接 cancel，
// 调用方随后读取 resp.Body 会因 ctx 已取消而被传输层中断
// （小体积响应因为已进入缓冲区才侥幸正常，慢响应/大响应则会失败）。
func TestWrapTransportKeepsBodyReadable(t *testing.T) {
	g := NewGate()
	oldGate := defaultGate
	defaultGate = g
	defer func() { defaultGate = oldGate }()

	const payload = "hello-body-must-be-readable-0123456789abcdefghijklmnopqrstuvwxyz"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(payload))
	}))
	defer srv.Close()

	client := &http.Client{Transport: WrapTransport(http.DefaultTransport)}
	resp, err := client.Get(srv.URL)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取响应体失败（说明 ctx 被过早取消）: %v", err)
	}
	if string(body) != payload {
		t.Fatalf("响应体内容不符: got %q want %q", string(body), payload)
	}
}

// TestPauseExpiry 验证暂停到期后 IsPaused 自动变为 false
func TestPauseExpiry(t *testing.T) {
	g := NewGate()
	g.Pause(100*time.Millisecond, "test")
	if !g.IsPaused() {
		t.Fatal("刚 Pause 后 IsPaused 应为 true")
	}
	time.Sleep(150 * time.Millisecond)
	if g.IsPaused() {
		t.Fatal("暂停到期后 IsPaused 应为 false")
	}
	if g.Remaining() != 0 {
		t.Fatalf("到期后 Remaining 应为 0，实际 %v", g.Remaining())
	}
}
