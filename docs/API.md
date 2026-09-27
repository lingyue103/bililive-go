# Bililive-go API

## `GET /api/info` Get app info
- Request:
    ```text
    method: GET
    path: http://127.0.0.1:8080/api/info
    ```
- Response:
    ```json
    {
      "app_name": "BiliLive-go",
      "app_version": "0.5.0-rc.3-3-g31ceeda",
      "build_time": "2020-05-05_01:07:16",
      "git_hash": "31ceeda8f508ba5546cfdefef5f3945828a87651",
      "pid": 33295,
      "platform": "darwin/amd64",
      "go_version": "go1.14.2"
    }
    ```
        
## `GET /api/lives` Get all live info 
- Request:  
    ```text
    method: GET
    path: http://127.0.0.1:8080/api/lives
    ```
- Response:   
    ```json
    [
      {
        "id": "212d9c98c7b376b730d4336bb49f6d3f",
        "live_url": "https://live.bilibili.com/14917277",
        "platform_cn_name": "哔哩哔哩",
        "host_name": "湊-阿库娅Official",
        "room_name": "【B站限定】棉花糖＆唱歌！！！！",
        "status": false,
        "listening": true,
        "recording": false
      },
      {
        "id": "63dc965c77d3d81058c92c3e38822256",
        "live_url": "https://live.bilibili.com/11588230",
        "platform_cn_name": "哔哩哔哩",
        "host_name": "白上吹雪Official",
        "room_name": "古老niconico老人会with☆乐园",
        "status": false,
        "listening": true,
        "recording": false
      },
      {
        "id": "dfb964a56725bbad165cb9ea1ef8ac5b",
        "live_url": "https://live.bilibili.com/1030",
        "platform_cn_name": "哔哩哔哩",
        "host_name": "怕上火暴王老菊",
        "room_name": "直播做饭",
        "status": false,
        "listening": true,
        "recording": false
      }
    ]
    ```
        
## `GET /api/lives/{id}` Get live info by id
- Request:  
    ```text
    method: GET
    path: http://127.0.0.1:8080/api/lives/212d9c98c7b376b730d4336bb49f6d3f
    ```
- Response:
    ```json
    {
      "id": "212d9c98c7b376b730d4336bb49f6d3f",
      "live_url": "https://live.bilibili.com/14917277",
      "platform_cn_name": "哔哩哔哩",
      "host_name": "湊-阿库娅Official",
      "room_name": "【B站限定】棉花糖＆唱歌！！！！",
      "status": false,
      "listening": true,
      "recording": false
    }
    ```
        
## `POST /api/lives` Add live
- Request:  
    ```text
    method: POST
    path: http://127.0.0.1:8080/api/lives
    body: 
        [
            {
                "url": "https://live.bilibili.com/14917277",
                "listen": true
            }
        ]
    ```
- Response:
    ```json
    [
        {
            "id": "212d9c98c7b376b730d4336bb49f6d3f",
            "live_url": "https://live.bilibili.com/14917277",
            "platform_cn_name": "哔哩哔哩",
            "host_name": "湊-阿库娅Official",
            "room_name": "【B站限定】棉花糖＆唱歌！！！！",
            "status": false,
            "listening": true,
            "recording": false
        }
    ]
    ```        
        
## `DELETE /api/lives/{id}` Delete live by id
- Request:  
    ```text
    method: DELETE
    path: http://127.0.0.1:8080/api/lives/212d9c98c7b376b730d4336bb49f6d3f
    ```
- Response:
    ```json
    {
        "err_no": 0,
        "err_msg": "",
        "data": "OK"
    }
    ```

## `GET /api/lives/{id}/start` Start listen live by id
- Request:  
    ```text
    method: GET
    path: http://127.0.0.1:8080/api/lives/212d9c98c7b376b730d4336bb49f6d3f/start
    ```
- Response:
    ```json
    {
        "id": "212d9c98c7b376b730d4336bb49f6d3f",
        "live_url": "https://live.bilibili.com/14917277",
        "platform_cn_name": "哔哩哔哩",
        "host_name": "湊-阿库娅Official",
        "room_name": "【B站限定】棉花糖＆唱歌！！！！",
        "status": false,
        "listening": true,
        "recording": false
    }
    ```
        
