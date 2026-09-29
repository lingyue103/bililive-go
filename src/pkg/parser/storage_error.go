package parser

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
)

// ErrStorageFull 表示「写入目标存储空间不足」（磁盘写满、配额超限）。
//
// 为什么需要这个哨兵错误：上层 recorders 需要据此在磁盘写满时抑制重试风暴，
// 但下载器返回的错误未必带得上这个语义——
//   - native 解析器直接写文件，syscall 的 ENOSPC 会原样出现在 err.Error() 里，文本匹配即可；
//   - ffmpeg / bililive-recorder 的 stderr 只被写进日志，cmd.Wait() 返回的
//     *exec.ExitError 文本只有 "exit status 1"，不含任何磁盘关键词。
//
// 因此这两个解析器在观察到子进程输出里的存储不足文本后，必须把本哨兵错误包装进返回值，
// 让上层能用 errors.Is(err, parser.ErrStorageFull) 判定，而不是依赖错误文案。
var ErrStorageFull = errors.New("storage full")

// storageFullKeywords 判定「存储空间不足」的关键词（全部小写，比较时大小写不敏感）。
//
// 覆盖场景：
//   - Linux / macOS：ffmpeg 等程序打印的 "No space left on device"（ENOSPC）；
//   - Windows：ERROR_DISK_FULL / ERROR_HANDLE_DISK_FULL 的两种常见文案；
//   - 群晖等挂载点配额：Disk quota exceeded / quota exceeded；
//   - 其他程序自定义文案：not enough space / ENOSPC 字面量。
var storageFullKeywords = []string{
	"no space left on device",
	"disk quota exceeded",
	"quota exceeded",
	"there is not enough space on the disk",
	"not enough space",
	"enospc",
}

// IsStorageFullText 判断一段日志 / 错误文本是否表明存储空间不足（大小写不敏感）。
//
// 供各解析器在处理子进程输出时集中复用；判定关键词只在本文件维护一份。
func IsStorageFullText(s string) bool {
	if s == "" {
		return false
	}
	lower := strings.ToLower(s)
	for _, kw := range storageFullKeywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}

// storageMatchWindow 是跨两次 Write 拼接匹配的窗口大小（字节）。
// 取 256 字节：足以覆盖最长关键词（"there is not enough space on the disk"）被任意切断的情形。
const storageMatchWindow = 256

// StorageFullDetectingWriter 包装子进程输出目标：内容原样转发给 dst，
// 同时记录「输出里是否出现过存储不足文本」，供进程退出后判定退出原因。
//
// 为什么不用逐行匹配：子进程的输出分块完全由内核管道决定，一行可能被拆到多次 Write，
// 逐行匹配会漏判；这里用「上一次写入的尾部窗口 + 本次写入」拼接后再匹配，
// 既覆盖了跨 Write 切断，又不需要缓存整份输出。
//
// 并发说明：handler 由 os/exec 的输出拷贝 goroutine 调用，IsStorageFull 一般在
// cmd.Wait() 返回之后调用；os/exec 保证 Wait 返回前拷贝 goroutine 已结束（happens-before），
// 但这里仍用 atomic.Bool 保存标志，避免任何可见性疑问，也便于 race detector 检查。
type StorageFullDetectingWriter struct {
	dst     io.Writer
	found   atomic.Bool
	pending []byte
}

// NewStorageFullDetectingWriter 创建一个检测写入器；(dst 为 nil 时只做检测，丢弃内容)。
func NewStorageFullDetectingWriter(dst io.Writer) *StorageFullDetectingWriter {
	return &StorageFullDetectingWriter{dst: dst}
}

// Write 转发数据并做关键词检测；无论是否命中，都返回 dst 的写入结果。
func (w *StorageFullDetectingWriter) Write(p []byte) (int, error) {
	if len(p) > 0 && !w.found.Load() {
		// 拼接上一次写入的尾部，覆盖关键词被拆到两次 Write 的情况
		tail := append(append(make([]byte, 0, len(w.pending)+len(p)), w.pending...), p...)
		if IsStorageFullText(string(tail)) {
			w.found.Store(true)
		}
		// 只保留尾部窗口（限制长度，避免异常输出把内存撑大）
		if len(tail) > storageMatchWindow {
			tail = tail[len(tail)-storageMatchWindow:]
		}
		w.pending = append(w.pending[:0], tail...)
	}
	if w.dst == nil {
		return len(p), nil
	}
	return w.dst.Write(p)
}

// IsStorageFull 返回输出中是否出现过存储不足文本（进程退出后调用）。
func (w *StorageFullDetectingWriter) IsStorageFull() bool {
	return w.found.Load()
}

// StorageFullError 在检测到存储不足时包装出一个可被 errors.Is(err, ErrStorageFull) 判定的错误；
// 未检测到（或 err 为 nil）时原样返回 err。
//
// 保留原始 err 信息（如 "exit status 1"）便于日志排查，同时附上哨兵语义。
func StorageFullError(err error, detected bool) error {
	if err == nil || !detected {
		return err
	}
	return fmt.Errorf("%w: %v", ErrStorageFull, err)
}
