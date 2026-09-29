package servers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/mux"

	"github.com/bililive-go/bililive-go/src/configs"
	"github.com/bililive-go/bililive-go/src/instance"
	"github.com/bililive-go/bililive-go/src/live"
	"github.com/bililive-go/bililive-go/src/livestate"
	"github.com/bililive-go/bililive-go/src/recorders"
	applog "github.com/bililive-go/bililive-go/src/log"
	"github.com/bililive-go/bililive-go/src/pkg/foldersize"
	"github.com/bililive-go/bililive-go/src/pkg/timeslot"
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
		// 【D11b】"转为持久性"前处于不录制状态（待删除 / 仅提醒）的房间，事务提交后需要补建录制器
		var promoteIDs []string
		_, err := configs.UpdateWithRetry(func(c *configs.Config) error {
			// mutator 可能因版本冲突被重试执行多次，收集切片必须重置，避免回执重复
			results = results[:0]
			promoteIDs = promoteIDs[:0]

			// 【D5】校验必须在任何写入之前完成，且校验失败整批不落盘：
			//   - 非法时间 / 跨天时段落盘后，下次启动 Config.Verify 失败 → os.Exit(1)，容器反复重启；
			//   - 悬空模板名会让 ResolveRecordSlots 返回 nil，录制被静默放行（前端还显示未启用）。
			if action == "set_schedule" {
				for _, id := range req.IDs {
					room := findRoomByAnyID(c, id)
					if room == nil {
						continue
					}
					if verr := validateRoomRecordSchedule(c, room.Url, *schedule); verr != nil {
						return newInvalidConfigError("%v", verr)
					}
				}
			}

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
					// 【D11b】待删除 / 仅提醒期间是"只提醒不录制"，转为持久性后必须立即补建录制器，
					// 否则要等到下一次开播才真正开录（单房间编辑路径就是这么补的）。
					if room.IsListening && (room.IsPendingDelete() || room.NotifyOnly) {
						promoteIDs = append(promoteIDs, id)
					}
					configs.ApplyOneTimeFlag(room, false)
				case "set_schedule":
					// 深拷贝时间段切片再赋值：配置走"复制-修改-原子替换"，与请求体共享底层数组
					// 会让旧快照被静默改写（Days 是内层切片，必须一并拷贝）。
					applied := *schedule
					applied.Slots = cloneTimeSlots(applied.Slots)
					room.RecordSchedule = applied
				}
				results = append(results, batchOperationResult{ID: id, Success: true})
			}
			return nil
		}, 3, 10*time.Millisecond)
		if err != nil {
			status := http.StatusInternalServerError
			msg := "批量更新配置失败: " + err.Error()
			if isInvalidConfigError(err) {
				status = http.StatusBadRequest
				msg = err.Error()
			}
			writeJsonWithStatusCode(writer, status, commonResp{
				ErrNo:  status,
				ErrMsg: msg,
			})
			return
		}

		// 事务提交之后再动运行时：正在直播且此前不录制的房间，转为持久性后立即补录
		for _, id := range promoteIDs {
			if liveObj, ok := findLiveByAnyID(inst, id); ok {
				autoStartRecordingIfLive(inst, liveObj, "转为持久性录制")
			}
		}

	case "start", "stop":
		listen := req.Action == "start"
		// 【D11c】顺序与单条（parseLiveAction）保持一致：先操作运行时，再落 is_listening 配置。
		// 反过来的话，运行时失败时磁盘上已经是 is_listening=true，必须重启才能纠正；
		// 单条失败只回执该条，不影响其它条目。
		//
		// 运行态没有该直播间（例如启动时初始化失败）时无运行时操作可做，仍沿用批量的既有能力：只同步配置。
		var succeeded []string
		for _, id := range req.IDs {
			liveObj, ok := findLiveByAnyID(inst, id)
			if !ok {
				room := findRoomByAnyID(configs.GetCurrentConfig(), id)
				if room == nil {
					results = append(results, batchOperationResult{ID: id, Message: "未找到直播间"})
					continue
				}
				succeeded = append(succeeded, room.Url)
				results = append(results, batchOperationResult{ID: id, Success: true})
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
			// 【D11a】stop 与单条保持一致：记录用户停止监控，结束 live_sessions 中仍开放的会话
			if !listen {
				if manager, mok := inst.LiveStateManager.(*livestate.Manager); mok && manager != nil {
					manager.OnUserStopMonitoring(string(liveObj.GetLiveId()))
				}
			}
			// 【D12】stop 必须广播 listen_stop（原实现无论开关都广播 listen_start）
			event := "listen_start"
			if !listen {
				event = "listen_stop"
			}
			GetSSEHub().BroadcastListChange(liveObj.GetLiveId(), event, map[string]interface{}{
				"live_id": string(liveObj.GetLiveId()),
			})
			succeeded = append(succeeded, liveObj.GetRawUrl())
			results = append(results, batchOperationResult{ID: id, Success: true})
		}
		// 运行时全部处理完之后再一次性落盘：既保证"先运行时后配置"的顺序，又避免 N 次写盘
		if len(succeeded) > 0 {
			if _, cerr := configs.UpdateWithRetry(func(c *configs.Config) error {
				for _, u := range succeeded {
					if room, rerr := c.GetLiveRoomByUrl(u); rerr == nil {
						room.IsListening = listen
					}
				}
				return nil
			}, 3, 10*time.Millisecond); cerr != nil {
				writeJsonWithStatusCode(writer, http.StatusInternalServerError, commonResp{
					ErrNo:  http.StatusInternalServerError,
					ErrMsg: "批量更新监听状态失败: " + cerr.Error(),
				})
				return
			}
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
// 需求6 / D5：录制时间段写入前的准入校验
// ============================================================================

// validateRoomRecordSchedule 校验即将写入某个直播间的录制时间段配置（需求6）。
//
// 为什么必须在 API 写入点做：校验原本只存在于 Config.Verify（启动与 PATCH /api/config），
// 而批量 set_schedule、单房间更新、设置明文页都会直接写盘，于是：
//   - 非法时间 / 跨天时段落盘后，下次启动 Verify 失败 → os.Exit(1)，容器反复重启；
//   - 模板名不存在时 ResolveRecordSlots 返回 nil，录制被静默放行（全天可录）且没有任何日志。
//
// 口径与 Config.validateRecordSchedules 一致，并额外堵住"启用了但解析不出任何时段"的静默全天可录。
// owner 仅用于拼装错误信息。
func validateRoomRecordSchedule(c *configs.Config, roomURL string, sched configs.RecordSchedule) error {
	if !sched.Enable {
		// 未启用时间段时不限制录制：字段里残留的草稿不生效，不做拒绝（允许用户先填后启用）
		return nil
	}
	if c == nil {
		return fmt.Errorf("配置尚未加载")
	}
	if name := strings.TrimSpace(sched.TemplateName); name != "" {
		// 必须与 ResolveRecordSlots 完全同口径地查模板：它拿 TrimSpace 后的模板名与模板的原始
		// Name 精确比较。若这里改用 TrimSpace 后的模板名匹配（Verify 的做法），模板名带空格时
		// 会出现"校验通过、运行时解析为空"的静默全天可录。
		for i := range c.RecordScheduleTemplates {
			if c.RecordScheduleTemplates[i].Name != name {
				continue
			}
			slots := c.RecordScheduleTemplates[i].Slots
			if len(slots) == 0 {
				return fmt.Errorf("直播间 %s 引用的录制时间段模板 %q 里没有任何时间段", roomURL, name)
			}
			return timeslot.Validate(slots, fmt.Sprintf("录制时间段模板 %q", name))
		}
		return fmt.Errorf("直播间 %s 引用了不存在的录制时间段模板: %s", roomURL, name)
	}
	// 未引用模板：必须自带合法且非空的时间段，否则 timeslot.Compile 得到空窗口，
	// 录制管理器把"没有时段限制"当成全天可录，前端却显示已启用。
	if len(sched.Slots) == 0 {
		return fmt.Errorf("直播间 %s 启用了录制时间段但没有配置任何时间段（也未引用模板），请至少添加一个时间段或指定模板，否则会全天录制", roomURL)
	}
	return timeslot.Validate(sched.Slots, "直播间 "+roomURL)
}

// cloneTimeSlots 深拷贝时间段切片（含 Days 内层切片），供 API 写入配置前隔离请求体与配置快照。
// 配置采用"复制-修改-原子替换"提交，共享底层数组会让旧快照被静默改写。
func cloneTimeSlots(src []timeslot.TimeSlot) []timeslot.TimeSlot {
	if src == nil {
		return nil
	}
	dst := make([]timeslot.TimeSlot, len(src))
	for i, s := range src {
		dst[i] = s
		if s.Days != nil {
			dst[i].Days = make([]int, len(s.Days))
			copy(dst[i].Days, s.Days)
		}
	}
	return dst
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
