# bililive-go 功能新增实现清单

> 基于 bililive-go master 分支代码分析，面向在其他电脑上自行实施的开发者。
> 项目结构：Go 后端 + React/TypeScript(Ant Design) 前端
> 仓库：https://github.com/lingyue103/bililive-go

---

## 项目关键文件索引

| 模块 | 文件路径 | 说明 |
|------|----------|------|
| 主入口 | `src/cmd/bililive/bililive.go` | 程序启动、组件初始化顺序 |
| 配置定义 | `src/configs/config.go` | `Config`/`LiveRoom`/`OverridableConfig` 等所有配置结构 |
| 配置注释 | `src/configs/config_comments.go` | 配置项的中文注释（前端设置页面展示用） |
| HTTP API | `src/servers/handler.go` | 所有 API handler（增删改查直播间、配置） |
| API 路由 | `src/servers/server.go` | 路由注册 |
| API 模型 | `src/servers/models.go` | 请求/响应结构体 |
| 录制器 | `src/recorders/recorder.go` | 录制核心逻辑、文件命名、后处理 |
| 录制管理 | `src/recorders/manager.go` | 录制器生命周期管理 |
| 录制事件 | `src/recorders/event.go` | 事件类型常量 |
| 监听器 | `src/listeners/listener.go` | 直播状态检测循环、开播/停播事件 |
| 监听管理 | `src/listeners/manager.go` | 监听器生命周期管理 |
| 监听事件 | `src/listeners/event.go` | 事件类型常量 |
| 直播信息 | `src/live/info.go` | `Info` 结构体（前端列表数据来源） |
| 直播工厂 | `src/live/lives.go` | `New()`/`NewInitializing()` 创建直播对象 |
| 平台注册 | `src/live/douyin/douyin.go` | 抖音平台（已注册 `live.douyin.com` 和 `v.douyin.com`） |
| 前端主列表 | `src/webapp/src/component/live-list/index.tsx` | 直播间列表表格、操作按钮 |
| 前端配置 | `src/webapp/src/component/config-info/index.tsx` | 设置页面 |
| 前端 API | `src/webapp/src/utils/api.ts` | 前端 API 封装 |

---

## 需求1：一次性录制功能

### 1.1 功能描述

- 添加录制链接时可选择"一次性录制"
- 已有链接也可被切换为一次性录制
- 一次性录制含义：正常录制，但停播后在设定时间（如3小时）内未再次开播 → 标记为"待删除"状态 → 再过设定时间（如7天）后删除链接（仅删链接不删文件）
- 设置中可配置默认是否勾选一次性录制
- 两个阈值（标记待删除超时、删除链接延迟）为全局配置，也可在单个链接覆盖

### 1.2 后端数据结构变更

**文件：`src/configs/config.go`**

1. `Config` 结构体（约 line 551）新增全局配置：

```go
// 一次性录制全局配置
OneTimeRecord struct {
    // 添加链接时是否默认勾选一次性录制
    DefaultOneTime bool `yaml:"default_one_time" json:"default_one_time"`
    // 停播后多少小时内未再开播则标记为待删除（默认3）
    PendingDeleteHours int `yaml:"pending_delete_hours" json:"pending_delete_hours"`
    // 标记待删除后多少天删除链接（默认7）
    DeleteLinkDays int `yaml:"delete_link_days" json:"delete_link_days"`
} `yaml:"one_time_record" json:"one_time_record"`
```

2. `LiveRoom` 结构体（约 line 940）新增字段：

```go
// 一次性录制
IsOneTime bool `yaml:"is_one_time,omitempty" json:"is_one_time,omitempty"`
// 一次性录制-停播后多少小时未再开播则标记待删除（0=用全局配置）
OneTimePendingDeleteHours int `yaml:"one_time_pending_delete_hours,omitempty" json:"one_time_pending_delete_hours,omitempty"`
// 一次性录制-标记待删除后多少天删除链接（0=用全局配置）
OneTimeDeleteLinkDays int `yaml:"one_time_delete_link_days,omitempty" json:"one_time_delete_link_days,omitempty"`
// 一次性录制状态：""=非一次性, "recording"=一次性录制中, "pending_delete"=待删除, "scheduled_delete"=已计划删除
OneTimeStatus string `yaml:"one_time_status,omitempty" json:"one_time_status,omitempty"`
// 最近一次直播结束时间（用于计算待删除超时）
OneTimeLastLiveEndTime time.Time `yaml:"-" json:"-"`
// 待删除标记时间（用于计算删除链接延迟）
OneTimePendingDeleteAt time.Time `yaml:"-" json:"-"`
```

3. `defaultConfig`（约 line 970）中设置默认值：

```go
OneTimeRecord: struct { ... }{
    DefaultOneTime:      false,
    PendingDeleteHours:  3,
    DeleteLinkDays:      7,
},
```

4. `Verify()` 方法中增加校验（PendingDeleteHours > 0, DeleteLinkDays > 0）

