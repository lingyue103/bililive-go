package douyin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/bililive-go/bililive-go/src/live"
	"github.com/bililive-go/bililive-go/src/tools"
)

var btoolsConsts = struct {
	port      int
	authToken string
}{
	port:      tools.BToolsPort,
	authToken: tools.BToolsAuthToken,
}

// btoolsClient 访问本地 bililive-tools 服务的专用客户端。
//
// 不能用 http.DefaultClient：它没有超时，本地服务一旦卡住（而不是报错），
// 调用方会永久阻塞，直播间轮询 goroutine 会不断堆积。
// 这里的请求全部打到 127.0.0.1，正常应在毫秒级返回，给 15 秒已经非常宽松。
var btoolsClient = &http.Client{
	Timeout: 15 * time.Second,
}

// doBToolsRequest 向本地 bililive-tools 服务发起一次带鉴权的 GET 请求。
// 返回的 body 已经读取完毕并关闭，调用方直接解析即可。
func doBToolsRequest(endpoint string) ([]byte, error) {
	// 需求8（软重启）：抖音的取流信息全部来自本地 bililive-tools（127.0.0.1），
	// 既不经过 BaseLive.RequestSession，也就不会被 pause.WrapTransport 掐断。
	// 因此必须在这里单独判定闸门：暂停期间直接返回，连本地请求都不发出去。
	// 上层（WrappedLive.GetInfo 的闸门）此时通常已经拦住，这里是兜底，
	// 覆盖任何绕过包装器直接调用平台实现的情形。
	if live.IsSoftRestartPaused() {
		return nil, live.ErrSoftRestartPaused
	}

	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", btoolsConsts.authToken)

	resp, err := btoolsClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// 读掉 body 才能让连接回到连接池复用，否则每次失败都会新建一条 TCP 连接，
		// 大量直播间同时失败时会迅速耗尽本地端口
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil, fmt.Errorf("请求失败: %s", resp.Status)
	}

	return io.ReadAll(resp.Body)
}

type ChannelInfo struct {
	Id     string `json:"id"`
	Title  string `json:"title"`
	Owner  string `json:"owner"`
	Avatar string `json:"avatar"`
	Uid    string `json:"uid"`
}

type liveInfoResp struct {
	Title  string `json:"title"`
	Owner  string `json:"owner"`
	Living bool   `json:"living"`
}

type streamInfoResp struct {
	Stream string `json:"stream"`
}

func NewBtoolsLive(live *Live) btoolsLive {
	return btoolsLive{
		Live:     live,
		roomId:   "",
		hostName: "",
		roomName: "",
	}
}

type btoolsLive struct {
	*Live
	roomId   string
	hostName string
	roomName string
}

func (l *btoolsLive) updateChannelInfo() (err error) {
	var channelInfo ChannelInfo
	channelInfo, err = l.fetchChannelInfo()
	if err != nil {
		return
	}
	if channelInfo.Id == "" {
		err = fmt.Errorf("无法获取频道信息")
		return
	}
	l.hostName = channelInfo.Owner
	l.roomName = channelInfo.Title
	l.roomId = channelInfo.Id
	return
}

func (l *btoolsLive) fetchChannelInfo() (channelInfo ChannelInfo, err error) {
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/bgo/channel-info?url=%s", btoolsConsts.port, url.QueryEscape(l.Url.String()))
	body, err := doBToolsRequest(endpoint)
	if err != nil {
		return
	}
	err = json.Unmarshal(body, &channelInfo)
	return
}

func (l *btoolsLive) fetchLiveInfo() (liveInfo liveInfoResp, err error) {
	if l.roomId == "" {
		err = l.updateChannelInfo()
		if err != nil {
			return
		}
	}

	endpoint := fmt.Sprintf("http://127.0.0.1:%d/bgo/live-info?platform=douyin&roomId=%s", btoolsConsts.port, url.QueryEscape(l.roomId))
	body, err := doBToolsRequest(endpoint)
	if err != nil {
		return liveInfo, err
	}
	if err = json.Unmarshal(body, &liveInfo); err != nil {
		return liveInfo, err
	}
	return liveInfo, nil
}

func (l *btoolsLive) fetchStreamInfo() (streamInfo streamInfoResp, err error) {
	if l.roomId == "" {
		err = l.updateChannelInfo()
		if err != nil {
			return
		}
	}

	endpoint := fmt.Sprintf("http://127.0.0.1:%d/bgo/stream-info?platform=douyin&roomId=%s", btoolsConsts.port, url.QueryEscape(l.roomId))
	body, err := doBToolsRequest(endpoint)
	if err != nil {
		return streamInfo, err
	}
	if err = json.Unmarshal(body, &streamInfo); err != nil {
		return streamInfo, err
	}
	return streamInfo, nil
}

func (l *btoolsLive) GetInfo() (info *live.Info, err error) {
	ret := &live.Info{
		Live:     l.Live,
		HostName: l.hostName,
		RoomName: l.roomName,
		Status:   false,
	}

	var liveInfo liveInfoResp
	liveInfo, err = l.fetchLiveInfo()
	if err != nil {
		return
	}
	ret.Status = liveInfo.Living
	ret.HostName = liveInfo.Owner
	ret.RoomName = liveInfo.Title

	return ret, nil
}

func (l *btoolsLive) GetStreamInfos() (us []*live.StreamUrlInfo, err error) {
	// 需求8（软重启）：取流地址同样要过闸门。WrappedLive 侧已经有一层，
	// 这里再判一次是为了让「直接持有平台实现」的调用方也拦住，
	// 并且避免先去做 updateChannelInfo 这类本地请求。
	if live.IsSoftRestartPaused() {
		return nil, live.ErrSoftRestartPaused
	}
	if l.roomId == "" {
		err = l.updateChannelInfo()
		if err != nil {
			return
		}
	}
	var streamInfo streamInfoResp
	streamInfo, err = l.fetchStreamInfo()
	if err != nil {
		return
	}
	u, parseErr := url.Parse(streamInfo.Stream)
	if parseErr != nil {
		err = parseErr
		return
	}

	return []*live.StreamUrlInfo{
		{
			Url: u,
		},
	}, nil
}
