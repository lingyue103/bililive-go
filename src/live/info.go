package live

import (
	"encoding/json"

	"github.com/bililive-go/bililive-go/src/types"
)

// AvailableStreamInfo 可用流信息（用于API展示）
type AvailableStreamInfo struct {
	Format      string  `json:"format"`                 // 格式: flv, hls, rtmp
	Quality     string  `json:"quality"`                // 清晰度标识: 1080p, 720p, 原画
	QualityName string  `json:"quality_name,omitempty"` // 清晰度汉字名称: 蓝光, 超清, 高清
	Description string  `json:"description,omitempty"`  // 平台提供的清晰度名称
	Width       int     `json:"width,omitempty"`        // 宽度
	Height      int     `json:"height,omitempty"`       // 高度
	Bitrate     int     `json:"bitrate,omitempty"`      // 码率 (kbps)
	FrameRate   float64 `json:"frame_rate,omitempty"`   // 帧率
	Codec       string  `json:"codec,omitempty"`        // 视频编码: h264, h265
	AudioCodec  string  `json:"audio_codec,omitempty"`  // 音频编码

	// 用于前端流选择的属性组合
	AttributesForStreamSelect map[string]string `json:"attributes_for_stream_select,omitempty"`
}

// QualityNameMap 分辨率到汉字名称的映射
var QualityNameMap = map[string]string{
	"原画":       "原画",
	"蓝光":       "蓝光",
	"超清":       "超清",
	"高清":       "高清",
	"流畅":       "流畅",
	"4K":       "4K",
	"1080p":    "蓝光",
	"1080":     "蓝光",
	"720p":     "超清",
	"720":      "超清",
	"480p":     "高清",
	"480":      "高清",
	"360p":     "流畅",
	"360":      "流畅",
	"original": "原画",
	"OD":       "原画",
}

// GetQualityName 获取清晰度的汉字名称
func GetQualityName(quality string) string {
	if name, ok := QualityNameMap[quality]; ok {
		return name
	}
	return quality
}

type Info struct {
	Live                 Live
	HostName, RoomName   string
	Status               bool // means isLiving, maybe better to rename it
	Listening, Recording bool
	RecordingPreparing   bool // 有 recorder 但尚未真正开始录制（重试中）
	Initializing         bool
	CustomLiveId         string
	AudioOnly            bool
	NotifyOnly           bool // 仅开播提醒模式
	// 最近一次 API 请求的错误信息（用于前端显示错误提示）
	LastError string
	// 可用流列表（最近一次获取的）
	AvailableStreams []*AvailableStreamInfo
	// 可用流更新时间
	AvailableStreamsUpdatedAt int64

	// ---------- 需求3：列表展示 ----------
	// AddedAt 添加链接的时间（unix 秒）
	AddedAt int64
	// FolderSize 该直播间所有历史文件夹（含改名产生的）总大小，单位字节
	FolderSize int64
	// FolderSizeHuman 文件夹大小的人类可读形式，如 "12.4 GB"
	FolderSizeHuman string

	// ---------- 需求1：一次性录制 ----------
	// OneTime 是否为一次性录制
	OneTime bool
	// OneTimeStatus 一次性录制状态：waiting_first_live / recording / pending_delete
	OneTimeStatus string
	// 以下时间信息由服务器按"生效阈值 + 状态"推导，供前端显示"当前处于什么阶段、还有多久"。
	// OneTimePendingDeleteHours 生效的"未开播阈值"（小时，含房间级覆盖）
	OneTimePendingDeleteHours int
	// OneTimeDeleteLinkDays 生效的"删链接延迟"（天，含房间级覆盖）
	OneTimeDeleteLinkDays int
	// OneTimeLastLiveEnd 最近一次停播时间（unix 秒，0=尚无停播记录）
	OneTimeLastLiveEnd int64
	// OneTimePendingDeleteAt 实际进入"待删除"的时刻（unix 秒，0=尚未进入）
	OneTimePendingDeleteAt int64
	// OneTimeMarkDeleteAt 预计进入"待删除"的时刻（unix 秒，0=无法推算，例如从未开播）
	OneTimeMarkDeleteAt int64
	// OneTimeDeleteAt 预计删除链接的时刻（unix 秒，0=无法推算）
	OneTimeDeleteAt int64
	// OneTimeRemainingSeconds 距离下一个节点的剩余秒数（负数表示已过期，0 表示无法推算）
	OneTimeRemainingSeconds int64
	// OneTimeNextStage 下一个节点：mark_delete（即将标记待删除）/ delete（即将删链接）
	OneTimeNextStage string

	// ---------- 需求6：录制时间段 ----------
	// ScheduleEnabled 是否配置并启用了录制时间段
	ScheduleEnabled bool
	// ScheduleActive 当前是否处于录制时段内（ScheduleEnabled 为 true 时才有意义）
	ScheduleActive bool
}

