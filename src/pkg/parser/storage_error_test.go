package parser

import (
	"bytes"
	"errors"
	"io"
	"testing"
)

func TestIsStorageFullText(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"[error] av_interleaved_write_frame(): No space left on device", true},
		{"NO SPACE LEFT ON DEVICE", true},
		{"Disk quota exceeded", true},
		{"[ERROR] There is not enough space on the disk.", true},
		{"write error: not enough space", true},
		{"error while writing: ENOSPC", true},
		{"Connection reset by peer", false},
		{"", false},
	}
	for _, c := range cases {
		if got := IsStorageFullText(c.in); got != c.want {
			t.Errorf("IsStorageFullText(%q) = %v, 期望 %v", c.in, got, c.want)
		}
	}
}

// TestStorageFullDetectingWriter 覆盖：内容原样透传、命中即置位、跨 Write 切断也能命中
func TestStorageFullDetectingWriter(t *testing.T) {
	t.Run("原样透传且命中", func(t *testing.T) {
		var sink bytes.Buffer
		w := NewStorageFullDetectingWriter(&sink)
		msg := "ffmpeg: No space left on device\n"
		n, err := w.Write([]byte(msg))
		if err != nil || n != len(msg) {
			t.Fatalf("Write 返回 %d/%v", n, err)
		}
		if sink.String() != msg {
			t.Errorf("透传内容 = %q, 期望 %q", sink.String(), msg)
		}
		if !w.IsStorageFull() {
			t.Error("应检测到存储不足")
		}
	})

	t.Run("关键字被拆到两次 Write", func(t *testing.T) {
		w := NewStorageFullDetectingWriter(io.Discard)
		w.Write([]byte("[error] No space left on"))
		if w.IsStorageFull() {
			t.Fatal("第一次写入不应该命中")
		}
		w.Write([]byte(" device\n"))
		if !w.IsStorageFull() {
			t.Error("拼接后应命中跨 Write 的关键词")
		}
	})

	t.Run("无关输出不误判", func(t *testing.T) {
		w := NewStorageFullDetectingWriter(io.Discard)
		for i := 0; i < 100; i++ {
			w.Write([]byte("frame=100 fps=30 size=1024kB time=00:00:10.00 bitrate=800kbits/s\n"))
		}
		if w.IsStorageFull() {
			t.Error("正常进度输出不应被判定为存储不足")
		}
	})

	t.Run("dst 为 nil 时只检测不写入", func(t *testing.T) {
		w := NewStorageFullDetectingWriter(nil)
		if n, err := w.Write([]byte("No space left on device")); err != nil || n != 23 {
			t.Fatalf("Write 返回 %d/%v", n, err)
		}
		if !w.IsStorageFull() {
			t.Error("dst 为 nil 时仍应检测")
		}
	})
}

// TestStorageFullError 覆盖：包装后可被 errors.Is 判定，且未命中/err 为 nil 时保持原样
func TestStorageFullError(t *testing.T) {
	orig := errors.New("exit status 1")

	if got := StorageFullError(orig, false); got != orig {
		t.Errorf("未命中时应原样返回，实际 %v", got)
	}
	if got := StorageFullError(nil, true); got != nil {
		t.Errorf("err 为 nil 时应返回 nil，实际 %v", got)
	}

	wrapped := StorageFullError(orig, true)
	if !errors.Is(wrapped, ErrStorageFull) {
		t.Error("命中时应能被 errors.Is(err, ErrStorageFull) 判定")
	}
	// 保留原始错误信息，便于日志排查
	if wrapped.Error() != "storage full: exit status 1" {
		t.Errorf("包装后的错误文本 = %q", wrapped.Error())
	}
}