### 1.3 后端逻辑变更

**新增文件：`src/recorders/one_time_manager.go`**

创建一个一次性录制管理器，负责：
- 监听 `LiveEnd` 事件，记录停播时间
- 启动后台 goroutine 定时检查（建议每5分钟）：
  - 遍历所有 `OneTimeStatus == "recording"` 的直播间
  - 若 `time.Since(OneTimeLastLiveEndTime) > 阈值` → 标记为 `"pending_delete"`
  - 遍历所有 `OneTimeStatus == "pending_delete"` 的直播间
  - 若 `time.Since(OneTimePendingDeleteAt) > 删除延迟` → 调用删除链接逻辑（只删 config 中的 LiveRoom + 停止 listener，不删文件）
- 监听 `LiveStart` 事件，若直播间处于 `pending_delete` 状态则重置为 `recording`（因为又开播了，取消待删除）
- 在 `Config` 中持久化 `OneTimeStatus` 和时间字段

**文件：`src/listeners/listener.go`**

- `processInfo()` 中检测到 `LiveEnd` 事件时，若该直播间 `IsOneTime == true`：
  - 设置 `OneTimeLastLiveEndTime = time.Now()`
  - 设置 `OneTimeStatus = "recording"`（表示正在等待是否再次开播）
  - 持久化到 config

**文件：`src/cmd/bililive/bililive.go`**

- 在启动流程中初始化 `OneTimeManager` 并启动后台 goroutine
- 位置：在 listener manager 和 recorder manager 启动之后

**文件：`src/servers/handler.go`**

- `addLiveImpl()`（约 line 709）：读取全局 `DefaultOneTime` 配置，若为 true 则新链接 `IsOneTime = true`
- 新增 API `PATCH /api/config/rooms/{url}` 已有，确保能更新 `IsOneTime` 和 `OneTimeStatus` 字段
- 新增 API：`POST /api/rooms/{id}/set-one-time` 和 `POST /api/rooms/{id}/set-persistent`，用于切换一次性/持久性

### 1.4 前端变更

**文件：`src/webapp/src/component/live-list/index.tsx`**

- 表格新增状态标签显示：
  - `one_time_status == "recording"` → 显示蓝色标签"一次性录制中"
  - `one_time_status == "pending_delete"` → 显示橙色标签"待删除"
  - `one_time_status == "scheduled_delete"` → 显示红色标签"已计划删除"
- 操作列新增"切换为一次性/持久性"按钮

**文件：`src/webapp/src/component/config-info/index.tsx` 或 `shared-fields.tsx`**

- 设置页面新增"一次性录制"配置区域：
  - 开关：默认一次性录制
  - 数字输入：待删除超时（小时）
  - 数字输入：删除链接延迟（天）

**文件：`src/webapp/src/component/pop-dialog/index.tsx`（添加链接弹窗）**

- 新增"一次性录制"复选框，默认值取全局配置

**文件：`src/webapp/src/component/batch-add-room-dialog/index.tsx`**

- 同上，批量添加时也可选一次性录制

---

## 需求2：抖音分享链接提取

### 2.1 功能描述

添加链接时，用户可能粘贴抖音 App 的分享文本（包含描述文字+短链接），需从中提取出纯链接。

示例输入：
```
2- #在抖音，记录美好生活#【QwQ】正在直播，来和我一起支持Ta吧。复制下方链接，打开【抖音】，直接观看直播！ https://v.douyin.com/nuxAedcdFF8/ 1@3.com :2pm
```
正确提取：`https://v.douyin.com/nuxAedcdFF8/`

### 2.2 后端变更

**文件：`src/servers/handler.go`**

在 `addLiveImpl()` 函数（约 line 709）开头，URL 预处理阶段：

```go
// 在 "https://" 前缀补全之前，先尝试从分享文本中提取 URL
urlStr = extractDouyinShareURL(urlStr)
```

新增函数：

```go
// extractDouyinShareURL 从抖音分享文本中提取短链接
// 匹配 https://v.douyin.com/xxxxx/ 格式的链接
var douyinShareURLRegex = regexp.MustCompile(`https?://v\.douyin\.com/[A-Za-z0-9]+/`)