## `GET /api/lives/{id}/stop` Stop listen and record live by id
- Request:  
    ```text
    method: GET
    path: http://127.0.0.1:8080/api/lives/212d9c98c7b376b730d4336bb49f6d3f/stop
    ```
- Response:
    ```json
    {
        "id": "212d9c98c7b376b730d4336bb49f6d3f",
        "live_url": "https://live.bilibili.com/14917277",
        "platform_cn_name": "哔哩哔哩",
        "host_name": "湊-阿库娅Official",
        "room_name": "【B站限定】棉花糖＆唱歌！！！！",
        "status": false,
        "listening": false,
        "recording": false
    }
    ```
        
## `GET /api/config` Get config info
- Request:  
    ```text
    method: GET
    path: http://127.0.0.1:8080/api/config
    ```
- Response:
    ```json
    {
      "RPC": {
        "Enable": true,
        "Bind": "127.0.0.1:8080"
      },
      "Debug": false,
      "Interval": 15,
      "OutPutPath": "/tmp",
      "Feature": {
        "UseNativeFlvParser": false
      },
      "LiveRooms": null
    }
    ```
        
## `PUT /api/config` Save lives info to config file
- Request:  
    ```text
    method: PUT
    path: http://127.0.0.1:8080/api/config
    ```
- Response:
    ```json
    {
        "err_no": 0,
        "err_msg": "",
        "data": "OK"
    }
    ```

## `GET /api/raw-config` Get raw config file
- Request:
    ```text
    method: GET
    path: http://127.0.0.1:8080/api/raw-config
    ```
- Response:
    ```json
    {
        "config": "rpc:\n  enable: true\n  bind: 0.0.0.0:8080\ndebug: false\ninterval: 15\nout_put_path: ./\nfeature:\n  use_native_flv_parser: false\nlive_rooms:\n- url: https://www.huya.com/991111\n  is_listening: false\nout_put_tmpl: \"\"\nvideo_split_strategies:\n  on_room_name_changed: false\n  max_duration: 0s\ncookies:\n  live.douyin.com: name1=qwer;name2=asdf;aaaa\non_record_finished:\n  convert_to_mp4: true\n  delete_flv_after_convert: false\ntimeout_in_us: 50000000\n"
    }
    ```

## `PUT /api/raw-config` Save the whole config file
- Request:
    ```text
    method: PUT
    path: http://127.0.0.1:8080/api/raw-config
    body:
        {
            "config": "rpc:\n  enable: true\n  bind: 0.0.0.0:8080\ndebug: false\ninterval: 15\nout_put_path: ./\nfeature:\n  use_native_flv_parser: false\nlive_rooms:\n- url: https://www.huya.com/991111\n  is_listening: false\nout_put_tmpl: \"\"\nvideo_split_strategies:\n  on_room_name_changed: false\n  max_duration: 0s\ncookies:\n  live.douyin.com: name1=qwer;name2=asdf;aaaa\non_record_finished:\n  convert_to_mp4: true\n  delete_flv_after_convert: false\ntimeout_in_us: 50000000\n"
        }
    ```
- Response:
    ```json
    {
        "err_no": 0,
        "err_msg": "",
        "data": "OK"
    }
    ```

---

# 定制版新增 API

> 以下端点由本项目定制分支（`feature/custom-v1`）新增，用于支撑
> 一次性录制（需求1）、列表三列与文件夹大小（需求3）、批量操作（需求7）、录制时间段（需求6）。

## `POST /api/lives/batch-operation` 批量操作直播间

对多个直播间批量执行同一操作。采用「同步逐项结果」语义：单条失败不影响其它条目。

- Request:
    ```text
    method: POST
    path: http://127.0.0.1:8080/api/lives/batch-operation
    body:
        {
            "ids": ["<live_id>", "..."],
            "action": "delete",
            "schedule": { "enable": true, "template_name": "工作日晚间", "slots": [] }
        }
    ```
