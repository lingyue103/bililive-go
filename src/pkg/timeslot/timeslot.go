// Package timeslot 提供「录制时间段」的解析、校验与命中判断（需求6）。
//
// 设计约束：
//   - 不支持跨天。如 22:00-次日02:00 属于非法配置，由配置校验层（Validate）拒绝；
//     需要覆盖凌晨时请拆成两条（例如 00:00-02:00 与 22:00-23:59）。
//   - 本包只回答"当前时间是否落在配置的时间段内"，不做任何录制决策。
//     调用方必须保证：时间段只控制"是否**开始**录制"，不中断进行中的录制。
//   - 本包不依赖 configs 包，避免形成循环导入。
package timeslot

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// TimeSlot 是配置中的一个录制时间段（外部形态，时间用 "HH:MM" 字符串）。
type TimeSlot struct {
	// Days 生效的星期，0=周日、1=周一 ... 6=周六；空切片表示每天
	Days []int `yaml:"days" json:"days"`
	// Start 开始时间，"HH:MM" 格式
	Start string `yaml:"start" json:"start"`
	// End 结束时间，"HH:MM" 格式
	End string `yaml:"end" json:"end"`
}

// Window 是编译后的时间段：时间已转成"当天分钟数"，便于快速比较。
type Window struct {
	// Days 生效的星期；空表示每天
	Days []int
	// Start 开始分钟数（0..1439）
	Start int
	// End 结束分钟数（0..1439）
	End int
}

// ParseHHMM 把 "HH:MM" 解析为当天的分钟数（0..1439）。
func ParseHHMM(s string) (int, error) {
	s = strings.TrimSpace(s)
	parts := strings.Split(s, ":")
	if len(parts) != 2 {
		return 0, fmt.Errorf("时间格式应为 HH:MM，实际为 %q", s)
	}
	h, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil || h < 0 || h > 23 {
		return 0, fmt.Errorf("小时部分无效: %q", parts[0])
	}
	m, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil || m < 0 || m > 59 {
		return 0, fmt.Errorf("分钟部分无效: %q", parts[1])
	}
	return h*60 + m, nil
}

// FormatMinutes 把当天分钟数格式化为 "HH:MM"（用于展示）。
func FormatMinutes(min int) string {
	if min < 0 {
		min = 0
	}
	min %= 24 * 60
	return fmt.Sprintf("%02d:%02d", min/60, min%60)
}

// Validate 校验一组时间段。owner 仅用于拼装错误信息（例如 "直播间 https://..."）。
// 校验项：时间格式合法、开始时间严格早于结束时间（即禁止跨天）、星期取值在 0..6。
func Validate(slots []TimeSlot, owner string) error {
	for i, s := range slots {
		start, err := ParseHHMM(s.Start)
		if err != nil {
			return fmt.Errorf("%s 第 %d 个时间段的开始时间无效: %v", owner, i+1, err)
		}
		end, err := ParseHHMM(s.End)
		if err != nil {
			return fmt.Errorf("%s 第 %d 个时间段的结束时间无效: %v", owner, i+1, err)
		}
		if start >= end {
			return fmt.Errorf(
				"%s 第 %d 个时间段 %s-%s 非法：开始时间必须早于结束时间（不支持跨天，如需覆盖凌晨请拆成两条）",
				owner, i+1, s.Start, s.End)
		}
		for _, d := range s.Days {
			if d < 0 || d > 6 {
				return fmt.Errorf("%s 第 %d 个时间段的星期取值 %d 无效（应为 0-6，0=周日）",
					owner, i+1, d)
			}
		}
	}
	return nil
}

// Compile 把配置形态编译成便于判断的 Window 列表。
// 非法项会被静默跳过（调用方应先用 Validate 把关，此处只做兜底）。
func Compile(slots []TimeSlot) []Window {
	if len(slots) == 0 {
		return nil
	}
	windows := make([]Window, 0, len(slots))
	for _, s := range slots {
		start, err1 := ParseHHMM(s.Start)
		end, err2 := ParseHHMM(s.End)
		if err1 != nil || err2 != nil || start >= end {
			continue
		}
		w := Window{Start: start, End: end}
		if len(s.Days) > 0 {
			w.Days = make([]int, len(s.Days))
			copy(w.Days, s.Days)
			sort.Ints(w.Days)
		}
		windows = append(windows, w)
	}
	if len(windows) == 0 {
		return nil
	}
	return windows
}

// IsActive 判断 now 是否落在任一时间段内。
// 区间语义为左闭右开 [Start, End)：例如 18:00-23:00 表示 23:00 整点已不再录制。
// windows 为空时返回 false —— 调用方在"未启用录制时间段"时应直接放行，不要调用本函数。
func IsActive(windows []Window, now time.Time) bool {
	if len(windows) == 0 {
		return false
	}
	weekday := int(now.Weekday()) // 0=Sunday
	cur := now.Hour()*60 + now.Minute()
	for _, w := range windows {
		if !dayMatches(w.Days, weekday) {
			continue
		}
		if cur >= w.Start && cur < w.End {
			return true
		}
	}
	return false
}

// Describe 把时间段列表转为人类可读的中文描述，用于前端/日志展示。
// 例如 "周一~周五 18:00-23:00；周六,周日 09:00-22:00"（相邻时间段会合并同类项）。
func Describe(slots []TimeSlot) string {
	if len(slots) == 0 {
		return ""
	}
	parts := make([]string, 0, len(slots))
	for _, s := range slots {
		parts = append(parts, fmt.Sprintf("%s %s-%s", DescribeDays(s.Days), s.Start, s.End))
	}
	return strings.Join(parts, "；")
}

// DescribeDays 把星期数组转为中文描述。
func DescribeDays(days []int) string {
	if len(days) == 0 {
		return "每天"
	}
	uniq := make(map[int]bool, len(days))
	for _, d := range days {
		if d >= 0 && d <= 6 {
			uniq[d] = true
		}
	}
	if len(uniq) == 7 {
		return "每天"
	}
	if len(uniq) == 5 && uniq[1] && uniq[2] && uniq[3] && uniq[4] && uniq[5] {
		return "工作日"
	}
	if len(uniq) == 2 && uniq[0] && uniq[6] {
		return "周末"
	}
	names := [7]string{"周日", "周一", "周二", "周三", "周四", "周五", "周六"}
	out := make([]string, 0, len(uniq))
	for d := 0; d <= 6; d++ {
		if uniq[d] {
			out = append(out, names[d])
		}
	}
	return strings.Join(out, ",")
}

// dayMatches 判断星期是否匹配；days 为空表示每天。
func dayMatches(days []int, weekday int) bool {
	if len(days) == 0 {
		return true
	}
	for _, d := range days {
		if d == weekday {
			return true
		}
	}
	return false
}