func extractDouyinShareURL(input string) string {
    input = strings.TrimSpace(input)
    // 如果本身就是纯 URL，直接返回
    if matched, _ := regexp.MatchString(`^https?://[^\s]+$`, input); matched {
        return input
    }
    // 从分享文本中提取
    matches := douyinShareURLRegex.FindString(input)
    if matches != "" {
        return matches
    }
    return input
}
```

同时也应用于批量添加的 `addLives()` 函数（约 line 689）中的 URL 处理。

### 2.3 前端变更（可选但推荐）

**文件：`src/webapp/src/component/pop-dialog/index.tsx`**
**文件：`src/webapp/src/component/batch-add-room-dialog/index.tsx`**

在前端输入框 onChange 或提交前也可做同样的正则提取，给用户即时反馈：

```typescript
const extractDouyinShareURL = (input: string): string => {
    const match = input.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9]+\//);
    return match ? match[0] : input.trim();
};
```

---

## 需求3：前端列表新增三列

### 3.1 功能描述

在直播间列表表格中，"主播名称"和"运行状态"之间新增三列：
1. **添加链接时间**：何时添加的链接。现存链接无此信息时，找录制文件夹的创建时间
2. **最近一次直播时间**：最近一次被监控到直播的时间
3. **文件夹大小**：该链接所创建的所有文件夹的总大小（含改名后新建的文件夹）

### 3.2 后端数据结构变更

**文件：`src/configs/config.go`**

`LiveRoom` 结构体新增：

```go
// 添加链接时间（首次添加时记录）
AddedAt time.Time `yaml:"added_at,omitempty" json:"added_at,omitempty"`
```

**文件：`src/live/info.go`**

`Info` 结构体新增字段，并在 `MarshalJSON` 中输出：

```go
AddedAt         time.Time `json:"added_at,omitempty"`          // 添加链接时间
LastLiveTime    time.Time `json:"last_live_time,omitempty"`    // 最近一次直播时间
FolderSize      int64     `json:"folder_size,omitempty"`       // 文件夹大小（字节）
FolderSizeHuman string    `json:"folder_size_human,omitempty"` // 文件夹大小（人类可读）
```

### 3.3 后端逻辑变更

**文件：`src/servers/handler.go`**

- `addLiveImpl()`（约 line 709）：创建新 LiveRoom 时设置 `AddedAt = time.Now()`
- `parseInfo()`（约 line 33）：
  - 从 config 的 LiveRoom 读取 `AddedAt` 赋值到 Info
  - 从 config 或 listener 状态读取 `LastLiveTime`

**文件：`src/listeners/listener.go`**

- `processInfo()` 中检测到 `LiveStart`（开播）时，记录 `LastLiveTime = time.Now()` 到 config 的 LiveRoom 中并持久化
- 或者在 `Live` 接口的 `SetLastStartTime()` 已有基础上扩展

**文件：`src/live/internal/base_live.go`**

- `BaseLive` 已有 `LastStartTime time.Time` 字段，可在 `SetLastStartTime()` 时同步写入 config

**新增文件：`src/pkg/foldersize/manager.go`**

文件夹大小计算与缓存管理器：

```go
// 方案：
// 1. 录制时在输出目录的直播间文件夹下写入 .bililive-room-id 标识文件
//    内容为 LiveId 或 URL（用于唯一标识归属）
// 2. 后台 goroutine 定期扫描输出目录（每5分钟），按标识文件匹配，
//    计算每个 LiveId 对应的所有文件夹大小，缓存到 map[LiveID]int64
// 3. 现存无标识文件的文件夹：按主播名匹配（遍历输出目录下的一级子目录，
//    用目录名中的主播名与当前 LiveRooms 的 HostName 做模糊匹配）
// 4. API 返回时从缓存读取，不实时计算
```

具体实现：

```go
package foldersize

type Manager struct {
    mu     sync.RWMutex
    sizes  map[types.LiveID]int64  // 缓存：LiveID -> 总大小
    outputPath string
    stopCh chan struct{}
}

func NewManager(outputPath string) *Manager { ... }

// Start 启动后台扫描 goroutine
func (m *Manager) Start(ctx context.Context) {
    ticker := time.NewTicker(5 * time.Minute)
    go func() {
        m.scan() // 首次立即扫描
        for {
            select {
            case <-ticker.C:
                m.scan()
            case <-m.stopCh:
                ticker.Stop()
                return
            }
        }
    }()
}

// scan 扫描输出目录，计算每个直播间的文件夹大小
func (m *Manager) scan() {
    // 1. 遍历 outputPath 下的二级目录结构
    //    结构：outputPath/平台名/主播名/录制文件...
    // 2. 检查每个主播名目录下是否有 .bililive-room-id 标识文件
    //    有则按 LiveId 归类，无则按目录名匹配 config 中的 HostName
    // 3. 递归计算目录大小（filepath.WalkDir + 累加文件 Size）
    // 4. 更新缓存
}

// GetSize 获取指定直播间的文件夹大小（从缓存）
func (m *Manager) GetSize(liveId types.LiveID) int64 { ... }

