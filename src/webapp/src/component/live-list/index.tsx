import React from "react";
import { Alert, Button, Checkbox, Divider, Dropdown, Input, Modal, Popover, Table, Tag, Tabs, Row, Col, Tooltip, message, List, Typography, Switch, Space, Popconfirm, Select, Spin } from 'antd';
import { EditOutlined, SyncOutlined, CloudSyncOutlined, ReloadOutlined, SwapOutlined, CheckCircleOutlined, ExclamationCircleOutlined, CommentOutlined, SettingOutlined } from '@ant-design/icons';
import PopDialog from '../pop-dialog/index';
import BatchAddRoomDialog from '../batch-add-room-dialog/index';
import LogPanel from '../log-panel/index';
import HistoryPanel from '../history-panel/index';
import DanmakuPanel, { DanmakuMessage } from '../danmaku-panel/index';
import API from '../../utils/api';
import Utils from '../../utils/common';
import { subscribeSSE, unsubscribeSSE, SSEMessage } from '../../utils/sse';
import { isListSSEEnabled, setListSSEEnabled, getPollIntervalMs } from '../../utils/settings';
import './live-list.css';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate, NavigateFunction } from "react-router-dom";
import EditCookieDialog from "../edit-cookie/index";
import { RoomConfigForm } from "../config-info";
import RecordScheduleDialog from '../record-schedule-dialog';
import { StreamAttributes } from '../../types/stream';

const api = new API();
const { Text } = Typography;

// 带过滤器的流列表组件
interface StreamListWithFilterProps {
    availableStreams: any[];
    availableStreamAttributes?: any[];
    detail: any;
    liveId: string;
    component: any; // LiveList 组件实例
}

const StreamListWithFilter: React.FC<StreamListWithFilterProps> = ({
    availableStreams,
    availableStreamAttributes,
    detail,
    liveId,
    component
}) => {
    const [filterAttrs, setFilterAttrs] = React.useState<StreamAttributes>({});

    // 提取所有属性的 key
    const allKeys = React.useMemo(() => {
        if (!availableStreamAttributes || availableStreamAttributes.length === 0) {
            return [];
        }
        const keysSet = new Set<string>();
        availableStreamAttributes.forEach((combo: any) => {
            Object.keys(combo).forEach((key: string) => keysSet.add(key));
        });
        return Array.from(keysSet);
    }, [availableStreamAttributes]);

    // 根据当前过滤条件，计算指定属性的有效值
    const getValidValues = (key: string): string[] => {
        if (!availableStreamAttributes) return [];
        const compatible = availableStreamAttributes.filter((combo: any) => {
            return Object.entries(filterAttrs).every(([k, v]) => {
                if (k === key) return true;
                return combo[k] === undefined || combo[k] === v;
            });
        });
        const values = new Set<string>();
        compatible.forEach((combo: any) => {
            if (combo[key]) values.add(combo[key]);
        });
        return Array.from(values);
    };

    // 处理属性变化
    const handleAttrChange = (key: string, value: string | undefined) => {
        setFilterAttrs((prev: StreamAttributes) => {
            const newAttrs = { ...prev };
            if (value === undefined) {
                delete newAttrs[key];
            } else {
                newAttrs[key] = value;
            }
            return newAttrs;
        });
    };

    // 根据选择的属性过滤流列表
    const filteredStreams = React.useMemo(() => {
        if (Object.keys(filterAttrs).length === 0) {
            return availableStreams;
        }
        return availableStreams.filter((stream: any) => {
            if (!stream.attributes_for_stream_select) return true;
            return Object.entries(filterAttrs).every(([k, v]) => {
                return stream.attributes_for_stream_select[k] === v;
            });
        });
    }, [filterAttrs, availableStreams]);

    // 渲染流列表项
    const renderStreamItem = (stream: any, index: number) => {
        // 判断是否为当前录制使用的流（或录制准备中时用户选中的流偏好）
        // 优先通过 recorder_status 中的实际录制属性匹配（录制中），
        // 回退到 room_config 中的用户流偏好匹配（录制准备中 — 还没成功录制但用户已选中）
        let isCurrentStream = false;
        const streamAttrs = stream.attributes_for_stream_select;
        if (streamAttrs) {
            // 来源 1：实际录制中的流属性
            const recorderAttrs = detail.recording && detail.recorder_status?.stream_attributes_for_stream_select;
            // 来源 2：用户配置的流偏好（录制准备中时 fallback）
            const preferenceAttrs = !recorderAttrs && detail.recording_preparing && detail.room_config?.stream_preference?.attributes;
            const targetAttrs = recorderAttrs || preferenceAttrs;
            if (targetAttrs) {
                isCurrentStream = Object.keys(targetAttrs).length === Object.keys(streamAttrs).length
                    && Object.entries(targetAttrs).every(([k, v]) => streamAttrs[k] === v);
            }
        }

        const handleSwitchStream = async () => {
            try {
                const result = await api.switchStream(liveId, {
                    attributes: stream.attributes_for_stream_select,
                    quality: stream.quality
                }) as { success?: boolean; message?: string };

                if (result.success) {
                    message.success(result.message || '流设置已更新');
                    component.loadRoomDetail(liveId);
                } else {
                    message.error(result.message || '切换流设置失败');
                }
            } catch (error) {
                message.error('切换流设置失败: ' + error);
            }
        };

        return (
            <List.Item key={index} style={{
                padding: '6px 0',
                borderBottom: '1px dashed #f0f0f0',
                backgroundColor: isCurrentStream ? '#f6ffed' : undefined
            }}>
                <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ flexGrow: 1 }}>
                        {/* 第一行：序号和所有从 attributes 渲染的标签 */}
                        <Space size="small" wrap>
                            <Tag color={isCurrentStream ? 'green' : 'default'}>
                                {isCurrentStream ? <CheckCircleOutlined /> : null} #{index + 1}
                            </Tag>
                            <Tag color="purple">
                                {stream.quality || '未知'}
                            </Tag>
                            {/* 从 attributes_for_stream_select 渲染所有属性 */}
                            {stream.attributes_for_stream_select && Object.entries(stream.attributes_for_stream_select).map(([key, value]: [string, any]) => {
                                // 跳过 quality，因为已经单独显示了
                                if (key === '画质' && value === stream.quality) {
                                    return null;
                                }
                                // 根据key类型使用不同颜色
                                let color = 'default';
                                if (key === 'codec') {
                                    color = value === 'h265' ? 'orange' : 'green';
                                } else if (key === 'format_name') {
                                    color = 'blue';
                                } else if (key === '协议') {
                                    color = 'cyan';
                                }
                                return (
                                    <Tag key={key} color={color}>
                                        {key === 'codec' || key === 'format_name' ? value.toUpperCase() : `${key}: ${value}`}
                                    </Tag>
                                );
                            })}
                        </Space>
                        {/* 第二行：如果有 description，单独显示 */}
                        {stream.description && stream.description !== stream.quality && (
                            <div style={{ marginTop: 4, fontSize: 12, color: '#666', paddingLeft: 8 }}>
                                <span style={{ fontStyle: 'italic' }}>ℹ️ {stream.description}</span>
                            </div>
                        )}
                    </div>
                    {!isCurrentStream && (
                        (detail.recording || detail.recording_preparing) ? (
                            <Popconfirm
                                title="切换录制流"
                                description={
                                    <div style={{ maxWidth: 300 }}>
                                        <p style={{ margin: '0 0 8px 0', color: '#ff4d4f', fontWeight: 500 }}>
                                            <ExclamationCircleOutlined /> 警告：切换流会截断当前录制！
                                        </p>
                                        <p style={{ margin: 0 }}>
                                            当前录制的视频文件将被保存，然后立即开始使用新的流设置进行录制。
                                        </p>
                                    </div>
                                }
                                onConfirm={handleSwitchStream}
                                okText="确认切换"
                                cancelText="取消"
                                okButtonProps={{ danger: true }}
                                icon={<ExclamationCircleOutlined style={{ color: '#ff4d4f' }} />}
                            >
                                <Tooltip title="切换到此流设置并重新开始录制（会截断当前录制）">
                                    <Button
                                        size="small"
                                        type="link"
                                        icon={<SwapOutlined />}
                                        style={{ color: '#faad14' }}
                                    >
                                        切换
                                    </Button>
                                </Tooltip>
                            </Popconfirm>
                        ) : (
                            <Tooltip title="设置为此流设置（将在下次录制时生效）">
                                <Button
                                    size="small"
                                    type="link"
                                    icon={<SwapOutlined />}
                                    onClick={handleSwitchStream}
                                >
                                    应用
                                </Button>
                            </Tooltip>
                        )
                    )}
                </div>
            </List.Item>
        );
    };

    return (
        <>
            {/* 属性过滤器 */}
            {allKeys.length > 0 && (
                <div style={{
                    padding: '12px',
                    marginBottom: '12px',
                    backgroundColor: '#fafafa',
                    borderRadius: '4px',
                    border: '1px solid #e8e8e8'
                }}>
                    <div style={{ marginBottom: '8px', fontWeight: 500, color: '#666' }}>
                        🔍 流属性过滤器
                    </div>
                    <Space direction="vertical" style={{ width: '100%' }} size="small">
                        {allKeys.map((key: string) => {
                            const validValues = getValidValues(key);
                            return (
                                <Space key={key} style={{ width: '100%' }}>
                                    <label style={{ minWidth: '80px' }}>{key}:</label>
                                    <Select
                                        value={filterAttrs[key]}
                                        onChange={(v) => handleAttrChange(key, v)}
                                        placeholder="不限制"
                                        allowClear
                                        style={{ flex: 1, minWidth: '150px' }}
                                    >
                                        {validValues.map((v: string) => (
                                            <Select.Option key={v} value={v}>{v}</Select.Option>
                                        ))}
                                    </Select>
                                    <span style={{ color: '#999', fontSize: '12px' }}>
                                        ({validValues.length} 个选项)
                                    </span>
                                </Space>
                            );
                        })}
                        <div style={{
                            color: '#1890ff',
                            fontSize: '13px',
                            marginTop: '4px',
                            paddingTop: '8px',
                            borderTop: '1px dashed #d9d9d9'
                        }}>
                            筛选结果：{filteredStreams.length} / {availableStreams.length} 个流
                        </div>
                    </Space>
                </div>
            )}

            {/* 过滤后的流列表 */}
            <List
                size="small"
                dataSource={filteredStreams}
                split={false}
                renderItem={renderStreamItem}
            />
        </>
    );
};

// 使用动态获取的刷新间隔
const getRefreshTime = () => getPollIntervalMs();

// ==================== 列设置（自由开关每一列）相关常量 ====================

// 可以在「列设置」面板里自由开关的列 key，与 this.columns / this.smallColumns 里的 key 一一对应：
//   name              -> 主播名称
//   room              -> 直播间名称（仅桌面端 columns 才有）
//   address           -> 直播平台（仅桌面端 columns 才有）
//   addedAt           -> 添加链接时间
//   lastStartTimeUnix -> 最近一次直播时间
//   folderSize        -> 文件夹大小
//   tags              -> 运行状态
const SWITCHABLE_COLUMN_KEYS: string[] = [
    'name',
    'room',
    'address',
    'addedAt',
    'lastStartTimeUnix',
    'folderSize',
    'tags',
];

// 「操作」列的 key：它不参与列设置，必须始终显示，否则用户无法操作任何直播间
const ALWAYS_VISIBLE_COLUMN_KEY = 'action';

// 列 key -> 列设置面板里展示的中文名称
const COLUMN_KEY_LABELS: { [key: string]: string } = {
    name: '主播名称',
    room: '直播间名称',
    address: '直播平台',
    addedAt: '添加链接时间',
    lastStartTimeUnix: '最近一次直播时间',
    folderSize: '文件夹大小',
    tags: '运行状态',
};

// 列显示设置的 localStorage key
const VISIBLE_COLUMNS_STORAGE_KEY = 'liveListVisibleColumns';

// ==================== 表格列宽与虚拟滚动宽度（两处必须保持一致） ====================

// 「展开图标列（+）」与「复选框列」的宽度。
// 这两列在传给 rc-table 的列定义里没有 width（antd 只给它们挂了 CSS 类宽度，
// 而虚拟滚动下 rc-table 会把 useWidthColumns 均分/填充出来的宽度写成 <col> 上的
// 行内 style，优先级高于 CSS 类），因此不显式指定就会被按 scroll.x 均分、各占 200px 以上。
// 这里统一取 48px（与 antd 自身默认的展开列宽一致）：
//   - 复选框列：antd 给该列的内边距是 8px ×2，加 16px 复选框，48px 绰绰有余；
//   - 展开列：图标布局盒固定 17px（controlInteractiveSize 16 推导而来），
//     桌面端 size="large" 时该列内边距 16px ×2，内容区 16px，图标不会溢出。
const EXTRA_COLUMN_WIDTH = 48;

// 桌面端 scroll.x 合计：展开列 44 + 复选框列 44 + 各业务列 width 之和。
// ⚠️ 必须与 columns 数组里各列的 width 严格一致（含 addedAtColumn / lastLiveColumn /
//    folderSizeColumn / runStatus / runAction 这几个独立列定义）：
//    一旦「各列 width 之和 < scroll.x」，rc-table 的 useWidthColumns 会把多出来的宽度
//    按比例放大给所有列，列宽又会失控（这正是本轮要修的问题）。
const TABLE_SCROLL_X = EXTRA_COLUMN_WIDTH + EXTRA_COLUMN_WIDTH
    + 140 // 主播名称
    + 140 // 直播间名称
    + 90 // 直播平台（内容很短，刻意收窄）
    + 165 // 添加链接时间（比建议的 150 宽：19 字符的时间串在大号表格下会换行）
    + 165 // 最近一次直播时间（同上）
    + 130 // 文件夹大小（表头「文件夹大小」+ 刷新图标约需 90px，100px 会让表头折行，故给 130）
    + 220 // 运行状态（可能同时显示多个 Tag）
    + 240; // 操作（平铺「停止监控/文件/配置」+「更多」下拉，待删除行还有两个挽留按钮）

// 移动端（≤768px）用的是 smallColumns：没有「直播间名称」「直播平台」两列，列数更少、合计更小。
// 若移动端沿用桌面端的 TABLE_SCROLL_X，多出来的宽度同样会被按比例摊给各列，
// 移动端反而要横向滚动更远，所以单独给出移动端的合计值。
const SMALL_TABLE_SCROLL_X = EXTRA_COLUMN_WIDTH + EXTRA_COLUMN_WIDTH
    + 140 // 主播名称
    + 165 // 添加链接时间（与 addedAtColumn 共用列定义，宽度必须一致）
    + 165 // 最近一次直播时间（与 lastLiveColumn 共用列定义，宽度必须一致）
    + 130 // 文件夹大小（与 folderSizeColumn 共用列定义，宽度必须一致）
    + 220 // 运行状态
    + 240; // 操作