type InfoCookie struct {
	Platform_cn_name string
	Host             string
	Cookie           string
}

func (i *Info) MarshalJSON() ([]byte, error) {
	t := struct {
		Id                        types.LiveID           `json:"id"`
		LiveUrl                   string                 `json:"live_url"`
		PlatformCNName            string                 `json:"platform_cn_name"`
		HostName                  string                 `json:"host_name"`
		RoomName                  string                 `json:"room_name"`
		Status                    bool                   `json:"status"`
		Listening                 bool                   `json:"listening"`
		Recording                 bool                   `json:"recording"`
		RecordingPreparing        bool                   `json:"recording_preparing,omitempty"`
		Initializing              bool                   `json:"initializing"`
		LastStartTime             string                 `json:"last_start_time,omitempty"`
		LastStartTimeUnix         int64                  `json:"last_start_time_unix,omitempty"`
		AudioOnly                 bool                   `json:"audio_only"`
		NotifyOnly                bool                   `json:"notify_only"`
		NickName                  string                 `json:"nick_name"`
		LastError                 string                 `json:"last_error,omitempty"`
		AvailableStreams          []*AvailableStreamInfo `json:"available_streams,omitempty"`
		AvailableStreamsUpdatedAt int64                  `json:"available_streams_updated_at,omitempty"`
		// ---------- 需求3 ----------
		AddedAt         int64  `json:"added_at,omitempty"`
		FolderSize      int64  `json:"folder_size,omitempty"`
		FolderSizeHuman string `json:"folder_size_human,omitempty"`
		// ---------- 需求1 ----------
		OneTime       bool   `json:"one_time,omitempty"`
		OneTimeStatus string `json:"one_time_status,omitempty"`
		// ---------- 需求1：一次性录制的时间线（前端据此显示"还有多久"）----------
		OneTimePendingDeleteHours int    `json:"one_time_pending_delete_hours,omitempty"`
		OneTimeDeleteLinkDays     int    `json:"one_time_delete_link_days,omitempty"`
		OneTimeLastLiveEnd        int64  `json:"one_time_last_live_end,omitempty"`
		OneTimePendingDeleteAt    int64  `json:"one_time_pending_delete_at,omitempty"`
		OneTimeMarkDeleteAt       int64  `json:"one_time_mark_delete_at,omitempty"`
		OneTimeDeleteAt           int64  `json:"one_time_delete_at,omitempty"`
		OneTimeRemainingSeconds   int64  `json:"one_time_remaining_seconds,omitempty"`
		OneTimeNextStage          string `json:"one_time_next_stage,omitempty"`
		// ---------- 需求6 ----------
		ScheduleEnabled bool `json:"schedule_enabled,omitempty"`
		ScheduleActive  bool `json:"schedule_active,omitempty"`
	}{
		Id:                        i.Live.GetLiveId(),
		LiveUrl:                   i.Live.GetRawUrl(),
		PlatformCNName:            i.Live.GetPlatformCNName(),
		HostName:                  i.HostName,
		RoomName:                  i.RoomName,
		Status:                    i.Status,
		Listening:                 i.Listening,
		Recording:                 i.Recording,
		RecordingPreparing:        i.RecordingPreparing,
		Initializing:              i.Initializing,
		AudioOnly:                 i.AudioOnly,
		NotifyOnly:                i.NotifyOnly,
		NickName:                  i.Live.GetOptions().NickName,
		LastError:                 i.LastError,
		AvailableStreams:          i.AvailableStreams,
		AvailableStreamsUpdatedAt: i.AvailableStreamsUpdatedAt,
		AddedAt:                   i.AddedAt,
		FolderSize:                i.FolderSize,
		FolderSizeHuman:           i.FolderSizeHuman,
		OneTime:                   i.OneTime,
		OneTimeStatus:             i.OneTimeStatus,
		OneTimePendingDeleteHours: i.OneTimePendingDeleteHours,
		OneTimeDeleteLinkDays:     i.OneTimeDeleteLinkDays,
		OneTimeLastLiveEnd:        i.OneTimeLastLiveEnd,
		OneTimePendingDeleteAt:    i.OneTimePendingDeleteAt,
		OneTimeMarkDeleteAt:       i.OneTimeMarkDeleteAt,
		OneTimeDeleteAt:           i.OneTimeDeleteAt,
		OneTimeRemainingSeconds:   i.OneTimeRemainingSeconds,
		OneTimeNextStage:          i.OneTimeNextStage,
		ScheduleEnabled:           i.ScheduleEnabled,
		ScheduleActive:            i.ScheduleActive,
	}
	if !i.Live.GetLastStartTime().IsZero() {
		t.LastStartTime = i.Live.GetLastStartTime().Format("2006-01-02 15:04:05")
		t.LastStartTimeUnix = i.Live.GetLastStartTime().Unix()
	}
	return json.Marshal(t)
}