// WriteRoomIdFile 在录制文件夹下写入标识文件
func WriteRoomIdFile(folderPath string, liveId types.LiveID, url string) error {
    content := fmt.Sprintf("%s\n%s", liveId, url)
    return os.WriteFile(filepath.Join(folderPath, ".bililive-room-id"), []byte(content), 0644)
}
```

**文件：`src/recorders/recorder.go`**

- 录制开始创建输出目录后（约 line 440 `mkdir` 调用处），调用 `foldersize.WriteRoomIdFile()` 写入标识文件
- 位置：在 `outputPath` 目录创建之后

**文件：`src/cmd/bililive/bililive.go`**

- 启动流程中初始化 `foldersize.Manager` 并启动
- 位置：在 listener/recorder manager 启动之后
- 将 manager 实例存入 `instance` 供 handler 使用

**文件：`src/servers/handler.go`**

- `parseInfo()` 中从 `foldersize.Manager` 获取大小并填入 `Info.FolderSize`
- 转换为人类可读格式填入 `Info.FolderSizeHuman`（如 "1.85 GB"）

### 3.4 前端变更

**文件：`src/webapp/src/component/live-list/index.tsx`**

在表格 `columns` 数组中，"主播名称"列之后、"运行状态"列之前，新增三个列定义：

```typescript
{
    title: '添加链接时间',
    dataIndex: 'added_at',
    key: 'added_at',
    width: 160,
    render: (val: string) => val ? dayjs(val).format('YYYY-MM-DD HH:mm') : '-',
    sorter: (a, b) => new Date(a.added_at).getTime() - new Date(b.added_at).getTime(),
},
{
    title: '最近直播时间',
    dataIndex: 'last_live_time',
    key: 'last_live_time',
    width: 160,
    render: (val: string) => val ? dayjs(val).format('YYYY-MM-DD HH:mm') : '-',
    sorter: (a, b) => new Date(a.last_live_time).getTime() - new Date(b.last_live_time).getTime(),
},
{
    title: '文件夹大小',
    dataIndex: 'folder_size_human',
    key: 'folder_size',
    width: 100,
    render: (val: string) => val || '-',
    sorter: (a, b) => (a.folder_size || 0) - (b.folder_size || 0),
},
```

---

## 需求4：直播文件小文件合并

### 4.1 功能描述

当前逻辑：每次直播片段录制结束 → 立即转码后处理。

新增功能：片段结束后，在设定时间内（可配置）如果同一直播间再次开播并录制 → 等第二次也结束后 → 合并为一个文件 → 再统一转码后处理。

注意：如果再次开播时直播间名称变了，不适用合并，按正常处理。

### 4.2 后端数据结构变更

**文件：`src/configs/config.go`**

`Config` 或 `OverridableConfig` 新增：

```go
// 小文件合并配置
SegmentMerge struct {
    // 是否启用小文件合并
    Enable bool `yaml:"enable" json:"enable"`
    // 片段结束后等待多少分钟，超时内有新片段则合并（默认10）
    WaitMinutes int `yaml:"wait_minutes" json:"wait_minutes"`
} `yaml:"segment_merge" json:"segment_merge"`
```

### 4.3 后端逻辑变更

**文件：`src/recorders/recorder.go`**

这是改动最深的需求。当前录制结束流程（`record()` 函数返回后）大致为：

```
record() → recordEnd() → 调用后处理（pipeline 或 custom_commandline）
```

改造方案：

1. 在 `recordEnd()` 中，检查 `SegmentMerge.Enable`：
   - 若不启用 → 保持原逻辑，立即后处理
   - 若启用 → 不立即后处理，而是：
     - 将当前录制文件路径存入一个"待合并队列"（按 LiveId 分组）
     - 启动一个定时器 `WaitMinutes` 分钟
     - 定时器到期且期间无新录制 → 对队列中的文件执行后处理（单个文件直接处理，多个文件先合并再处理）
     - 期间有新录制完成 → 取消定时器，新文件也加入队列，重置定时器

2. 判断"名称是否变化"：
   - 比较 待合并队列中最后一个文件 和 新文件 的文件名中的 `{{ .RoomName }}` 部分
   - 若不同 → 不合并，将旧队列立即后处理，新文件单独进入新队列

**新增文件：`src/recorders/segment_merger.go`**

```go
package recorders

type pendingMerge struct {
    liveId    types.LiveID
    files     []string    // 待合并文件列表
    roomName  string      // 最近一次录制的房间名（用于判断名称是否变化）
    timer     *time.Timer // 等待定时器
    mu        sync.Mutex
}

type SegmentMerger struct {
    pending map[types.LiveID]*pendingMerge
    mu      sync.RWMutex
    config  *configs.SegmentMerge
}

// AddFile 添加一个录制完成的文件到待合并队列
// 返回 true 表示已加入队列（延迟后处理），false 表示应立即后处理
func (sm *SegmentMerger) AddFile(liveId types.LiveID, filePath string, roomName string) bool { ... }