// 生成「模糊搜索」筛选面板（主播名称 / 直播间名称两列共用，避免重复代码）。
// 用自定义 filterDropdown 而不是 filters + filterSearch，因为这里要的是输入即匹配的模糊搜索；
// 搜索状态由 antd 自己维护（selectedKeys -> onFilter），不需要手动传 filteredValue。
const createFuzzyFilterDropdown = (placeholder: string) => {
    // 返回 antd 列定义需要的 filterDropdown 渲染函数
    return ({ setSelectedKeys, selectedKeys, confirm, clearFilters }: any) => (
        <div style={{ padding: 8 }}>
            <Input
                placeholder={placeholder}
                value={(selectedKeys[0] as string) || ''}
                onChange={e => setSelectedKeys(e.target.value ? [e.target.value] : [])}
                onPressEnter={() => confirm()}
                style={{ width: 200, marginBottom: 8, display: 'block' }}
            />
            <Space>
                <Button type="primary" size="small" onClick={() => confirm()}>搜索</Button>
                <Button size="small" onClick={() => { if (clearFilters) { clearFilters(); } confirm(); }}>重置</Button>
            </Space>
        </div>
    );
};

// 从 localStorage 读取用户保存的列显示设置。
// 读取失败、内容非法、或过滤后一列都不剩时，一律回退为「全部可见」。
const loadVisibleColumnKeys = (): string[] => {
    try {
        const saved = localStorage.getItem(VISIBLE_COLUMNS_STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) {
                // 只保留仍然合法的列 key，避免历史数据或手工改 localStorage 造成脏值
                const valid = parsed
                    .map((key: any) => String(key))
                    .filter((key: string) => SWITCHABLE_COLUMN_KEYS.includes(key));
                if (valid.length > 0) {
                    return valid;
                }
            }
        }
    } catch (e) {
        console.error('加载列显示设置失败:', e);
    }
    // 默认全部可见
    return [...SWITCHABLE_COLUMN_KEYS];
};

interface Props {
    navigate: NavigateFunction;
    refresh?: () => void;
}

// 刷新状态类型
// idle: 可以立即刷新
// waiting_interval: 等待配置的访问间隔
// waiting_rate_limit: 等待平台访问频率限制
// refreshing: 正在刷新
// no_schedule: 未安排定期刷新（如未监控的直播间）
type RefreshStatus = 'idle' | 'waiting_interval' | 'waiting_rate_limit' | 'refreshing' | 'no_schedule';

interface IState {
    list: ItemData[],
    cookieList: CookieItemData[],
    batchAddDialogVisible: boolean,
    window: any,
    expandedRowKeys: string[],  // 展开的行
    expandedDetails: { [key: string]: any }, // 直播间详细信息缓存
    expandedLogs: { [key: string]: string[] }, // 直播间日志缓存
    sseSubscriptions: { [key: string]: string }, // roomId -> subscriptionId 映射
    globalConfig: any, // 全局配置缓存
    countdownTimers: { [key: string]: number }, // 倒计时值缓存（秒）
    lastUpdateTimes: { [key: string]: number }, // 上次更新时间戳（毫秒）
    refreshStatus: { [key: string]: RefreshStatus }, // 刷新状态
    listSSESubscription: string | null, // 列表级别的SSE订阅ID
    enableListSSE: boolean, // 是否启用列表级别SSE（从localStorage读取）
    sortedInfo: { columnKey: string | null; order: 'ascend' | 'descend' | null }, // 表格排序状态
    danmakuMessages: { [key: string]: DanmakuMessage[] }, // roomId -> 弹幕消息列表
    expandedActiveTabs: { [key: string]: string }, // roomId -> 当前激活的 tab key
    douyuNeedRescan: boolean, // 斗鱼 cookie 自动续期已失败，需重新扫码
    selectedRowKeys: string[], // 需求7：当前多选选中的直播间 id 列表
    batchOperating: boolean, // 需求7：批量操作请求进行中
    recordScheduleDialogVisible: boolean, // 需求6：录制时间段配置弹窗是否可见
    recordScheduleRoomIds: string[], // 需求6：录制时间段配置弹窗作用的直播间 id 列表（支持批量）
    folderSizeRefreshing: boolean, // 需求3：文件夹大小手动刷新中
    visibleColumnKeys: string[], // 列设置：当前可见的列 key 列表（不含始终显示的「操作」列），默认全部可见
}

interface ItemData {
    key: string,
    name: string,
    room: Room,
    address: string,
    tags: string[],
    listening: boolean
    roomId: string
    notifyOnly: boolean
    isLive: boolean
    isRecording: boolean
    addedAt: number // 需求3：添加链接时间（unix 秒）
    lastStartTimeUnix: number // 需求3：最近一次直播时间（unix 秒，复用后端已有字段）
    folderSize: number // 需求3：文件夹大小（字节，仅用于排序）
    folderSizeHuman: string // 需求3：文件夹大小（人类可读，如 "12.4 GB"）
    oneTimeStatus: string // 需求1：一次性录制状态，'' | waiting_first_live | recording | pending_delete
    scheduleEnabled: boolean // 需求6：是否配置了录制时间段
    scheduleActive: boolean // 需求6：当前是否处于录制时段内
}
interface CookieItemData {
    Platform_cn_name: string,
    Host: string,
    Cookie: string
}

interface Room {
    roomName: string;
    url: string;
    lastError?: string;
}

class LiveList extends React.Component<Props, IState> {
    //弹幕批量缓冲（高频场景优化）
    private danmakuBuffer: { [roomId: string]: DanmakuMessage[] } = {};
    private danmakuFlushTimer: ReturnType<typeof setTimeout> | null = null;

    //cookie开窗
    cookieChild!: EditCookieDialog;

    //定时器
    timer!: NodeJS.Timeout;

    //倒计时定时器
    countdownTimer!: NodeJS.Timeout;

    // 列表 Table 的实例引用。
    // 虚拟滚动下只有可视区域附近的行在 DOM 里，未渲染的行用 getElementById 取不到，
    // 因此深度链接定位行要改用 Table 实例的 scrollTo({ key })（rc-table/virtual-list 支持按 key 定位）。
    private tableRef = React.createRef<any>();

    runStatus: ColumnsType<ItemData>[number] = {
        title: '运行状态',
        key: 'tags',
        dataIndex: 'tags',
        // 列宽：该列可能同时显示多个 Tag（如「录制中」+「一次性录制中」），固定 220px
        // （需与 TABLE_SCROLL_X / SMALL_TABLE_SCROLL_X 中的 220 保持一致）
        width: 220,
        // 性能：筛选器与过滤函数都是静态的，直接定义在列上即可。
        // 原先在 render() 里每次渲染都用 .map() 生成新数组、新函数赋给 column.filters/onFilter，
        // 会让 antd Table 每次渲染都认为列定义变了并重建内部结构。
        filters: [
            '初始化', '监控中', '录制中', '录制准备中', '仅提醒', '已停止',
            // 需求1/6：一次性录制与录制时间段带来的新状态
            '一次性录制中', '待删除', '等待首次直播', '时段外仅监控',
        ].map(text => ({ text, value: text })),
        onFilter: (value: string | number | boolean, record: ItemData) => record.tags.includes(value as string),
        render: (tags: string[]) => (
            <span>
                {tags.map(tag => {
                    let color = 'green';
                    if (tag === '已停止') {
                        color = 'grey';
                    }
                    if (tag === '监控中') {
                        color = 'green';
                    }
                    if (tag === '录制中') {
                        color = 'red';
                    }
                    if (tag === '录制准备中') {
                        color = 'volcano';
                    }
                    if (tag === '初始化') {
                        color = 'orange';
                    }
                    if (tag === '仅提醒') {
                        color = 'purple';
                    }
                    // ---- 需求1：一次性录制相关状态标签 ----
                    if (tag === '一次性录制中') {
                        color = 'blue';
                    }
                    if (tag === '待删除') {
                        color = 'orange';
                    }
                    if (tag === '等待首次直播') {
                        color = 'cyan';
                    }
                    // ---- 需求6：配置了录制时间段但当前处于时段外，仅监控不录制 ----
                    if (tag === '时段外仅监控') {
                        color = 'grey';
                    }

                    return (
                        <Tag color={color} key={tag}>
                            {tag.toUpperCase()}
                        </Tag>
                    );
                })}
            </span>
        ),
        sorter: (a: ItemData, b: ItemData) => {
            // 待删除 > 一次性录制中/等待首次直播 > 录制中 > 录制准备中 > 其他
            // 「待删除」优先级最高，提醒用户尽快处理（挽留或转为永久）
            const getRecordingPriority = (tags: string[]) => {
                if (tags.includes('待删除')) return 4;
                if (tags.includes('一次性录制中') || tags.includes('等待首次直播')) return 3;
                if (tags.includes('录制中')) return 2;
                if (tags.includes('录制准备中')) return 1;
                return 0;
            };
            return getRecordingPriority(a.tags) - getRecordingPriority(b.tags);
        },
        defaultSortOrder: 'descend',
    };

