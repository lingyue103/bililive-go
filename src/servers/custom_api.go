package servers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"github.com/gorilla/mux"

	"github.com/bililive-go/bililive-go/src/configs"
	"github.com/bililive-go/bililive-go/src/instance"
	"github.com/bililive-go/bililive-go/src/live"
	"github.com/bililive-go/bililive-go/src/recorders"
	applog "github.com/bililive-go/bililive-go/src/log"
	"github.com/bililive-go/bililive-go/src/pkg/foldersize"
	"github.com/bililive-go/bililive-go/src/pkg/utils"
	"github.com/bililive-go/bililive-go/src/types"
)

// ============================================================================
// 本文件承载定制版新增的 HTTP API（需求1 / 3 / 7）
//   POST /api/lives/batch-operation   批量删除/启停/切换一次性/配置录制时间段
//   POST /api/lives/{id}/one-time     切换一次性录制，或对"待删除"做挽留重置
//   POST /api/folder-size/refresh     手动刷新文件夹大小统计
// ============================================================================

// computeLiveIDByURL 按与 live/internal.genLiveId 相同的规则，从 URL 推导 LiveId。
// 用途：配置里的 LiveId 是不持久化的瞬时字段（yaml:"-"），进程刚启动或房间未初始化时为空，
// 此时只能用 URL 推导出的 hash 与前端传来的 id 做匹配。
func computeLiveIDByURL(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return utils.GetMd5String([]byte(parsed.Host + parsed.Path))
}

// findRoomByAnyID 在配置快照中按 id 查找直播间。
// 先按 LiveId 精确匹配，未命中时回退为"按 URL 推导的 hash"匹配。
func findRoomByAnyID(c *configs.Config, id string) *configs.LiveRoom {
	if c == nil || id == "" {
		return nil
	}
	for i := range c.LiveRooms {
		if string(c.LiveRooms[i].LiveId) == id {
			return &c.LiveRooms[i]
		}
	}
	for i := range c.LiveRooms {
		if computeLiveIDByURL(c.LiveRooms[i].Url) == id {
			return &c.LiveRooms[i]
		}
	}
	return nil
}

// findLiveByAnyID 在运行时 LiveMap 中按 id 查找直播间对象，同样带"URL hash"回退。
func findLiveByAnyID(inst *instance.Instance, id string) (live.Live, bool) {
	if l, ok := inst.Lives.Get(types.LiveID(id)); ok {
		return l, true
	}
	var found live.Live
	inst.Lives.Range(func(_ types.LiveID, l live.Live) bool {
		if computeLiveIDByURL(l.GetRawUrl()) == id {
			found = l
			return false
		}
		return true
	})
	if found == nil {
		return nil, false
	}
	return found, true
}

// ============================================================================
// 需求7：批量操作
// ============================================================================

// batchOperationRequest 批量操作请求体
type batchOperationRequest struct {
	// IDs 直播间 id 列表（LiveId 或 URL hash）
	IDs []string `json:"ids"`
	// Action 操作类型：
	//   start / stop          —— 开启 / 关闭监控（等价于 is_listening 开关）
	//   delete                —— 删除链接（不删文件）
	//   set_one_time          —— 转为一次性录制
	//   set_persistent        —— 转为持久性录制
	//   set_schedule          —— 应用 Schedule 中的录制时间段配置
	Action string `json:"action"`
	// Schedule 仅 action=set_schedule 时使用
	Schedule *configs.RecordSchedule `json:"schedule,omitempty"`
}

// batchOperationResult 单个直播间的操作结果
type batchOperationResult struct {
	ID      string `json:"id"`
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
}