// 合并实现：使用 ffmpeg concat demuxer
// ffmpeg -f concat -safe 0 -i list.txt -c copy output.flv
func mergeFiles(files []string, outputPath string) error { ... }
```

**文件：`src/recorders/manager.go`**

- 持有 `SegmentMerger` 实例
- 录制结束事件 `RecorderStop` 的处理中，将文件交给 `SegmentMerger` 而非直接后处理

### 4.4 前端变更

**文件：`src/webapp/src/component/config-info/shared-fields.tsx`**

设置页面新增"小文件合并"区域：
- 开关：启用小文件合并
- 数字输入：等待时间（分钟）

---

## 需求5：启动性能优化

### 5.1 功能描述

录制链接较多时启动缓慢。目标是前后端先起来，直播间数据慢慢加载，避免长时间打不开前端。

### 5.2 现状分析

代码中已有优化基础：
- `bililive.go` 中 HTTP 服务器已提前启动（约 line 515）
- 使用 `InitializingLive` 实现直播间快速创建（约 line 670）
- listener 的首次信息获取已放到后台 goroutine（`listener.go` line 65）

### 5.3 优化方向

**文件：`src/cmd/bililive/bililive.go`**

1. **分批启动 listener**（约 line 720 之后）：
   - 当前代码遍历所有 `LiveRooms` 创建 `InitializingLive` 后，批量启动 listener
   - 改为：将 listener 启动分批，每批 N 个（如20个），批次间间隔 1-2 秒
   - 避免几百个直播间同时对平台 API 发起请求

```go
// 分批启动 listener
batchSize := 20
for i := 0; i < len(listeningRooms); i += batchSize {
    end := i + batchSize
    if end > len(listeningRooms) {
        end = len(listeningRooms)
    }
    batch := listeningRooms[i:end]
    for _, l := range batch {
        // 启动 listener
    }
    if end < len(listeningRooms) {
        time.Sleep(2 * time.Second)
    }
}
```

2. **确保 HTTP 服务器在所有初始化之前启动**：
   - 当前已基本满足，但需确认 `servers.NewServer().Start()` 在 live rooms 初始化之前
   - 检查是否有阻塞操作在 HTTP 启动之前

**文件：`src/listeners/manager.go`**

3. **listener 启动加并发限制**：
   - `AddListener` 时使用带缓冲的 channel 或 semaphore 控制并发
   - 避免一次性启动太多 goroutine 同时请求平台 API

**文件：`src/webapp/src/component/live-list/index.tsx`**

4. **前端加载状态优化**：
   - 列表数据未返回时显示"加载中"骨架屏，而非空白
   - 利用现有 SSE 机制：直播间初始化完成后通过 SSE 推送更新，前端增量刷新
   - 已有 `Initializing: true` 状态，前端应显示"初始化中"标签

**文件：`src/configs/config.go`**

5. 可选：新增配置项控制分批大小：

```go
// 启动时分批初始化直播间的每批数量（0=不分批）
InitBatchSize int `yaml:"init_batch_size" json:"init_batch_size"`
```

---

## 需求6：录制时间段配置

### 6.1 功能描述

- 在直播间"操作"列新增"录制时间段"配置入口
- 只在配置的时间段内录制，其他时间段只监控不录制
- 时间段可指定星期几（周一、周末等）
- 不支持跨天（如 22:00-次日02:00 不行）
- 如果直播从录制时段一直持续到停止时间，不掐断，等自然结束
- 支持模板：预设时间段组合保存为模板，多个直播间复用
- "运行状态"列同步显示录制时间段状态（新增状态如"仅监控"）

### 6.2 后端数据结构变更

**文件：`src/configs/config.go`**

新增时间段相关结构：

```go
// 录制时间段
type RecordTimeSlot struct {
    // 星期几：0=周日, 1=周一, ..., 6=周六
    // 支持特殊值：7=工作日(1-5), 8=周末(0和6), 9=每天(0-6)
    DayOfWeek int    `yaml:"day_of_week" json:"day_of_week"`
    StartTime string `yaml:"start_time" json:"start_time"` // "HH:MM" 格式，如 "18:00"
    EndTime   string `yaml:"end_time" json:"end_time"`     // "HH:MM" 格式，如 "23:00"
}

// 录制时间段配置
type RecordSchedule struct {
    // 是否启用录制时间段
    Enable bool `yaml:"enable" json:"enable"`
    // 录制时间段列表
    Slots []RecordTimeSlot `yaml:"slots" json:"slots"`
    // 使用的模板名称（若使用模板则 slots 为空，从模板加载）
    TemplateName string `yaml:"template_name,omitempty" json:"template_name,omitempty"`
}

// 录制时间段模板
type RecordScheduleTemplate struct {
    Name  string           `yaml:"name" json:"name"`
    Slots []RecordTimeSlot `yaml:"slots" json:"slots"`
}
```

`Config` 结构体新增：

```go
// 录制时间段模板列表（全局）
RecordScheduleTemplates []RecordScheduleTemplate `yaml:"record_schedule_templates,omitempty" json:"record_schedule_templates,omitempty"`
```

`LiveRoom` 结构体新增：

```go
// 录制时间段配置
RecordSchedule RecordSchedule `yaml:"record_schedule,omitempty" json:"record_schedule,omitempty"`
```

### 6.3 后端逻辑变更

**新增文件：`src/pkg/schedule/checker.go`**

```go
package schedule

