package servers

import (
	"net/http"

	"github.com/bililive-go/bililive-go/src/instance"
	"github.com/bililive-go/bililive-go/src/pkg/pause"
	"github.com/bililive-go/bililive-go/src/pkg/softrestart"
)

// ============================================================================
// 需求8：定时软重启的 HTTP API
//
//	GET  /api/soft-restart/status  查询状态（是否切断流量中、剩余时间、下次计划）
//	POST /api/soft-restart/now     立即执行一次软重启
//	POST /api/soft-restart/cancel  取消进行中的软重启，立刻恢复请求
//
// 说明：本轮只实现软重启（切断流量一段时间后恢复）。
// 硬重启（重启整个进程）在容器内不可用，未实现。
// ============================================================================

// getSoftRestartStatus 处理 GET /api/soft-restart/status
func getSoftRestartStatus(writer http.ResponseWriter, r *http.Request) {
	inst := instance.GetInstance(r.Context())
	if mgr, ok := inst.SoftRestartManager.(*softrestart.Manager); ok && mgr != nil {
		writeJSON(writer, commonResp{Data: mgr.Status()})
		return
	}
	// 管理器尚未就绪时回退为闸门状态，保证前端始终有数据可渲染
	snap := pause.Default().Snapshot()
	writeJSON(writer, commonResp{Data: softrestart.Status{
		Paused:           snap.Paused,
		RemainingSeconds: snap.RemainingSeconds,
		UntilAt:          snap.UntilAt,
		Reason:           snap.Reason,
	}})
}

// triggerSoftRestart 处理 POST /api/soft-restart/now
//
// 立即返回：整个恢复窗口可能长达数十分钟，不能让 HTTP 请求一直悬挂等它结束。
func triggerSoftRestart(writer http.ResponseWriter, r *http.Request) {
	inst := instance.GetInstance(r.Context())
	mgr, ok := inst.SoftRestartManager.(*softrestart.Manager)
	if !ok || mgr == nil {
		writeJsonWithStatusCode(writer, http.StatusServiceUnavailable, commonResp{
			ErrNo:  http.StatusServiceUnavailable,
			ErrMsg: "软重启管理器尚未就绪",
		})
		return
	}
	if mgr.Status().Running {
		writeJsonWithStatusCode(writer, http.StatusConflict, commonResp{
			ErrNo:  http.StatusConflict,
			ErrMsg: "已有软重启正在执行",
		})
		return
	}

	go mgr.SoftRestartNow("手动触发")

	// 回一份"已开始"的状态；remaining_seconds 可能还没来得及写入，
	// 前端可稍后再拉一次 status。
	writeJSON(writer, commonResp{Data: mgr.Status()})
}

// cancelSoftRestart 处理 POST /api/soft-restart/cancel
func cancelSoftRestart(writer http.ResponseWriter, r *http.Request) {
	inst := instance.GetInstance(r.Context())
	if mgr, ok := inst.SoftRestartManager.(*softrestart.Manager); ok && mgr != nil {
		canceled := mgr.Cancel()
		writeJSON(writer, commonResp{Data: map[string]interface{}{
			"canceled": canceled,
			"status":   mgr.Status(),
		}})
		return
	}
	// 管理器不可用时，直接放开闸门保证请求能恢复
	pause.Default().Resume()
	writeJSON(writer, commonResp{Data: "OK"})
}
