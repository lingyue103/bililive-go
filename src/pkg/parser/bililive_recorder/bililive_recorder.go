// Package bililive_recorder 实现了基于 BililiveRecorder CLI 的直播流下载器
package bililive_recorder

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"

	"github.com/bililive-go/bililive-go/src/configs"
	"github.com/bililive-go/bililive-go/src/live"
	"github.com/bililive-go/bililive-go/src/pkg/livelogger"
	"github.com/bililive-go/bililive-go/src/pkg/parser"
	bilisentry "github.com/bililive-go/bililive-go/src/pkg/sentry"
	"github.com/bililive-go/bililive-go/src/pkg/utils"

	"github.com/kira1928/remotetools/pkg/tools"
)

const (
	// Name 是本下载器的标识符
	Name = "bililive-recorder"

	// ToolName 是工具在 remotetools 中的名称
	ToolName = "bililive-recorder-cli"

	// DotnetToolName 是 dotnet 运行时的工具名称
	DotnetToolName = "dotnet"
)

var (
	// ErrToolNotAvailable 表示 BililiveRecorder CLI 工具不可用
	ErrToolNotAvailable = errors.New("bililive-recorder CLI 工具不可用")
	// ErrDotnetNotAvailable 表示 dotnet 运行时不可用
	ErrDotnetNotAvailable = errors.New("dotnet 运行时不可用")
)

func init() {
	parser.Register(Name, new(builder))
}

type builder struct{}

func (b *builder) Build(cfg map[string]string, logger *livelogger.LiveLogger) (parser.Parser, error) {
	return &Parser{
		closeOnce: new(sync.Once),
		stopCh:    make(chan struct{}),
		cfg:       cfg,
		logger:    logger,
	}, nil
}

// Parser 实现了基于 BililiveRecorder CLI 的 parser.Parser 接口
type Parser struct {
	cmd       *exec.Cmd
	cmdStdIn  io.WriteCloser
	closeOnce *sync.Once
	stopCh    chan struct{}
	cmdLock   sync.Mutex
	cfg       map[string]string
	logger    *livelogger.LiveLogger
}

// IsAvailable 检查 BililiveRecorder CLI 工具是否可用
func IsAvailable() bool {
	api := tools.Get()
	if api == nil {
		return false
	}

	// 检查 dotnet 是否可用
	dotnet, err := api.GetTool(DotnetToolName)
	if err != nil || !dotnet.DoesToolExist() {
		return false
	}

	// 检查 bililive-recorder-cli 是否可用
	recorder, err := api.GetTool(ToolName)
	if err != nil || !recorder.DoesToolExist() {
		return false
	}

	return true
}

// GetToolPaths 返回 dotnet 和 BililiveRecorder CLI 的路径
func GetToolPaths() (dotnetPath, recorderPath string, err error) {
	api := tools.Get()
	if api == nil {
		return "", "", errors.New("remotetools API 不可用")
	}

	dotnet, err := api.GetTool(DotnetToolName)
	if err != nil {
		return "", "", fmt.Errorf("获取 dotnet 工具失败: %w", err)
	}
	if !dotnet.DoesToolExist() {
		return "", "", ErrDotnetNotAvailable
	}

	recorder, err := api.GetTool(ToolName)
	if err != nil {
		return "", "", fmt.Errorf("获取 bililive-recorder-cli 工具失败: %w", err)
	}
	if !recorder.DoesToolExist() {
		return "", "", ErrToolNotAvailable
	}

	return dotnet.GetToolPath(), recorder.GetToolPath(), nil
}

