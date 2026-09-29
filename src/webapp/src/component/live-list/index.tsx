import React from "react";
import { Alert, Button, Checkbox, Divider, Dropdown, Input, Modal, Popover, Table, Tag, Tabs, Row, Col, Tooltip, message, List, Typography, Switch, Space, Popconfirm, Select, Spin } from 'antd';
import { EditOutlined, SyncOutlined, CloudSyncOutlined, ReloadOutlined, SwapOutlined, CheckCircleOutlined, ExclamationCircleOutlined, CommentOutlined, SettingOutlined, FilterOutlined, MoreOutlined, DownOutlined, UpOutlined, CloseOutlined } from '@ant-design/icons';
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
//
// ⚠️ 现状：窄屏（≤768px）已改为渲染卡片列表、不再渲染 Table，
// 因此下面这组「小屏列集合 + 小屏 scroll.x」只在断点抖动等极端情况下才会被用到，
// 但**不能删除**：Table 的 scroll.x 表达式仍然引用它，删掉会变成未使用变量（ESLint error）。
const SMALL_TABLE_SCROLL_X = EXTRA_COLUMN_WIDTH + EXTRA_COLUMN_WIDTH
    + 140 // 主播名称
    + 165 // 添加链接时间（与 addedAtColumn 共用列定义，宽度必须一致）
    + 165 // 最近一次直播时间（与 lastLiveColumn 共用列定义，宽度必须一致）
    + 130 // 文件夹大小（与 folderSizeColumn 共用列定义，宽度必须一致）
    + 220 // 运行状态
    + 240; // 操作

// ==================== 响应式断点与移动端卡片列表常量 ====================

// 窄屏断点：视口宽度 ≤ 768px 视为移动端。
// 为什么集中成常量：响应式判断原先散落在 5 处 window.screen.width 比较里，
// 一旦阈值要调整就得全部同步修改，极易漏改导致「列集合与 scroll.x 不匹配」。
const MOBILE_BREAKPOINT_PX = 768;

// 媒体查询字符串：监听「视口宽度」而不是设备屏幕宽度。
// window.screen.width 是设备屏幕的逻辑宽度，桌面浏览器拖窄窗口、手机横竖屏切换时它都不会变，
// 所以原实现既测不出窄屏、也收不到任何变化通知；matchMedia('(max-width: 768px)')
// 基于视口宽度并且自带 change 事件，正好覆盖这两种场景。
const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;

// 移动端卡片列表「分段渲染」的每批条数。
// 线上实测 206 个直播间，每张卡片含复选框 + 若干个 Tag + 4~6 个 antd 按钮/下拉/气泡确认，
// 一次性全量渲染会产生两千多个组件实例——桌面端正是因为这个问题才改用虚拟滚动
// （见 Table 上 virtual 的注释）。手机上 CPU 更弱，这里改为首屏先渲染 30 张、
// 用户滑到底再「加载更多」，把首屏的可交互时间压下来。
const MOBILE_CARD_PAGE_SIZE = 30;

// 窄屏卡片列表的排序方式 key。
// 卡片列表没有表头，无法像桌面端那样点列头排序，因此在工具条里放一个「排序」下拉；
// 可选值与桌面端可排序的列一一对应（运行状态/添加时间/最近直播/文件夹大小/主播名）。
type MobileSortKey = 'priority' | 'addedAt' | 'lastStartTimeUnix' | 'folderSize' | 'name';

// 窄屏排序下拉的选项（顺序即下拉里的展示顺序）
const MOBILE_SORT_OPTIONS: { key: MobileSortKey; label: string }[] = [
    { key: 'priority', label: '运行状态' },
    { key: 'addedAt', label: '添加时间' },
    { key: 'lastStartTimeUnix', label: '最近直播' },
    { key: 'folderSize', label: '文件夹大小' },
    { key: 'name', label: '主播名称' },
];

// 窄屏排序偏好的 localStorage key（与列设置一样持久化，刷新后仍生效）
const MOBILE_SORT_STORAGE_KEY = 'liveListMobileSortKey';