// IsInRecordTime 判断当前时间是否在录制时间段内
func IsInRecordTime(slots []RecordTimeSlot, now time.Time) bool {
    dayOfWeek := int(now.Weekday()) // 0=Sunday
    currentTime := now.Format("15:04")
    
    for _, slot := range slots {
        days := expandDays(slot.DayOfWeek) // 展开特殊值 7/8/9 为具体天数
        if contains(days, dayOfWeek) && currentTime >= slot.StartTime && currentTime < slot.EndTime {
            return true
        }
    }
    return false
}

// expandDays 展开星期特殊值
func expandDays(dayOfWeek int) []int {
    switch dayOfWeek {
    case 7: return []int{1, 2, 3, 4, 5}       // 工作日
    case 8: return []int{0, 6}                 // 周末
    case 9: return []int{0, 1, 2, 3, 4, 5, 6} // 每天
    default: return []int{dayOfWeek}
    }
}
```

**文件：`src/listeners/listener.go`**

- `processInfo()` 中检测到 `LiveStart`（开播事件）时：
  - 检查该直播间的 `RecordSchedule.Enable`
  - 若启用且当前不在录制时间段 → 只发通知不启动录制器
  - 若在录制时间段内 → 正常启动录制器

**文件：`src/recorders/manager.go`**

- `AddRecorder()` 或事件处理中，增加录制时间段判断：
  - 不在录制时间段 → 跳过录制器创建，标记为"仅监控"状态

**关键逻辑：不掐断正在进行的录制**

- 录制启动后，不因时间到了 EndTime 而停止录制
- 只在**下一次**开播时检查是否在录制时间段
- 即：时间段只控制"是否开始录制"，不控制"是否停止录制"

**文件：`src/servers/handler.go`**

- 新增 API：
  - `GET /api/schedule-templates` — 获取所有模板
  - `POST /api/schedule-templates` — 新增/更新模板
  - `DELETE /api/schedule-templates/{name}` — 删除模板
  - 现有 `PATCH /api/config/rooms/{url}` 可更新 `RecordSchedule` 字段

### 6.4 前端变更

**文件：`src/webapp/src/component/live-list/index.tsx`**

1. "运行状态"列新增状态标签：
   - 配置了录制时间段且当前不在录制时段 → 显示灰色标签"仅监控"
   
2. "操作"列新增"录制时间段"按钮，点击弹出配置弹窗

**新增文件：`src/webapp/src/component/record-schedule/index.tsx`**

录制时间段配置弹窗组件：

```tsx
// UI 布局：
// - 开关：启用录制时间段
// - 时间段列表（可增删）：
//   每行：星期选择器（下拉：周一~周日/工作日/周末/每天） + 开始时间(TimePicker) + 结束时间(TimePicker) + 删除按钮
// - 模板选择器（下拉，可选已有模板或"自定义"）
// - "保存为模板"按钮（输入模板名保存当前配置）
// - 保存按钮
```

**文件：`src/webapp/src/component/config-info/` (设置页面)**

- 新增"录制时间段模板管理"区域，可增删改查全局模板

---

## 需求7：直播间列表多选操作

### 7.1 功能描述

直播间列表支持多选，勾选后可批量执行：
- 多项删除
- 停止录制
- 启动录制
- 配置录制时间段
- 更改为一次性录制
- 更改为持久性录制

### 7.2 后端变更

**文件：`src/servers/handler.go`**

新增批量操作 API（或前端循环调用现有单个 API）：

```go
// 批量操作请求
type batchOperationRequest struct {
    IDs    []string `json:"ids"`
    Action string   `json:"action"` // "delete", "start", "stop", "set_one_time", "set_persistent"
}

// POST /api/batch-operation
func batchOperation(writer http.ResponseWriter, r *http.Request) {
    // 遍历 IDs 执行对应操作
}
```

**文件：`src/servers/server.go`**

注册路由：

```go
apiRoute.HandleFunc("/batch-operation", batchOperation).Methods("POST")
```

### 7.3 前端变更

**文件：`src/webapp/src/component/live-list/index.tsx`**

1. Table 组件添加 `rowSelection`：

```tsx
const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);

// Table 属性：
<Table
    rowSelection={{
        selectedRowKeys,
        onChange: setSelectedRowKeys,
    }}
    ...
