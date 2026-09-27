package foldersize

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// maxRoomIDFileSize 读取标识文件时最多读取的字节数，防止标识文件被意外替换成大文件后读爆内存
const maxRoomIDFileSize = 4 << 10

// readRoomIDFile 读取目录下 .bililive-room-id 的第一行作为 live_id。
//
// 文件不存在、内容为空或读取失败都返回空字符串，调用方会退化为「按名字兜底匹配」。
func readRoomIDFile(dir string) string {
	f, err := os.Open(filepath.Join(dir, RoomIDFileName))
	if err != nil {
		return ""
	}
	defer f.Close()

	reader := bufio.NewReader(io.LimitReader(f, maxRoomIDFileSize))
	line, readErr := reader.ReadString('\n')
	if readErr != nil && line == "" {
		return ""
	}
	// 去掉可能存在的 UTF-8 BOM 与首尾空白
	line = strings.TrimPrefix(line, "\ufeff")
	return strings.TrimSpace(line)
}

// WriteRoomIDFile 在录制目录写入归属标识文件 .bililive-room-id：
// 第一行为 live_id，第二行为原始 URL，文件权限固定 0644。
//
// 录制器应在 mkdir 之后调用本函数，这样该目录之后无论改名成什么都能被正确归属。
//
//   - 幂等：目标文件内容已经完全一致时不重写，避免每次开播都产生一次磁盘写入；
//   - 原子：先写同目录临时文件再 rename，避免进程被杀时留下半截标识文件导致归属错乱；
//     若当前挂载点不支持 rename（跨设备、特殊文件系统），回退为原地覆盖写，
//     毕竟录制目录写不进去不该让录制本身失败。
func WriteRoomIDFile(folderPath, liveID, rawURL string) error {
	folderPath = strings.TrimSpace(folderPath)
	if folderPath == "" {
		return errors.New("录制目录为空，无法写入房间标识文件")
	}
	liveID = strings.TrimSpace(liveID)
	if liveID == "" {
		return errors.New("live_id 为空，无法写入房间标识文件")
	}

	if err := os.MkdirAll(folderPath, 0755); err != nil {
		return fmt.Errorf("创建录制目录失败: %w", err)
	}

	// 第一行 live_id、第二行原始 URL，都以换行结尾（读的时候只关心第一行）
	content := liveID + "\n" + strings.TrimRight(rawURL, "\r\n") + "\n"
	dst := filepath.Join(folderPath, RoomIDFileName)

	// 幂等：内容一致直接返回，不产生任何磁盘写入
	if old, err := os.ReadFile(dst); err == nil && string(old) == content {
		return nil
	}

	tmp, err := os.CreateTemp(folderPath, ".bililive-room-id-*.tmp")
	if err != nil {
		return writeRoomIDFileInPlace(dst, content)
	}
	tmpName := tmp.Name()

	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return fmt.Errorf("写入房间标识文件失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return fmt.Errorf("落盘房间标识文件失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("关闭房间标识文件失败: %w", err)
	}
	// CreateTemp 建出来的临时文件是 0600，改名前显式放宽到 0644
	if err := os.Chmod(tmpName, 0644); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("设置房间标识文件权限失败: %w", err)
	}
	if err := os.Rename(tmpName, dst); err != nil {
		os.Remove(tmpName)
		return writeRoomIDFileInPlace(dst, content)
	}
	return nil
}

// writeRoomIDFileInPlace 原地覆盖写标识文件，仅在原子替换不可用时回退使用。
func writeRoomIDFileInPlace(path, content string) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("创建房间标识文件失败: %w", err)
	}
	if _, err := f.WriteString(content); err != nil {
		f.Close()
		return fmt.Errorf("写入房间标识文件失败: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("落盘房间标识文件失败: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("关闭房间标识文件失败: %w", err)
	}
	// 已存在的文件不会被 OpenFile 的 perm 参数改动权限，需显式修正
	if err := os.Chmod(path, 0644); err != nil {
		return fmt.Errorf("设置房间标识文件权限失败: %w", err)
	}
	return nil
}
