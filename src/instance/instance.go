package instance

import (
	"context"
	"sync"

	"github.com/bililive-go/bililive-go/src/interfaces"
	"github.com/bluele/gcache"
)

type Instance struct {
	Ctx              context.Context   // 应用级 context，不随 HTTP 请求结束而取消
	WaitGroup        sync.WaitGroup
	Lives            LiveMap
	Cache            gcache.Cache
	Server           interfaces.Module
	EventDispatcher  interfaces.Module
	ListenerManager  interfaces.Module
	RecorderManager  interfaces.Module
	PipelineManager  interfaces.Module // 后处理管道管理器
	LiveStateManager interface{}       // 直播间状态持久化管理器 (*livestate.Manager)
	LiveStateStore   interface{}       // 直播间状态存储 (livestate.Store)
	IOStatsModule    interfaces.Module // IO 统计模块 (*iostats.Module)

	// FolderSizeManager 录制文件夹大小统计管理器（*foldersize.Manager，需求3）。
	// 用 interface{} 承载以避免 instance 包反向依赖具体实现包，与 LiveStateManager 的做法一致。
	FolderSizeManager interface{}
}
