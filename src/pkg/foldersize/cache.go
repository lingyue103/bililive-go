package foldersize

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/sirupsen/logrus"
)

// cacheDoc 是 {outputPath}/.appdata/folder_size_cache.json 的 JSON 结构：
//
//	{
//	  "sizes":      { "<live_id>": 123456 },
//	  "first_seen": { "<live_id>": 1234567890 },
//	  "updated_at": 1234567890
//	}
type cacheDoc struct {
	// Sizes live_id -> 文件夹总大小（字节）
	Sizes map[string]int64 `json:"sizes"`
	// FirstSeen live_id -> 最早出现的录制目录时间（unix 秒），
	// 用于存量链接缺「添加链接时间」时的兜底显示
	FirstSeen map[string]int64 `json:"first_seen,omitempty"`
	// UpdatedAt 本次写入时间（unix 秒）
	UpdatedAt int64 `json:"updated_at"`
}

// loadCache 在 NewManager 中同步加载上一次的扫描结果。
//
// 缓存只是加速手段：文件不存在、解析失败都只降级为「空缓存」，不影响功能。
func (m *Manager) loadCache() {
	if m.cachePath == "" {
		return
	}

	data, err := os.ReadFile(m.cachePath)
	if err != nil {
		if !os.IsNotExist(err) {
			logrus.WithError(err).Warn("读取文件夹大小缓存失败，将从空缓存开始")
		}
		return
	}

	var doc cacheDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		logrus.WithError(err).Warn("解析文件夹大小缓存失败，将从空缓存开始")
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	for id, size := range doc.Sizes {
		if id != "" && size >= 0 {
			m.sizes[id] = size
		}
	}
	for id, ts := range doc.FirstSeen {
		if id != "" && ts > 0 {
			m.firstSeen[id] = ts
		}
	}

	logrus.WithFields(logrus.Fields{
		"sizes":      len(m.sizes),
		"first_seen": len(m.firstSeen),
		"updated_at": doc.UpdatedAt,
	}).Info("已加载文件夹大小缓存")
}

// saveCache 把当前结果原子写入缓存文件（temp + rename）。
//
// 目录不存在时自动创建（首次启动、.appdata 被清理过都能自愈）。
// 缓存写失败不影响功能，只记录 Warn，下次扫描还会再试。
func (m *Manager) saveCache(sizes, firstSeen map[string]int64) {
	if m.cachePath == "" {
		return
	}

	doc := cacheDoc{
		Sizes:     sizes,
		FirstSeen: firstSeen,
		UpdatedAt: time.Now().Unix(),
	}
	data, err := json.Marshal(doc)
	if err != nil {
		logrus.WithError(err).Warn("序列化文件夹大小缓存失败")
		return
	}

	dir := filepath.Dir(m.cachePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		logrus.WithError(err).Warn("创建文件夹大小缓存目录失败")
		return
	}

	tmp, err := os.CreateTemp(dir, ".folder_size_cache-*.tmp")
	if err != nil {
		logrus.WithError(err).Warn("创建文件夹大小缓存临时文件失败")
		return
	}
	tmpName := tmp.Name()

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		logrus.WithError(err).Warn("写入文件夹大小缓存失败")
		return
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		logrus.WithError(err).Warn("落盘文件夹大小缓存失败")
		return
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		logrus.WithError(err).Warn("关闭文件夹大小缓存失败")
		return
	}
	if err := os.Chmod(tmpName, 0644); err != nil {
		os.Remove(tmpName)
		logrus.WithError(err).Warn("设置文件夹大小缓存权限失败")
		return
	}
	if err := os.Rename(tmpName, m.cachePath); err != nil {
		os.Remove(tmpName)
		logrus.WithError(err).Warn("替换文件夹大小缓存失败")
	}
}
