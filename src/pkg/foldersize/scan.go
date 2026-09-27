package foldersize

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// errRootUnavailable 输出根目录当前不可读（不存在/未挂载）。
// 这种情况下必须保留上一次的缓存，绝不能把缓存清空。
var errRootUnavailable = errors.New("输出目录暂不可用")

// noiseDirNames 必须排除的噪音目录名（精确匹配）。
//
//   - @eaDir：群晖为每个目录生成的缩略图索引
//   - #recycle：群晖回收站
//   - .appdata：bililive-go 自己的应用数据目录（缓存/db 都在里面）
//   - Videos：群晖 Video Station 生成的目录
//
// 这些名字在任意层级都要排除：@eaDir 会出现在每个主播目录内部，
// 若不排除会显著虚高「文件夹大小」。
var noiseDirNames = map[string]bool{
	"@eaDir":   true,
	"#recycle": true,
	".appdata": true,
	"Videos":   true,
}

// isNoiseDirName 判断目录名是否属于必须排除的噪音目录
func isNoiseDirName(name string) bool {
	return noiseDirNames[name]
}

// isHiddenDirName 判断是否为以 "." 开头的隐藏目录（平台层排除）
func isHiddenDirName(name string) bool {
	return strings.HasPrefix(name, ".")
}

// dirCandidate 扫描过程中的一个目录候选（已过滤噪音）
type dirCandidate struct {
	name string // 目录名（不含父路径）
	path string // 完整路径
}

// scanResult 一次扫描的产物
type scanResult struct {
	// sizes live_id -> 该直播间所有归属目录的字节数之和
	sizes map[string]int64
	// firstSeen live_id -> 本次扫描观测到的最早目录时间（unix 秒）
	firstSeen map[string]int64
}

// scanTree 遍历 outputPath 下的两层结构并统计归属目录大小。
//
// 约定：第一层视为平台目录（如 抖音/），第二层视为主播目录（如 抖音/主播名/）。
// 同时兼容历史遗留的三层嵌套（如 抖音1/抖音/主播名/），判定方式见 scanLevelOne。
//
// idSet 为 nil 表示全量统计；非 nil 时只对这批 live_id 递归累加大小
// （仍然会识别其余目录的归属，只是不去算它们的大小，省掉绝大部分 IO）。
func (m *Manager) scanTree(ctx context.Context, roomIndex map[string][]string, idSet map[string]bool) (*scanResult, error) {
	res := &scanResult{
		sizes:     make(map[string]int64),
		firstSeen: make(map[string]int64),
	}
	if strings.TrimSpace(m.outputPath) == "" {
		return res, nil
	}

	// 第一层：平台目录。排除噪音目录与以 "." 开头的隐藏目录（.appdata、.DS_Store 之类）
	platforms, err := readSubDirs(m.outputPath, true)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("%w: %s", errRootUnavailable, m.outputPath)
		}
		return nil, fmt.Errorf("读取输出目录 %s 失败: %w", m.outputPath, err)
	}

	idx := buildNameIndex(roomIndex)
	for _, platform := range platforms {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := m.scanLevelOne(ctx, platform, idx, idSet, res); err != nil {
			return nil, err
		}
	}
	return res, nil
}