// 读取窄屏排序偏好；读不到或值非法时回退为「运行状态」
// （按录制优先级倒序 = 桌面端「运行状态」列的 defaultSortOrder: 'descend'）
const loadMobileSortKey = (): MobileSortKey => {
    try {
        const saved = localStorage.getItem(MOBILE_SORT_STORAGE_KEY);
        if (saved && MOBILE_SORT_OPTIONS.some(option => option.key === saved)) {
            return saved as MobileSortKey;
        }
    } catch (e) {
        console.error('读取窄屏排序设置失败:', e);
    }
    return 'priority';
};

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
    // 窄屏标记：true 表示「视口宽度 ≤768px」，此时不再渲染 Table，改为渲染卡片列表。
    // 由 matchMedia('(max-width: 768px)') 驱动（见 componentDidMount），
    // 取代原先的 window.screen.width（设备屏幕宽度，横竖屏/拖窗口都不会变）。
    isSmall: boolean,
    // 当前视口高度：仅用于派生 Table 虚拟滚动的 scroll.y（原先是写死的 600），随 resize 更新
    viewportHeight: number,
    // 移动端卡片列表的名称搜索关键字（等价替代桌面端「主播名称」列表头的模糊搜索）
    mobileSearchKeyword: string,
    // 移动端「筛选」抽屉：直播间名关键字 + 直播平台多选（与 mobileSearchKeyword 取交集）
    mobileFilterKeyword: string,
    mobilePlatformFilter: string[],
    // 移动端「筛选」抽屉是否展开
    mobileFilterOpen: boolean,
    // 移动端卡片列表的排序方式（默认按运行状态/录制优先级，与桌面端 defaultSortOrder 一致）
    mobileSortKey: MobileSortKey,
    // 移动端多选模式：卡片上常显复选框 + 底部批量操作条；进入该模式不影响 selectedRowKeys
    mobileSelecting: boolean,
    // 移动端底部抽屉：批量「更多操作」/ 单卡「更多操作」/ 顶部「更多功能」/「列设置」
    mobileBatchSheetVisible: boolean,
    mobileCardMenuRoom: ItemData | null,
    mobileFeatureSheetVisible: boolean,
    mobileColumnSheetVisible: boolean,
    // 移动端卡片默认只平铺 2 个按钮（监控开关 + 展开详情），其余低频按钮折叠为「操作 ▾」
    mobileActionsExpanded: { [key: string]: boolean },
    // 移动端卡片列表当前已渲染的条数（分段渲染，避免一次性渲染 200+ 张卡片）
    mobileRenderLimit: number,
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

    // ---- 响应式断点：改用「视口宽度 + 变化监听」 ----
    //
    // 为什么不用 window.screen.width：
    //   screen.width 是设备屏幕的逻辑宽度，桌面浏览器把窗口拖到 600px、
    //   手机从竖屏转横屏，它都不会变化，因此原来的判断既测不准也收不到任何变化通知；
    //   结果是必须在「列集合 / scroll.x / Table 尺寸」等 5 处重复比较，改阈值容易漏改。
    // 这里改为 matchMedia('(max-width: 768px)')，它基于视口宽度且自带 change 事件。
    private smallScreenQuery: MediaQueryList | null = null;

    // resize 节流的 requestAnimationFrame 句柄（移动端地址栏收起/展开会高频触发 resize）
    private resizeRaf: number | null = null;

    // 媒体查询命中断点变化时的回调：把结果写入 state 触发重新排版，
    // 并顺带做一次列设置自愈（桌面端的列 key 在移动端可能一个都不存在）。
    handleSmallScreenChange = (event: MediaQueryListEvent) => {
        this.setState({ isSmall: event.matches }, () => {
            this.ensureVisibleColumnKeysValid();
        });
    };

    // 视口尺寸变化：只用来更新派生的 Table 虚拟滚动高度。
    // 用 rAF 节流，避免 resize 抖动时连续 setState 造成整表重渲染。
    handleViewportResize = () => {
        if (this.resizeRaf !== null) {
            return;
        }
        this.resizeRaf = window.requestAnimationFrame(() => {
            this.resizeRaf = null;
            const nextHeight = window.innerHeight;
            // 变化不足 8px 直接忽略：移动端滚动时地址栏的显示/隐藏会引起 60px 左右的抖动，
            // 若每次都更新 scroll.y，表格会在滚动过程中反复重排。
            if (Math.abs(nextHeight - this.state.viewportHeight) >= 8) {
                this.setState({ viewportHeight: nextHeight });
            }
        });
    };

    // Table 虚拟滚动的 scroll.y：由视口高度派生，代替原先写死的 600。
    // 写死 600 的问题：手机上一屏的预算（Header + Tabs + 工具栏 + 表头 ≈ 450px）已经接近视口高度，
    // 再叠加 600px 的内层滚动盒，表体底部永远落在屏幕外；手指落在表格上只会滚动内层盒子、
    // 页面不动，用户会以为「界面卡住」。这里按视口高度扣掉固定开销，并夹在 [240, 720] 之间。
    getTableScrollY = (): number => {
        return Math.max(240, Math.min(720, this.state.viewportHeight - 320));
    };

    // ---- 窄屏卡片列表复用的公共逻辑 ----
    // 下面这几个方法从原有的「运行状态」列 / 「操作」列里抽出来，
    // 目的是让桌面端 Table 与移动端卡片列表共用同一套状态标签颜色、同一套操作菜单，
    // 抽出前后逻辑逐行一致，桌面端渲染结果不变（只是调用点换成了方法调用）。

    // 录制优先级：数字越大越需要用户关注（待删除 > 一次性/等待首次直播 > 录制中 > 录制准备中 > 其他）。
    // 桌面端「运行状态」列的 sorter 用它，移动端卡片列表的默认排序也用它
    // ——卡片列表没有表头排序入口，若不排序，「待删除」的挽留入口会被埋在 200 多张卡片中间。
    getRecordingPriority = (tags: string[]): number => {
        if (tags.includes('待删除')) return 4;
        if (tags.includes('一次性录制中') || tags.includes('等待首次直播')) return 3;
        if (tags.includes('录制中')) return 2;
        if (tags.includes('录制准备中')) return 1;
        return 0;
    };

    // 运行状态标签渲染（颜色规则与原先「运行状态」列完全一致）。
    // 移动端卡片顶部要「完整展示」这些标签，颜色逻辑必须与桌面端一致，因此抽成方法复用。
    renderStatusTags = (tags: string[]): JSX.Element => (
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
    );

    // 「更多 ▾」下拉的菜单项（方案B）：录制时间段 / 一次性录制开关 / 删除直播间。
    // 桌面端「操作」列与移动端卡片共用，避免两套菜单逐渐走样。
    buildMoreMenuItems = (data: ItemData): any[] => [
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
        // 标签颜色规则抽到 renderStatusTags 里，供移动端卡片复用（渲染结果与原先完全一致）
        render: (tags: string[]) => this.renderStatusTags(tags),
        sorter: (a: ItemData, b: ItemData) => {
            // 待删除 > 一次性录制中/等待首次直播 > 录制中 > 录制准备中 > 其他
            // 「待删除」优先级最高，提醒用户尽快处理（挽留或转为永久）
            // 优先级计算抽到 getRecordingPriority，移动端卡片列表的默认排序复用同一套规则
            return this.getRecordingPriority(a.tags) - this.getRecordingPriority(b.tags);
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
            // 方案B：低频操作收进「更多」下拉菜单，避免操作列过于拥挤。
            // 菜单项由 buildMoreMenuItems 生成，移动端卡片复用同一份定义。
            const moreItems: any[] = this.buildMoreMenuItems(data);

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
            // 初始值直接用视口宽度判断：matchMedia 的订阅在 componentDidMount 里建立，
            // 但首屏渲染发生在挂载之前，若这里不给初值，第一帧会先按桌面端渲染再跳成移动端。
            isSmall: typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT_PX,
            viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 800,
            mobileSearchKeyword: '',
            mobileFilterKeyword: '',
            mobilePlatformFilter: [],
            mobileFilterOpen: false,
            mobileSortKey: loadMobileSortKey(),
            mobileSelecting: false,
            mobileBatchSheetVisible: false,
            mobileCardMenuRoom: null,
            mobileFeatureSheetVisible: false,
            mobileColumnSheetVisible: false,
            mobileActionsExpanded: {},
            mobileRenderLimit: MOBILE_CARD_PAGE_SIZE,
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

        // 响应式断点订阅：matchMedia 基于「视口宽度」，并在横竖屏切换 / 拖拽窗口时主动通知，
        // 取代原先只在 render 里读一次 window.screen.width 的做法。
        if (typeof window.matchMedia === 'function') {
            // 用局部常量承载，避免下面在闭包/多次 this 访问之后还要重新判空
            const smallQuery = window.matchMedia(MOBILE_MEDIA_QUERY);
            this.smallScreenQuery = smallQuery;
            // 用媒体查询的当前值同步一次 state，保证首屏判断与订阅后的判断来自同一来源
            this.setState({ isSmall: smallQuery.matches }, () => {
                this.ensureVisibleColumnKeysValid();
            });
            // 旧版 iOS Safari（<14）的 MediaQueryList 只有已废弃的 addListener，
            // 这里做一次能力探测，避免在不支持的手机浏览器上直接抛错导致整页白屏
            if (typeof (smallQuery as any).addEventListener === 'function') {
                smallQuery.addEventListener('change', this.handleSmallScreenChange);
            } else if (typeof (smallQuery as any).addListener === 'function') {
                (smallQuery as any).addListener(this.handleSmallScreenChange);
            }
        }

        // 视口高度监听：用于派生 Table 的 scroll.y。
        // orientationchange 在部分浏览器里会早于 innerHeight 更新，但同时也会触发 resize，
        // 两个事件共用同一个带 8px 阈值的处理函数，重复触发是安全的。
        window.addEventListener('resize', this.handleViewportResize);
        window.addEventListener('orientationchange', this.handleViewportResize);

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

        // 取消响应式断点与视口高度监听，避免组件卸载后回调仍触发 setState
        const smallQuery = this.smallScreenQuery;
        if (smallQuery) {
            if (typeof (smallQuery as any).removeEventListener === 'function') {
                smallQuery.removeEventListener('change', this.handleSmallScreenChange);
            } else if (typeof (smallQuery as any).removeListener === 'function') {
                // 与 componentDidMount 里的 addListener 兜底配对
                (smallQuery as any).removeListener(this.handleSmallScreenChange);
            }
            this.smallScreenQuery = null;
        }
        window.removeEventListener('resize', this.handleViewportResize);
        window.removeEventListener('orientationchange', this.handleViewportResize);
        if (this.resizeRaf !== null) {
            window.cancelAnimationFrame(this.resizeRaf);
            this.resizeRaf = null;
        }

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
                            // 窄屏：目标卡片可能还没被「分段渲染」出来（getElementById 会拿到 null），
                            // 这里把渲染上限提到「目标在卡片列表中的位置 + 1」，保证它一定在 DOM 里。
                            // 桌面端走的是 Table 的 scrollTo，与此无关。
                            if (this.state.isSmall) {
                                const targetIndex = this.getMobileFilteredSortedList()
                                    .findIndex(item => item.roomId === pendingRoomId);
                                if (targetIndex >= 0) {
                                    this.setState(prevState => ({
                                        mobileRenderLimit: Math.max(prevState.mobileRenderLimit, targetIndex + 1)
                                    }));
                                }
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
                                    // 窄屏渲染的是卡片列表，没有 Table 实例可调用 scrollTo，
                                    // 因此补一次原生滚动把目标卡片带到屏幕中间（桌面端行为不变）
                                    if (this.state.isSmall && typeof element.scrollIntoView === 'function') {
                                        element.scrollIntoView({ block: 'center' });
                                    }
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

    // 当前断点下「真实存在」的可切换列 key。
    //
    // 为什么需要它：桌面端与窄屏用的是两套列集合，而列设置过去是共用一份 key 的。
    // 手机上 Table 已经换成卡片列表，卡片只呈现 smallColumns 对应的信息，
    // 「直播间名称 / 直播平台」这两个 key 在窄屏下根本不存在：
    // 若面板仍展示它们，用户会把「主播名称 / 时间 / 大小 / 状态」全部取消、只留这两个不存在的列，
    // 结果列表只剩一个「操作」列，既无法辨认在操作谁、也无法自愈。
    getAvailableSwitchableColumnKeys = (isSmall: boolean): string[] => {
        if (!isSmall) {
            return [...SWITCHABLE_COLUMN_KEYS];
        }
        const smallColumnKeys = this.smallColumns
            .map((column: ColumnsType<ItemData>[number]) => String(column.key || ''))
            // 「操作」列不属于可切换列，剔除掉
            .filter((key: string) => !!key && key !== ALWAYS_VISIBLE_COLUMN_KEY);
        // 仍按 SWITCHABLE_COLUMN_KEYS 的顺序输出，保证面板顺序在断点切换前后稳定
        return SWITCHABLE_COLUMN_KEYS.filter(key => smallColumnKeys.includes(key));
    };

    // 「当前断点下有效」的可见列 key：
    //   1) 与当前断点可用的列 key 求交集（桌面端保存的设置切到窄屏后可能全部失效）；
    //   2) 交集为空时回退为「本断点全部可用列」，实现自愈，绝不会出现「一列都不剩」的死局。
    // 桌面端 available 就是全部 7 个 key，交集结果与 state.visibleColumnKeys 完全一致，
    // 因此桌面端的列显隐行为保持不变。
    getEffectiveVisibleColumnKeys = (): string[] => {
        const available = this.getAvailableSwitchableColumnKeys(this.state.isSmall);
        const effective = this.state.visibleColumnKeys.filter(key => available.includes(key));
        return effective.length > 0 ? effective : available;
    };

    // 断点切换 / 初始化时调用：若当前设置在本断点下一列都不剩，直接重置为本断点的全部列。
    // 这是「防止手机上只剩操作列」的第二道保险（第一道是 handleVisibleColumnsChange 的校验），
    // 用于纠正历史 localStorage 里已经存下的、在当前断点下无效的设置。
    ensureVisibleColumnKeysValid = () => {
        const available = this.getAvailableSwitchableColumnKeys(this.state.isSmall);
        const effective = this.state.visibleColumnKeys.filter(key => available.includes(key));
        if (effective.length === 0) {
            // 重置为全部可切换列（写入的是 7 个 key 的超集，另一个断点回到自己的界面时不会丢设置）
            this.handleSelectAllColumns();
        }
    };

    // 把当前可见列写回 localStorage（持久化失败不影响界面）
    saveVisibleColumnKeys = (keys: string[]) => {
        try {
            localStorage.setItem(VISIBLE_COLUMNS_STORAGE_KEY, JSON.stringify(keys));
        } catch (e) {
            console.error('保存列显示设置失败:', e);
        }
    };

    // Checkbox 组变化：勾选显示 / 取消隐藏某一列。
    // 校验口径：**过滤掉当前断点不存在的列之后**至少保留 1 列，否则拒绝并提示。
    // （原先只判断 length === 0，手机上把仅有的几列取消后会出现「列表只剩操作列」的死局）
    // allowEmpty=true 表示调用方已经在界面上做过二次确认（如窄屏抽屉里的「关闭全部」），
    // 此时允许清空可切换列——「操作」列始终显示，列表不会因此不可用。
    handleVisibleColumnsChange = (checkedValues: any, allowEmpty: boolean = false) => {
        const available = this.getAvailableSwitchableColumnKeys(this.state.isSmall);
        // 只接受本断点真实存在的列 key，防御程序化传入的脏值
        const keys = (Array.isArray(checkedValues) ? checkedValues : [])
            .map((key: any) => String(key))
            .filter((key: string) => available.includes(key));
        if (keys.length === 0 && !allowEmpty) {
            message.warning('至少要保留一列，不能把所有列都隐藏');
            return;
        }
        // 另一个断点专有的列 key 原样保留：
        // 否则在手机上调整一次列显隐，回到桌面端会发现「直播间名称 / 直播平台」也被关掉了。
        const preserved = this.state.visibleColumnKeys.filter(key => !available.includes(key));
        const nextKeys = [...keys, ...preserved];
        this.setState({ visibleColumnKeys: nextKeys });
        this.saveVisibleColumnKeys(nextKeys);
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
    renderColumnSettingPanel = () => {
        // 面板只渲染「当前断点列集合里真实存在」的 key，理由见 getAvailableSwitchableColumnKeys
        const available = this.getAvailableSwitchableColumnKeys(this.state.isSmall);
        return (
        <div style={{ minWidth: 200 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <Button type="link" size="small" style={{ padding: 0 }} onClick={this.handleSelectAllColumns}>全选</Button>
                <Button type="link" size="small" style={{ padding: 0 }} onClick={this.handleResetColumns}>重置</Button>
            </div>
            <Divider style={{ margin: '4px 0 8px' }} />
            <Checkbox.Group
                value={this.getEffectiveVisibleColumnKeys()}
                onChange={this.handleVisibleColumnsChange}
                style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
            >
                {available.map(key => (
                    <Checkbox key={key} value={key}>{COLUMN_KEY_LABELS[key] || key}</Checkbox>
                ))}
            </Checkbox.Group>
            <div style={{ color: '#999', fontSize: 12, marginTop: 8, paddingTop: 6, borderTop: '1px dashed #f0f0f0' }}>
                {this.state.isSmall
                    ? '窄屏使用卡片列表：「直播间名称 / 直播平台」固定显示在卡片副标题，无需开关；其余开关控制卡片上的信息行'
                    : '「操作」列始终显示'}
            </div>
        </div>
        );
    };

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
        // 断点来源统一改为 state.isSmall（由 matchMedia 驱动），不再读 window.screen.width
        const { isSmall } = this.state;
        const baseColumns = isSmall ? this.smallColumns : this.columns;

        // 平台筛选列表（去重后作为筛选器选项）；只有它变化时才需要重建列
        const addressList = Array.from(new Set(this.state.list.map(item => item.address)));
        const addressKey = addressList.join('\u0001');

        const { sortedInfo } = this.state;
        // 列显示设置必须进入缓存键：否则用户切换列显隐后缓存不失效，界面不会更新。
        // 这里用「当前断点下有效的列」而不是 state.visibleColumnKeys：
        // 桌面端两者完全相同，移动端则会剔除本断点不存在的列，保证缓存键与真实列集合一致。
        const effectiveVisibleKeys = this.getEffectiveVisibleColumnKeys();
        const visibleKey = effectiveVisibleKeys.join(',');
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
            return effectiveVisibleKeys.includes(key);
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

    // ==================== 窄屏（≤768px）卡片式列表 ====================
    //
    // 为什么用卡片替代 Table：
    //   Table 在手机上有一组无法通过调参解决的结构性问题——
    //   1) 列宽合计远超屏宽，必须横滑才能看到「操作」列，横滑后主播名又滑出屏幕，看不清在操作谁；
    //   2) 虚拟滚动按固定行高定位行，而「运行状态」多标签 + 待删除的两个挽留按钮必然折行 → 行错位；
    //   3) 展开行宽度 = 表格宽度（1156px），手机上 2/3 在屏幕外。
    //   卡片把「一个直播间在一屏内看完」当成前提：纵向排列、无横向滚动、行高自适应，
    //   上面三个问题从结构上就不存在了。

    // 卡片上的时间显示：只取「月-日 时:分」。
    // 复用 Utils.timestampToHumanReadable 保证与桌面端同源（避免两套时间格式），
    // 再截掉年份与秒——一行里要塞下「添加」和「直播」两个时间，19 字符的完整串在 375px 上会折行。
    formatCardTime = (timestamp: number): string => {
        if (!timestamp) {
            return '';
        }
        // "YYYY-MM-DD HH:mm:ss" -> "MM-DD HH:mm"
        return Utils.timestampToHumanReadable(timestamp).slice(5, 16);
    };

    // 卡片上的文件夹大小：优先后端返回的人类可读值，缺失时用字节数换算兜底
    formatCardFolderSize = (record: ItemData): string => {
        if (record.folderSizeHuman) {
            return record.folderSizeHuman;
        }
        return record.folderSize ? Utils.byteSizeToHumanReadableFileSize(record.folderSize) : '-';
    };

    // ---- 多选：与桌面端 rowSelection 共用同一份 state.selectedRowKeys ----
    // 共用同一个 state 的意义：横竖屏切换导致 isSmall 翻转时，选中状态不会丢失。

    toggleSelectRow = (roomId: string, checked: boolean) => {
        const next = checked
            ? Array.from(new Set([...this.state.selectedRowKeys, roomId]))
            : this.state.selectedRowKeys.filter(id => id !== roomId);
        this.setSelectedRowKeys(next);
    };

    // 卡片列表的数据源：搜索 + 筛选 + 排序，全部在完整列表 this.state.list 上完成
    // （不受「分段渲染」影响，未渲染的卡片同样参与筛选/全选，语义与桌面端一致）。
    //
    // 三层过滤条件（取交集）：
    //   1) 工具条搜索框 mobileSearchKeyword —— 同时匹配主播名与直播间名；
    //   2) 筛选抽屉 mobileFilterKeyword —— 只匹配直播间名（桌面端「直播间名称」列的表头搜索）；
    //   3) 筛选抽屉 mobilePlatformFilter —— 直播平台多选（桌面端「直播平台」列的表头筛选）。
    // 排序默认按录制优先级倒序，与桌面端「运行状态」列的 defaultSortOrder: 'descend' 一致，
    // 保证「待删除」永远排在最前面，用户不会漏掉卡片上的挽留入口；用户可在工具条里改排序。
    getMobileFilteredSortedList = (): ItemData[] => {
        const keyword = this.state.mobileSearchKeyword.trim().toLowerCase();
        const roomKeyword = this.state.mobileFilterKeyword.trim().toLowerCase();
        const platforms = this.state.mobilePlatformFilter;
        const filtered = this.state.list.filter(item => {
            if (keyword) {
                const matchedName = String(item.name || '').toLowerCase().includes(keyword);
                const matchedRoom = String((item.room && item.room.roomName) || '').toLowerCase().includes(keyword);
                if (!matchedName && !matchedRoom) {
                    return false;
                }
            }
            if (roomKeyword) {
                const roomName = String((item.room && item.room.roomName) || '').toLowerCase();
                if (!roomName.includes(roomKeyword)) {
                    return false;
                }
            }
            if (platforms.length > 0 && !platforms.includes(item.address)) {
                return false;
            }
            return true;
        });
        return this.sortMobileList(filtered);
    };

    // 窄屏排序：按 state.mobileSortKey 排序（默认运行状态/录制优先级倒序）
    sortMobileList = (list: ItemData[]): ItemData[] => {
        const comparators: { [key: string]: (a: ItemData, b: ItemData) => number } = {
            priority: (a, b) => this.getRecordingPriority(b.tags) - this.getRecordingPriority(a.tags),
            // 时间/大小列与桌面端的 sorter 方向一致（桌面端点第一次是升序）
            addedAt: (a, b) => a.addedAt - b.addedAt,
            lastStartTimeUnix: (a, b) => a.lastStartTimeUnix - b.lastStartTimeUnix,
            folderSize: (a, b) => a.folderSize - b.folderSize,
            name: (a, b) => a.name.localeCompare(b.name),
        };
        const compare = comparators[this.state.mobileSortKey] || comparators.priority;
        return list.slice().sort(compare);
    };

    // ---- 窄屏工具条：搜索 / 筛选 / 排序 / 多选 ----

    // 搜索框变化：清空分段渲染进度，避免「加载更多」的进度串到新的筛选结果上
    handleMobileSearchChange = (value: string) => {
        this.setState({ mobileSearchKeyword: value, mobileRenderLimit: MOBILE_CARD_PAGE_SIZE });
    };

    // 筛选抽屉里的直播间名关键字
    handleMobileFilterKeywordChange = (value: string) => {
        this.setState({ mobileFilterKeyword: value, mobileRenderLimit: MOBILE_CARD_PAGE_SIZE });
    };

    // 筛选抽屉里的直播平台多选（选项为当前列表里实际出现过的平台）
    handleMobilePlatformFilterChange = (values: any) => {
        this.setState({
            mobilePlatformFilter: Array.isArray(values) ? values.map((v: any) => String(v)) : [],
            mobileRenderLimit: MOBILE_CARD_PAGE_SIZE,
        });
    };

    // 切换窄屏排序方式（持久化到 localStorage，与列设置同一套做法）
    handleMobileSortChange = (key: MobileSortKey) => {
        this.setState({ mobileSortKey: key, mobileRenderLimit: MOBILE_CARD_PAGE_SIZE });
        try {
            localStorage.setItem(MOBILE_SORT_STORAGE_KEY, key);
        } catch (e) {
            console.error('保存窄屏排序设置失败:', e);
        }
    };

    // 清空全部窄屏筛选条件（搜索框 + 筛选抽屉）
    clearMobileFilters = () => {
        this.setState({
            mobileSearchKeyword: '',
            mobileFilterKeyword: '',
            mobilePlatformFilter: [],
            mobileRenderLimit: MOBILE_CARD_PAGE_SIZE,
        });
    };

    // 单卡「操作 ▾」的展开状态（key = roomId）
    toggleMobileCardActions = (roomId: string) => {
        this.setState(prevState => ({
            mobileActionsExpanded: {
                ...prevState.mobileActionsExpanded,
                [roomId]: !prevState.mobileActionsExpanded[roomId],
            }
        }));
    };

    // 当前筛选条件下已生效的筛选条数（用于工具条上「筛选」按钮的角标）
    getMobileFilterCount = (): number => {
        return (this.state.mobileFilterKeyword.trim() ? 1 : 0)
            + (this.state.mobilePlatformFilter.length > 0 ? 1 : 0);
    };

    // ---- 窄屏面板的公共组件：底部抽屉 / 操作行 / 顶部工具条 ----
    // 为什么不直接用 antd Drawer：本文件在 antd 5/6 混用的边界上，
    // 自绘抽屉不依赖任何可能改名的组件 API（open/visible、destroyOnClose 等），
    // 也便于把触控目标统一做到 ≥44px、并把滚动锁在抽屉内部（不产生第二层页面滚动）。

    // 底部抽屉：遮罩 + 圆角面板 + 标题栏（关闭按钮）。
    // 点遮罩、点关闭按钮、点任意条目都会关闭抽屉；条目由调用方传入。
    renderMobileSheet = (
        visible: boolean,
        title: string,
        onClose: () => void,
        children: React.ReactNode,
        subtitle?: string
    ) => {
        if (!visible) {
            return null;
        }
        return (
            <div className="ll-sheet-mask" onClick={onClose}>
                <div className="ll-sheet" onClick={(e) => e.stopPropagation()}>
                    <div className="ll-sheet-header">
                        <div className="ll-sheet-title">
                            {title}
                            {subtitle ? <span className="ll-sheet-subtitle">{subtitle}</span> : null}
                        </div>
                        <button type="button" className="ll-sheet-close" onClick={onClose} aria-label="关闭">
                            <CloseOutlined />
                        </button>
                    </div>
                    <div className="ll-sheet-body">{children}</div>
                </div>
            </div>
        );
    };

    // 抽屉里的一行操作：左侧图标（可选）+ 文案 + 右侧说明，
    // 统一用 44px 最小高度与 14px 字号，danger 为删除类操作。
    renderMobileSheetItem = (
        key: string,
        label: string,
        onClick: () => void,
        options?: { icon?: React.ReactNode; danger?: boolean; active?: boolean; hint?: string }
    ) => {
        const opts = options || {};
        return (
            <button
                type="button"
                key={key}
                className={`ll-sheet-item${opts.danger ? ' danger' : ''}${opts.active ? ' active' : ''}`}
                onClick={onClick}
            >
                {opts.icon ? <span className="ll-sheet-item-icon">{opts.icon}</span> : null}
                <span className="ll-sheet-item-label">{label}</span>
                {opts.active ? <CheckCircleOutlined className="ll-sheet-item-check" /> : null}
                {opts.hint ? <span className="ll-sheet-item-hint">{opts.hint}</span> : null}
            </button>
        );
    };

    // 当前筛选结果是否已被全部选中（用于「全选 / 取消全选」按钮的文案）
    isMobileAllSelected = (): boolean => {
        const list = this.getMobileFilteredSortedList();
        return list.length > 0 && list.every(item => this.state.selectedRowKeys.includes(item.roomId));
    };

    // 移动端「全选 / 取消全选」：作用于「当前筛选结果的完整 key 列表」，
    // 而不是已渲染出来的卡片，语义与桌面端表头全选一致（筛选后全选 = 选中筛选结果）。
    toggleSelectAllMobile = () => {
        if (this.isMobileAllSelected()) {
            this.setSelectedRowKeys([]);
            return;
        }
        this.setSelectedRowKeys(this.getMobileFilteredSortedList().map(item => item.roomId));
    };

    // ---- 卡片上的操作：与桌面端「操作」列语义一致，只把按钮从 link 样式换成可点的块状按钮 ----

    // 停止 / 开启监控
    handleToggleListening = (roomId: string, listening: boolean) => {
        if (listening) {
            api.stopRecord(roomId)
                .then(() => {
                    api.saveSettingsInBackground();
                    this.refresh();
                })
                .catch(err => {
                    alert(`停止监控失败:\n${err}`);
                });
        } else {
            api.startRecord(roomId)
                .then(() => {
                    api.saveSettingsInBackground();
                    this.refresh();
                })
                .catch(err => {
                    alert(`开启监控失败:\n${err}`);
                });
        }
    };

    // 仅提醒模式下的直接开始/停止录制
    handleStartRecordDirect = (roomId: string) => {
        api.startRecordDirect(roomId)
            .then(() => {
                message.success('已开始录制');
                this.refresh();
            })
            .catch(err => {
                alert(`开始录制失败:\n${err}`);
            });
    };

    handleStopRecordDirect = (roomId: string) => {
        api.stopRecordDirect(roomId)
            .then(() => {
                message.success('已停止录制');
                this.refresh();
            })
            .catch(err => {
                alert(`停止录制失败:\n${err}`);
            });
    };

    // ---- 待删除的两个挽留操作（明确的产品需求：必须放在卡片内显眼位置，不能藏进「更多」）----

    // 挽留：再次开启一次性录制并带上 reset 标记，从「待删除」重置为「一次性录制中」并重新计时
    handleResetToOneTime = (roomId: string) => {
        api.setOneTime(roomId, true, true)
            .then(() => {
                message.success('已重置为一次性录制');
                this.refresh();
            })
            .catch(err => {
                alert(`重置为一次性录制失败:\n${err}`);
            });
    };

    // 转为永久：清除一次性标记，不再进入待删除
    handleConvertToPersistent = (roomId: string) => {
        api.setOneTime(roomId, false)
            .then(() => {
                message.success('已转为永久录制');
                this.refresh();
            })
            .catch(err => {
                alert(`转为永久录制失败:\n${err}`);
            });
    };

    // ==================== 窄屏工具条 / 底部抽屉 / 卡片 ====================

    // renderMobileTopBar 渲染窄屏顶部第一行：标题 + 「多选」+「更多功能」。
    // 窄屏只保留这两个入口，避免标题被挤成竖排、按钮被裁出屏幕。
    renderMobileTopBar = () => {
        const selectedCount = this.state.selectedRowKeys.length;
        return (
            <div className="ll-mobile-topbar">
                <div className="ll-mobile-title">
                    直播间列表
                    <span className="ll-mobile-count">{this.state.list.length} 个</span>
                </div>
                <div className="ll-mobile-topbar-actions">
                    <Button
                        size="middle"
                        type={this.state.mobileSelecting ? 'primary' : 'default'}
                        onClick={() => {
                            // 退出多选时同时收起批量抽屉，避免抽屉停留在已失效的上下文里
                            this.setState(prevState => ({
                                mobileSelecting: !prevState.mobileSelecting,
                                mobileBatchSheetVisible: false,
                            }));
                        }}
                    >
                        {this.state.mobileSelecting ? `多选中(${selectedCount})` : '多选'}
                    </Button>
                    <Button size="middle" onClick={() => this.setState({ mobileFeatureSheetVisible: true })}>
                        <MoreOutlined /> 更多
                    </Button>
                </div>
            </div>
        );
    };

    // renderMobileToolbar 渲染窄屏第二行工具条：搜索 + 筛选 + 排序 + 列设置。
    // 这一行是 sticky 的（吸附在滚动容器顶部），列表滚动时依然可用。
    renderMobileToolbar = () => {
        const filterCount = this.getMobileFilterCount();
        const sortLabel = (MOBILE_SORT_OPTIONS.find(option => option.key === this.state.mobileSortKey) || MOBILE_SORT_OPTIONS[0]).label;
        const sortItems = MOBILE_SORT_OPTIONS.map(option => ({
            key: option.key,
            label: option.label,
        }));
        return (
            <div className="ll-mobile-toolbar">
                <div className="ll-mobile-toolbar-row">
                    <Input
                        allowClear
                        size="middle"
                        placeholder="搜索主播 / 直播间"
                        value={this.state.mobileSearchKeyword}
                        onChange={e => this.handleMobileSearchChange(e.target.value)}
                    />
                    <button
                        type="button"
                        className={`ll-mobile-tool-btn${filterCount > 0 ? ' active' : ''}`}
                        onClick={() => this.setState({ mobileFilterOpen: true })}
                    >
                        <FilterOutlined />
                        <span>筛选{filterCount > 0 ? `(${filterCount})` : ''}</span>
                    </button>
                    <button
                        type="button"
                        className="ll-mobile-tool-btn"
                        onClick={() => this.setState({ mobileColumnSheetVisible: true })}
                    >
                        <SettingOutlined />
                        <span>列</span>
                    </button>
                </div>
                <div className="ll-mobile-toolbar-row ll-mobile-toolbar-sub">
                    <Dropdown
                        trigger={['click']}
                        menu={{
                            items: sortItems,
                            selectable: true,
                            selectedKeys: [this.state.mobileSortKey],
                            // antd Menu 的 info.key 是 string，而 handleMobileSortChange 需要 MobileSortKey，
                            // 这里显式收敛类型（下拉项只可能来自 MOBILE_SORT_OPTIONS）
                            onClick: (info: any) => this.handleMobileSortChange(String(info.key) as MobileSortKey),
                        }}
                    >
                        <button type="button" className="ll-mobile-tool-btn">
                            排序：{sortLabel}
                            <DownOutlined />
                        </button>
                    </Dropdown>
                    <span className="ll-mobile-hint">
                        {this.state.mobileSearchKeyword || filterCount > 0
                            ? `筛选结果 ${this.getMobileFilteredSortedList().length} / ${this.state.list.length}`
                            : '任一卡片可多选，底部出现批量操作'}
                    </span>
                </div>
            </div>
        );
    };

    // renderMobileFilterSheet 渲染窄屏「筛选」底部抽屉：直播间名 + 直播平台。
    // 与桌面端的「直播间名称列头模糊搜索」和「直播平台列头筛选」一一对应，
    // 保证卡片列表上这两个桌面能力同样可达。
    renderMobileFilterSheet = () => {
        const platformList = Array.from(new Set(this.state.list.map(item => item.address))).filter(Boolean);
        return this.renderMobileSheet(
            this.state.mobileFilterOpen,
            '筛选',
            () => this.setState({ mobileFilterOpen: false }),
            <div className="ll-sheet-form">
                <div className="ll-sheet-field">
                    <label>直播间名称</label>
                    <Input
                        allowClear
                        size="middle"
                        placeholder="按直播间名称过滤"
                        value={this.state.mobileFilterKeyword}
                        onChange={e => this.handleMobileFilterKeywordChange(e.target.value)}
                    />
                </div>
                <div className="ll-sheet-field">
                    <label>直播平台</label>
                    <Select
                        mode="multiple"
                        allowClear
                        size="middle"
                        placeholder="不限制（可多选）"
                        value={this.state.mobilePlatformFilter}
                        onChange={this.handleMobilePlatformFilterChange}
                        options={platformList.map(name => ({ label: name, value: name }))}
                    />
                </div>
                <div className="ll-sheet-actions">
                    <Button block size="middle" onClick={this.clearMobileFilters}>清空筛选</Button>
                    <Button block size="middle" type="primary" onClick={() => this.setState({ mobileFilterOpen: false })}>
                        完成
                    </Button>
                </div>
            </div>
        );
    };

    // renderMobileFeatureSheet 渲染窄屏「更多功能」底部抽屉：
    // 放置实时更新开关、列设置、多选模式、刷新列表、保存设置、添加房间。
    // 桌面端这些按钮平铺在标题栏右侧，窄屏塞不下，因此收进抽屉，全部能力仍然可达。
    renderMobileFeatureSheet = () => {
        return this.renderMobileSheet(
            this.state.mobileFeatureSheetVisible,
            '更多功能',
            () => this.setState({ mobileFeatureSheetVisible: false }),
            <div className="ll-sheet-list">
                {this.renderMobileSheetItem(
                    'sse',
                    this.state.enableListSSE ? '实时更新：已开启' : '实时更新：已关闭',
                    () => {
                        setListSSEEnabled(!this.state.enableListSSE);
                        this.setState({ mobileFeatureSheetVisible: false });
                    },
                    { icon: <CloudSyncOutlined />, active: this.state.enableListSSE }
                )}
                {this.renderMobileSheetItem(
                    'columns',
                    '列设置',
                    () => this.setState({ mobileFeatureSheetVisible: false, mobileColumnSheetVisible: true }),
                    { icon: <SettingOutlined /> }
                )}
                {this.renderMobileSheetItem(
                    'select',
                    this.state.mobileSelecting ? '退出多选模式' : '开启多选模式',
                    () => this.setState(prevState => ({
                        mobileSelecting: !prevState.mobileSelecting,
                        mobileFeatureSheetVisible: false,
                    })),
                    { icon: <CheckCircleOutlined /> }
                )}
                {this.renderMobileSheetItem(
                    'refresh',
                    '刷新列表',
                    () => {
                        this.refresh();
                        this.setState({ mobileFeatureSheetVisible: false });
                    },
                    { icon: <SyncOutlined /> }
                )}
                {this.renderMobileSheetItem(
                    'save',
                    '保存设置',
                    () => {
                        this.onSettingSave();
                        this.setState({ mobileFeatureSheetVisible: false });
                    },
                    { icon: <EditOutlined /> }
                )}
                {this.renderMobileSheetItem(
                    'add',
                    '添加房间',
                    () => this.setState({ mobileFeatureSheetVisible: false, batchAddDialogVisible: true }),
                    { icon: <CloudSyncOutlined /> }
                )}
            </div>
        );
    };

    // renderMobileColumnSheet 渲染窄屏「列设置」底部抽屉。
    // 复用列设置面板的同一份数据源（getAvailableSwitchableColumnKeys /
    // getEffectiveVisibleColumnKeys / handleVisibleColumnsChange），
    // 因此窄屏与桌面端的列显隐是同一份设置，切换后互不打架。
    renderMobileColumnSheet = () => {
        const available = this.getAvailableSwitchableColumnKeys(this.state.isSmall);
        const effective = this.getEffectiveVisibleColumnKeys();
        const orderedKeys = available.slice().sort((a, b) => {
            const indexA = effective.indexOf(a);
            const indexB = effective.indexOf(b);
            return (indexA < 0 ? 99 : indexA) - (indexB < 0 ? 99 : indexB);
        });
        return this.renderMobileSheet(
            this.state.mobileColumnSheetVisible,
            '列设置',
            () => this.setState({ mobileColumnSheetVisible: false }),
            <div className="ll-sheet-list">
                {orderedKeys.map(key => {
                    const checked = effective.includes(key);
                    return this.renderMobileSheetItem(
                        `col-${key}`,
                        COLUMN_KEY_LABELS[key] || key,
                        () => this.handleVisibleColumnsChange(
                            checked ? effective.filter(item => item !== key) : [...effective, key]
                        ),
                        { active: checked }
                    );
                })}
                <div className="ll-sheet-note">
                    窄屏使用卡片列表：「主播名称」固定显示，直播间名与直播平台固定显示在卡片副标题；其余开关控制卡片上的信息行。
                </div>
                <div className="ll-sheet-actions">
                    <Button block size="middle" onClick={this.handleSelectAllColumns}>全部显示</Button>
                    <Button block size="middle" onClick={this.handleResetColumns}>恢复默认</Button>
                </div>
            </div>
        );
    };

    // buildMobileCardActionItems 生成单卡「更多操作」抽屉的条目。
    // 与桌面端「操作」列的「更多 ▾」（buildMoreMenuItems）语义一致，
    // 另外补上文件管理 / 直播间配置 / 刷新文件夹大小 / 强制刷新这些桌面端平铺的入口。
    buildMobileCardActionItems = (record: ItemData): JSX.Element[] => {
        const items: JSX.Element[] = [];
        items.push(this.renderMobileSheetItem(
            'file',
            '文件管理',
            () => {
                this.setState({ mobileCardMenuRoom: null });
                this.props.navigate(`/fileList/${record.address}/${record.name}`);
            },
            { icon: <SettingOutlined /> }
        ));
        items.push(this.renderMobileSheetItem(
            'config',
            '直播间配置',
            () => {
                this.setState({ mobileCardMenuRoom: null });
                window.open(`/#/configInfo#rooms-live-${record.roomId}`, '_blank', 'noopener,noreferrer');
            },
            { icon: <SettingOutlined /> }
        ));
        items.push(this.renderMobileSheetItem(
            'folderSize',
            '刷新文件夹大小',
            () => {
                this.handleRefreshFolderSize();
                this.setState({ mobileCardMenuRoom: null });
            },
            { icon: <ReloadOutlined /> }
        ));
        items.push(this.renderMobileSheetItem(
            'schedule',
            '录制时间段',
            () => {
                this.setState({ mobileCardMenuRoom: null });
                this.openRecordScheduleDialog([record.roomId]);
            },
            { icon: <SwapOutlined /> }
        ));
        // 一次性录制开关：与桌面端「更多」菜单同一套语义（oneTimeStatus 非空 -> 转持久）
        items.push(this.renderMobileSheetItem(
            'oneTime',
            record.oneTimeStatus ? '转为持久性录制' : '转为一次性录制',
            () => {
                const nextValue = !record.oneTimeStatus;
                this.setState({ mobileCardMenuRoom: null });
                api.setOneTime(record.roomId, nextValue)
                    .then(() => {
                        message.success(nextValue ? '已转为一次性录制' : '已转为持久性录制');
                        this.refresh();
                    })
                    .catch(err => {
                        alert(`设置一次性录制失败:\n${err}`);
                    });
            },
            { icon: <SwapOutlined />, active: !!record.oneTimeStatus }
        ));
        items.push(this.renderMobileSheetItem(
            'forceRefresh',
            '强制刷新房间信息',
            () => {
                this.setState({ mobileCardMenuRoom: null });
                api.forceRefreshLive(record.roomId)
                    .then(() => {
                        message.success('已触发强制刷新');
                        this.loadRoomDetail(record.roomId);
                        this.refresh();
                    })
                    .catch(err => {
                        alert(`强制刷新失败:\n${err}`);
                    });
            },
            { icon: <SyncOutlined /> }
        ));
        items.push(this.renderMobileSheetItem(
            'delete',
            '删除直播间',
            () => {
                this.setState({ mobileCardMenuRoom: null });
                Modal.confirm({
                    title: '确定删除当前直播间？',
                    content: '删除链接不会删除已录制到磁盘的文件。',
                    okText: '确定',
                    cancelText: '取消',
                    okButtonProps: { danger: true },
                    onOk: () => {
                        api.deleteRoom(record.roomId)
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
            { icon: <ExclamationCircleOutlined />, danger: true }
        ));
        return items;
    };

    // renderMobileBatchSheet 渲染批量「更多操作」底部抽屉。
    // 平铺批次操作（启动/停止监控、删除）放在底部操作条上，
    // 录制时间段 / 一次性 / 持久化这三个低频批量操作放这里。
    renderMobileBatchSheet = () => {
        const selectedCount = this.state.selectedRowKeys.length;
        return this.renderMobileSheet(
            this.state.mobileBatchSheetVisible,
            '批量操作',
            () => this.setState({ mobileBatchSheetVisible: false }),
            <div className="ll-sheet-list">
                {this.renderMobileSheetItem(
                    'schedule',
                    '配置录制时间段',
                    () => {
                        const ids = this.state.selectedRowKeys;
                        this.setState({ mobileBatchSheetVisible: false });
                        this.openRecordScheduleDialog(ids);
                    },
                    { icon: <SwapOutlined /> }
                )}
                {this.renderMobileSheetItem(
                    'oneTime',
                    '设为一次性录制',
                    () => {
                        this.setState({ mobileBatchSheetVisible: false });
                        this.handleBatchOperation('set_one_time');
                    },
                    { icon: <SwapOutlined /> }
                )}
                {this.renderMobileSheetItem(
                    'persistent',
                    '设为持久性录制',
                    () => {
                        this.setState({ mobileBatchSheetVisible: false });
                        this.handleBatchOperation('set_persistent');
                    },
                    { icon: <SwapOutlined /> }
                )}
                {this.renderMobileSheetItem(
                    'delete',
                    `删除选中的 ${selectedCount} 个直播间`,
                    () => {
                        this.setState({ mobileBatchSheetVisible: false });
                        Modal.confirm({
                            title: `确定删除选中的 ${selectedCount} 个直播间？`,
                            content: '删除链接不会删除已录制到磁盘的文件。',
                            okText: '确定',
                            cancelText: '取消',
                            okButtonProps: { danger: true },
                            onOk: () => this.handleBatchOperation('delete'),
                        });
                    },
                    { icon: <ExclamationCircleOutlined />, danger: true }
                )}
                {this.renderMobileSheetItem(
                    'clear',
                    '取消全部选择',
                    () => {
                        this.setSelectedRowKeys([]);
                        this.setState({ mobileBatchSheetVisible: false });
                    },
                    { icon: <CloseOutlined /> }
                )}
            </div>
        );
    };

    // renderMobileCardSheet 渲染单卡「更多操作」底部抽屉（由 renderMobileCard 触发）
    renderMobileCardSheet = () => {
        const record = this.state.mobileCardMenuRoom;
        return this.renderMobileSheet(
            !!record,
            record ? record.name : '',
            () => this.setState({ mobileCardMenuRoom: null }),
            record ? <div className="ll-sheet-list">{this.buildMobileCardActionItems(record)}</div> : null,
            record ? `${record.room.roomName} · ${record.address}` : undefined
        );
    };

    // renderMobileCardMeta 渲染卡片上的信息行。
    // 「添加链接时间 / 最近一次直播时间 / 文件夹大小」这三项跟随「列设置」开关，
    // 与桌面端这三列一一对应；「文件夹大小」自带手动刷新入口。
    renderMobileCardMeta = (record: ItemData) => {
        const visibleKeys = this.getEffectiveVisibleColumnKeys();
        const showAddedAt = visibleKeys.includes('addedAt');
        const showLastLive = visibleKeys.includes('lastStartTimeUnix');
        const showFolderSize = visibleKeys.includes('folderSize');
        if (!showAddedAt && !showLastLive && !showFolderSize) {
            return null;
        }
        const rows: React.ReactNode[] = [];
        if (showAddedAt) {
            rows.push(<span key="addedAt">添加 {this.formatCardTime(record.addedAt) || '-'}</span>);
        }
        if (showLastLive) {
            rows.push(<span key="lastLive">直播 {record.lastStartTimeUnix ? this.formatCardTime(record.lastStartTimeUnix) : '从未直播'}</span>);
        }
        if (showFolderSize) {
            rows.push(
                <span key="folderSize" onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', alignItems: 'center' }}>
                    文件夹 {this.formatCardFolderSize(record)}
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
            );
        }
        return <div className="ll-card-meta">{rows}</div>;
    };

    // renderMobileCardButtons 渲染单卡的操作按钮。
    // 默认平铺 4 个按钮（监控开关 + 操作 ▾ + 更多 + 详情），低频入口折叠进「操作 ▾」，
    // 避免一张卡片上出现 6~7 个按钮把卡片撑得又高又乱；
    // 「待删除」的两个挽留按钮以及「仅提醒」的开始/停止录制属高频且紧急，始终平铺。
    renderMobileCardButtons = (record: ItemData, expanded: boolean) => {
        const actionsExpanded = !!this.state.mobileActionsExpanded[record.roomId];
        return (
            <>
                <PopDialog
                    title={record.listening ? '确定停止监控？' : '确定开启监控？'}
                    onConfirm={() => this.handleToggleListening(record.roomId, record.listening)}>
                    <Button className="ll-btn" size="middle" type={record.listening ? 'default' : 'primary'}>
                        {record.listening ? '停止监控' : '开启监控'}
                    </Button>
                </PopDialog>
                {record.notifyOnly && record.isLive && !record.isRecording && (
                    <PopDialog
                        title="确定开始录制？"
                        onConfirm={() => this.handleStartRecordDirect(record.roomId)}>
                        <Button className="ll-btn" size="middle" type="primary" danger>开始录制</Button>
                    </PopDialog>
                )}
                {record.notifyOnly && record.isLive && record.isRecording && (
                    <PopDialog
                        title="确定停止录制？"
                        onConfirm={() => this.handleStopRecordDirect(record.roomId)}>
                        <Button className="ll-btn" size="middle" danger>停止录制</Button>
                    </PopDialog>
                )}
                {actionsExpanded && (
                    <>
                        <Button
                            className="ll-btn"
                            size="middle"
                            onClick={() => this.props.navigate(`/fileList/${record.address}/${record.name}`)}>
                            文件
                        </Button>
                        <Button
                            className="ll-btn"
                            size="middle"
                            onClick={() => window.open(`/#/configInfo#rooms-live-${record.roomId}`, '_blank', 'noopener,noreferrer')}>
                            配置
                        </Button>
                        <Button
                            className="ll-btn"
                            size="middle"
                            onClick={() => this.openRecordScheduleDialog([record.roomId])}>
                            时间段
                        </Button>
                    </>
                )}
                <Button
                    className="ll-btn"
                    size="middle"
                    onClick={() => this.toggleMobileCardActions(record.roomId)}>
                    {actionsExpanded ? '收起' : '操作'}
                    {actionsExpanded ? <UpOutlined /> : <DownOutlined />}
                </Button>
                <Button
                    className="ll-btn"
                    size="middle"
                    onClick={() => this.setState({ mobileCardMenuRoom: record })}>
                    <MoreOutlined /> 更多
                </Button>
                <Button
                    className="ll-btn"
                    size="middle"
                    type={expanded ? 'primary' : 'default'}
                    ghost={expanded}
                    onClick={() => this.toggleExpandRow(record.roomId)}>
                    {expanded ? '收起详情' : '详情'}
                </Button>
            </>
        );
    };

    // renderMobileCard 渲染单个直播间卡片。
    // 结构（自上而下，全部落在单张卡片内，不产生横向滚动）：
    //   1) 卡片外框：选中 / 展开 / 待删除 / 多选态各有独立视觉（一眼可辨）
    //   2) 标题行：复选框（多选态常显）+ 主播名（单行省略）+ 直播平台标签
    //   3) 状态标签行：运行状态标签（允许换行，不省略）
    //   4) 副标题行：直播间名（省略，点击跳转原直播间）+ lastError 提示
    //   5) 信息行：添加时间 · 最近直播 · 文件夹大小（跟随列设置）
    //   6) 待删除挽留区：重置为一次性 / 转为永久
    //   7) 操作行：监控开关 + 开始/停止录制 + 操作 ▾ + 更多抽屉 + 详情
    //   8) 展开详情：复用 renderExpandedRow
    renderMobileCard = (record: ItemData): JSX.Element => {
        const selected = this.state.selectedRowKeys.includes(record.roomId);
        const expanded = this.state.expandedRowKeys.includes(record.roomId);
        const isPendingDelete = record.oneTimeStatus === 'pending_delete';
        const inSelectMode = this.state.mobileSelecting || this.state.selectedRowKeys.length > 0;

        const cardClass = [
            'll-card',
            selected ? 'll-card-selected' : '',
            expanded ? 'll-card-expanded' : '',
            isPendingDelete ? 'll-card-pending' : '',
            inSelectMode ? 'll-card-selectmode' : '',
        ].filter(Boolean).join(' ');

        return (
            <div key={record.roomId} id={`row-live-${record.roomId}`} className={cardClass}>
                <div className="ll-card-head">
                    <div className="ll-card-title">
                        {inSelectMode && (
                            <span className="ll-card-check" onClick={(e) => e.stopPropagation()}>
                                <Checkbox
                                    checked={selected}
                                    name={record.roomId}
                                    onChange={e => this.toggleSelectRow(record.roomId, e.target.checked)}
                                />
                            </span>
                        )}
                        <a
                            className="ll-card-name"
                            href={record.room.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={record.name}
                            onClick={(e) => e.stopPropagation()}
                        >
                            {record.name}
                        </a>
                        {record.address && <Tag className="ll-card-platform">{record.address}</Tag>}
                    </div>
                </div>
                <div className="ll-card-tags">
                    {this.renderStatusTags(record.tags)}
                </div>
                <div className="ll-card-sub">
                    {record.room.lastError && (
                        <Tooltip title={record.room.lastError}>
                            <ExclamationCircleOutlined style={{ color: '#ff4d4f', marginRight: 4 }} />
                        </Tooltip>
                    )}
                    <a
                        className="ll-card-room"
                        href={record.room.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={record.room.roomName}
                    >
                        {record.room.roomName}
                    </a>
                </div>
                {this.renderMobileCardMeta(record)}
                {isPendingDelete && (
                    <div className="ll-card-alert">
                        <div className="ll-card-alert-text">
                            <ExclamationCircleOutlined /> 一次性录制已结束，该直播间即将被删除
                        </div>
                        <div className="ll-card-alert-actions">
                            <PopDialog
                                title="确定将该直播间重置为一次性录制？"
                                onConfirm={() => this.handleResetToOneTime(record.roomId)}>
                                <Button className="ll-btn" size="middle" style={{ backgroundColor: '#52c41a', borderColor: '#52c41a', color: '#fff' }}>
                                    重置为一次性
                                </Button>
                            </PopDialog>
                            <PopDialog
                                title="确定将该直播间转为永久录制？"
                                onConfirm={() => this.handleConvertToPersistent(record.roomId)}>
                                <Button className="ll-btn" size="middle" style={{ backgroundColor: '#fa8c16', borderColor: '#fa8c16', color: '#fff' }}>
                                    转为永久
                                </Button>
                            </PopDialog>
                        </div>
                    </div>
                )}
                <div className="ll-card-actions">
                    {this.renderMobileCardButtons(record, expanded)}
                </div>
                {expanded && (
                    <div className="ll-card-detail">
                        {this.renderExpandedRow(record)}
                    </div>
                )}
            </div>
        );
    };

    // renderMobileCardList 渲染窄屏卡片列表本身（不含工具条）。
    // 容器用 flex: 1 + min-height: 0 + overflow-y: auto（见 live-list.css）：
    // 整个窄屏界面只有这一个纵向滚动层，不会出现「页面滚一层 + 列表内再滚一层」。
    // 参数 sorted 由 renderMobileStickyArea 统一计算，避免同一帧内重复排序。
    renderMobileCardList = (sorted: ItemData[]) => {
        const total = this.state.list.length;
        const hasFilter = !!this.state.mobileSearchKeyword.trim() || this.getMobileFilterCount() > 0;
        // 分段渲染：线上 200+ 个直播间，先渲染前 30 张，滑到底再「加载更多」
        const visible = sorted.slice(0, this.state.mobileRenderLimit);
        return (
            <div className="ll-mobile-list">
                {sorted.length === 0 ? (
                    <div className="ll-mobile-empty">
                        <div>{hasFilter ? '没有匹配的直播间' : '暂无直播间'}</div>
                        {hasFilter && (
                            <Button size="middle" style={{ marginTop: 12 }} onClick={this.clearMobileFilters}>
                                清空筛选条件
                            </Button>
                        )}
                    </div>
                ) : (
                    visible.map(record => this.renderMobileCard(record))
                )}
                {sorted.length > visible.length && (
                    <Button
                        className="ll-mobile-more"
                        block
                        size="middle"
                        onClick={() => this.setState({ mobileRenderLimit: this.state.mobileRenderLimit + MOBILE_CARD_PAGE_SIZE })}>
                        加载更多（剩余 {sorted.length - visible.length} 个）
                    </Button>
                )}
                {sorted.length > 0 && (
                    <div className="ll-mobile-footnote">
                        共 {sorted.length} 个
                        {hasFilter ? `（已筛选，全部 ${total} 个）` : ''}
                        {sorted.length > visible.length ? `，当前显示前 ${visible.length} 个` : ''}
                    </div>
                )}
            </div>
        );
    };

    // renderMobileStickyArea 渲染窄屏上半部分：工具条（不滚动）+ 卡片列表（唯一滚动层）。
    renderMobileStickyArea = () => {
        const sorted = this.getMobileFilteredSortedList();
        return (
            <div className="ll-mobile-main">
                <div className="ll-mobile-fixed">
                    {this.renderMobileToolbar()}
                </div>
                {this.renderMobileCardList(sorted)}
            </div>
        );
    };

    // renderMobileBatchBar 渲染窄屏底部批量操作条（有选中项时常驻在底部，不与列表抢滚动）。
    // 平铺「启动监控 / 停止监控 / 删除」三个高频操作，其余收进「更多操作」抽屉；
    // 「全选」作用于**当前筛选结果的完整列表**（见 toggleSelectAllMobile），
    // 未渲染出来的卡片同样会被选中，语义与桌面端表头全选一致。
    renderMobileBatchBar = () => {
        const selectedCount = this.state.selectedRowKeys.length;
        const allSelected = this.isMobileAllSelected();
        const filteredCount = this.getMobileFilteredSortedList().length;
        return (
            <div className="ll-mobile-batchbar">
                <div className="ll-mobile-batchbar-head">
                    <span className="ll-mobile-batchbar-count">已选 {selectedCount} 项</span>
                    <span className="ll-mobile-batchbar-hint">
                        {allSelected
                            ? `已全选当前 ${filteredCount} 个`
                            : `当前筛选结果共 ${filteredCount} 个`}
                    </span>
                </div>
                <div className="ll-mobile-batchbar-actions">
                    <Button
                        className="ll-btn"
                        size="middle"
                        disabled={filteredCount === 0}
                        onClick={this.toggleSelectAllMobile}>
                        {allSelected ? '取消全选' : `全选(${filteredCount})`}
                    </Button>
                    <Button
                        className="ll-btn"
                        size="middle"
                        type="primary"
                        loading={this.state.batchOperating}
                        onClick={() => this.handleBatchOperation('start')}>
                        启动
                    </Button>
                    <Button
                        className="ll-btn"
                        size="middle"
                        loading={this.state.batchOperating}
                        onClick={() => this.handleBatchOperation('stop')}>
                        停止
                    </Button>
                    <Button
                        className="ll-btn"
                        size="middle"
                        onClick={() => this.setState({ mobileBatchSheetVisible: true })}>
                        <MoreOutlined /> 更多
                    </Button>
                    <Button
                        className="ll-btn"
                        size="middle"
                        type="link"
                        onClick={() => this.setSelectedRowKeys([])}>
                        取消选择
                    </Button>
                </div>
            </div>
        );
    };

    // renderMobileSheets 渲染窄屏的全部底部抽屉（批量 / 单卡 / 更多功能 / 列设置 / 筛选）。
    // 统一挂在窄屏容器的最后，任何一个打开时都会盖住列表与底部操作条。
    renderMobileSheets = () => (
        <>
            {this.renderMobileFilterSheet()}
            {this.renderMobileFeatureSheet()}
            {this.renderMobileColumnSheet()}
            {this.renderMobileBatchSheet()}
            {this.renderMobileCardSheet()}
        </>
    );

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
                // 桌面端（表格内展开行）保持原有 8/16/16 边距，行为完全不变；
                // 窄屏下详情直接嵌在卡片里，左右 16px 会与卡片内边距叠加、把内容区挤窄，
                // 因此收紧为 8/0/12（卡片自身已有 12px 内边距）。
                margin: this.state.isSmall ? '8px 0 12px' : '8px 16px 16px',
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
                        {/* ==================== 窄屏 / 桌面端分流 ====================
                            只有当「视口宽度 ≤768px」（state.isSmall，由 matchMedia 驱动）时才走窄屏分支。
                            窄屏分支的结构（自上而下）：
                              1) .ll-mobile-shell —— 占满可用高度的 flex 纵向容器；
                              2) renderMobileTopBar —— 标题 / 多选 / 更多功能；
                              3) renderMobileStickyArea —— 筛选排序工具条 + 卡片列表（唯一的纵向滚动层）；
                              4) renderMobileBatchBar —— 有选中项时的底部批量操作条；
                              5) renderMobileSheets —— 筛选 / 更多功能 / 列设置 / 批量 / 单卡 五个底部抽屉。
                            桌面端分支（宽 >768px）与改动前逐字一致：同一份批量操作栏 + 同一个 Table
                            （含虚拟滚动、列设置、名称搜索、方案B 操作列），因此桌面端行为完全不受影响。 */}
                        {this.state.isSmall ? (
                            <div className="ll-mobile-shell">
                                {this.renderMobileTopBar()}
                                {this.renderMobileStickyArea()}
                                {this.state.selectedRowKeys.length > 0 && this.renderMobileBatchBar()}
                                {this.renderMobileSheets()}
                            </div>
                        ) : (
                            <>
                                <div style={{
                                    padding: '16px 24px',
                                    backgroundColor: '#fff',
                                    borderBottom: '1px solid #e8e8e8',
                                    marginBottom: 16,
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    // 桌面端保持 nowrap（默认值），排版与改动前完全一致
                                    flexWrap: 'nowrap',
                                    alignItems: 'center'
                                }}>
                                    <div>
                                        <span style={{ fontSize: '20px', fontWeight: 600, color: 'rgba(0,0,0,0.85)', marginRight: 12 }}>直播间列表</span>
                                        <span style={{ fontSize: '14px', color: 'rgba(0,0,0,0.45)' }}>Room List</span>
                                    </div>
                                    <div style={{
                                        display: 'flex',
                                        gap: '8px',
                                        alignItems: 'center',
                                        flexWrap: 'nowrap'
                                    }}>
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
                                    size="large"
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
                                    // 该分支只在 isSmall=false（视口 >768px，即桌面端）时渲染，因此列集合固定是
                                    // columns（TABLE_SCROLL_X）；窄屏已改用卡片列表，不再渲染本 Table，
                                    // 三目里保留 SMALL_TABLE_SCROLL_X 只是为了让该常量继续被引用，
                                    // 不删除是为了不破坏「窄屏列集合」这一组常量的完整性。
                                    virtual
                                    scroll={{
                                        x: this.state.isSmall ? SMALL_TABLE_SCROLL_X : TABLE_SCROLL_X,
                                        // y 由视口高度派生（原先是写死的 600）。
                                        y: this.getTableScrollY(),
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
                            </>
                        )}
                        {/* 需求6：录制时间段配置弹窗（支持单个与批量）。
                            放在分流之外，保证桌面端与卡片列表都能打开同一个弹窗。 */}
                        <RecordScheduleDialog
                            visible={this.state.recordScheduleDialogVisible}
                            roomIds={this.state.recordScheduleRoomIds}
                            onClose={() => this.setState({ recordScheduleDialogVisible: false, recordScheduleRoomIds: [] })}
                            onSaved={this.refresh}
                        />
                        {/* 批量添加直播间弹窗：同样放在分流之外，桌面端与窄屏共用 */}
                        <BatchAddRoomDialog
                            visible={this.state.batchAddDialogVisible}
                            onClose={() => this.setState({ batchAddDialogVisible: false })}
                            onSuccess={this.refresh}
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
                            // 这一项原本两边都写 cookieColumns（恒等），保留原样；
                            // 只把断点判断统一改为 state.isSmall（不再读 window.screen.width）
                            columns={(this.state.isSmall) ? this.cookieColumns : this.cookieColumns}
                            dataSource={this.state.cookieList}
                            size={this.state.isSmall ? "middle" : "large"}
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
