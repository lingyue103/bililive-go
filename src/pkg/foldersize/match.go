package foldersize

import (
	"regexp"
	"sort"
	"strings"
	"unicode"
)

// trailingSeqRe 匹配结尾的「分隔符 + 纯数字」后缀，例如 "主播名-2"、"_3"、".4"、" 5"。
// 录制器为防止重名会在目录名后追加这类序号；要求前面必须有分隔符，
// 这样 "小缘233"（数字本身就是名字的一部分）不会被误伤。
// 分隔符里显式包含全角空格 U+3000 —— Go 正则的 \s 只覆盖 ASCII 空白，
// 而中文目录名里全角空格很常见。
var trailingSeqRe = regexp.MustCompile(`[\s\x{3000}\-._]+\d+$`)

// nameIndex 是「主播名 -> live_id」的反查索引，由调用方通过 SetRoomIndex 传入的候选列表构建。
type nameIndex struct {
	// exact 规范化名 -> live_id
	exact map[string]string
	// lower 小写规范化名 -> live_id（ASCII 大小写容错）
	lower map[string]string
	// all 全部候选（规范化名 + live_id），按名字长度降序，用于「互相包含」兜底匹配
	all []namePair
}

// namePair 一条候选名记录
type namePair struct {
	norm   string // 规范化后的候选名
	liveID string
}

// buildNameIndex 由「live_id -> 主播名候选列表」构建反查索引。
// 同一个名字对应多个直播间时，取 live_id 字典序最小者，保证结果稳定可复现。
func buildNameIndex(roomIndex map[string][]string) *nameIndex {
	idx := &nameIndex{
		exact: make(map[string]string, len(roomIndex)),
		lower: make(map[string]string, len(roomIndex)),
	}
	if len(roomIndex) == 0 {
		return idx
	}

	ids := make([]string, 0, len(roomIndex))
	for id := range roomIndex {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	seen := make(map[string]bool)
	for _, id := range ids {
		for _, name := range roomIndex[id] {
			norm := normalizeName(name)
			if norm == "" {
				continue
			}
			if seen[id+"\x00"+norm] {
				continue
			}
			seen[id+"\x00"+norm] = true

			lower := strings.ToLower(norm)
			if _, ok := idx.exact[norm]; !ok {
				idx.exact[norm] = id
			}
			if _, ok := idx.lower[lower]; !ok {
				idx.lower[lower] = id
			}
			idx.all = append(idx.all, namePair{norm: norm, liveID: id})
		}
	}

	// 长度降序：包含匹配时优先命中更长的候选名，减少短名误配
	sort.SliceStable(idx.all, func(i, j int) bool {
		return len([]rune(idx.all[i].norm)) > len([]rune(idx.all[j].norm))
	})
	return idx
}

// normalizeName 把主播名 / 目录名规范化，用于「宽松且容错」的名字匹配：
//
//   - 去掉所有空白、控制字符、零宽字符（"主播 名" 与 "主播名" 视为同名）；
//   - 去掉 emoji 等符号与变体选择符（目录名常带 emoji，候选名往往没有）；
//   - 去掉首尾的 "-"、"."、"_"（文件名校验/sanitize 的常见产物）；
//   - 反复剥掉结尾的「分隔符 + 数字」序号后缀（"主播名-2" -> "主播名"）；
//   - 其余字符一律保留，不做小写化（小写容错在索引层单独处理，避免过度合并）。
func normalizeName(s string) string {
	if s == "" {
		return ""
	}

	// 第一步必须先把结尾的「分隔符 + 数字」序号剥掉，且**早于**删除空白。
	// 反例：目录名 "主播甲 4"，若先删空白会压成 "主播甲4"，分隔符消失后
	// 就再也识别不出这是序号后缀，导致 "主播甲 4" 无法匹配到 "主播甲"。
	pre := strings.Trim(s, "-._")
	for i := 0; i < 4; i++ {
		trimmed := strings.Trim(trailingSeqRe.ReplaceAllString(pre, ""), "-._")
		if trimmed == pre {
			break
		}
		pre = trimmed
	}

	var b strings.Builder
	b.Grow(len(pre))
	for _, r := range pre {
		switch {
		case unicode.IsSpace(r), unicode.IsControl(r), unicode.Is(unicode.Cf, r):
			continue // 空白 / 控制字符 / 格式字符（U+200D 零宽连接符等）
		case unicode.Is(unicode.So, r), unicode.Is(unicode.Sk, r), unicode.Is(unicode.Co, r):
			continue // emoji、修饰符号、私用区字符
		case r >= 0xFE00 && r <= 0xFE0F:
			continue // 变体选择符（emoji 后面的 U+FE0F）
		default:
			b.WriteRune(r)
		}
	}

	return strings.Trim(b.String(), "-._")
}

// resolveOwner 判定一个候选主播目录归属于哪个 live_id。
//
// 优先级（与需求一致）：
//  1. 标识文件优先：目录下 .bililive-room-id 的第一行就是 live_id（录制时写入，最可靠）；
//  2. 存量目录按名兜底：目录名与调用方给的候选名做宽松匹配——
//     先「规范化后精确匹配」，再「小写精确匹配」，最后「互相包含」兜底
//     （目录名可能被 sanitize、被截断、带 emoji 或额外后缀）。
//
// 都不命中时返回空字符串，表示这个目录不属于任何已知直播间。
func resolveOwner(dir, name string, idx *nameIndex) string {
	if id := readRoomIDFile(dir); id != "" {
		return id
	}
	if idx == nil {
		return ""
	}

	norm := normalizeName(name)
	if norm == "" {
		return ""
	}
	if id, ok := idx.exact[norm]; ok {
		return id
	}
	if id, ok := idx.lower[strings.ToLower(norm)]; ok {
		return id
	}

	// 兜底：互相包含。短于 2 个字符的名字不参与包含匹配，避免把噪音目录误配成主播目录。
	// idx.all 已按名字长度降序排列，第一个命中的就是「最长候选名」。
	normLen := len([]rune(norm))
	if normLen < 2 {
		return ""
	}
	for _, p := range idx.all {
		if len([]rune(p.norm)) < 2 {
			continue
		}
		if strings.Contains(norm, p.norm) || strings.Contains(p.norm, norm) {
			return p.liveID
		}
	}
	return ""
}