/>
```

2. 选中后显示批量操作工具栏：

```tsx
{selectedRowKeys.length > 0 && (
    <Space style={{ marginBottom: 16 }}>
        <span>已选择 {selectedRowKeys.length} 项</span>
        <Button icon={<PlayCircleOutlined />} onClick={() => batchOp('start')}>启动录制</Button>
        <Button icon={<PauseCircleOutlined />} onClick={() => batchOp('stop')}>停止录制</Button>
        <Button icon={<DeleteOutlined />} onClick={() => batchOp('delete')}>删除</Button>
        <Button icon={<ClockCircleOutlined />} onClick={() => batchOp('schedule')}>配置录制时间段</Button>
        <Button onClick={() => batchOp('set_one_time')}>设为一次性</Button>
        <Button onClick={() => batchOp('set_persistent')}>设为持久性</Button>
        <Button type="link" onClick={() => setSelectedRowKeys([])}>取消选择</Button>
    </Space>
)}
```

3. "配置录制时间段"批量操作：弹出录制时间段配置弹窗，保存后应用到所有选中项

---

## 需求8：定时重启

### 8.1 功能描述

- 硬重启：彻底重启整个应用（非 Docker 环境可用，依赖 launcher）
- 软重启：切断录制请求（不发送流量到服务器），等待设定时间后恢复
- Docker 内只支持软重启
- 软重启时间为全局配置，如每天凌晨3点执行，3点10分恢复

### 8.2 后端数据结构变更

**文件：`src/configs/config.go`**

新增配置：

```go
// 定时重启配置
type AutoRestart struct {
    // 是否启用定时重启
    Enable bool `yaml:"enable" json:"enable"`
    // 重启类型："soft" 或 "hard"
    Type string `yaml:"type" json:"type"`
    // 执行时间 "HH:MM" 格式，如 "03:00"
    RestartTime string `yaml:"restart_time" json:"restart_time"`
    // 软重启后多少分钟恢复 "MM" 格式的分钟数，如 "10"
    RecoveryMinutes int `yaml:"recovery_minutes" json:"recovery_minutes"`
} `yaml:"auto_restart" json:"auto_restart"`
```

### 8.3 后端逻辑变更

**新增文件：`src/pkg/autorestart/manager.go`**

```go
package autorestart

type Manager struct {
    config   *configs.AutoRestart
    stopCh   chan struct{}
    isDocker bool
    // 软重启时需要停止/恢复的组件引用
    listenerMgr listeners.Manager
    recorderMgr recorders.Manager
}

func NewManager(cfg *configs.AutoRestart, lm listeners.Manager, rm recorders.Manager) *Manager { ... }

// IsDocker 检测是否运行在 Docker 内
func IsDocker() bool {
    // 检查 /.dockerenv 文件是否存在
    if _, err := os.Stat("/.dockerenv"); err == nil {
        return true
    }
    // 检查 cgroup
    if data, err := os.ReadFile("/proc/1/cgroup"); err == nil {
        if strings.Contains(string(data), "docker") || strings.Contains(string(data), "containerd") {
            return true
        }
    }
    return false
}

// Start 启动定时重启调度
func (m *Manager) Start(ctx context.Context) {
    if !m.config.Enable {
        return
    }
    go func() {
        for {
            now := time.Now()
            // 解析配置的重启时间
            restartTime := parseTimeToday(m.config.RestartTime, now)
            // 如果今天的重启时间已过，等到明天
            if now.After(restartTime) {
                restartTime = restartTime.Add(24 * time.Hour)
            }
            waitDuration := restartTime.Sub(now)
            select {
            case <-time.After(waitDuration):
                m.doRestart(ctx)
            case <-m.stopCh:
                return
            }
        }
    }()
}

// doRestart 执行重启
func (m *Manager) doRestart(ctx context.Context) {
    if m.config.Type == "hard" && !m.isDocker {
        // 硬重启：通知 launcher 重新启动
        // 或 os.Exit(0) + 外部进程管理器（如 systemd/docker restart=always）自动拉起
        m.hardRestart()
    } else {
        // 软重启
        m.softRestart(ctx)
    }
}

// softRestart 软重启：停止所有监听和录制，等待设定时间后恢复
func (m *Manager) softRestart(ctx context.Context) {
    // 1. 停止所有 listener（不再检测直播状态，不发送流量）
    inst := instance.GetInstance(ctx)
    inst.Lives.Range(func(id types.LiveID, l live.Live) bool {
        m.listenerMgr.RemoveListener(ctx, id)
        m.recorderMgr.RemoveRecorder(ctx, id)
        return true
    })
    
    // 2. 等待设定时间
    time.Sleep(time.Duration(m.config.RecoveryMinutes) * time.Minute)
    
    // 3. 恢复所有 listener
    cfg := configs.GetCurrentConfig()
    for _, room := range cfg.LiveRooms {
        if room.IsListening {
            // 重新创建 live 对象并启动 listener
            l, err := live.New(ctx, &room, inst.Cache)
            if err == nil {
                m.listenerMgr.AddListener(ctx, l)
            }
        }
    }
}

