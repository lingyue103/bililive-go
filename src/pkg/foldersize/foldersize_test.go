package foldersize

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeTestFile 在测试目录里造一个指定大小的文件
func writeTestFile(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0644); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
}

func TestHumanSize(t *testing.T) {
	cases := []struct {
		in   int64
		want string
	}{
		{0, "0"},
		{-1, "0"},
		{1, "1 B"},
		{1023, "1023 B"},
		{1024, "1 kB"},
		{1536, "1.5 kB"},
		{1024 * 1024, "1 MB"},
		{12 * 1024 * 1024 * 1024, "12 GB"},
		{13314398618, "12.4 GB"}, // 12.4 GiB
	}
	for _, c := range cases {
		if got := HumanSize(c.in); got != c.want {
			t.Errorf("HumanSize(%d) = %q, 期望 %q", c.in, got, c.want)
		}
	}
}

func TestNormalizeName(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"  主播甲  ", "主播甲"},
		{"-主播甲", "主播甲"},
		{".主播甲.", "主播甲"},
		{"_主播甲_", "主播甲"},
		{"主播甲-2", "主播甲"},
		{"主播甲.3", "主播甲"},
		{"主播甲 4", "主播甲"},
		{"主播甲-2-3", "主播甲"},
		{"主播 甲", "主播甲"},
		{"主播甲🔥", "主播甲"},
		{"🎤主播甲", "主播甲"},
		{"小缘233", "小缘233"}, // 数字是名字的一部分，不能当序号剥掉
		{"", ""},
	}
	for _, c := range cases {
		if got := normalizeName(c.in); got != c.want {
			t.Errorf("normalizeName(%q) = %q, 期望 %q", c.in, got, c.want)
		}
	}
}

// TestScanTreeAttributes 覆盖：两层结构、三层嵌套、噪音目录排除、递归内容
func TestScanTreeAttributes(t *testing.T) {
	root := t.TempDir()

	writeTestFile(t, filepath.Join(root, "抖音", "主播甲", "a.flv"), 100)
	// 群晖在每个主播目录里都会塞 @eaDir，必须排除，否则大小会虚高
	writeTestFile(t, filepath.Join(root, "抖音", "主播甲", "@eaDir", "thumb"), 4096)
	writeTestFile(t, filepath.Join(root, "抖音", "主播乙", "sub", "b.flv"), 200)
	// 历史遗留的三层嵌套
	writeTestFile(t, filepath.Join(root, "抖音1", "抖音", "主播丙", "c.flv"), 300)
	// 各种噪音
	writeTestFile(t, filepath.Join(root, "#recycle", "x.flv"), 5000)
	writeTestFile(t, filepath.Join(root, "Videos", "v.flv"), 7000)
	writeTestFile(t, filepath.Join(root, ".hidden", "h.flv"), 9000)
	writeTestFile(t, filepath.Join(root, ".appdata", "junk.bin"), 8000)
	// 根目录下的散落文件不参与统计
	writeTestFile(t, filepath.Join(root, "Emotion_Customized.zip"), 100)

	m := NewManager(root)
	m.SetRoomIndex(map[string][]string{
		"id-a": {"主播甲"},
		"id-b": {"主播乙"},
		"id-c": {"主播丙"},
	})

	sizes := m.Refresh(context.Background(), nil)
	if len(sizes) != 3 {
		t.Fatalf("应只归属 3 个直播间，实际 %v", sizes)
	}
	for id, want := range map[string]int64{"id-a": 100, "id-b": 200, "id-c": 300} {
		if got := sizes[id]; got != want {
			t.Errorf("%s 大小 = %d，期望 %d（噪音目录不应计入）", id, got, want)
		}
	}
	for _, id := range []string{"id-a", "id-b", "id-c"} {
		if ts := m.GetFirstSeenAt(id); ts <= 0 {
			t.Errorf("%s 应记录到目录时间，实际 %d", id, ts)
		}
	}
}