// scanLevelOne 处理一个第一层目录，它有两种可能：
//
//  1. 平台目录：子项就是主播目录（绝大多数情况）；
//  2. 历史遗留的嵌套包裹层（如 抖音1/，里面只有 抖音/，再往下才是主播目录）。
//
// 判定方式（不猜名字，只看结构与调用方给的候选名）：
// 先把直接子目录当作主播目录识别归属；只要识别出至少一个归属，就认为它是平台目录。
// 一个都识别不出来时，向下多探一层：把子目录当作平台目录、把子子目录当作主播目录。
//
// 注意：归属识别（matched）只看候选名与标识文件，与 idSet 无关，
// 这样「全量刷新」与「指定 ids 刷新」走到的目录集合是一致的，结果可复现。
func (m *Manager) scanLevelOne(ctx context.Context, platform dirCandidate, idx *nameIndex, idSet map[string]bool, res *scanResult) error {
	subs, err := readSubDirs(platform.path, false)
	if err != nil || len(subs) == 0 {
		// 单个平台目录读不到（权限/被删）不应让整次扫描失败
		return nil
	}

	matched := 0
	for _, sub := range subs {
		if err := ctx.Err(); err != nil {
			return err
		}
		owner := resolveOwner(sub.path, sub.name, idx)
		if owner == "" {
			continue
		}
		matched++
		if idSet != nil && !idSet[owner] {
			// 能识别归属，但不属于本次请求的 ids：跳过大小计算
			continue
		}
		if err := m.accumulate(ctx, owner, sub, res); err != nil {
			return err
		}
	}
	if matched > 0 {
		return nil
	}

	// 一个归属都没识别出来：可能是嵌套包裹层，向下多探一层。
	//
	// 需求里描述的条件是「本层只有目录、且子目录结构与平台目录相似」。实测包裹层里
	// 可能混有散落文件（例如解压出来的压缩包），若严格要求「只有目录」，整个嵌套分支
	// 会被直接漏掉；而下探本身只比对目录名，不做大小计算，代价很低（多几次 ReadDir）。
	// 因此这里只保留结构性判据：某个子目录里「还有子目录」，即结构与平台目录相似。
	for _, sub := range subs {
		if err := ctx.Err(); err != nil {
			return err
		}
		subSubs, readErr := readSubDirs(sub.path, false)
		if readErr != nil || len(subSubs) == 0 {
			continue
		}
		for _, ss := range subSubs {
			if err := ctx.Err(); err != nil {
				return err
			}
			owner := resolveOwner(ss.path, ss.name, idx)
			if owner == "" {
				continue
			}
			if idSet != nil && !idSet[owner] {
				continue
			}
			if err := m.accumulate(ctx, owner, ss, res); err != nil {
				return err
			}
		}
	}
	return nil
}

// accumulate 递归累加目录内所有文件大小，并把它归属到 liveID。
//
// 同一 live_id 可能有多个历史目录（改名产生），大小累加、时间取最早。
func (m *Manager) accumulate(ctx context.Context, liveID string, dir dirCandidate, res *scanResult) error {
	size, err := dirSize(ctx, dir.path)
	if err != nil {
		return err
	}
	res.sizes[liveID] += size

	// 目录 ModTime 作为「这个目录什么时候开始有的」的观测值。
	// 目录里增删文件都会刷新 ModTime，所以取最早一次观测到的最小值。
	if info, statErr := os.Stat(dir.path); statErr == nil {
		if ts := info.ModTime().Unix(); ts > 0 {
			if old, ok := res.firstSeen[liveID]; !ok || ts < old {
				res.firstSeen[liveID] = ts
			}
		}
	}
	return nil
}

// readSubDirs 读取目录下「非噪音」的直接子目录（普通文件一律忽略）。
//
// skipHidden 为 true 时同时跳过以 "." 开头的隐藏目录：只用在第一层（平台层）。
// 第二层（主播层）不跳过点开头目录——实测存在文件名 sanitize 后以 "-"、"." 开头的主播目录，
// 直接跳过会漏归属；这类目录只有靠标识文件或候选名匹配上归属后才会被统计，
// 所以噪音目录（.appdata 等在噪音名单里）依然不会混进来。
func readSubDirs(dir string, skipHidden bool) ([]dirCandidate, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]dirCandidate, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if isNoiseDirName(name) {
			continue
		}
		if skipHidden && isHiddenDirName(name) {
			continue
		}
		out = append(out, dirCandidate{name: name, path: filepath.Join(dir, name)})
	}
	return out, nil
}

// dirSize 递归累加目录下所有普通文件的大小。
//
//   - 跳过噪音目录（@eaDir / #recycle / .appdata / Videos），任意层级都跳；
//   - 跳过符号链接与其他非常规文件：filepath.WalkDir 本身不跟随符号链接，
//     这里再显式只统计普通文件，避免统计环或重复计算；
//   - 每遍历一个条目检查一次 ctx，保证几百 GB 的大目录也能被及时取消。
func dirSize(ctx context.Context, dir string) (int64, error) {
	var total int64
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// 单个条目读不到（权限、扫描过程中被删）不应让整次扫描失败
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		if d.IsDir() {
			if path != dir && isNoiseDirName(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil // 符号链接、设备文件、管道等一律跳过
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return nil
		}
		total += info.Size()
		return nil
	})
	if err != nil {
		return 0, err
	}
	return total, nil
}