// ParseLiveStream 使用 BililiveRecorder CLI 下载直播流
func (p *Parser) ParseLiveStream(ctx context.Context, streamUrlInfo *live.StreamUrlInfo, live live.Live, file string) error {
	dotnetPath, recorderPath, err := GetToolPaths()
	if err != nil {
		return err
	}

	url := streamUrlInfo.Url

	// 构建命令行参数
	args := []string{
		recorderPath,
		"downloader",
		url.String(),
		file,
		"--disable-log-file", // 使用 bililive-go 的日志系统
	}

	// 添加下载 headers
	for k, v := range streamUrlInfo.HeadersForDownloader {
		args = append(args, "-h", fmt.Sprintf("%s: %s", k, v))
	}

	// 从配置获取分段设置
	cfg := configs.GetCurrentConfig()
	if cfg != nil {
		// 最大文件大小 (字节 -> MB)
		if maxFileSize := cfg.VideoSplitStrategies.MaxFileSize.Bytes(); maxFileSize > 0 {
			maxSizeMB := float64(maxFileSize) / 1024.0 / 1024.0
			args = append(args, "--max-size", strconv.FormatFloat(maxSizeMB, 'f', 2, 64))
		}

		// 最大时长 (纳秒 -> 分钟)
		if maxDuration := cfg.VideoSplitStrategies.MaxDuration; maxDuration > 0 {
			maxDurationMinutes := float64(maxDuration) / 1e9 / 60.0
			args = append(args, "--max-duration", strconv.FormatFloat(maxDurationMinutes, 'f', 2, 64))
		}

		// 超时设置 (微秒 -> 毫秒)
		if timeoutUs := cfg.TimeoutInUs; timeoutUs > 0 {
			timeoutMs := timeoutUs / 1000
			args = append(args, "--timing-watchdog-timeout", strconv.Itoa(timeoutMs))
		}
	}

	// 设置日志级别
	if configs.IsDebug() {
		args = append(args, "--loglevel", "Debug")
	} else {
		args = append(args, "--loglevel", "Information")
	}

	p.cmdLock.Lock()
	p.cmd = exec.Command(dotnetPath, args...)

	var cmdErr error
	if p.cmdStdIn, cmdErr = p.cmd.StdinPipe(); cmdErr != nil {
		p.cmdLock.Unlock()
		return cmdErr
	}

	// 将输出重定向到日志
	// 两个流都套一层「存储不足」检测器：录播姬写盘失败时只会把原因打到控制台，
	// 退出码/错误文本里看不出是磁盘满，上层无法据此启用退避（见 parser.ErrStorageFull）。
	// 检测器与 p.cmd 一起在 cmdLock 内创建，生命周期与本次录制一致，不做跨录制复用。
	stdoutDetector := parser.NewStorageFullDetectingWriter(io.MultiWriter(
		utils.NewDebugControlledWriter(os.Stdout),
		utils.NewLoggerWriter(p.logger),
	))
	stderrDetector := parser.NewStorageFullDetectingWriter(io.MultiWriter(
		utils.NewLogFilterWriter(os.Stderr),
		utils.NewLoggerWriter(p.logger),
	))
	p.cmd.Stdout = stdoutDetector
	p.cmd.Stderr = stderrDetector

	if cmdErr = p.cmd.Start(); cmdErr != nil {
		if p.cmd.Process != nil {
			p.cmd.Process.Kill()
		}
		p.cmdLock.Unlock()
		return cmdErr
	}
	p.cmdLock.Unlock()

	// 等待命令完成或接收停止信号
	cmdDone := make(chan error, 1)
	bilisentry.Go(func() {
		cmdDone <- p.cmd.Wait()
	})

	// storageFull 判定本次录制期间是否出现过「存储不足」文本（stdout/stderr 任一即可）。
	// 必须在 Wait() 返回之后读取：os/exec 保证 Wait 返回前输出拷贝 goroutine 已结束。
	storageFull := func() bool {
		return stdoutDetector.IsStorageFull() || stderrDetector.IsStorageFull()
	}

	select {
	case <-p.stopCh:
		// 收到停止信号，发送 'q' 优雅停止
		if p.cmdStdIn != nil {
			p.cmdStdIn.Write([]byte("q\n"))
		}
		waitErr := <-cmdDone
		return parser.StorageFullError(waitErr, storageFull())
	case err := <-cmdDone:
		// 磁盘写满时录播姬的退出信息里没有磁盘关键词，这里补上哨兵语义，
		// 让 recorders.isDiskWriteFailure 能识别（仅 err != nil 时才包装）。
		return parser.StorageFullError(err, storageFull())
	}
}

// Stop 停止下载
func (p *Parser) Stop() error {
	var err error
	p.closeOnce.Do(func() {
		close(p.stopCh)
		p.cmdLock.Lock()
		defer p.cmdLock.Unlock()
		if p.cmd != nil && p.cmd.ProcessState == nil {
			if p.cmdStdIn != nil && p.cmd.Process != nil {
				// 发送 'q' 命令优雅停止
				if _, writeErr := p.cmdStdIn.Write([]byte("q\n")); writeErr != nil {
					err = fmt.Errorf("发送停止命令失败: %v", writeErr)
				}
			} else if p.cmdStdIn == nil {
				err = errors.New("stdin 未初始化")
			} else if p.cmd.Process == nil {
				err = errors.New("进程未启动")
			}
		}
	})
	return err
}

// Status 返回下载器的当前状态
func (p *Parser) Status() (map[string]interface{}, error) {
	return map[string]interface{}{
		"parser": Name,
	}, nil
}

// GetPID 返回 bililive-recorder 进程的 PID
// 如果进程未启动或已退出，返回 0
func (p *Parser) GetPID() int {
	p.cmdLock.Lock()
	defer p.cmdLock.Unlock()
	if p.cmd != nil && p.cmd.Process != nil {
		return p.cmd.Process.Pid
	}
	return 0
}

// CanHandle 检查指定 URL 是否可以由此下载器处理
// BililiveRecorder CLI 支持所有 FLV 流
func CanHandle(urlPath string) bool {
	return strings.Contains(urlPath, ".flv")
}