    runAction: ColumnsType<ItemData>[number] = {
        title: '操作',
        key: 'action',
        dataIndex: 'listening',
        // 列宽：方案B 平铺「停止监控 / 文件 / 配置」+「更多 ▾」下拉，
        // 「待删除」行还会多出「重置为一次性 / 转为永久」两个按钮，因此给到 240px
        // （需与 TABLE_SCROLL_X / SMALL_TABLE_SCROLL_X 中的 240 保持一致）
        width: 240,
        render: (listening: boolean, data: ItemData) => {
            // 方案B：低频操作收进「更多」下拉菜单，避免操作列过于拥挤
            const moreItems: any[] = [
                {
                    key: 'schedule',
                    label: '录制时间段',
                    // 需求6：打开录制时间段配置弹窗，传入当前直播间 id
                    onClick: () => this.openRecordScheduleDialog([data.roomId]),
                },
                {
                    key: 'one-time',
                    // oneTimeStatus 非空表示当前已是一次性录制，此时提供「转为持久性录制」
                    label: data.oneTimeStatus ? '转为持久性录制' : '转为一次性录制',
                    // 需求1：一次性录制开关
                    onClick: () => {
                        api.setOneTime(data.roomId, !data.oneTimeStatus)
                            .then(() => {
                                this.refresh();
                            })
                            .catch(err => {
                                alert(`设置一次性录制失败:\n${err}`);
                            });
                    },
                },
                {
                    key: 'delete',
                    label: '删除直播间',
                    danger: true,
                    onClick: () => {
                        // 下拉菜单点击后会立即收起，因此用 Modal 做二次确认
                        Modal.confirm({
                            title: '确定删除当前直播间？',
                            content: '删除链接不会删除已录制到磁盘的文件。',
                            okText: '确定',
                            cancelText: '取消',
                            okButtonProps: { danger: true },
                            onOk: () => {
                                api.deleteRoom(data.roomId)
                                    .then(() => {
                                        api.saveSettingsInBackground();
                                        this.refresh();
                                    })
                                    .catch(err => {
                                        alert(`删除直播间失败:\n${err}`);
                                    });
                            },
                        });
                    },
                },
            ];

            return (
                <span onClick={(e) => e.stopPropagation()}>
                    <PopDialog
                        title={listening ? "确定停止监控？" : "确定开启监控？"}
                        onConfirm={(e) => {
                            if (listening) {
                                //停止监控
                                api.stopRecord(data.roomId)
                                    .then(rsp => {
                                        api.saveSettingsInBackground();
                                        this.refresh();
                                    })
                                    .catch(err => {
                                        alert(`停止监控失败:\n${err}`);
                                    });
                            } else {
                                //开启监控
                                api.startRecord(data.roomId)
                                    .then(rsp => {
                                        api.saveSettingsInBackground();
                                        this.refresh();
                                    })
                                    .catch(err => {
                                        alert(`开启监控失败:\n${err}`);
                                    });
                            }
                        }}>
                        <Button type="link" size="small">{listening ? "停止监控" : "开启监控"}</Button>
                    </PopDialog>
                    {/* 仅提醒模式下的手动录制按钮 */}
                    {data.notifyOnly && data.isLive && !data.isRecording && (
                        <>
                            <Divider type="vertical" />
                            <PopDialog
                                title="确定开始录制？"
                                onConfirm={(e) => {
                                    api.startRecordDirect(data.roomId)
                                        .then(rsp => {
                                            message.success('已开始录制');
                                            this.refresh();
                                        })
                                        .catch(err => {
                                            alert(`开始录制失败:\n${err}`);
                                        });
                                }}>
                                <Button type="primary" size="small" danger>开始录制</Button>
                            </PopDialog>
                        </>
                    )}
                    {/* 仅提醒模式下的停止录制按钮 */}
                    {data.notifyOnly && data.isLive && data.isRecording && (
                        <>
                            <Divider type="vertical" />
                            <PopDialog
                                title="确定停止录制？"
                                onConfirm={(e) => {
                                    api.stopRecordDirect(data.roomId)
                                        .then(rsp => {
                                            message.success('已停止录制');
                                            this.refresh();
                                        })
                                        .catch(err => {
                                            alert(`停止录制失败:\n${err}`);
                                        });
                                }}>
                                <Button type="default" size="small">停止录制</Button>
                            </PopDialog>
                        </>
                    )}
                    {/* 需求1：待删除行额外平铺两个高亮按钮（挽留 / 转为永久） */}
                    {data.oneTimeStatus === 'pending_delete' && (
                        <>
                            <Divider type="vertical" />
                            <PopDialog
                                title="确定将该直播间重置为一次性录制？"
                                onConfirm={(e) => {
                                    // 挽留操作：reset=true，从「待删除」重置为「一次性录制中」并重新计时
                                    api.setOneTime(data.roomId, true, true)
                                        .then(() => {
                                            message.success('已重置为一次性录制');
                                            this.refresh();
                                        })
                                        .catch(err => {
                                            alert(`重置为一次性录制失败:\n${err}`);
                                        });
                                }}>
                                <Button
                                    size="small"
                                    style={{ backgroundColor: '#52c41a', borderColor: '#52c41a', color: '#fff' }}
                                >
                                    重置为一次性
                                </Button>
                            </PopDialog>
                            <Divider type="vertical" />
                            <PopDialog
                                title="确定将该直播间转为永久录制？"
                                onConfirm={(e) => {
                                    // 转为永久：清除一次性标记，不再进入待删除
                                    api.setOneTime(data.roomId, false)
                                        .then(() => {
                                            message.success('已转为永久录制');
                                            this.refresh();
                                        })
                                        .catch(err => {
                                            alert(`转为永久录制失败:\n${err}`);
                                        });
                                }}>
                                <Button
                                    size="small"
                                    style={{ backgroundColor: '#fa8c16', borderColor: '#fa8c16', color: '#fff' }}
                                >
                                    转为永久
                                </Button>
                            </PopDialog>
                        </>
                    )}
                    <Divider type="vertical" />
                    <Button type="link" size="small" onClick={(e) => {
                        this.props.navigate(`/fileList/${data.address}/${data.name}`);
                    }}>文件</Button>
                    <Divider type="vertical" />
                    <a
                        href={`/#/configInfo#rooms-live-${data.roomId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        style={{ fontSize: 12 }}
                    >
                        配置
                    </a>
                    <Divider type="vertical" />
                    {/* 方案B：录制时间段 / 一次性录制切换 / 删除直播间 收进「更多」下拉 */}
                    <Dropdown menu={{ items: moreItems }} trigger={['click']}>
                        <Button type="link" size="small">更多 ▾</Button>
                    </Dropdown>
                </span>
            );
        },
    };

    // ---- 需求3：主播名称与运行状态之间新增的三列 ----

    // 添加链接时间（后端 added_at，unix 秒；0 或空显示 -）
    addedAtColumn: ColumnsType<ItemData>[number] = {
        title: '添加链接时间',
        dataIndex: 'addedAt',
        key: 'addedAt',
        // 列宽：165px。本列固定渲染 "YYYY-MM-DD HH:mm:ss"（19 字符，桌面端 14px 字号约 124~128px），
        // 而 antd 大号表格（size="large"）单元格左右内边距各 16px，150px 列只剩 118px 会换行；
        // 虚拟滚动按固定行高定位行，换行会让该行覆盖下一行，因此留出余量给到 165px
        // （需与 TABLE_SCROLL_X / SMALL_TABLE_SCROLL_X 中的 165 保持一致）
        width: 165,
        sorter: (a: ItemData, b: ItemData) => a.addedAt - b.addedAt,
        render: (addedAt: number) => (
            <span>{addedAt ? Utils.timestampToHumanReadable(addedAt) : '-'}</span>
        )
    };

    // 最近一次直播时间（复用后端已有字段 last_start_time_unix，unix 秒；0 表示从未直播）
    lastLiveColumn: ColumnsType<ItemData>[number] = {
        title: '最近一次直播时间',
        dataIndex: 'lastStartTimeUnix',
        key: 'lastStartTimeUnix',
        // 列宽：165px。本列固定渲染 "YYYY-MM-DD HH:mm:ss"（19 字符，桌面端 14px 字号约 124~128px），
        // 而 antd 大号表格（size="large"）单元格左右内边距各 16px，150px 列只剩 118px 会换行；
        // 虚拟滚动按固定行高定位行，换行会让该行覆盖下一行，因此留出余量给到 165px
        // （需与 TABLE_SCROLL_X / SMALL_TABLE_SCROLL_X 中的 165 保持一致）
        width: 165,
        sorter: (a: ItemData, b: ItemData) => a.lastStartTimeUnix - b.lastStartTimeUnix,
        render: (lastStartTimeUnix: number) => (
            <span>{lastStartTimeUnix ? Utils.timestampToHumanReadable(lastStartTimeUnix) : '从未直播'}</span>
        )
    };

    // 文件夹大小（folderSizeHuman 用于展示，folderSize 用于排序；表头右侧带手动刷新图标）
    folderSizeColumn: ColumnsType<ItemData>[number] = {
        // 用函数形式的 title：类字段初始化阶段 this.state 尚未赋值，不能直接求值
        title: (() => (
            <span>
                文件夹大小
                <Tooltip title="重新扫描录制目录，刷新文件夹大小">
                    <ReloadOutlined
                        spin={this.state.folderSizeRefreshing}
                        onClick={(e) => {
                            e.stopPropagation();
                            this.handleRefreshFolderSize();
                        }}
                        style={{ marginLeft: 6, color: '#1890ff', cursor: 'pointer' }}
                    />
                </Tooltip>
            </span>
        )) as any,
        dataIndex: 'folderSizeHuman',
        key: 'folderSize',
        // 列宽：130px —— 表头「文件夹大小」+ 手动刷新图标约需 90px 宽，
        // 给 100px 会让表头折成两行（需与 TABLE_SCROLL_X / SMALL_TABLE_SCROLL_X 中的 130 保持一致）
        width: 130,
        sorter: (a: ItemData, b: ItemData) => a.folderSize - b.folderSize,
        render: (folderSizeHuman: string) => (
            <span>{folderSizeHuman || '-'}</span>
        )
    };

    columns: ColumnsType<ItemData> = [
        {
            title: '主播名称',
            dataIndex: 'name',
            key: 'name',
            // 列宽：140px（需与 TABLE_SCROLL_X 中的 140 保持一致）
            width: 140,
            // 长主播名必须单行省略：虚拟滚动按**固定行高**绝对定位每一行，
            // 单元格一旦换行会让该行变高，从而压住下一行、错位整屏。
            ellipsis: true,
            sorter: (a: ItemData, b: ItemData) => {
                return a.name.localeCompare(b.name);
            },
            // 需求：主播名称列的表头支持「模糊搜索」（见 createFuzzyFilterDropdown）
            filterDropdown: createFuzzyFilterDropdown('搜索主播名称'),
            // 模糊匹配：忽略大小写、支持中文（includes 子串匹配）
            onFilter: (value: any, record: ItemData) =>
                String(record.name || '').toLowerCase().includes(String(value).toLowerCase()),
            render: (name: string) => <span>{name}</span>
        },
        {
            title: '直播间名称',
            dataIndex: 'room',
            key: 'room',
            // 列宽：140px（需与 TABLE_SCROLL_X 中的 140 保持一致；移动端不显示本列）
            width: 140,
            // 同上：长直播间名单行省略，避免换行破坏虚拟滚动的固定行高
            ellipsis: true,
            // 需求：直播间名称列同样提供模糊搜索（匹配的是 record.room.roomName，不是整个 room 对象）
            // 该列原本没有 sorter，这里只增加筛选入口，不影响其他列排序
            filterDropdown: createFuzzyFilterDropdown('搜索直播间名称'),
            // 模糊匹配房间名；record.room 理论上始终存在，这里仍做一次防御，避免脏数据导致渲染期报错
            onFilter: (value: any, record: ItemData) => {
                const roomName = (record.room && record.room.roomName) || '';
                return roomName.toLowerCase().includes(String(value).toLowerCase());
            },
            render: (room: Room) => (
                <span>
                    <a href={room.url} rel="noopener noreferrer" target="_blank" onClick={(e) => e.stopPropagation()}>{room.roomName}</a>
                    {room.lastError && (
                        <Tooltip title={room.lastError}>
                            <ExclamationCircleOutlined style={{ color: '#ff4d4f', marginLeft: 6, fontSize: 14 }} />
                        </Tooltip>
                    )}
                </span>
            )
        },
        {
            title: '直播平台',
            dataIndex: 'address',
            key: 'address',
            // 列宽：90px（平台名很短，用户要求刻意收窄；需与 TABLE_SCROLL_X 中的 90 保持一致）
            width: 90,
            sorter: (a: ItemData, b: ItemData) => {
                return a.address.localeCompare(b.address);
            },
            render: (address: string) => <span>{address}</span>
        },
        // 需求3：新增三列（添加链接时间 / 最近一次直播时间 / 文件夹大小）
        this.addedAtColumn,
        this.lastLiveColumn,
        this.folderSizeColumn,
        this.runStatus,
        this.runAction
    ];

    smallColumns: ColumnsType<ItemData> = [
        {
            title: '主播名称',
            dataIndex: 'name',
            key: 'name',
            // 列宽：140px（需与 SMALL_TABLE_SCROLL_X 中的 140 保持一致）
            width: 140,
            // 同上：长主播名单行省略，避免换行破坏虚拟滚动的固定行高
            ellipsis: true,
            // 需求：移动端（小屏）的主播名称列同样提供模糊搜索，与桌面端保持一致
            filterDropdown: createFuzzyFilterDropdown('搜索主播名称'),
            onFilter: (value: any, record: ItemData) =>
                String(record.name || '').toLowerCase().includes(String(value).toLowerCase()),
            render: (name: string, data: ItemData) => (
                <span>
                    <a href={data.room.url} rel="noopener noreferrer" target="_blank" onClick={(e) => e.stopPropagation()}>{name}</a>
                    {data.room.lastError && (
                        <Tooltip title={data.room.lastError}>
                            <ExclamationCircleOutlined style={{ color: '#ff4d4f', marginLeft: 6, fontSize: 14 }} />
                        </Tooltip>
                    )}
                </span>
            )
        },
        // 需求3：移动端同样展示新增三列
        this.addedAtColumn,
        this.lastLiveColumn,
        this.folderSizeColumn,
        this.runStatus,
        this.runAction
    ];
    cookieColumns: ColumnsType<CookieItemData> = [
        {
            title: '直播平台',
            dataIndex: 'livename',
            key: 'livename',
            render: (name: string, data: CookieItemData) => {
                const isDouyu = data.Host === 'www.douyu.com' || data.Host === 'douyu.com';
                return (
                    <span>
                        {data.Platform_cn_name + '(' + data.Host + ')'}
                        {isDouyu && this.state.douyuNeedRescan && (
                            <Tooltip title="斗鱼登录 Cookie 自动续期已失败（长期凭证失效），录制将退回匿名录制，请点击右侧按钮重新扫码登录">
                                <Tag color="red" style={{ marginLeft: 8 }}>需重新扫码</Tag>
                            </Tooltip>
                        )}
                    </span>
                );
            }
        }, {
            title: 'Cookie',
            dataIndex: 'Cookie',
            key: 'Cookie',
            ellipsis: true,
            render: (name: String, data: CookieItemData) => {
                return <Row gutter={16}>
                    <Col className="gutter-row" span={12}>
                        <Tooltip title={data.Cookie}>
                            <div className="gutter-box cookieString" title={data.Cookie}>{data.Cookie}</div>
                        </Tooltip>
                    </Col>
                    <Col className="gutter-row" span={4}>
                        <div className="gutter-box">
                            <Button type="primary" shape="circle" icon={<EditOutlined />} onClick={() => {
                                this.onEditCookitClick(data)
                            }} />
                        </div>
                    </Col>
                </Row>
            }
        }
    ]

    constructor(props: Props) {
        super(props);
        // 从 localStorage 加载排序状态
        let savedSortedInfo = { columnKey: null as string | null, order: null as 'ascend' | 'descend' | null };
        try {
            const saved = localStorage.getItem('liveListSortedInfo');
            if (saved) {
                savedSortedInfo = JSON.parse(saved);
            }
        } catch (e) {
            console.error('加载排序状态失败:', e);
        }
        this.state = {
            list: [],
            cookieList: [],
            batchAddDialogVisible: false,
            window: window,
            expandedRowKeys: [],
            expandedDetails: {},
            expandedLogs: {},
            sseSubscriptions: {},
            globalConfig: null,
            countdownTimers: {},
            lastUpdateTimes: {},
            refreshStatus: {},
            listSSESubscription: null,
            enableListSSE: isListSSEEnabled(),
            sortedInfo: savedSortedInfo,
            danmakuMessages: {},
            expandedActiveTabs: {},
            douyuNeedRescan: false,
            selectedRowKeys: [],
            batchOperating: false,
            recordScheduleDialogVisible: false,
            recordScheduleRoomIds: [],
            folderSizeRefreshing: false,
            // 列设置：从 localStorage 恢复用户上次的列显隐选择，读不到则全部可见
            visibleColumnKeys: loadVisibleColumnKeys(),
        }
    }

    pendingRoomId: string | null = null;

    // 监听localStorage设置变化的处理函数
    handleLocalSettingsChange = (event: CustomEvent) => {
        const newSettings = event.detail;
        const oldEnableSSE = this.state.enableListSSE;
        const newEnableSSE = newSettings.enableListSSE;

        if (oldEnableSSE !== newEnableSSE) {
            this.setState({ enableListSSE: newEnableSSE }, () => {
                if (newEnableSSE) {
                    // 启用SSE，设置SSE订阅
                    this.setupListSSE();
                    // 减少轮询频率（使用更长的间隔）
                    clearInterval(this.timer);
                    this.timer = setInterval(() => {
                        this.requestData("livelist");
                    }, getRefreshTime() * 2); // SSE模式下轮询作为备份，间隔翻倍
                } else {
                    // 禁用SSE，取消订阅
                    this.cleanupListSSE();
                    // 恢复正常轮询频率
                    clearInterval(this.timer);
                    this.timer = setInterval(() => {
                        this.requestData("livelist");
                    }, getRefreshTime());
                }
            });
        }
    };

    componentDidMount() {
        // 解析 URL 参数以支持深度链接
        const hash = window.location.hash;
        if (hash.includes('?')) {
            const searchParams = new URLSearchParams(hash.split('?')[1]);
            this.pendingRoomId = searchParams.get('room');
        }

        // 监听localStorage设置变化
        window.addEventListener('localSettingsChanged', this.handleLocalSettingsChange as EventListener);

        this.requestData("livelist"); // Call with a specific targetKey
        this.fetchGlobalConfig().then(() => {
            // 根据用户设置决定是否启用列表级别SSE
            if (this.state.enableListSSE) {
                this.setupListSSE();
            }
        });

        // 设置轮询定时器，SSE模式下使用更长的间隔作为备份
        const refreshInterval = this.state.enableListSSE ? getRefreshTime() * 2 : getRefreshTime();
        this.timer = setInterval(() => {
            this.requestData("livelist"); // Call with a specific targetKey
        }, refreshInterval);

        // 启动倒计时定时器，每秒更新一次
        this.countdownTimer = setInterval(() => {
            this.updateCountdowns();
        }, 1000);
    }

    fetchGlobalConfig = async () => {
        try {
            const config = await api.getEffectiveConfig();
            this.setState({ globalConfig: config });
        } catch (error) {
            console.error('Failed to fetch global config:', error);
        }
    }

    // 设置列表级别的SSE订阅
    // ---- 性能：SSE 触发的列表刷新防抖 ----
    //
    // 后端对每个直播间分别广播 live_update / list_change。批量操作、程序启动、
    // 或短时间内多个房间状态变化时，前端可能瞬间收到几十上百条事件；
    // 原先每条都立即 requestListData()（拉取 210 条、约 65KB 响应）并 setState，
    // 会连续触发全表重渲染，直接表现为主线程长时间繁忙、界面点击/悬停无响应。
    // 这里把窗口内的多次刷新合并为一次。
    private listRefreshTimer: NodeJS.Timeout | null = null;

    // scheduleListRefresh 延迟合并列表刷新请求。
    // delay 默认 400ms：既能合并突发事件，又不会让状态变化看起来明显延迟。
    scheduleListRefresh = (delay = 400) => {
        if (this.listRefreshTimer) {
            clearTimeout(this.listRefreshTimer);
        }
        this.listRefreshTimer = setTimeout(() => {
            this.listRefreshTimer = null;
            this.requestListData();
        }, delay);
    };

    setupListSSE = () => {
        // 如果已经有订阅，先清理
        this.cleanupListSSE();

        // 订阅所有房间的 live_update 事件（直播状态变化）
        const liveUpdateSubId = subscribeSSE('*', 'live_update', (message: SSEMessage) => {
            // 性能：改用合并刷新，避免突发多条事件时连续重渲染整个列表
            this.scheduleListRefresh();
            // 如果该房间已展开，也刷新详情
            if (this.state.expandedRowKeys.includes(message.room_id)) {
                this.loadRoomDetail(message.room_id);
            }
        });

        // 订阅 list_change 事件（直播间增删、监控开关等）
        const listChangeSubId = subscribeSSE('*', 'list_change', (message: SSEMessage) => {
            console.log('[SSE] List change event:', message);
            const roomId = message.room_id;
            const changeType = message.data?.change_type;

            // 性能：同上，合并刷新
            this.scheduleListRefresh();

            // 如果该房间已展开，且是监控开关变化，重新加载详情（更新调度器状态）
            if (roomId && this.state.expandedRowKeys.includes(roomId)) {
                if (changeType === 'listen_start' || changeType === 'listen_stop') {
                    // 稍微延迟以确保后端状态已更新
                    setTimeout(() => {
                        this.loadRoomDetail(roomId);
                    }, 500);
                }
            }
        });

        // 订阅 rate_limit_update 事件（强制刷新后更新频率限制信息）
        const rateLimitSubId = subscribeSSE('*', 'rate_limit_update', (message: SSEMessage) => {
            console.log('[SSE] Rate limit update event:', message);
            const roomId = message.room_id;
            // 如果该房间已展开，更新频率限制信息
            if (this.state.expandedRowKeys.includes(roomId)) {
                this.handleRateLimitUpdate(roomId, message.data);
            }
        });

        // 保存所有订阅ID（用下划线连接，或者使用新的数据结构）
        this.setState({
            listSSESubscription: `${liveUpdateSubId}|${listChangeSubId}|${rateLimitSubId}`
        });
    }

    // 清理列表级别的SSE订阅
    cleanupListSSE = () => {
        const { listSSESubscription } = this.state;
        if (listSSESubscription) {
            // 取消所有订阅
            const subIds = listSSESubscription.split('|');
            subIds.forEach(subId => {
                if (subId) {
                    unsubscribeSSE(subId);
                }
            });
            this.setState({ listSSESubscription: null });
        }
    }

    // 处理频率限制更新事件（包括调度器刷新完成）
    handleRateLimitUpdate = (roomId: string, updateData: any) => {
        this.setState(prevState => {
            const currentDetail = prevState.expandedDetails[roomId];
            if (!currentDetail) {
                return prevState;
            }

            // 检查是否是调度器刷新完成事件
            const schedulerStatus = updateData?.scheduler_status;
            if (schedulerStatus) {
                // 从调度器状态计算倒计时
                let countdown: number;
                let status: RefreshStatus;

                if (!schedulerStatus.scheduler_running || !schedulerStatus.has_waiters) {
                    // 调度器未运行或没有等待者，无刷新计划
                    countdown = -1;
                    status = 'no_schedule';
                } else if (schedulerStatus.seconds_until_next_request > 0) {
                    // 有下次请求计划
                    countdown = Math.ceil(schedulerStatus.seconds_until_next_request);
                    status = 'waiting_interval';
                } else {
                    // 距离下次请求时间已过
                    countdown = 0;
                    status = 'idle';
                }

                // 更新详情中的调度器状态
                const updatedDetail = {
                    ...currentDetail,
                    scheduler_status: schedulerStatus
                };

                return {
                    ...prevState,
                    expandedDetails: {
                        ...prevState.expandedDetails,
                        [roomId]: updatedDetail
                    },
                    countdownTimers: {
                        ...prevState.countdownTimers,
                        [roomId]: countdown
                    },
                    lastUpdateTimes: {
                        ...prevState.lastUpdateTimes,
                        [roomId]: Date.now()
                    },
                    refreshStatus: {
                        ...prevState.refreshStatus,
                        [roomId]: status
                    }
                };
            }

            // 旧的频率限制信息处理逻辑（兼容性保留）
            const rateLimitInfo = updateData;
            const rateLimitEnabled = rateLimitInfo?.enabled
                ?? currentDetail?.platform_rate_limit_enabled
                ?? true;
            const updatedDetail = {
                ...currentDetail,
                platform_rate_limit_enabled: rateLimitEnabled,
                platform_rate_limit: rateLimitEnabled ? currentDetail?.platform_rate_limit : 0,
                rate_limit_info: {
                    ...rateLimitInfo,
                    enabled: rateLimitEnabled
                }
            };

            if (!rateLimitEnabled) {
                return {
                    ...prevState,
                    expandedDetails: {
                        ...prevState.expandedDetails,
                        [roomId]: updatedDetail
                    },
                    countdownTimers: {
                        ...prevState.countdownTimers,
                        [roomId]: 0
                    },
                    lastUpdateTimes: {
                        ...prevState.lastUpdateTimes,
                        [roomId]: Date.now()
                    },
                    refreshStatus: {
                        ...prevState.refreshStatus,
                        [roomId]: 'idle'
                    }
                };
            }

            const nextRequestInSec = Math.ceil(rateLimitInfo?.next_request_in_sec || 0);
            const minIntervalSec = rateLimitInfo?.min_interval_sec || currentDetail?.platform_rate_limit || 20;
            const waitedSec = Math.round(rateLimitInfo?.waited_seconds || 0);
            const initialCountdown = nextRequestInSec > 0 ? nextRequestInSec : minIntervalSec - waitedSec;

            return {
                ...prevState,
                expandedDetails: {
                    ...prevState.expandedDetails,
                    [roomId]: updatedDetail
                },
                countdownTimers: {
                    ...prevState.countdownTimers,
                    [roomId]: Math.max(0, initialCountdown)
                },
                lastUpdateTimes: {
                    ...prevState.lastUpdateTimes,
                    [roomId]: Date.now()
                },
                refreshStatus: {
                    ...prevState.refreshStatus,
                    [roomId]: nextRequestInSec > 0 ? 'waiting_interval' : 'idle'
                }
            };
        });
    }

    // 根据列表大小更新SSE订阅策略（保留但简化，因为现在SSE始终订阅）
    updateListSSESubscription = () => {
        // 如果用户启用了SSE但尚未订阅，则设置订阅
        if (this.state.enableListSSE && !this.state.listSSESubscription) {
            this.setupListSSE();
        }
    }

    componentWillUnmount() {
        //clear refresh timer
        clearInterval(this.timer);
        clearInterval(this.countdownTimer);
        // 性能：清理列表合并刷新的定时器，避免组件卸载后仍触发 setState
        if (this.listRefreshTimer) {
            clearTimeout(this.listRefreshTimer);
            this.listRefreshTimer = null;
        }
        // 清理弹幕批量缓冲
        if (this.danmakuFlushTimer) {
            clearTimeout(this.danmakuFlushTimer);
            this.danmakuFlushTimer = null;
        }
        this.danmakuBuffer = {};

        // 移除localStorage设置变化监听
        window.removeEventListener('localSettingsChanged', this.handleLocalSettingsChange as EventListener);

        // 取消列表级别的SSE订阅
        this.cleanupListSSE();

        // 取消所有详情页的 SSE 订阅
        const { sseSubscriptions } = this.state;
        Object.values(sseSubscriptions).forEach(subId => {
            unsubscribeSSE(subId);
        });
    }

    onCookieRef = (ref: EditCookieDialog) => {
        this.cookieChild = ref
    }

    onEditCookitClick = (data: any) => {
        this.cookieChild.showModal(data)
    }

    /**
     * 保存设置至config文件
     */
    onSettingSave = () => {
        api.saveSettings()
            .then((rsp: any) => {
                if (rsp.err_no === 0) {
                    alert("设置保存成功");
                } else {
                    alert("Server Error!");
                }
            }).catch(err => {
                alert(`Server Error!:\n${err}`);
            })
    }

    /**
     * 刷新页面数据
     */
    refresh = () => {
        this.requestListData();
    }

    refreshCookie = () => {
        this.requestCookieData();
    }

    // ==================== 需求7：多选与批量操作 ====================

    // 更新表格多选状态（rowKey 为 roomId，统一转成字符串便于比较）
    setSelectedRowKeys = (keys: React.Key[]) => {
        this.setState({ selectedRowKeys: keys.map(key => String(key)) });
    }

    /**
     * 执行批量操作
     * @param action 操作类型：start | stop | delete | set_one_time | set_persistent | set_schedule
     * @param schedule 仅 action=set_schedule 时使用
     */
    handleBatchOperation = (action: string, schedule?: any) => {
        const ids = this.state.selectedRowKeys;
        if (ids.length === 0 || this.state.batchOperating) {
            return;
        }
        this.setState({ batchOperating: true });
        api.batchOperation(ids, action, schedule)
            .then((rsp: any) => {
                if (rsp && rsp.err_no === 0) {
                    message.success(`批量操作完成（共 ${ids.length} 项）`);
                } else {
                    message.error(`批量操作失败：${(rsp && rsp.err_msg) || '未知错误'}`);
                }
                // 无论成功与否都清空选择并刷新列表，保证界面状态与后端一致
                this.setState({ selectedRowKeys: [], batchOperating: false });
                this.refresh();
            })
            .catch(err => {
                this.setState({ batchOperating: false });
                alert(`批量操作失败:\n${err}`);
            });
    }

    // 打开录制时间段配置弹窗（支持单个直播间与批量）
    openRecordScheduleDialog = (roomIds: string[]) => {
        if (!roomIds || roomIds.length === 0) {
            return;
        }
        this.setState({ recordScheduleRoomIds: roomIds, recordScheduleDialogVisible: true });
    }

    // ==================== 需求3：文件夹大小手动刷新 ====================

    // 手动触发后端重新扫描录制目录（不传 ids 表示刷新全部）
    handleRefreshFolderSize = () => {
        if (this.state.folderSizeRefreshing) {
            return;
        }
        this.setState({ folderSizeRefreshing: true });
        api.refreshFolderSize()
            .then(() => {
                this.setState({ folderSizeRefreshing: false });
                this.refresh();
            })
            .catch(err => {
                this.setState({ folderSizeRefreshing: false });
                alert(`刷新文件夹大小失败:\n${err}`);
            });
    }

    /**
     * 加载列表数据
     */
    requestListData() {
        api.getRoomList()
            .then(function (rsp: any) {
                if (rsp.length === 0) {
                    return [];
                }
                return rsp.map((item: any, index: number) => {
                    //判断标签状态
                    let tags;
                    if (item.listening === true) {
                        tags = ['监控中'];
                    } else {
                        tags = ['已停止'];
                    }

                    if (item.recording === true) {
                        tags = ['录制中'];
                    } else if (item.recording_preparing === true) {
                        tags = ['录制准备中'];
                    }

                    if (item.initializing === true) {
                        tags.push('初始化')
                    }

                    // 仅提醒模式标签
                    if (item.notify_only === true) {
                        tags.push('仅提醒')
                    }

                    // ---- 需求1：一次性录制状态标签 ----
                    if (item.one_time_status === 'recording') {
                        tags.push('一次性录制中')
                    }
                    if (item.one_time_status === 'pending_delete') {
                        tags.push('待删除')
                    }
                    if (item.one_time_status === 'waiting_first_live') {
                        tags.push('等待首次直播')
                    }

                    // ---- 需求6：配置了录制时间段但当前处于时段外，仅监控不录制 ----
                    if (item.schedule_enabled === true && item.schedule_active !== true && item.listening === true) {
                        tags.push('时段外仅监控')
                    }

                    return {
                        key: index + 1,
                        name: item.nick_name || item.host_name,
                        room: {
                            roomName: item.room_name,
                            url: item.live_url,
                            lastError: item.last_error
                        },
                        address: item.platform_cn_name,
                        tags,
                        listening: item.listening,
                        roomId: item.id,
                        notifyOnly: item.notify_only || false,
                        isLive: item.status || false,
                        isRecording: (item.recording || item.recording_preparing) || false,
                        // ---- 需求3：列表新增三列所需的字段 ----
                        addedAt: item.added_at || 0,
                        lastStartTimeUnix: item.last_start_time_unix || 0,
                        folderSize: item.folder_size || 0,
                        folderSizeHuman: item.folder_size_human || '',
                        // ---- 需求1/6：一次性录制与录制时间段状态 ----
                        oneTimeStatus: item.one_time_status || '',
                        scheduleEnabled: item.schedule_enabled === true,
                        scheduleActive: item.schedule_active === true,
                    };
                });
            })
            .then((data: ItemData[]) => {
                const oldListLength = this.state.list.length;
                // 需求7：列表刷新后剔除已不存在的选中项，避免批量操作携带失效 id
                const validRoomIds = new Set(data.map(item => item.roomId));
                const nextSelectedRowKeys = this.state.selectedRowKeys.filter(id => validRoomIds.has(id));
                this.setState({
                    list: data,
                    selectedRowKeys: nextSelectedRowKeys
                }, () => {
                    // 如果列表大小发生变化，重新评估SSE订阅策略
                    if (oldListLength !== data.length) {
                        this.updateListSSESubscription();
                    }

                    // 处理深度链接自动展开
                    if (this.pendingRoomId) {
                        // 先取出到局部变量：下面会立即把 this.pendingRoomId 置空，
                        // 而 setTimeout 回调是 500ms 后才执行，闭包里再读 this.pendingRoomId 只会拿到 null
                        const pendingRoomId = this.pendingRoomId;
                        const targetRoom = data.find(item => item.roomId === pendingRoomId);
                        if (targetRoom) {
                            if (!this.state.expandedRowKeys.includes(pendingRoomId)) {
                                this.toggleExpandRow(pendingRoomId);
                            }
                            // 滚动到该行。
                            // 虚拟滚动下目标行可能不在已渲染的窗口里（getElementById 会拿到 null），
                            // 所以这里优先用 Table 实例的 scrollTo({ key }) 让虚拟列表滚动到目标行；
                            // 若该行恰好已渲染，再补一个高亮 class 作视觉提示。
                            setTimeout(() => {
                                const table: any = this.tableRef.current;
                                if (table && typeof table.scrollTo === 'function') {
                                    table.scrollTo({ key: pendingRoomId });
                                }
                                const element = document.getElementById(`row-live-${pendingRoomId}`);
                                if (element) {
                                    element.classList.add('highlight-row'); // 可以添加 CSS 动画
                                }
                            }, 500);
                        }
                        // 清除 pending，避免后续刷新重复操作
                        this.pendingRoomId = null;
                    }
                });
            })
            .catch(err => {
                alert(`加载列表数据失败:\n${err}`);
            });
    }

    requestCookieData() {
        api.getCookieList()
            .then((data: any) => {
                this.setState({ cookieList: Array.isArray(data) ? data : [] });
            })
            .catch(err => {
                // 与 requestListData 不同，这里原先没有 catch：网络异常时是未处理的 Promise rejection
                console.error(`加载 Cookie 列表失败:\n${err}`);
            })
        // 顺带拉取斗鱼自动续期状态，续期失败时在列表上给出可见提醒
        api.getDouyuAuthStatus()
            .then((res: any) => {
                this.setState({ douyuNeedRescan: !!(res && res.err_no === 0 && res.data && res.data.need_rescan) });
            })
            .catch(() => {
                // 旧后端无此接口时忽略，不影响 cookie 列表本身
            })
    }

    requestData = (targetKey: string) => {
        switch (targetKey) {
            case "livelist":
                this.requestListData()
                break
            case "cookielist":
                this.requestCookieData()
                break
        }
    }

    // 处理表格排序变化
    handleTableChange = (pagination: any, filters: any, sorter: any) => {
        const sortedInfo = {
            columnKey: sorter.columnKey || null,
            order: sorter.order || null,
        };
        this.setState({ sortedInfo });
        // 保存到 localStorage
        try {
            localStorage.setItem('liveListSortedInfo', JSON.stringify(sortedInfo));
        } catch (e) {
            console.error('保存排序状态失败:', e);
        }
    };

    // 获取带有动态排序状态的列配置
    getColumnsWithSort = (columns: ColumnsType<ItemData>): ColumnsType<ItemData> => {
        const { sortedInfo } = this.state;
        return columns.map(col => {
            // 如果列有 key 且匹配当前排序列，则设置 sortOrder
            if (col.key && col.key === sortedInfo.columnKey) {
                return { ...col, sortOrder: sortedInfo.order };
            }
            // 其他列清除排序状态（如果有 defaultSortOrder，也需要覆盖）
            if ('sortOrder' in col || 'defaultSortOrder' in col) {
                return { ...col, sortOrder: col.key === sortedInfo.columnKey ? sortedInfo.order : undefined };
            }
            return col;
        });
    };

    // ==================== 列设置：自由开关每一列 ====================

    // 把当前可见列写回 localStorage（持久化失败不影响界面）
    saveVisibleColumnKeys = (keys: string[]) => {
        try {
            localStorage.setItem(VISIBLE_COLUMNS_STORAGE_KEY, JSON.stringify(keys));
        } catch (e) {
            console.error('保存列显示设置失败:', e);
        }
    };

    // Checkbox 组变化：勾选显示 / 取消隐藏某一列。
    // 约束：至少保留一列可切换列，全部取消时直接拦截并提示（不允许把表格变成空表）。
    handleVisibleColumnsChange = (checkedValues: any) => {
        const keys = (Array.isArray(checkedValues) ? checkedValues : []).map((key: any) => String(key));
        if (keys.length === 0) {
            message.warning('至少要保留一列，不能把所有列都隐藏');
            return;
        }
        this.setState({ visibleColumnKeys: keys });
        this.saveVisibleColumnKeys(keys);
    };

    // 「全选」：所有可切换列全部显示
    handleSelectAllColumns = () => {
        const keys = [...SWITCHABLE_COLUMN_KEYS];
        this.setState({ visibleColumnKeys: keys });
        this.saveVisibleColumnKeys(keys);
    };

    // 「重置」：恢复默认（默认即全部可见）
    handleResetColumns = () => {
        const keys = [...SWITCHABLE_COLUMN_KEYS];
        this.setState({ visibleColumnKeys: keys });
        this.saveVisibleColumnKeys(keys);
    };

    // 列设置面板内容：Checkbox 组 + 全选/重置快捷操作
    // 说明：「操作」列不在面板里，它始终显示
    renderColumnSettingPanel = () => (
        <div style={{ minWidth: 200 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <Button type="link" size="small" style={{ padding: 0 }} onClick={this.handleSelectAllColumns}>全选</Button>
                <Button type="link" size="small" style={{ padding: 0 }} onClick={this.handleResetColumns}>重置</Button>
            </div>
            <Divider style={{ margin: '4px 0 8px' }} />
            <Checkbox.Group
                value={this.state.visibleColumnKeys}
                onChange={this.handleVisibleColumnsChange}
                style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
                {SWITCHABLE_COLUMN_KEYS.map(key => (
                    <Checkbox key={key} value={key}>{COLUMN_KEY_LABELS[key] || key}</Checkbox>
                ))}
            </Checkbox.Group>
            <div style={{ color: '#999', fontSize: 12, marginTop: 8, paddingTop: 6, borderTop: '1px dashed #f0f0f0' }}>
                「操作」列始终显示
            </div>
        </div>
    );

    // ---- 性能：列定义缓存 ----
    //
    // antd Table 对 columns 的「引用变化」极为敏感：引用一变就会重建列结构、重算固定列与筛选器，
    // 对 210 行的表格来说这是每次渲染的固定开销。
    // 原先每次 render 都调用 getColumnsWithSort(...) 生成新数组，并在 render() 里就地改写
    // this.columns 的 filters/onFilter（同样每次生成新数组），二者叠加使 Table 每次渲染都全量重建。
    // 这里按「影响列内容的键」把结果缓存起来。
    private cachedColumns: ColumnsType<ItemData> | null = null;
    private cachedColumnsKey = '';
    private cachedAddressFilterKey = '';

    // getCachedColumns 返回带排序状态的列定义，仅在真正影响列内容的条件变化时才重建。
    // 影响列内容的条件：屏幕宽窄（决定用 columns 还是 smallColumns）、排序状态、平台筛选列表、列显示设置。
    getCachedColumns = (): ColumnsType<ItemData> => {
        const isSmall = this.state.window.screen.width <= 768;
        const baseColumns = isSmall ? this.smallColumns : this.columns;

        // 平台筛选列表（去重后作为筛选器选项）；只有它变化时才需要重建列
        const addressList = Array.from(new Set(this.state.list.map(item => item.address)));
        const addressKey = addressList.join('\u0001');

        const { sortedInfo, visibleColumnKeys } = this.state;
        // 列显示设置必须进入缓存键：否则用户切换列显隐后缓存不失效，界面不会更新
        const visibleKey = visibleColumnKeys.join(',');
        const cacheKey = `${isSmall}|${sortedInfo.columnKey}|${sortedInfo.order}|${addressKey}|${visibleKey}`;
        if (this.cachedColumns && this.cachedColumnsKey === cacheKey) {
            return this.cachedColumns;
        }

        // 平台列的筛选器取决于当前列表里实际出现了哪些平台，属动态项，
        // 仅在列表真的变化时更新一次，避免每次渲染都赋一个新数组让 Table 误判为"列变了"。
        // 注意：这里遍历的是未过滤的 baseColumns，被隐藏的列同样会被更新，
        // 这样用户重新勾选该列时筛选器选项依然是最新的。
        if (this.cachedAddressFilterKey !== addressKey) {
            this.cachedAddressFilterKey = addressKey;
            baseColumns.forEach((column: ColumnsType<ItemData>[number]) => {
                if (column.key === 'address') {
                    column.filters = addressList.map(text => ({ text, value: text }));
                    column.onFilter = (value: string | number | boolean, record: ItemData) =>
                        record.address === value;
                }
            });
        }

        // 按用户的列设置过滤列：「操作」列始终显示，其余列只有被勾选时才出现。
        // 列元素本身仍是同一批对象引用，Table 不会因为过滤本身而重建列结构。
        const visibleColumns = baseColumns.filter((column: ColumnsType<ItemData>[number]) => {
            const key = String(column.key || '');
            if (key === ALWAYS_VISIBLE_COLUMN_KEY) {
                return true;
            }
            return visibleColumnKeys.includes(key);
        });

        this.cachedColumns = this.getColumnsWithSort(visibleColumns);
        this.cachedColumnsKey = cacheKey;
        return this.cachedColumns;
    };

    toggleExpandRow = (roomId: string) => {
        const isCurrentlyExpanded = this.state.expandedRowKeys.includes(roomId);

        if (isCurrentlyExpanded) {
            // 收起 - 取消 SSE 订阅并清理倒计时状态
            const subscriptionId = this.state.sseSubscriptions[roomId];
            if (subscriptionId) {
                unsubscribeSSE(subscriptionId);
            }
            this.setState(prevState => {
                const newSubscriptions = { ...prevState.sseSubscriptions };
                const newCountdowns = { ...prevState.countdownTimers };
                const newLastUpdateTimes = { ...prevState.lastUpdateTimes };
                const newRefreshStatus = { ...prevState.refreshStatus };
                const newDanmakuMessages = { ...prevState.danmakuMessages };
                const newActiveTabs = { ...prevState.expandedActiveTabs };
                delete newSubscriptions[roomId];
                delete newCountdowns[roomId];
                delete newLastUpdateTimes[roomId];
                delete newRefreshStatus[roomId];
                delete newDanmakuMessages[roomId];
                delete newActiveTabs[roomId];
                // 清理弹幕缓冲
                delete this.danmakuBuffer[roomId];
                return {
                    expandedRowKeys: prevState.expandedRowKeys.filter(key => key !== roomId),
                    sseSubscriptions: newSubscriptions,
                    countdownTimers: newCountdowns,
                    lastUpdateTimes: newLastUpdateTimes,
                    refreshStatus: newRefreshStatus,
                    danmakuMessages: newDanmakuMessages,
                    expandedActiveTabs: newActiveTabs,
                };
            });
        } else {
            // 展开 - 获取详细信息和日志，并订阅 SSE
            this.setState(prevState => ({
                expandedRowKeys: [...prevState.expandedRowKeys, roomId]
            }), () => {
                // 在状态更新后执行副作用
                this.loadRoomDetail(roomId);
                this.loadRoomLogs(roomId);
                this.subscribeRoomSSE(roomId);
            });
        }
    }

    // 订阅房间的 SSE 事件
    subscribeRoomSSE = (roomId: string) => {
        // 订阅所有该房间的事件
        const subscriptionId = subscribeSSE(roomId, '*', (message: SSEMessage) => {
            this.handleSSEMessage(roomId, message);
        });

        this.setState(prevState => ({
            sseSubscriptions: {
                ...prevState.sseSubscriptions,
                [roomId]: subscriptionId
            }
        }));
    }

    // 处理 SSE 消息
    handleSSEMessage = (roomId: string, message: SSEMessage) => {
        switch (message.type) {
            case 'log':
                // 追加新日志
                this.setState(prevState => {
                    const currentLogs = prevState.expandedLogs[roomId] || [];
                    // 限制日志数量，保留最新的 500 条（与 LogPanel 的 MAX_LOG_LINES 保持一致）
                    const newLogs = [...currentLogs, message.data].slice(-500);
                    return {
                        expandedLogs: {
                            ...prevState.expandedLogs,
                            [roomId]: newLogs
                        }
                    };
                });
                break;

            case 'live_update':
                // 刷新房间详情
                this.loadRoomDetail(roomId);
                // 性能：合并刷新列表，避免突发多条事件时连续重渲染整个表格
                this.scheduleListRefresh();
                break;

            case 'conn_stats':
                // 更新连接统计
                this.setState(prevState => {
                    const currentDetail = prevState.expandedDetails[roomId];
                    if (!currentDetail) {
                        return prevState;
                    }
                    return {
                        ...prevState,
                        expandedDetails: {
                            ...prevState.expandedDetails,
                            [roomId]: {
                                ...currentDetail,
                                conn_stats: message.data
                            }
                        }
                    };
                });
                break;

            case 'recorder_status':
                // 更新录制器状态（包含下载速度）
                this.setState(prevState => {
                    const currentDetail = prevState.expandedDetails[roomId];
                    if (!currentDetail) {
                        return prevState;
                    }
                    return {
                        ...prevState,
                        expandedDetails: {
                            ...prevState.expandedDetails,
                            [roomId]: {
                                ...currentDetail,
                                recorder_status: message.data
                            }
                        }
                    };
                });
                break;

            case 'danmaku':
                // 只在"实时弹幕"Tab 激活时累积消息
                if (this.state.expandedActiveTabs[roomId] === 'danmaku' &&
                    message.data && message.data.type && message.data.username && message.data.timestamp) {
                    // 写入缓冲区，不立即 setState
                    if (!this.danmakuBuffer[roomId]) {
                        this.danmakuBuffer[roomId] = [];
                    }
                    this.danmakuBuffer[roomId].push(message.data as DanmakuMessage);
                    // 启动 flush 定时器（如果还没启动）
                    if (!this.danmakuFlushTimer) {
                        this.danmakuFlushTimer = setTimeout(() => this.flushDanmakuBuffer(), 100);
                    }
                }
                break;
        }
    }

    // 批量 flush 弹幕缓冲到 state（每 100ms 最多一次 setState）
    flushDanmakuBuffer = () => {
        this.danmakuFlushTimer = null;
        const entries = Object.entries(this.danmakuBuffer);
        if (entries.length === 0) return;

        // 清空缓冲区
        this.danmakuBuffer = {};

        this.setState(prevState => {
            const newMsgs = { ...prevState.danmakuMessages };
            for (const [roomId, msgs] of entries) {
                if (prevState.expandedActiveTabs[roomId] !== 'danmaku') continue;
                const current = newMsgs[roomId] || [];
                newMsgs[roomId] = [...current, ...msgs].slice(-500);
            }
            return { danmakuMessages: newMsgs };
        });
    }

    loadRoomDetail = (roomId: string) => {
        api.getLiveDetail(roomId)
            .then((detail: any) => {
                this.setState(prevState => {
                    // 优先使用 scheduler_status 来确定刷新状态
                    const schedulerStatus = detail.scheduler_status;
                    const rateLimitInfo = detail.rate_limit_info;
                    const rateLimitEnabled = detail.platform_rate_limit_enabled
                        ?? rateLimitInfo?.enabled
                        ?? true;

                    let initialCountdown = 0;
                    let initialStatus: RefreshStatus = 'idle';

                    if (schedulerStatus) {
                        // 有调度器状态信息
                        if (!schedulerStatus.has_waiters) {
                            // 没有等待者，说明没有安排定期刷新
                            initialStatus = 'no_schedule';
                            initialCountdown = -1; // 特殊值表示无计划
                        } else if (schedulerStatus.seconds_until_next_request > 0) {
                            // 有下次请求计划
                            initialCountdown = Math.ceil(schedulerStatus.seconds_until_next_request);
                            // 检查是否在等待平台限制
                            if (rateLimitEnabled && rateLimitInfo?.next_request_in_sec > 0) {
                                initialStatus = 'waiting_rate_limit';
                            } else {
                                initialStatus = 'waiting_interval';
                            }
                        } else if (schedulerStatus.seconds_until_next_request === 0) {
                            // 即将发送请求或正在等待平台限制
                            if (rateLimitEnabled && rateLimitInfo?.next_request_in_sec > 0) {
                                initialCountdown = Math.ceil(rateLimitInfo.next_request_in_sec);
                                initialStatus = 'waiting_rate_limit';
                            } else {
                                initialCountdown = 0;
                                initialStatus = 'idle';
                            }
                        } else {
                            // seconds_until_next_request < 0，表示没有计划
                            initialStatus = 'no_schedule';
                            initialCountdown = -1;
                        }
                    } else {
                        // 回退到旧逻辑（兼容性）
                        if (!rateLimitEnabled) {
                            initialCountdown = 0;
                            initialStatus = 'idle';
                        } else {
                            const nextRequestInSec = Math.ceil(rateLimitInfo?.next_request_in_sec || 0);
                            const minIntervalSec = rateLimitInfo?.min_interval_sec || detail.platform_rate_limit || 20;
                            const waitedSec = Math.round(rateLimitInfo?.waited_seconds || 0);

                            if (nextRequestInSec > 0) {
                                initialCountdown = nextRequestInSec;
                                initialStatus = 'waiting_rate_limit';
                            } else if (waitedSec < minIntervalSec) {
                                initialCountdown = minIntervalSec - waitedSec;
                                initialStatus = 'waiting_interval';
                            } else {
                                initialCountdown = 0;
                                initialStatus = 'idle';
                            }
                        }
                    }

                    return {
                        expandedDetails: {
                            ...prevState.expandedDetails,
                            [roomId]: detail
                        },
                        countdownTimers: {
                            ...prevState.countdownTimers,
                            [roomId]: initialCountdown
                        },
                        lastUpdateTimes: {
                            ...prevState.lastUpdateTimes,
                            [roomId]: Date.now()
                        },
                        refreshStatus: {
                            ...prevState.refreshStatus,
                            [roomId]: initialStatus
                        }
                    };
                });
            })
            .catch(err => {
                message.error(`获取直播间详情失败: ${err}`);
            });
    }

    // 更新所有展开房间的倒计时
    updateCountdowns = () => {
        this.setState(prevState => {
            const newCountdowns = { ...prevState.countdownTimers };
            const newRefreshStatus = { ...prevState.refreshStatus };
            let hasChanges = false;

            // 只更新展开的房间
            prevState.expandedRowKeys.forEach(roomId => {
                const currentStatus = newRefreshStatus[roomId];
                const currentCountdown = newCountdowns[roomId];

                // 跳过无计划和正在刷新的状态
                if (currentStatus === 'no_schedule' || currentStatus === 'refreshing') {
                    return;
                }

                // 跳过无效的倒计时值
                if (currentCountdown === undefined || currentCountdown < 0) {
                    return;
                }

                if (currentCountdown > 0) {
                    // 递减倒计时
                    newCountdowns[roomId] = currentCountdown - 1;
                    hasChanges = true;

                    // 如果倒计时归零，更新状态为 idle
                    if (newCountdowns[roomId] === 0) {
                        newRefreshStatus[roomId] = 'idle';
                    }
                }
            });

            return hasChanges ? {
                ...prevState,
                countdownTimers: newCountdowns,
                refreshStatus: newRefreshStatus
            } : prevState;
        });
    }

    loadRoomLogs = (roomId: string) => {
        api.getLiveLogs(roomId, 100)
            .then((logs: any) => {
                this.setState(prevState => ({
                    expandedLogs: {
                        ...prevState.expandedLogs,
                        [roomId]: logs.lines || []
                    }
                }));
            })
            .catch(err => {
                message.warning(`获取直播间日志失败: ${err}`);
            });
    }

    // 格式化下载速度：将 ffmpeg 的 speed 值转换为 MB/s 或 KB/s
    formatDownloadSpeed = (recorderStatus: any): string => {
        if (!recorderStatus || !recorderStatus.bitrate) {
            return '';
        }

        // ffmpeg bitrate 格式如 "2345.6kbits/s"
        const bitrateStr = recorderStatus.bitrate;
        const match = bitrateStr.match(/([\d.]+)(k?bits\/s)/i);

        if (!match) {
            return recorderStatus.speed || ''; // 回退到原始 speed 值
        }

        let bitsPerSec = parseFloat(match[1]);
        const unit = match[2].toLowerCase();

        // 转换为 bits/s
        if (unit.startsWith('k')) {
            bitsPerSec *= 1000;
        }

        // 转换为 MB/s 或 KB/s
        const bytesPerSec = bitsPerSec / 8;
        const mbPerSec = bytesPerSec / (1024 * 1024);
        const kbPerSec = bytesPerSec / 1024;

        if (mbPerSec >= 1) {
            return `${mbPerSec.toFixed(2)} MB/s`;
        } else {
            return `${kbPerSec.toFixed(2)} KB/s`;
        }
    }

    // 格式化文件大小：将字节转换为可读格式
    formatFileSize = (sizeStr: string): string => {
        const bytes = parseInt(sizeStr, 10);
        if (isNaN(bytes) || bytes < 0) {
            return '未知';
        }

        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = bytes;
        let unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return `${size.toFixed(2)} ${units[unitIndex]}`;
    }

    renderExpandedRow = (record: ItemData): JSX.Element => {
        const { expandedDetails, expandedLogs, countdownTimers, refreshStatus } = this.state;
        const detail = expandedDetails[record.roomId];
        const logs = expandedLogs[record.roomId] || [];
        const countdown = countdownTimers[record.roomId] ?? 0;
        const status = refreshStatus[record.roomId] ?? 'idle';
        const liveId = record.roomId;
        const platformRateLimitEnabled = detail?.platform_rate_limit_enabled
            ?? detail?.rate_limit_info?.enabled
            ?? true;
        // 保存 this 引用供嵌套函数使用
        const component = this;

        // 配置项行样式
        const configRowStyle: React.CSSProperties = {
            display: 'flex',
            alignItems: 'center',
            padding: '6px 12px',
            borderBottom: '1px solid #f0f0f0',
            minWidth: 0,
        };

        const configLabelStyle: React.CSSProperties = {
            width: '120px',
            flexShrink: 0,
            fontWeight: 500,
            color: '#666',
        };

        // 获取刷新状态的显示文本和颜色
        const getRefreshStatusDisplay = () => {
            // 暂无刷新计划状态
            if (status === 'no_schedule') {
                return {
                    text: '未安排刷新',
                    color: 'default' as const,
                    icon: null
                };
            }

            if (countdown > 0) {
                if (status === 'waiting_rate_limit') {
                    return {
                        text: `等待平台限制 ${countdown} 秒`,
                        color: 'red' as const,
                        icon: <SyncOutlined spin />
                    };
                } else {
                    return {
                        text: `${countdown} 秒`,
                        color: 'orange' as const,
                        icon: null
                    };
                }
            } else {
                if (status === 'refreshing') {
                    return {
                        text: '正在刷新',
                        color: 'blue' as const,
                        icon: <SyncOutlined spin />
                    };
                } else {
                    return {
                        text: '立即可用',
                        color: 'green' as const,
                        icon: null
                    };
                }
            }
        };

        // 运行时信息面板
        const renderRuntimePanel = () => {
            const handleForceRefresh = async () => {
                // 设置刷新中状态
                component.setState(prevState => ({
                    refreshStatus: {
                        ...prevState.refreshStatus,
                        [liveId]: 'refreshing'
                    }
                }));

                try {
                    const result = await api.forceRefreshLive(liveId) as { success?: boolean; message?: string };
                    if (result.success) {
                        message.success('强制刷新成功');
                        // 重新加载详细信息（会更新倒计时和状态）
                        component.loadRoomDetail(liveId);
                    } else {
                        message.error(result.message || '强制刷新失败');
                        // 恢复状态
                        component.setState(prevState => ({
                            refreshStatus: {
                                ...prevState.refreshStatus,
                                [liveId]: 'idle'
                            }
                        }));
                    }
                } catch (error) {
                    message.error('强制刷新失败');
                    // 恢复状态
                    component.setState(prevState => ({
                        refreshStatus: {
                            ...prevState.refreshStatus,
                            [liveId]: 'idle'
                        }
                    }));
                }
            };

            return (
                <div>
                    {detail ? (
                        <div>
                            <div style={{ padding: '4px 0' }}>
                                <div style={configRowStyle}>
                                    <span style={configLabelStyle}>监控状态</span>
                                    <Tag color={detail.listening ? 'green' : undefined}>
                                        {detail.listening ? '监控中' : '已停止'}
                                    </Tag>
                                </div>
                                <div style={configRowStyle}>
                                    <span style={configLabelStyle}>录制状态</span>
                                    <Tag color={detail.recording ? 'red' : detail.recording_preparing ? 'volcano' : undefined}>
                                        {detail.recording ? '录制中' : detail.recording_preparing ? '录制准备中' : '未录制'}
                                    </Tag>
                                </div>
                                {/* 当前录制画质信息 */}
                                {detail.recording && detail.recorder_status?.stream_quality && (
                                    <div style={configRowStyle}>
                                        <span style={configLabelStyle}>录制画质</span>
                                        <Space size="small">
                                            <Tag color="purple">
                                                {detail.recorder_status.stream_quality_name || detail.recorder_status.stream_quality}
                                                {detail.recorder_status.stream_description &&
                                                    detail.recorder_status.stream_description !== detail.recorder_status.stream_quality &&
                                                    ` [${detail.recorder_status.stream_description}]`}
                                            </Tag>
                                            {detail.recorder_status.stream_resolution && (
                                                <Tag>{detail.recorder_status.stream_resolution}</Tag>
                                            )}
                                            {detail.recorder_status.stream_format && (
                                                <Tag>{detail.recorder_status.stream_format.toUpperCase()}</Tag>
                                            )}
                                            {detail.recorder_status.stream_bitrate && (
                                                <Tag color="blue">{detail.recorder_status.stream_bitrate} kbps</Tag>
                                            )}
                                            {detail.recorder_status.stream_fps && (
                                                <Tag>{detail.recorder_status.stream_fps}fps</Tag>
                                            )}
                                            {detail.recorder_status.stream_codec && (
                                                <Tag color={detail.recorder_status.stream_codec === 'h265' ? 'orange' : 'default'}>
                                                    {detail.recorder_status.stream_codec.toUpperCase()}
                                                </Tag>
                                            )}
                                        </Space>
                                    </div>
                                )}
                                {/* 实际分辨率信息（来自 StreamProbe 探测） */}
                                {detail.recording && detail.recorder_status?.probe_status && (
                                    <div style={{ ...configRowStyle, alignItems: 'flex-start' }}>
                                        <span style={{ ...configLabelStyle, paddingTop: 2 }}>实际分辨率</span>
                                        <Space size="small" wrap style={{ flex: 1, minWidth: 0 }}>
                                            {detail.recorder_status.probe_status === 'success' && (
                                                <>
                                                    {detail.recorder_status.actual_resolution && (
                                                        <Tag color={detail.recorder_status.resolution_match === false ? 'warning' : 'success'}>
                                                            {detail.recorder_status.actual_resolution}
                                                            {detail.recorder_status.resolution_match === false ? ' ⚠️' : ' ✓'}
                                                        </Tag>
                                                    )}
                                                    {detail.recorder_status.actual_video_codec && (
                                                        <Tag>{detail.recorder_status.actual_video_codec.toUpperCase()}</Tag>
                                                    )}
                                                    {detail.recorder_status.actual_video_bitrate && (
                                                        <Tag>{detail.recorder_status.actual_video_bitrate} kbps</Tag>
                                                    )}
                                                    {detail.recorder_status.actual_frame_rate && (
                                                        <Tag>{detail.recorder_status.actual_frame_rate}fps</Tag>
                                                    )}
                                                    {detail.recorder_status.resolution_match === false && detail.recorder_status.stream_resolution && (
                                                        <span style={{ color: '#faad14', fontSize: '12px' }}>
                                                            与声称的 {detail.recorder_status.stream_resolution} 不符
                                                        </span>
                                                    )}
                                                </>
                                            )}
                                            {detail.recorder_status.probe_status === 'unsupported' && (
                                                <Tag color="default">
                                                    {detail.recorder_status.actual_video_codec ?
                                                        `${detail.recorder_status.actual_video_codec.toUpperCase()} - 无法解析` :
                                                        '无法解析'
                                                    }
                                                </Tag>
                                            )}
                                            {detail.recorder_status.probe_status === 'pending' && (
                                                <Tag>探测中...</Tag>
                                            )}
                                            {detail.recorder_status.probe_message && (
                                                <span style={{ color: '#999', fontSize: '12px', wordBreak: 'break-all', lineHeight: '1.4' }}>
                                                    {detail.recorder_status.probe_message}
                                                </span>
                                            )}
                                        </Space>
                                    </div>
                                )}
                                {detail.recording && detail.recorder_status?.bitrate && (
                                    <div style={configRowStyle}>
                                        <span style={configLabelStyle}>下载速度</span>
                                        <Tag color="blue">{this.formatDownloadSpeed(detail.recorder_status)}</Tag>
                                    </div>
                                )}
                                {detail.recording && detail.recorder_status?.file_size && (
                                    <div style={configRowStyle}>
                                        <span style={configLabelStyle}>当前文件大小</span>
                                        <Tag color="green">{this.formatFileSize(detail.recorder_status.file_size)}</Tag>
                                    </div>
                                )}
                                {detail.recording && detail.recorder_status?.file_path && (
                                    <div style={configRowStyle}>
                                        <span style={configLabelStyle}>录制文件路径</span>
                                        <Tooltip title={detail.recorder_status.file_path}>
                                            <span style={{
                                                maxWidth: '200px',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                                display: 'inline-block',
                                                verticalAlign: 'middle',
                                                cursor: 'pointer'
                                            }}>
                                                {detail.recorder_status.file_path.split(/[/\\]/).pop() || detail.recorder_status.file_path}
                                            </span>
                                        </Tooltip>
                                    </div>
                                )}
                                {/* 录制流调试信息（可折叠） */}
                                {detail.recording && detail.recorder_status?.stream_url && (
                                    <details style={{ padding: '4px 12px', margin: '4px 0' }}>
                                        <summary style={{
                                            cursor: 'pointer',
                                            color: '#1890ff',
                                            fontSize: '12px',
                                            userSelect: 'none',
                                            outline: 'none',
                                            padding: '4px 0',
                                        }}>
                                            📡 查看录制流 URL 和 Headers
                                        </summary>
                                        <div style={{
                                            marginTop: 8,
                                            padding: '8px 12px',
                                            background: '#f5f5f5',
                                            borderRadius: 6,
                                            fontSize: '12px',
                                            lineHeight: '1.6',
                                            wordBreak: 'break-all',
                                        }}>
                                            <div style={{ marginBottom: 8 }}>
                                                <strong>流 URL：</strong>
                                                <div style={{
                                                    fontFamily: 'monospace',
                                                    background: '#fff',
                                                    padding: '6px 8px',
                                                    borderRadius: 4,
                                                    border: '1px solid #e8e8e8',
                                                    marginTop: 4,
                                                    whiteSpace: 'pre-wrap',
                                                }}>
                                                    {detail.recorder_status.stream_url}
                                                </div>
                                            </div>
                                            {detail.recorder_status.stream_headers && Object.keys(detail.recorder_status.stream_headers).length > 0 && (
                                                <div style={{ marginBottom: 8 }}>
                                                    <strong>Headers：</strong>
                                                    <div style={{
                                                        fontFamily: 'monospace',
                                                        background: '#fff',
                                                        padding: '6px 8px',
                                                        borderRadius: 4,
                                                        border: '1px solid #e8e8e8',
                                                        marginTop: 4,
                                                    }}>
                                                        {Object.entries(detail.recorder_status.stream_headers as Record<string, string>).map(
                                                            ([k, v]) => (
                                                                <div key={k}>
                                                                    <span style={{ color: '#1890ff' }}>{k}</span>: {v}
                                                                </div>
                                                            )
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                            <Space size="small" style={{ marginTop: 4 }}>
                                                <Button
                                                    size="small"
                                                    onClick={() => {
                                                        navigator.clipboard.writeText(detail.recorder_status.stream_url)
                                                            .then(() => message.success('URL 已复制'))
                                                            .catch(() => message.error('复制失败'));
                                                    }}
                                                >
                                                    📋 复制 URL
                                                </Button>
                                                <Button
                                                    size="small"
                                                    type="primary"
                                                    ghost
                                                    onClick={() => {
                                                        const url = detail.recorder_status.stream_url;
                                                        const headers = detail.recorder_status.stream_headers as Record<string, string> | undefined;
                                                        let curlCmd = `curl '${url}'`;
                                                        if (headers) {
                                                            for (const [k, v] of Object.entries(headers)) {
                                                                curlCmd += ` \\\n  -H '${k}: ${v}'`;
                                                            }
                                                        }
                                                        navigator.clipboard.writeText(curlCmd)
                                                            .then(() => message.success('curl 命令已复制'))
                                                            .catch(() => message.error('复制失败'));
                                                    }}
                                                >
                                                    🔧 复制为 curl
                                                </Button>
                                            </Space>
                                        </div>
                                    </details>
                                )}
                                <div style={configRowStyle}>
                                    <span style={configLabelStyle}>开播时间</span>
                                    <span>{detail.live_start_time || (detail.status ? '获取中...' : '未开播')}</span>
                                </div>
                                <div style={{ ...configRowStyle, borderBottom: 'none' }}>
                                    <span style={configLabelStyle}>录制开始</span>
                                    <span>{detail.last_record_time || (detail.recording ? '获取中...' : '未在录制')}</span>
                                </div>
                                {detail.recorder_status?.danmaku_running !== undefined && (
                                    <>
                                        <div style={configRowStyle}>
                                            <span style={configLabelStyle}>弹幕录制</span>
                                            <Tag color={detail.recorder_status.danmaku_running ? 'cyan' : 'default'}>
                                                {detail.recorder_status.danmaku_running ? '连接中' : '已停止'}
                                            </Tag>
                                        </div>
                                        <div style={configRowStyle}>
                                            <span style={configLabelStyle}>弹幕数量</span>
                                            <span>{detail.recorder_status.danmaku_count ?? 0} 条</span>
                                        </div>
                                        {detail.recorder_status.danmaku_output && (
                                            <div style={{ ...configRowStyle, borderBottom: 'none' }}>
                                                <span style={configLabelStyle}>弹幕文件</span>
                                                <Tooltip title={detail.recorder_status.danmaku_output}>
                                                    <span style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', verticalAlign: 'bottom' }}>
                                                        {detail.recorder_status.danmaku_output.split(/[/\\]/).pop()}
                                                    </span>
                                                </Tooltip>
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>

                            <Divider style={{ margin: '8px 0' }}>平台访问频率控制</Divider>
                            <div style={{ padding: '0 12px 8px' }}>
                                {!platformRateLimitEnabled ? (
                                    <div>
                                        <Alert
                                            message="平台级访问限流已暂时停用"
                                            description="当前不会限制同平台请求的最小间隔或并发数；已保存的 min_access_interval_sec 配置暂不生效。"
                                            type="warning"
                                            showIcon
                                        />
                                        <div style={{ marginTop: 12, borderBottom: 'none' }}>
                                            <Button
                                                type="primary"
                                                size="small"
                                                onClick={handleForceRefresh}
                                                loading={status === 'refreshing'}
                                                icon={<ReloadOutlined />}
                                            >
                                                立即刷新
                                            </Button>
                                        </div>
                                    </div>
                                ) : detail.rate_limit_info ? (
                                    <div>
                                        <div style={configRowStyle}>
                                            <Tooltip
                                                title={
                                                    <div>
                                                        <p style={{ margin: '4px 0' }}>
                                                            <strong>直播平台级最小访问间隔</strong>
                                                        </p>
                                                        <p style={{ margin: '4px 0' }}>
                                                            为避免触发直播平台的风控机制，对同一平台的所有直播间请求会保持一定的时间间隔。
                                                        </p>
                                                        <p style={{ margin: '4px 0' }}>
                                                            即使同时监控多个{detail.platform}直播间，两次请求之间也会至少间隔该时长。
                                                        </p>
                                                        <p style={{ margin: '4px 0', color: '#faad14' }}>
                                                            可在配置文件的 platform_configs 中自定义各平台的 min_access_interval_sec
                                                        </p>
                                                    </div>
                                                }
                                                placement="right"
                                            >
                                                <span style={{ ...configLabelStyle, cursor: 'help', textDecoration: 'underline dotted' }}>
                                                    平台最小访问间隔
                                                </span>
                                            </Tooltip>
                                            <Tag>{detail.rate_limit_info.min_interval_sec || detail.platform_rate_limit} 秒</Tag>
                                        </div>
                                        <div style={configRowStyle}>
                                            <span style={configLabelStyle}>距上次请求</span>
                                            <span>{Math.round(detail.rate_limit_info.waited_seconds || 0)} 秒</span>
                                        </div>
                                        <div style={configRowStyle}>
                                            <span style={configLabelStyle}>距离下次刷新</span>
                                            {(() => {
                                                const statusDisplay = getRefreshStatusDisplay();
                                                return (
                                                    <Tag color={statusDisplay.color} icon={statusDisplay.icon}>
                                                        {statusDisplay.text}
                                                    </Tag>
                                                );
                                            })()}
                                        </div>
                                        <div style={{ marginTop: 12, borderBottom: 'none' }}>
                                            <Button
                                                type="primary"
                                                size="small"
                                                onClick={handleForceRefresh}
                                                loading={status === 'refreshing'}
                                                icon={<ReloadOutlined />}
                                            >
                                                强制刷新（突破频率限制）
                                            </Button>
                                        </div>
                                    </div>
                                ) : (
                                    <div style={{ padding: '8px 0', textAlign: 'center', color: '#999' }}>
                                        暂无访问频率信息
                                    </div>
                                )}
                            </div>

                            <Divider style={{ margin: '8px 0' }}>网络连接统计</Divider>
                            <div style={{ padding: '0 12px 8px' }}>
                                {detail.conn_stats && detail.conn_stats.length > 0 ? (
                                    <List
                                        size="small"
                                        dataSource={detail.conn_stats}
                                        split={false}
                                        renderItem={(item: any) => (
                                            <List.Item style={{ padding: '6px 0', borderBottom: '1px dashed #f0f0f0' }}>
                                                <div style={{ width: '100%' }}>
                                                    <Text strong style={{ fontSize: 13 }}>{item.host}</Text>
                                                    <div style={{ marginTop: 4 }}>
                                                        <Text type="secondary">↓ 接收: </Text>
                                                        <Tag color="blue" style={{ marginRight: 16 }}>{item.received_format}</Tag>
                                                        <Text type="secondary">↑ 发送: </Text>
                                                        <Tag color="green">{item.sent_format}</Tag>
                                                    </div>
                                                </div>
                                            </List.Item>
                                        )}
                                    />
                                ) : (
                                    <div style={{ padding: '12px 0', textAlign: 'center', color: '#999' }}>
                                        暂无网络连接统计数据
                                    </div>
                                )}
                            </div>

                            {/* 可用流列表 - 带过滤器 */}
                            {detail.available_streams && detail.available_streams.length > 0 && (
                                <>
                                    <Divider style={{ margin: '8px 0' }}>可用流列表 ({detail.available_streams.length})</Divider>
                                    <div style={{ padding: '0 12px 8px' }}>
                                        <StreamListWithFilter
                                            availableStreams={detail.available_streams}
                                            availableStreamAttributes={detail.available_stream_attributes}
                                            detail={detail}
                                            liveId={liveId}
                                            component={component}
                                        />
                                        {detail.available_streams_updated_at && (
                                            <div style={{
                                                marginTop: 8,
                                                fontSize: 12,
                                                color: '#999',
                                                textAlign: 'right'
                                            }}>
                                                更新于: {new Date(detail.available_streams_updated_at * 1000).toLocaleString()}
                                            </div>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>
                    ) : (
                        <div style={{ padding: '20px', textAlign: 'center', color: '#999' }}>
                            加载运行时信息中...
                        </div>
                    )}
                </div>
            );
        };

        // 日志面板
        const renderLogsPanel = () => {
            const handleLogsChange = (newLogs: string[]) => {
                this.setState(prevState => ({
                    expandedLogs: {
                        ...prevState.expandedLogs,
                        [record.roomId]: newLogs
                    }
                }));
            };

            return (
                <LogPanel
                    logs={logs}
                    onLogsChange={handleLogsChange}
                    roomName={record.name}
                />
            );
        };

        return (
            <div style={{
                margin: '8px 16px 16px',
                border: '1px solid #d9d9d9',
                borderRadius: '6px',
                backgroundColor: '#fff',
                boxShadow: '0 2px 8px rgba(0,0,0,0.06)'
            }}>
                <Tabs
                    defaultActiveKey="runtime"
                    size="small"
                    animated={false}
                    style={{ margin: 0 }}
                    tabBarStyle={{
                        margin: 0,
                        padding: '0 12px',
                        backgroundColor: '#fafafa',
                        borderBottom: '1px solid #e8e8e8',
                        borderRadius: '6px 6px 0 0'
                    }}
                    onChange={(key) => {
                        if (key === 'danmaku') {
                            // 切换到弹幕Tab：开始累积消息
                            this.setState(prevState => ({
                                expandedActiveTabs: { ...prevState.expandedActiveTabs, [liveId]: 'danmaku' },
                                danmakuMessages: { ...prevState.danmakuMessages, [liveId]: [] },
                            }));
                        } else {
                            // 切换到其他Tab：停止累积并清空消息，释放内存
                            delete this.danmakuBuffer[liveId];
                            this.setState(prevState => {
                                const newTabs = { ...prevState.expandedActiveTabs };
                                const newMsgs = { ...prevState.danmakuMessages };
                                delete newTabs[liveId];
                                delete newMsgs[liveId];
                                return { expandedActiveTabs: newTabs, danmakuMessages: newMsgs };
                            });
                        }
                    }}
                >
                    <Tabs.TabPane tab="运行时信息" key="runtime">
                        {renderRuntimePanel()}
                    </Tabs.TabPane>
                    <Tabs.TabPane tab="设置" key="settings">
                        <div style={{ padding: '16px 20px' }}>
                            {this.state.globalConfig && detail && detail.room_config ? (
                                <RoomConfigForm
                                    room={detail.room_config}
                                    globalConfig={this.state.globalConfig}
                                    platformId={detail.platform_key}
                                    onSave={async (updates) => {
                                        await api.updateRoomConfigById(detail.live_id, updates);
                                        // 更新后重新加载详情以获取最新配置状态
                                        await this.loadRoomDetail(record.roomId);
                                        // 立即刷新主列表以反映配置变更
                                        this.requestListData();
                                    }}
                                    loading={false}
                                    onRefresh={() => this.loadRoomDetail(record.roomId)}
                                />
                            ) : (
                                <div style={{ textAlign: 'center', padding: '20px' }}>正在加载配置...</div>
                            )}
                        </div>
                    </Tabs.TabPane>
                    <Tabs.TabPane tab="最近日志" key="logs">
                        {renderLogsPanel()}
                    </Tabs.TabPane>
                    <Tabs.TabPane tab="直播历史" key="history">
                        <HistoryPanel roomId={record.roomId} roomName={record.name} />
                    </Tabs.TabPane>
                    <Tabs.TabPane tab="实时弹幕" key="danmaku">
                        <div style={{
                            padding: '12px 16px',
                            background: '#111',
                            borderRadius: '0 0 6px 6px',
                            borderLeft: '1px solid rgba(255,255,255,0.06)',
                            borderRight: '1px solid rgba(255,255,255,0.06)',
                            borderBottom: '1px solid rgba(255,255,255,0.06)',
                        }}>
                            {detail?.recorder_status?.danmaku_running ? (
                                <DanmakuPanel
                                    messages={this.state.danmakuMessages[liveId] || []}
                                />
                            ) : detail?.recording && detail?.room_config?.danmaku_enable && detail?.recorder_status?.danmaku_running === false ? (
                                <div style={{ padding: '40px 0', textAlign: 'center', color: '#555' }}>
                                    <CommentOutlined style={{ fontSize: 32, marginBottom: 12, opacity: 0.3 }} />
                                    <div>弹幕录制已停止</div>
                                </div>
                            ) : detail?.recording && !detail?.room_config?.danmaku_enable ? (
                                <div style={{ padding: '40px 0', textAlign: 'center', color: '#555' }}>
                                    <CommentOutlined style={{ fontSize: 32, marginBottom: 12, opacity: 0.3 }} />
                                    <div>弹幕录制未启用</div>
                                </div>
                            ) : detail?.recording ? (
                                <div style={{ padding: '40px 0', textAlign: 'center', color: '#555' }}>
                                    <Spin size="small" />
                                    <div style={{ marginTop: 12, fontSize: 13 }}>弹幕连接中...</div>
                                </div>
                            ) : (
                                <div style={{ padding: '40px 0', textAlign: 'center', color: '#555' }}>
                                    <CommentOutlined style={{ fontSize: 32, marginBottom: 12, opacity: 0.3 }} />
                                    <div>录制开始后可查看实时弹幕</div>
                                </div>
                            )}
                        </div>
                    </Tabs.TabPane>
                </Tabs>
            </div>
        );
    }

    render() {
        // 性能：列定义与筛选器已移入 getCachedColumns() 缓存，
        // 这里不再每次渲染都就地改写 this.columns（那会产生新数组并让 Table 重建列结构）。
        return (
            <div>
                <Tabs defaultActiveKey="livelist" type="card" onChange={this.requestData}>
                    <Tabs.TabPane tab="直播间列表" key="livelist">
                        <div style={{
                            padding: '16px 24px',
                            backgroundColor: '#fff',
                            borderBottom: '1px solid #e8e8e8',
                            marginBottom: 16,
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                        }}>
                            {/* ... content ... */}
                            <div>
                                <span style={{ fontSize: '20px', fontWeight: 600, color: 'rgba(0,0,0,0.85)', marginRight: 12 }}>直播间列表</span>
                                <span style={{ fontSize: '14px', color: 'rgba(0,0,0,0.45)' }}>Room List</span>
                            </div>
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                <Tooltip title={this.state.enableListSSE
                                    ? "实时更新已启用：列表变化将自动同步"
                                    : "实时更新已禁用：需手动刷新页面查看变化"}>
                                    <Space size="small">
                                        <CloudSyncOutlined style={{ color: this.state.enableListSSE ? '#1890ff' : '#999' }} />
                                        <Switch
                                            size="small"
                                            checked={this.state.enableListSSE}
                                            onChange={(checked) => {
                                                setListSSEEnabled(checked);
                                                // 状态更新会通过 handleLocalSettingsChange 事件处理
                                            }}
                                        />
                                    </Space>
                                </Tooltip>
                                {/* 列设置入口：点击弹出 Checkbox 面板，可自由开关每一列（选择持久化到 localStorage） */}
                                <Popover
                                    trigger="click"
                                    placement="bottomRight"
                                    title="列设置"
                                    content={this.renderColumnSettingPanel()}
                                >
                                    <Button icon={<SettingOutlined />}>列设置</Button>
                                </Popover>
                                <Button key="2" type="default" onClick={this.onSettingSave}>保存设置</Button>
                                <Button key="1" type="primary" onClick={() => this.setState({ batchAddDialogVisible: true })}>
                                    添加房间
                                </Button>
                                <BatchAddRoomDialog
                                    visible={this.state.batchAddDialogVisible}
                                    onClose={() => this.setState({ batchAddDialogVisible: false })}
                                    onSuccess={this.refresh}
                                />
                            </div>
                        </div>
                        {/* 需求7：批量操作栏，有选中项时显示在表格上方 */}
                        {this.state.selectedRowKeys.length > 0 && (
                            <div style={{
                                padding: '10px 24px',
                                marginBottom: 12,
                                backgroundColor: '#e6f7ff',
                                border: '1px solid #91d5ff',
                                borderRadius: 4,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                flexWrap: 'wrap'
                            }}>
                                <span style={{ fontSize: 14, color: 'rgba(0,0,0,0.65)', marginRight: 4 }}>
                                    已选择 {this.state.selectedRowKeys.length} 项
                                </span>
                                <Button size="small" type="primary" loading={this.state.batchOperating}
                                    onClick={() => this.handleBatchOperation('start')}>启动监控</Button>
                                <Button size="small" loading={this.state.batchOperating}
                                    onClick={() => this.handleBatchOperation('stop')}>停止监控</Button>
                                <Button size="small" loading={this.state.batchOperating}
                                    onClick={() => this.openRecordScheduleDialog(this.state.selectedRowKeys)}>配置录制时间段</Button>
                                <Button size="small" loading={this.state.batchOperating}
                                    onClick={() => this.handleBatchOperation('set_one_time')}>一次性录制</Button>
                                <Button size="small" loading={this.state.batchOperating}
                                    onClick={() => this.handleBatchOperation('set_persistent')}>持久性录制</Button>
                                <PopDialog
                                    title={`确定删除选中的 ${this.state.selectedRowKeys.length} 个直播间？`}
                                    onConfirm={() => this.handleBatchOperation('delete')}>
                                    <Button size="small" danger loading={this.state.batchOperating}>删除</Button>
                                </PopDialog>
                                <Button size="small" onClick={() => this.setSelectedRowKeys([])}>取消选择</Button>
                            </div>
                        )}
                        <Table
                            className="item-pad"
                            // 用于深度链接按 key 定位行（虚拟滚动下 DOM 里可能没有目标行）
                            ref={this.tableRef}
                            columns={this.getCachedColumns()}
                            dataSource={this.state.list}
                            size={(this.state.window.screen.width > 768) ? "large" : "middle"}
                            // ---- 性能：改为 antd 虚拟滚动 ----
                            // 原先 pagination={false} 会把全部直播间（线上实测 210 个）一次性渲染，
                            // 每行含 3 个 Tag + 下拉菜单 + 气泡确认 + 复选框 + 多个按钮，
                            // 合计三千多个 antd 组件实例；antd v6 的 CSS-in-JS 在实例数很大时，
                            // 每次协调都要重新计算样式哈希，导致主线程长期繁忙、hover 反馈延迟数百毫秒。
                            // 虚拟滚动只渲染「可视区域 + 缓冲」内的行，实例数从数千降到几十。
                            //
                            // 关键点：虚拟滚动只影响"渲染哪些行"，dataSource 依旧是完整列表（this.state.list），
                            // 因此排序、列筛选、以及多选全选的语义都与完整 dataSource 一致，
                            // 未渲染出来的行同样参与筛选和全选（详见下方 rowSelection 的注释）。
                            //
                            // 注意：antd 硬性要求 virtual 必须同时提供「数字类型」的 scroll.x 与 scroll.y，
                            // 缺任意一个都会在控制台报错并使虚拟滚动失效。
                            // scroll.x 必须等于「展开列 44 + 复选框列 44 + 当前列集合各列 width 之和」：
                            // 各列 width 已显式指定，若合计小于 scroll.x，rc-table 会把多出来的宽度
                            // 按比例摊给所有列，列宽又会失控（详见 TABLE_SCROLL_X / SMALL_TABLE_SCROLL_X 的注释）。
                            // 桌面端用 columns（1348），移动端 ≤768px 用 smallColumns（1118），
                            // 与 getCachedColumns() 里选择列集合的判断（width <= 768）保持一致。
                            // 另外：用户用「列设置」隐藏列后合计会变小，rc-table 会把剩余列按比例
                            // 放大（各列比例保持不变，不会再像原先那样被均分成一样宽）。
                            virtual
                            scroll={{
                                x: this.state.window.screen.width > 768 ? TABLE_SCROLL_X : SMALL_TABLE_SCROLL_X,
                                y: 600,
                            }}
                            // 虚拟滚动下不能再用分页（分页 + virtual 会互相干扰）
                            pagination={false}
                            expandedRowKeys={this.state.expandedRowKeys}
                            // 展开行与虚拟滚动是兼容的：@rc-component/table 的 VirtualTable/BodyLine
                            // 会把 expandedRowRender 的结果一并放进虚拟列表渲染，因此展开功能保持原样。
                            // 已知固有折中：虚拟滚动按固定行高估算总高度，而展开行远高于普通行，
                            // 所以有行处于展开状态时滚动条位置可能略有跳动——这是 antd 虚拟表格的既有取舍，
                            // 这里不做 hack 修复，避免引入更复杂的定位问题。
                            expandedRowRender={this.renderExpandedRow}
                            // 展开图标列（+）：与复选框列同样默认没有固定宽度，会被虚拟滚动按
                            // scroll.x 均分，这里显式收窄为 44px。
                            // antd 允许 expandable 与下面这些顶层属性（expandedRowKeys /
                            // expandedRowRender / onExpand）共存：rc-table 合并时会以上层
                            // expandable 为准、再叠加顶层遗留属性，因此本行只补宽度，不影响展开逻辑。
                            expandable={{ columnWidth: EXTRA_COLUMN_WIDTH }}
                            rowKey={record => record.roomId}
                            // 需求7：多选批量操作
                            // 全选语义（与虚拟滚动无关）：
                            // 1) selectedRowKeys 是我们自己维护的「全量 key 列表」，不读取任何 DOM / 已渲染行，
                            //    虚拟滚动不改变 dataSource，所以未渲染出来的行也会被选中；
                            // 2) 表头全选时，antd 依据「完整 dataSource（有列筛选时则是完整筛选结果）」
                            //    算出 key 列表后通过 onChange 回传，我们直接采用该结果，不做任何基于可见行的裁剪；
                            // 3) 因此"筛选后全选 = 选中筛选结果"，保持 antd 的既有语义。
                            // 说明：antd v6 中 rowSelection.onSelectAll 已标记 deprecated（v7 将移除），
                            // 为避免依赖即将移除的 API，这里统一走 onChange，不再额外挂 onSelectAll。
                            rowSelection={{
                                // 复选框列：antd 默认不给该列固定宽度，会被虚拟滚动按 scroll.x 均分，
                                // 因此显式收窄为 44px（其余原有配置保持不变）
                                columnWidth: EXTRA_COLUMN_WIDTH,
                                selectedRowKeys: this.state.selectedRowKeys,
                                onChange: this.setSelectedRowKeys,
                                // 给复选框带上所属直播间 id，便于识别
                                getCheckboxProps: (record: ItemData) => ({ name: record.roomId }),
                            }}
                            onExpand={(expanded, record) => this.toggleExpandRow(record.roomId)}
                            onRow={(record) => ({
                                id: `row-live-${record.roomId}`,
                                // 性能：原为 transition 1s，视觉上表现为"点了没反应"，
                                // 实测会让人误以为界面卡死；缩短到 0.15s 保留反馈又跟手。
                                style: { transition: 'background-color 0.15s' },
                                onClick: (e) => {
                                    // 只有点击 td 单元格本身（空白处）才触发展开
                                    // 如果点击的是 td 内的内容元素，则不触发
                                    const target = e.target as HTMLElement;
                                    // 需求7：点击多选框/选择列时不触发展开，避免与多选冲突
                                    // （antd v6 选择列 td 的类名，同时兜底 checkbox 包裹层）
                                    if (target.closest && target.closest('.ant-table-selection-column, .ant-table-selection-col, .ant-checkbox-wrapper')) {
                                        return;
                                    }
                                    // 虚拟滚动下表体改用 div 网格渲染（不再是 <td>），
                                    // 因此这里同时兼容普通表格的 TD 与虚拟表格的 .ant-table-cell，
                                    // 保证"点击行的空白处展开"这一交互在虚拟滚动下依然可用。
                                    const isCell = target.tagName === 'TD'
                                        || (target.tagName === 'DIV' && target.classList.contains('ant-table-cell'));
                                    if (isCell) {
                                        this.toggleExpandRow(record.roomId);
                                    }
                                }
                            })}
                            onChange={this.handleTableChange}
                        />
                        {/* 需求6：录制时间段配置弹窗（支持单个与批量） */}
                        <RecordScheduleDialog
                            visible={this.state.recordScheduleDialogVisible}
                            roomIds={this.state.recordScheduleRoomIds}
                            onClose={() => this.setState({ recordScheduleDialogVisible: false, recordScheduleRoomIds: [] })}
                            onSaved={this.refresh}
                        />
                    </Tabs.TabPane>
                    <Tabs.TabPane tab="Cookie管理" key="cookielist">
                        <div style={{
                            padding: '16px 24px',
                            backgroundColor: '#fff',
                            borderBottom: '1px solid #e8e8e8',
                            marginBottom: 16,
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                        }}>
                            <div>
                                <span style={{ fontSize: '20px', fontWeight: 600, color: 'rgba(0,0,0,0.85)', marginRight: 12 }}>Cookie管理</span>
                                <span style={{ fontSize: '14px', color: 'rgba(0,0,0,0.45)' }}>Cookie List</span>
                            </div>
                            <div>
                                <EditCookieDialog key="1" ref={this.onCookieRef} refresh={this.refreshCookie} />
                            </div>
                        </div>
                        <Table
                            className="item-pad"
                            columns={(this.state.window.screen.width > 768) ? this.cookieColumns : this.cookieColumns}
                            dataSource={this.state.cookieList}
                            size={(this.state.window.screen.width > 768) ? "large" : "middle"}
                            pagination={false}
                        />
                    </Tabs.TabPane>
                </Tabs>
            </div>
        );
    };
}

// HOC to inject navigate hook into class component
function LiveListWithRouter(props: Omit<Props, 'navigate'>) {
    const navigate = useNavigate();
    return <LiveList {...props} navigate={navigate} />;
}

export default LiveListWithRouter;