// TestMarkerFileWins 覆盖：标识文件优先于名字，且写入幂等
func TestMarkerFileWins(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "哔哩哔哩", "旧名字")
	writeTestFile(t, filepath.Join(dir, "a.flv"), 64)

	if err := WriteRoomIDFile(dir, "live-123", "https://live.bilibili.com/123"); err != nil {
		t.Fatalf("写入标识文件失败: %v", err)
	}
	marker := filepath.Join(dir, RoomIDFileName)
	info, err := os.Stat(marker)
	if err != nil {
		t.Fatalf("标识文件不存在: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0644 {
		t.Errorf("标识文件权限 = %o，期望 644", perm)
	}

	m := NewManager(root)
	// 候选名与目录名完全对不上，只能靠标识文件归属
	m.SetRoomIndex(map[string][]string{"live-123": {"新名字"}})
	sizes := m.Refresh(context.Background(), nil)
	if _, ok := sizes["live-123"]; !ok {
		t.Fatalf("应通过标识文件归属到 live-123，实际 %v", sizes)
	}
	if sizes["live-123"] < 64 {
		t.Errorf("大小应不少于 64，实际 %d", sizes["live-123"])
	}

	// 幂等：内容相同不重写
	time.Sleep(20 * time.Millisecond)
	if err := WriteRoomIDFile(dir, "live-123", "https://live.bilibili.com/123"); err != nil {
		t.Fatalf("重复写入标识文件失败: %v", err)
	}
	info2, err := os.Stat(marker)
	if err != nil {
		t.Fatalf("标识文件不存在: %v", err)
	}
	if !info.ModTime().Equal(info2.ModTime()) {
		t.Error("内容相同时不应重写标识文件")
	}

	// 内容变化时应重写
	if err := WriteRoomIDFile(dir, "live-123", "https://live.bilibili.com/456"); err != nil {
		t.Fatalf("更新标识文件失败: %v", err)
	}
	raw, err := os.ReadFile(marker)
	if err != nil {
		t.Fatalf("读取标识文件失败: %v", err)
	}
	want := "live-123\nhttps://live.bilibili.com/456\n"
	if string(raw) != want {
		t.Errorf("标识文件内容 = %q，期望 %q", string(raw), want)
	}
}

// TestLooseNameMatch 覆盖：目录名被 sanitize（前缀 -/.、emoji、序号后缀）后仍能匹配
func TestLooseNameMatch(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "抖音", "🎤主播甲-2", "a.flv"), 50)
	writeTestFile(t, filepath.Join(root, "抖音", ".主播乙", "b.flv"), 70)
	writeTestFile(t, filepath.Join(root, "抖音", "主播丙的直播间", "c.flv"), 90)

	m := NewManager(root)
	m.SetRoomIndex(map[string][]string{
		"id-a": {"主播甲"},
		"id-b": {"主播乙"},
		"id-c": {"主播丙"}, // 目录名更长，靠「互相包含」兜底
	})

	sizes := m.Refresh(context.Background(), nil)
	for id, want := range map[string]int64{"id-a": 50, "id-b": 70, "id-c": 90} {
		if got := sizes[id]; got != want {
			t.Errorf("%s 大小 = %d，期望 %d（宽松匹配失败）", id, got, want)
		}
	}
}