- `action` 取值：

  | 值 | 说明 |
  |---|---|
  | `start` | 开启监控（等价于置 `is_listening=true`） |
  | `stop` | 关闭监控 |
  | `delete` | 删除链接（**只删链接，不删录制文件**） |
  | `set_one_time` | 转为一次性录制 |
  | `set_persistent` | 转为持久性录制 |
  | `set_schedule` | 应用 `schedule` 中的录制时间段配置（此时必须提供 `schedule`） |

- Response:
    ```json
    {
        "err_no": 0,
        "err_msg": "",
        "data": [
            { "id": "<live_id>", "success": true },
            { "id": "<live_id2>", "success": false, "message": "未找到直播间" }
        ]
    }
    ```

## `POST /api/lives/{id}/one-time` 切换一次性录制 / 挽留

- Request:
    ```text
    method: POST
    path: http://127.0.0.1:8080/api/lives/{id}/one-time
    body:
        { "is_one_time": true, "reset": false }
    ```
- 参数说明：
  - `is_one_time=true`：转为一次性录制（从未开播过则状态为 `waiting_first_live`）
  - `is_one_time=false`：转为持久性录制（清空一次性状态与计时）
  - `reset=true`：**挽留操作** —— 把已进入 `pending_delete`（待删除，不可逆终态）的直播间
    重置为 `recording`（一次性录制中）并重新计时。若此时正在直播且尚未录制，会自动开始录制。
- Response：`commonResp`，`data` 为该直播间的 `live.Info`（含最新 `one_time_status`）

## `POST /api/folder-size/refresh` 手动刷新文件夹大小统计

后台默认每 30 分钟扫描一次录制根目录，此端点用于强制立即重扫。

- Request:
    ```text
    method: POST
    path: http://127.0.0.1:8080/api/folder-size/refresh
    body:
        { "ids": ["<live_id>"] }
    ```
  `ids` 省略或为空数组表示刷新全部（全量刷新在线上约 690 个主播目录，耗时较长，服务端有 3 分钟超时保护）。
- Response:
    ```json
    {
        "err_no": 0,
        "err_msg": "",
        "data": { "<live_id>": 13314375680 }
    }
    ```
  `data` 为 live_id → 字节数的映射；未统计到录制目录的直播间不会出现在结果里。

## 相关：`live.Info` 新增字段

定制版在 `live.Info`（`GET /api/lives` 与 `GET /api/lives/{id}` 的返回元素）上新增：

| 字段 | 类型 | 说明 |
|---|---|---|
| `added_at` | int64 | 添加链接时间（unix 秒）；存量链接回退为最早录制文件夹的时间 |
| `folder_size` | int64 | 该直播间所有历史文件夹总大小（字节） |
| `folder_size_human` | string | 人类可读大小，如 `"12.4 GB"` |
| `one_time` | bool | 是否为一次性录制 |
| `one_time_status` | string | `waiting_first_live` / `recording` / `pending_delete` |
| `schedule_enabled` | bool | 是否配置并启用了录制时间段 |
| `schedule_active` | bool | 当前是否处于录制时段内 |

## 相关：新增配置段

`PATCH /api/config` 与 `GET /api/config` 支持以下新增配置段：

```yaml
one_time_record:
  default_one_time: false        # 添加链接时是否默认勾选"一次性录制"
  pending_delete_hours: 3        # 停播后多少小时未再开播 → 标记"待删除"
  delete_link_days: 7            # 进入"待删除"后多少天删除链接（只删链接不删文件）

segment_merge:
  enable: false                  # 是否启用小文件合并
  wait_minutes: 10               # 片段结束后的等待时长（分钟）
  verify_segments: true          # 合并前用 ffprobe 校验并剔除坏片段

record_schedule_templates:       # 录制时间段模板（全局，可被房间复用）
  - name: "工作日晚间"
    slots:
      - days: [1, 2, 3, 4, 5]    # 0=周日..6=周六；留空=每天
        start: "18:00"
        end: "23:00"             # 必须 start < end（不支持跨天）
```

房间级新增字段（`PATCH /api/config/rooms/id/{id}` 与 `PATCH /api/config/rooms/{url}`）：
`is_one_time`、`one_time_pending_delete_hours`、`one_time_delete_link_days`、
`one_time_reset`（挽留）、`record_schedule`。