// batchOperationHandler 处理 POST /api/lives/batch-operation
//
// 采用「同步逐项结果数组」范式（与 /api/batch/file/delete 一致）：
// 单条失败不影响其它条目，逐条回执给前端。
func batchOperationHandler(writer http.ResponseWriter, r *http.Request) {
	var req batchOperationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJsonWithStatusCode(writer, http.StatusBadRequest, commonResp{
			ErrNo:  http.StatusBadRequest,
			ErrMsg: "无效的请求体: " + err.Error(),
		})
		return
	}
	if len(req.IDs) == 0 {
		writeJsonWithStatusCode(writer, http.StatusBadRequest, commonResp{
			ErrNo:  http.StatusBadRequest,
			ErrMsg: "ids 不能为空",
		})
		return
	}

	inst := instance.GetInstance(r.Context())
	results := make([]batchOperationResult, 0, len(req.IDs))

	switch req.Action {
	case "set_one_time", "set_persistent", "set_schedule":
		// 纯配置类操作：一次事务改完所有房间，避免 N 次落盘
		action := req.Action
		schedule := req.Schedule
		if action == "set_schedule" && schedule == nil {
			writeJsonWithStatusCode(writer, http.StatusBadRequest, commonResp{
				ErrNo:  http.StatusBadRequest,
				ErrMsg: "action=set_schedule 时必须提供 schedule 参数",
			})
			return
		}
		_, err := configs.UpdateWithRetry(func(c *configs.Config) error {
			for _, id := range req.IDs {
				room := findRoomByAnyID(c, id)
				if room == nil {
					results = append(results, batchOperationResult{ID: id, Message: "未找到直播间"})
					continue
				}
				switch action {
				case "set_one_time":
					configs.ApplyOneTimeFlag(room, true)
				case "set_persistent":
					configs.ApplyOneTimeFlag(room, false)
				case "set_schedule":
					room.RecordSchedule = *schedule
				}
				results = append(results, batchOperationResult{ID: id, Success: true})
			}
			return nil
		}, 3, 10*time.Millisecond)
		if err != nil {
			writeJsonWithStatusCode(writer, http.StatusInternalServerError, commonResp{
				ErrNo:  http.StatusInternalServerError,
				ErrMsg: "批量更新配置失败: " + err.Error(),
			})
			return
		}

	case "start", "stop":
		listen := req.Action == "start"
		// 先落配置（is_listening），再操作运行时 listener
		_, err := configs.UpdateWithRetry(func(c *configs.Config) error {
			for _, id := range req.IDs {
				if room := findRoomByAnyID(c, id); room != nil {
					room.IsListening = listen
				}
			}
			return nil
		}, 3, 10*time.Millisecond)
		if err != nil {
			writeJsonWithStatusCode(writer, http.StatusInternalServerError, commonResp{
				ErrNo:  http.StatusInternalServerError,
				ErrMsg: "批量更新监听状态失败: " + err.Error(),
			})
			return
		}
		for _, id := range req.IDs {
			liveObj, ok := findLiveByAnyID(inst, id)
			if !ok {
				results = append(results, batchOperationResult{ID: id, Message: "未找到运行中的直播间"})
				continue
			}
			var opErr error
			if listen {
				opErr = startListening(inst.Ctx, liveObj)
			} else {
				opErr = stopListening(inst.Ctx, liveObj.GetLiveId())
			}
			if opErr != nil {
				results = append(results, batchOperationResult{ID: id, Message: opErr.Error()})
				continue
			}
			GetSSEHub().BroadcastListChange(liveObj.GetLiveId(), "listen_start", map[string]interface{}{
				"live_id": string(liveObj.GetLiveId()),
			})
			results = append(results, batchOperationResult{ID: id, Success: true})
		}

	case "delete":
		for _, id := range req.IDs {
			liveObj, ok := findLiveByAnyID(inst, id)
			if !ok {
				results = append(results, batchOperationResult{ID: id, Message: "未找到运行中的直播间"})
				continue
			}
			if err := removeLiveImpl(inst.Ctx, liveObj); err != nil {
				results = append(results, batchOperationResult{ID: id, Message: err.Error()})
				continue
			}
			results = append(results, batchOperationResult{ID: id, Success: true})
		}

	default:
		writeJsonWithStatusCode(writer, http.StatusBadRequest, commonResp{
			ErrNo:  http.StatusBadRequest,
			ErrMsg: "不支持的操作: " + req.Action,
		})
		return
	}

	writeJSON(writer, commonResp{Data: results})
}

// ============================================================================
// 需求1：一次性录制的切换与挽留
// ============================================================================

// setOneTimeRequest 一次性录制设置请求体
type setOneTimeRequest struct {
	// IsOneTime true=转为一次性录制，false=转为持久性录制
	IsOneTime bool `json:"is_one_time"`
	// Reset true=挽留操作：把"待删除"重置为"一次性录制中"并重新计时
	Reset bool `json:"reset"`
}