// TestRefreshWithIDs 覆盖：指定 ids 时只统计这批直播间
func TestRefreshWithIDs(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "抖音", "主播甲", "a.flv"), 100)
	writeTestFile(t, filepath.Join(root, "抖音", "主播乙", "b.flv"), 200)

	m := NewManager(root)
	m.SetRoomIndex(map[string][]string{
		"id-a": {"主播甲"},
		"id-b": {"主播乙"},
	})

	got := m.Refresh(context.Background(), []string{"id-a"})
	if len(got) != 1 || got["id-a"] != 100 {
		t.Fatalf("局部刷新结果 = %v，期望只含 id-a=100", got)
	}
	if _, ok := m.GetSize("id-b"); ok {
		t.Error("未被请求的直播间不应在这次扫描中被统计")
	}

	// 全量刷新后两个都在
	all := m.Refresh(context.Background(), nil)
	if all["id-a"] != 100 || all["id-b"] != 200 {
		t.Fatalf("全量刷新结果 = %v", all)
	}

	// 传入不存在的 id 不应影响已有数据
	unknown := m.Refresh(context.Background(), []string{"not-exist"})
	if len(unknown) != 0 {
		t.Errorf("未知 id 的刷新结果应为空，实际 %v", unknown)
	}
	if size, ok := m.GetSize("id-a"); !ok || size != 100 {
		t.Errorf("已有数据不应被局部刷新清掉，实际 %d/%v", size, ok)
	}
}

// TestRefreshHonorsCanceledContext 覆盖：ctx 已取消时立刻返回、且不破坏已有缓存
func TestRefreshHonorsCanceledContext(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "抖音", "主播甲", "a.flv"), 10)

	m := NewManager(root)
	m.SetRoomIndex(map[string][]string{"id-a": {"主播甲"}})
	if got := m.Refresh(context.Background(), nil); got["id-a"] != 10 {
		t.Fatalf("首次扫描结果 = %v", got)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got := m.Refresh(ctx, nil)
	if got["id-a"] != 10 {
		t.Errorf("ctx 取消时应返回已有缓存，实际 %v", got)
	}
}

// TestCachePersistedAcrossRestart 覆盖：缓存落盘 + 重启后免扫描直接可用
func TestCachePersistedAcrossRestart(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "抖音", "主播甲", "a.flv"), 4096)

	m := NewManager(root)
	m.SetRoomIndex(map[string][]string{"id-a": {"主播甲"}})
	m.Refresh(context.Background(), nil)
	firstSeen := m.GetFirstSeenAt("id-a")
	if firstSeen <= 0 {
		t.Fatalf("首次扫描应记录目录时间")
	}

	cachePath := filepath.Join(root, ".appdata", CacheFileName)
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("缓存文件未生成: %v", err)
	}

	// 模拟重启：新 Manager 直接可用，不需要先扫描
	restarted := NewManager(root)
	if size, ok := restarted.GetSize("id-a"); !ok || size != 4096 {
		t.Errorf("重启后应直接读到缓存大小，实际 %d/%v", size, ok)
	}
	if got := restarted.GetFirstSeenAt("id-a"); got != firstSeen {
		t.Errorf("重启后目录时间 = %d，期望 %d", got, firstSeen)
	}
}

// TestStartStop 覆盖：Start 不阻塞调用方、Stop 能正常收尾
func TestStartStop(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "抖音", "主播甲", "a.flv"), 128)

	m := NewManager(root)
	m.SetRoomIndex(map[string][]string{"id-a": {"主播甲"}})
	m.SetRoomIndex(map[string][]string{"id-a": {"主播甲"}}) // 重复设置应安全

	done := make(chan struct{})
	go func() {
		m.Start(context.Background())
		m.Start(context.Background()) // 重复 Start 应安全
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Start 不应阻塞调用方")
	}

	// 后台首次扫描是异步的，等一会儿再看结果
	deadline := time.Now().Add(3 * time.Second)
	for {
		if size, ok := m.GetSize("id-a"); ok && size == 128 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("后台首次扫描未产出结果")
		}
		time.Sleep(20 * time.Millisecond)
	}

	m.Stop()
	m.Stop() // 重复 Stop 应安全
}

// TestMissingOutputPath 覆盖：输出目录不存在时不动缓存、不 panic
func TestMissingOutputPath(t *testing.T) {
	root := filepath.Join(t.TempDir(), "not-exist")
	m := NewManager(root)
	m.SetRoomIndex(map[string][]string{"id-a": {"主播甲"}})
	if got := m.Refresh(context.Background(), nil); len(got) != 0 {
		t.Errorf("目录不存在时应返回空结果，实际 %v", got)
	}
}
