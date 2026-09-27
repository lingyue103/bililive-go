package configs

import "gopkg.in/yaml.v3"

// DecorateConfigNode 将硬编码的中文注释注入到配置节点树中。
func DecorateConfigNode(node *yaml.Node) {
	if node.Kind != yaml.DocumentNode || len(node.Content) == 0 {
		return
	}
	root := node.Content[0]
	if root.Kind != yaml.MappingNode {
		return
	}

	root.HeadComment = `# 这个配置文件内的注释是自动生成的，请不要手动修改。
# 需要修改注释时，请在 src/configs/config_comments.go 文件内修改。`

	setFieldLineComment(root, "ffmpeg_path", "# 如果此项为空，就自动在环境变量里寻找")

	setFieldComment(root, "out_put_tmpl",
		`# '{{ .Live.GetPlatformCNName }}/{{ .HostName | filenameFilter }}/[{{ now | date "2006-01-02 15-04-05"}}][{{ .HostName | filenameFilter }}][{{ .RoomName | filenameFilter }}].flv'
# ./平台名称/主播名字/[时间戳][主播名字][房间名字].flv
# https://github.com/bililive-go/bililive-go/wiki/More-Tips`, "")

	splitNode := findNode(root, "video_split_strategies")
	if splitNode != nil {
		setFieldComment(splitNode, "max_file_size",
			`# 仅在使用 ffmpeg 或 bililive-recorder 下载器时生效
# 支持可读格式，如: 500MB, 1GB, 1.5GB, 1024KB
# 也支持纯数字（视为字节），如: 1073741824
# 有效值为正数，默认值 0 为不限制
# 负数为非法值，程序会输出 log 提醒，并无视所设定的数值`, "")
	}

	setFieldHeadComment(root, "notify", "# 通知服务配置")
	notifyNode := findNode(root, "notify")
	if notifyNode != nil {
		setFieldComment(notifyNode, "send_recording_summary",
			`# 录制结束后是否推送录制文件摘要（文件数量、文件名、大小）
# 需要至少开启一个通知渠道（Telegram/Email/Bark）才会生效`, "")
		telegram := findNode(notifyNode, "telegram")
		if telegram != nil {
			setFieldComment(telegram, "enable", "# 是否开启Telegram通知", "")
			setFieldComment(telegram, "withNotification", "# 是否启用声音通知", "")
			setFieldComment(telegram, "botToken", "# Telegram机器人Token", "")
			setFieldComment(telegram, "chatID", "# Telegram聊天ID", "")
		}
		email := findNode(notifyNode, "email")
		if email != nil {
			setFieldComment(email, "enable", "# 是否开启Email通知", "")
			setFieldComment(email, "smtpHost", "# SMTP服务器地址 (例如: smtp.gmail.com, smtp.qq.com等)", "")
			setFieldComment(email, "smtpPort", "# SMTP服务器端口 (常用端口: 25, 465, 587)", "")
			setFieldComment(email, "senderEmail", "# 发送者邮箱地址", "")
			setFieldComment(email, "senderPassword", "# 发送者邮箱授权码或应用专用密码", "")
			setFieldComment(email, "recipientEmail", "# 接收者邮箱地址 ", "")
		}
		barkNode := findNode(notifyNode, "bark")
		if barkNode != nil {
			setFieldComment(barkNode, "enable", "# 是否开启Bark通知(iOS)", "")
			setFieldComment(barkNode, "serverURL", "# Bark服务器地址，默认 https://api.day.app，支持自建", "")
			setFieldComment(barkNode, "deviceKey", "# 设备推送密钥（在Bark App首页获取）", "")
			setFieldComment(barkNode, "sound", "# 推送铃声（可选，如 alarm、birdsong、glass 等）", "")
			setFieldComment(barkNode, "group", "# 通知分组名称（可选）", "")
			setFieldComment(barkNode, "icon", "# 自定义图标URL（可选）", "")
			setFieldComment(barkNode, "level", "# 通知级别（可选）: active/timeSensitive/passive/critical", "")
		}
	}

	// 特殊处理 live_rooms
	// 注释需要出现在 live_rooms 列表的第一个元素上方
	liveRoomsNode := findNode(root, "live_rooms")
	if liveRoomsNode != nil && liveRoomsNode.Kind == yaml.SequenceNode && len(liveRoomsNode.Content) > 0 {
		firstItem := liveRoomsNode.Content[0]
		firstItem.HeadComment = `# quality参数目前仅B站启用，默认为0
# (B站)0代表原画PRO(HEVC)优先, 其他数值为原画(AVC)
# 原画PRO会保存为.ts文件, 原画为.flv
# HEVC相比AVC体积更小, 减少35%体积, 画质相当, 但是B站转码有时候会崩`
	}

	// Proxy 代理配置注释
	setFieldHeadComment(root, "proxy", "# 代理配置（支持 HTTP 和 SOCKS5 代理）")
	proxyNode := findNode(root, "proxy")
	if proxyNode != nil {
		setFieldComment(proxyNode, "enable",
			`# 通用代理开关
# false: 使用系统环境变量 (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY)
# true: 使用下方配置的代理地址`, "")
		setFieldComment(proxyNode, "url",
			`# 通用代理地址，支持以下格式：
# HTTP 代理: http://host:port 或 http://user:pass@host:port
# SOCKS5 代理: socks5://host:port 或 socks5://user:pass@host:port
# 示例: socks5://127.0.0.1:1080 (翻墙软件常用端口)
# 此地址同时用于信息获取和下载，除非下方单独配置了专用代理`, "")
		setFieldComment(proxyNode, "info_proxy",
			`# 信息获取专用代理（可选，覆盖通用代理设置）
# 仅用于获取直播间信息、平台 API 请求等
# 注意：通过 bililive-tools 间接获取信息的平台（如抖音）暂不受此代理设置影响
# 如果只想为信息获取使用代理（例如解决临时 IP 封禁），可以只配置此项`, "")
		setFieldComment(proxyNode, "download_proxy",
			`# 下载专用代理（可选，覆盖通用代理设置）
# 仅用于下载直播流数据
# 如果不想让下载流量走代理，可以将此项的 enable 设为 false`, "")
	}

	// Feature 功能配置注释
	featureNode := findNode(root, "feature")
	if featureNode != nil {
		setFieldComment(featureNode, "downloader_type",
			`# 下载器类型：ffmpeg（默认）、native（内置 FLV 解析器）、bililive-recorder
# ffmpeg: 使用 FFmpeg 录制，支持所有流格式，需要安装 FFmpeg
# native: 使用内置 FLV 解析器，仅支持 FLV 流，无需额外依赖
# bililive-recorder: 使用 BililiveRecorder CLI，仅支持 FLV 流`, "")
		setFieldComment(featureNode, "enable_flv_proxy_segment",
			`# FLV 代理分段功能（仅对 FFmpeg 下载器生效）
# 当检测到视频编码参数变化（新的 SPS/PPS）时，会主动断开连接触发 FFmpeg 分段
# 这可以避免因视频编码参数变化导致的花屏问题
# 注意：启用后会在本地启动一个 FLV 代理服务器，FFmpeg 从代理读取流`, "")
	}

	// 需求1：一次性录制的配置注释
	if oneTimeNode := findNode(root, "one_time_record"); oneTimeNode != nil {
		setFieldComment(oneTimeNode, "default_one_time",
			`# 添加链接时是否默认勾选"一次性录制"`, "")
		setFieldComment(oneTimeNode, "pending_delete_hours",
			`# 停播后多少小时内未再次开播 → 标记为"待删除"（默认 3）
# 注意：一旦进入"待删除"即不可逆，重新开播也不会回退，期间只提醒不录制；
# 只能在前端通过"重置为一次性"或"转为永久"挽留`, "")
		setFieldComment(oneTimeNode, "delete_link_days",
			`# 进入"待删除"后多少天删除链接（默认 7，只删链接不删文件）
# 删除时刻 = 最后停播 + pending_delete_hours + delete_link_days`, "")
	}

	// 需求4：小文件合并的配置注释
	if segNode := findNode(root, "segment_merge"); segNode != nil {
		setFieldComment(segNode, "enable",
			`# 是否启用小文件合并
# 一次录制结束后，在 wait_minutes 内该直播间再次录制完成，则合并为一个文件后再统一转码`, "")
		setFieldComment(segNode, "wait_minutes",
			`# 片段结束后的等待时长（分钟，默认 10）`, "")
		setFieldComment(segNode, "verify_segments",
			`# 合并前是否用 ffprobe 逐个校验片段、剔除无法播放的坏片段（默认 true）
# 强烈建议保持开启：1G 正常文件与 200K 坏文件合并会导致整个文件报废`, "")
	}

	// 需求6：录制时间段模板的配置注释
	if tplNode := findNode(root, "record_schedule_templates"); tplNode != nil {
		tplNode.HeadComment = `# 录制时间段模板（可被多个直播间复用）
# days: 0=周日,1=周一,...,6=周六；留空表示每天
# start/end: "HH:MM" 格式，必须 start < end（不支持跨天，如需覆盖凌晨请拆成两条）`
	}

	// 需求8：定时软重启的配置注释
	if arNode := findNode(root, "auto_restart"); arNode != nil {
		setFieldComment(arNode, "enable",
			`# 是否启用定时软重启`, "")
		arNode.HeadComment = `# 定时软重启（本轮仅实现软重启）
# 软重启：切断所有直播连接（停止录制器 + 不再向平台发起任何请求），
#         等待 recovery_minutes 分钟后自动恢复请求。
# 硬重启（重启整个进程）在容器内不可用，未实现。`
		if scNode := findNode(arNode, "schedules"); scNode != nil {
			scNode.HeadComment = `# 软重启计划列表，可配置多个时间点
# days: 0=周日,1=周一,...,6=周六；留空表示每天
# time: "HH:MM" 格式的执行时刻`
		}
		setFieldComment(arNode, "recovery_minutes",
			`# 切断流量后多少分钟恢复（默认 10）`, "")
	}
}

func findNode(mapNode *yaml.Node, key string) *yaml.Node {
	for i := 0; i < len(mapNode.Content); i += 2 {
		if mapNode.Content[i].Value == key {
			return mapNode.Content[i+1]
		}
	}
	return nil
}

func setFieldComment(mapNode *yaml.Node, key, headComment, lineComment string) {
	for i := 0; i < len(mapNode.Content); i += 2 {
		k := mapNode.Content[i]
		if k.Value == key {
			if headComment != "" {
				k.HeadComment = headComment
			}
			if lineComment != "" {
				k.LineComment = lineComment
			}
			return
		}
	}
}

func setFieldLineComment(mapNode *yaml.Node, key, lineComment string) {
	for i := 0; i < len(mapNode.Content); i += 2 {
		k := mapNode.Content[i]
		if k.Value == key {
			k.LineComment = lineComment
			return
		}
	}
}

func setFieldHeadComment(mapNode *yaml.Node, key, headComment string) {
	for i := 0; i < len(mapNode.Content); i += 2 {
		k := mapNode.Content[i]
		if k.Value == key {
			k.HeadComment = headComment
			return
		}
	}
}