// hardRestart 硬重启
func (m *Manager) hardRestart() {
    // 方案1：通过 launcher 机制（如果可用）
    // 方案2：os.Exit(0)，依赖外部进程管理器自动拉起
    // Docker 环境下不可用（容器内 os.Exit 后不会自动重启，除非有 restart=always）
    os.Exit(0)
}
```

**文件：`src/cmd/bililive/bililive.go`**

- 启动流程中初始化 `autorestart.Manager` 并启动
- 位置：在 listener/recorder manager 启动之后

**文件：`src/servers/handler.go`**

- 新增手动触发重启的 API：

```go
// POST /api/restart
func restartHandler(writer http.ResponseWriter, r *http.Request) {
    // 解析请求：{"type": "soft"|"hard"}
    // 调用 autorestart.Manager 的重启方法
}
```

**文件：`src/servers/server.go`**

```go
apiRoute.HandleFunc("/restart", restartHandler).Methods("POST")
```

### 8.4 前端变更

**文件：`src/webapp/src/component/config-info/shared-fields.tsx` 或 `index.tsx`**

设置页面新增"定时重启"配置区域：

```tsx
// UI 布局：
// - 开关：启用定时重启
// - 单选：重启类型
//   - 软重启（Docker 内仅此项可用）
//   - 硬重启（非 Docker 环境可用）
// - 时间选择器：执行时间（如 03:00）
// - 数字输入：恢复延迟（分钟，仅软重启）
// - 提示文字：Docker 环境下仅支持软重启
```

**文件：`src/webapp/src/component/layout/index.tsx`（顶部菜单栏）**

- 可选：新增"重启"按钮，手动触发软/硬重启

---

## 实施顺序建议

按难度从低到高排序，建议以下顺序：

| 顺序 | 需求 | 难度 | 预估文件数 | 说明 |
|------|------|------|-----------|------|
| 1 | 需求2 - 抖音分享链接 | ★☆☆ | 2-3 | 正则提取，改动最小 |
| 2 | 需求7 - 多选操作 | ★★☆ | 3-4 | 前端为主，Table rowSelection |
| 3 | 需求5 - 启动优化 | ★★☆ | 3-5 | 已有基础，分批启动+前端骨架屏 |
| 4 | 需求3 - 列表新增三列 | ★★★ | 8-10 | 文件夹大小缓存方案 |
| 5 | 需求1 - 一次性录制 | ★★★ | 10-12 | 后台定时任务+状态机 |
| 6 | 需求6 - 录制时间段 | ★★★★ | 10-12 | 时间段判断+模板系统 |
| 7 | 需求8 - 定时重启 | ★★★ | 4-5 | Docker检测+软/硬重启 |
| 8 | 需求4 - 小文件合并 | ★★★★★ | 4-5 | 改动核心录制流程，风险最高 |

---

## 配置文件变更汇总

以下是所有需要新增到 `config.yml` 的配置项（以及 `config.go` 中的 `defaultConfig`）：

```yaml
# 一次性录制全局配置
one_time_record:
  default_one_time: false          # 添加链接时是否默认勾选一次性录制
  pending_delete_hours: 3          # 停播后多少小时未再开播则标记待删除
  delete_link_days: 7             # 标记待删除后多少天删除链接

# 小文件合并
segment_merge:
  enable: false
  wait_minutes: 10                # 片段结束后等待多少分钟

# 定时重启
auto_restart:
  enable: false
  type: soft                      # soft 或 hard
  restart_time: "03:00"
  recovery_minutes: 10

# 录制时间段模板（全局）
record_schedule_templates:
  - name: "工作日晚间"
    slots:
      - day_of_week: 7            # 7=工作日(1-5)
        start_time: "18:00"
        end_time: "23:00"
  - name: "周末全天"
    slots:
      - day_of_week: 8            # 8=周末(0和6)
        start_time: "09:00"
        end_time: "22:00"
```

单个直播间配置示例：

```yaml
live_rooms:
  - url: "https://live.bilibili.com/12345"
    is_listening: true
    is_one_time: true              # 一次性录制
    one_time_pending_delete_hours: 2  # 覆盖全局阈值
    one_time_delete_link_days: 5   # 覆盖全局阈值
    added_at: 2024-01-15T10:30:00Z  # 添加时间（自动生成）
    record_schedule:               # 录制时间段
      enable: true
      template_name: "工作日晚间"   # 使用模板
    # 或自定义时间段（不用模板）：
    # record_schedule:
    #   enable: true
    #   slots:
    #     - day_of_week: 1
    #       start_time: "18:00"
    #       end_time: "23:00"
```

---

## 注意事项

1. **编译验证**：每完成一个需求，运行 `make build-web dev` 验证前后端编译通过
2. **代码注释**：所有新增代码使用中文注释（项目约定）
3. **配置兼容**：新增配置项使用 `omitempty` 标签，确保旧配置文件不会报错
4. **LiveRoom 持久化**：`OneTimeStatus`、`AddedAt`、`LastLiveTime` 等需要持久化的字段要确保 `yaml` 标签正确，在 config 保存时写入磁盘
5. **事件驱动**：项目使用 `events.Dispatcher` 做事件通知，新功能尽量复用事件机制而非轮询
6. **前端 API**：新增 API 后需在 `src/webapp/src/utils/api.ts` 中添加对应方法
7. **config_comments.go**：新增配置项需同步更新配置注释（前端设置页面展示用）
8. **需求4（小文件合并）风险最高**：涉及录制核心流程，建议最后实现，并充分测试不影响正常录制