// setOneTimeHandler 处理 POST /api/lives/{id}/one-time
func setOneTimeHandler(writer http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	id := vars["id"]
	if id == "" {
		writeJsonWithStatusCode(writer, http.StatusBadRequest, commonResp{
			ErrNo:  http.StatusBadRequest,
			ErrMsg: "缺少直播间 id",
		})
		return
	}

	var req setOneTimeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJsonWithStatusCode(writer, http.StatusBadRequest, commonResp{
			ErrNo:  http.StatusBadRequest,
			ErrMsg: "无效的请求体: " + err.Error(),
		})
		return
	}

	_, err := configs.UpdateWithRetry(func(c *configs.Config) error {
		room := findRoomByAnyID(c, id)
		if room == nil {
			return fmt.Errorf("未找到直播间: %s", id)
		}
		if req.Reset {
			// 挽留：从"待删除"回到"一次性录制中"并重新计时
			configs.ResetOneTimeState(room)
			applog.GetLogger().Infof("一次性录制挽留：直播间 %s 已从待删除重置为一次性录制中", room.Url)
		} else {
			configs.ApplyOneTimeFlag(room, req.IsOneTime)
		}
		return nil
	}, 3, 10*time.Millisecond)
	if err != nil {
		writeJsonWithStatusCode(writer, http.StatusInternalServerError, commonResp{
			ErrNo:  http.StatusInternalServerError,
			ErrMsg: err.Error(),
		})
		return
	}

	inst := instance.GetInstance(r.Context())
	liveObj, ok := findLiveByAnyID(inst, id)
	if !ok {
		writeJSON(writer, commonResp{Data: "OK"})
		return
	}

	// 挽留后若该直播间正在直播且尚未录制，立即补上录制器
	// （待删除期间是"只提醒不录制"，重置后应恢复录制能力）
	if req.Reset {
		if obj, cerr := inst.Cache.Get(liveObj); cerr == nil && obj != nil {
			if info, iok := obj.(*live.Info); iok && info.Status {
				if mgr, mok := inst.RecorderManager.(recorders.Manager); mok {
					if !mgr.HasRecorder(inst.Ctx, liveObj.GetLiveId()) {
						if aerr := mgr.AddRecorder(inst.Ctx, liveObj); aerr != nil {
							liveObj.GetLogger().Warnf("挽留后自动开始录制失败: %v", aerr)
						}
					}
				}
			}
		}
	}

	writeJSON(writer, commonResp{Data: parseInfo(r.Context(), liveObj)})
}

// ============================================================================
// 需求3：文件夹大小手动刷新
// ============================================================================

// refreshFolderSizeRequest 手动刷新请求体
type refreshFolderSizeRequest struct {
	// IDs 只刷新指定直播间；为空表示全部刷新
	IDs []string `json:"ids"`
}

// refreshFolderSizeHandler 处理 POST /api/folder-size/refresh
//
// 注意：全量刷新需要遍历录制根目录下的所有主播文件夹（线上实测约 690 个），
// 属于重 IO 操作，因此给一个较宽松但有限的上限超时，并把 ctx 透传给扫描器以便及时中断。
func refreshFolderSizeHandler(writer http.ResponseWriter, r *http.Request) {
	var req refreshFolderSizeRequest
	// 请求体允许为空（表示刷新全部），因此解码失败不视为错误
	_ = json.NewDecoder(r.Body).Decode(&req)

	inst := instance.GetInstance(r.Context())
	mgr, ok := inst.FolderSizeManager.(*foldersize.Manager)
	if !ok || mgr == nil {
		writeJsonWithStatusCode(writer, http.StatusServiceUnavailable, commonResp{
			ErrNo:  http.StatusServiceUnavailable,
			ErrMsg: "文件夹大小统计尚未就绪",
		})
		return
	}

	// 顺手刷新"房间名索引"，让存量无标识目录也能按主播名匹配归属
	UpdateFolderSizeRoomIndex(inst, mgr)

	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()

	sizes := mgr.Refresh(ctx, req.IDs)
	writeJSON(writer, commonResp{Data: sizes})
}

// UpdateFolderSizeRoomIndex 把"live_id → 该直播间的主播名/房间名候选"同步给文件夹统计模块。
//
// 存量录制文件夹没有归属标识文件，只能按目录名匹配，因此扫描前必须先刷新这份索引
// （foldersize.Manager 的扫描 goroutine 会读取它）。
// 导出以便启动流程在直播间对象创建完成后立即调用一次。
func UpdateFolderSizeRoomIndex(inst *instance.Instance, mgr *foldersize.Manager) {
	if inst == nil || mgr == nil {
		return
	}
	cfg := configs.GetCurrentConfig()
	index := make(map[string][]string, 256)

	inst.Lives.Range(func(id types.LiveID, l live.Live) bool {
		names := make([]string, 0, 3)
		// 优先取运行时缓存的直播间信息（主播名/房间名）
		if obj, err := inst.Cache.Get(l); err == nil && obj != nil {
			if info, ok := obj.(*live.Info); ok {
				if info.HostName != "" {
					names = append(names, info.HostName)
				}
				if info.RoomName != "" {
					names = append(names, info.RoomName)
				}
			}
		}
		// 再补上配置里的昵称（用户可能手工指定过）
		if cfg != nil {
			if room, err := cfg.GetLiveRoomByUrl(l.GetRawUrl()); err == nil && room.NickName != "" {
				names = append(names, room.NickName)
			}
		}
		if len(names) > 0 {
			index[string(id)] = names
		}
		return true
	})

	mgr.SetRoomIndex(index)
}
