import React, { useState, useEffect, useCallback } from 'react';
import {
  Modal,
  Switch,
  Select,
  Input,
  Button,
  Space,
  Typography,
  Alert,
  Divider,
  message as antdMessage,
} from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import API from '../../utils/api';
import Utils from '../../utils/common';

const { Text } = Typography;

const api = new API();
const utils = new Utils();

// 单个录制时间段（与后端 configs.RecordTimeSlot 对齐）
export interface RecordTimeSlot {
  days: number[]; // 0=周日,1=周一,...,6=周六；空数组 = 每天
  start: string;  // "HH:MM"
  end: string;    // "HH:MM"
}

// 房间级录制时间段配置（与后端 configs.RecordSchedule 对齐）
export interface RecordSchedule {
  enable: boolean;
  template_name?: string;
  slots?: RecordTimeSlot[];
}

// 录制时间段模板（与后端 configs.RecordScheduleTemplate 对齐）
export interface RecordScheduleTemplate {
  name: string;
  slots: RecordTimeSlot[];
}

// 弹窗 props 契约（外部按此 import 使用）
export interface RecordScheduleDialogProps {
  visible: boolean;
  roomIds: string[];      // 要配置的直播间 id 列表（支持批量，空数组表示不生效）
  onClose: () => void;
  onSaved?: () => void;   // 保存成功后回调
}

// 星期选项：值为数字（提交时转 number），展示为中文
const DAY_OPTIONS: { label: string; value: number }[] = [
  { label: '周日', value: 0 },
  { label: '周一', value: 1 },
  { label: '周二', value: 2 },
  { label: '周三', value: 3 },
  { label: '周四', value: 4 },
  { label: '周五', value: 5 },
  { label: '周六', value: 6 },
];

// 自定义模板在模板下拉中的特殊值（不属于任何真实模板名）
const CUSTOM_TEMPLATE_VALUE = '__custom__';

// 空配置：启用关闭 + 一条 00:00-23:59 的「每天」时段，方便用户直接改
function emptySchedule(): RecordSchedule {
  return {
    enable: false,
    template_name: '',
    slots: [{ days: [], start: '00:00', end: '23:59' }],
  };
}

// 后端返回的时段可能缺字段，这里做一次清洗，保证受控 state 结构完整
function normalizeSlots(raw: any): RecordTimeSlot[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((s: any) => ({
    days: Array.isArray(s?.days) ? s.days.map((d: any) => Number(d)) : [],
    start: typeof s?.start === 'string' ? s.start : '',
    end: typeof s?.end === 'string' ? s.end : '',
  }));
}

// commonResp 统一校验：err_no 非 0 时抛错，交给调用方提示
function assertOk(rsp: any, fallbackMessage: string) {
  if (rsp && typeof rsp.err_no === 'number' && rsp.err_no !== 0) {
    throw new Error(rsp.err_msg || fallbackMessage);
  }
}

/**
 * 录制时间段配置弹窗
 * - 单个房间：PATCH api/config/rooms/id/{id}，body {"record_schedule": {...}}
 * - 多个房间：POST api/lives/batch-operation，action=set_schedule
 * 语义：只决定「是否开始录制」，不会中断正在进行的录制。
 */
export default function RecordScheduleDialog(props: RecordScheduleDialogProps): JSX.Element {
  const { visible, roomIds, onClose, onSaved } = props;

  // 当前编辑中的配置
  const [enabled, setEnabled] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [slots, setSlots] = useState<RecordTimeSlot[]>([]);
  // 可选模板列表（来自全局配置 record_schedule_templates）
  const [templates, setTemplates] = useState<RecordScheduleTemplate[]>([]);
  // 新模板名称
  const [newTemplateName, setNewTemplateName] = useState('');
  // 加载/保存中的状态
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);

  // 打开弹窗时读取回显数据
  const loadData = useCallback(async () => {
    if (!visible) {
      return;
    }
    setLoading(true);
    let currentTemplates: RecordScheduleTemplate[] = [];
    // 1) 读取全局模板列表（getEffectiveConfig 失败时回落 raw-config）
    try {
      const cfg: any = await api.getEffectiveConfig();
      const eff = cfg && (cfg.data !== undefined ? cfg.data : cfg);
      if (eff && Array.isArray(eff.record_schedule_templates)) {
        currentTemplates = eff.record_schedule_templates;
      }
    } catch (e) {
      try {
        const raw: any = await api.getConfigInfo();
        const conf = raw && (raw.data !== undefined ? raw.data : raw);
        if (conf && Array.isArray(conf.record_schedule_templates)) {
          currentTemplates = conf.record_schedule_templates;
        }
      } catch (e2) {
        // 模板读取失败不阻塞弹窗，仅无模板可选
        currentTemplates = [];
      }
    }
    setTemplates(currentTemplates);

    // 2) 单个房间时读取房间级 record_schedule 回显；批量则从空开始
    if (roomIds.length === 1) {
      try {
        const detail: any = await api.getLiveDetail(roomIds[0]);
        const roomCfg = detail?.room_config?.record_schedule || detail?.data?.room_config?.record_schedule;
        if (roomCfg) {
          setEnabled(!!roomCfg.enable);
          setTemplateName(roomCfg.template_name || '');
          const s = normalizeSlots(roomCfg.slots);
          setSlots(s.length > 0 ? s : emptySchedule().slots!);
        } else {
          const empty = emptySchedule();
          setEnabled(empty.enable);
          setTemplateName('');
          setSlots(empty.slots!);
        }
      } catch (e) {
        const empty = emptySchedule();
        setEnabled(empty.enable);
        setTemplateName('');
        setSlots(empty.slots!);
        antdMessage.warning('读取当前录制时间段失败，已按空配置展示');
      }
    } else {
      const empty = emptySchedule();
      setEnabled(empty.enable);
      setTemplateName('');
      setSlots(empty.slots!);
    }
    setNewTemplateName('');
    setLoading(false);
    // roomIds 以 join 后的字符串作为依赖，避免数组引用变化导致重复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, roomIds.join(',')]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 修改某一行时段（patch 方式局部更新）
  const updateSlot = (index: number, patch: Partial<RecordTimeSlot>) => {
    setSlots(prev => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  // 新增一条时段
  const addSlot = () => {
    setSlots(prev => [...prev, { days: [], start: '18:00', end: '23:00' }]);
  };

  // 删除一条时段
  const removeSlot = (index: number) => {
    setSlots(prev => prev.filter((_, i) => i !== index));
  };

  // 选择模板：把模板的时段复制进编辑区并记录模板名；「自定义」则只清空模板名
  const handleTemplateChange = (value: string) => {
    if (!value || value === CUSTOM_TEMPLATE_VALUE) {
      setTemplateName('');
      return;
    }
    const tpl = templates.find(t => t.name === value);
    if (tpl) {
      setTemplateName(tpl.name);
      setSlots(normalizeSlots(tpl.slots));
    }
  };

  // 组装最终提交给后端的配置对象
  const buildSchedule = (): RecordSchedule => {
    const cleaned: RecordTimeSlot[] = slots.map(s => ({
      days: (s.days || []).map(d => Number(d)).sort((a, b) => a - b),
      start: s.start || '',
      end: s.end || '',
    }));
    const schedule: RecordSchedule = { enable: enabled, slots: cleaned };
    if (templateName) {
      schedule.template_name = templateName;
    }
    return schedule;
  };

  // 保存为模板：把当前时段追加到全局 record_schedule_templates 后 PATCH 保存
  const handleSaveAsTemplate = async () => {
    const name = newTemplateName.trim();
    if (!name) {
      antdMessage.warning('请输入模板名称');
      return;
    }
    if (slots.length === 0) {
      antdMessage.warning('当前没有可保存的时间段');
      return;
    }
    if (templates.some(t => t.name === name)) {
      antdMessage.warning('模板名称已存在，请换一个名称');
      return;
    }
    const newTemplate: RecordScheduleTemplate = { name, slots: buildSchedule().slots || [] };
    const nextTemplates = [...templates, newTemplate];
    setSavingTemplate(true);
    try {
      const rsp: any = await api.updateConfig({ record_schedule_templates: nextTemplates });
      assertOk(rsp, '保存模板失败');
      setTemplates(nextTemplates);
      setTemplateName(name);
      setNewTemplateName('');
      antdMessage.success('模板已保存');
    } catch (err: any) {
      antdMessage.error('保存模板失败: ' + (err?.err_msg || err?.message || err));
    } finally {
      setSavingTemplate(false);
    }
  };

  // 保存房间级配置
  const handleSave = async () => {
    if (saving) {
      return;
    }
    if (roomIds.length === 0) {
      antdMessage.warning('没有选中任何直播间');
      return;
    }
    // 启用时必须至少有一条合法时段
    if (enabled) {
      if (slots.length === 0) {
        antdMessage.warning('启用录制时间段后至少需要一条时间段');
        return;
      }
      const invalid = slots.some(s => !s.start || !s.end || s.start === s.end);
      if (invalid) {
        antdMessage.warning('存在开始/结束时间未填写或相同的时间段，请检查');
        return;
      }
    }

    const schedule = buildSchedule();
    setSaving(true);
    try {
      if (roomIds.length === 1) {
        const rsp: any = await api.updateRoomConfigById(roomIds[0], { record_schedule: schedule });
        assertOk(rsp, '保存失败');
      } else {
        // api.ts 中的 batchOperation 由另一位开发者添加；此处用宽松访问避免编译期依赖顺序问题
        const batchOp = (api as any).batchOperation;
        if (typeof batchOp === 'function') {
          await batchOp(roomIds, 'set_schedule', schedule);
        } else {
          // 兜底：直接拼批量操作请求（api/lives/batch-operation）
          const rsp: any = await utils.requestPost('api/lives/batch-operation', {
            ids: roomIds,
            action: 'set_schedule',
            schedule,
          });
          assertOk(rsp, '批量保存失败');
        }
      }
      antdMessage.success(roomIds.length > 1 ? `已应用到 ${roomIds.length} 个直播间` : '录制时间段已保存');
      if (onSaved) {
        onSaved();
      }
      onClose();
    } catch (err: any) {
      antdMessage.error('保存失败: ' + (err?.err_msg || err?.message || err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="录制时间段配置"
      open={visible}
      onCancel={onClose}
      width={720}
      destroyOnClose
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={handleSave}>
            保存
          </Button>
        </Space>
      }
    >
      {roomIds.length > 1 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`将把这份录制时间段配置应用到选中的 ${roomIds.length} 个直播间`}
        />
      )}

      {/* 启用开关 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <Switch checked={enabled} onChange={setEnabled} disabled={loading} />
        <Text style={{ lineHeight: '24px' }}>启用录制时间段</Text>
      </div>
      <div style={{ marginTop: 6, marginLeft: 52, color: '#888', fontSize: 12, lineHeight: 1.7 }}>
        开启后仅在下列时间段内录制；其他时间只监控不录制（状态显示“时段外仅监控”）。
        <Text strong>到达时间段的结束时刻会掐断正在进行的录制</Text>
        （当前片段会正常收尾并进入转码/后处理，不会损坏文件）；
        下次进入时间段时如果还在直播，会自动继续录制。
      </div>

      <Divider style={{ margin: '12px 0' }} />

      {/* 模板下拉 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Text style={{ width: 60, color: '#666' }}>模板</Text>
        <Select
          style={{ width: 260 }}
          value={templateName || CUSTOM_TEMPLATE_VALUE}
          onChange={handleTemplateChange}
          disabled={loading}
          placeholder="选择模板"
          options={[
            ...templates.map(t => ({ label: t.name, value: t.name })),
            { label: '自定义', value: CUSTOM_TEMPLATE_VALUE },
          ]}
        />
        {templates.length === 0 && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            暂无全局模板，可在下方保存当前设置为模板
          </Text>
        )}
      </div>

      {/* 时间段列表 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {slots.map((slot, index) => (
          <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Select
              mode="multiple"
              style={{ width: 280 }}
              placeholder="每天（不选=每天）"
              value={slot.days}
              onChange={(vals: any) => updateSlot(index, { days: (vals as number[]) || [] })}
              options={DAY_OPTIONS}
              maxTagCount="responsive"
            />
            <Input
              type="time"
              style={{ width: 120 }}
              value={slot.start}
              onChange={e => updateSlot(index, { start: e.target.value })}
            />
            <Text type="secondary">至</Text>
            <Input
              type="time"
              style={{ width: 120 }}
              value={slot.end}
              onChange={e => updateSlot(index, { end: e.target.value })}
            />
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => removeSlot(index)}
            />
          </div>
        ))}
      </div>

      <Button
        type="dashed"
        icon={<PlusOutlined />}
        onClick={addSlot}
        style={{ marginTop: 12, width: 240 }}
      >
        ＋ 添加时间段
      </Button>

      <div style={{ marginTop: 10, color: '#d48806', fontSize: 12 }}>
        ⚠ 不支持跨天（如 22:00 至次日 02:00）；如需覆盖凌晨请另加一条 00:00–02:00
      </div>

      <Divider style={{ margin: '12px 0' }} />

      {/* 保存为模板 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Text style={{ color: '#666' }}>保存为模板</Text>
        <Input
          style={{ width: 200 }}
          placeholder="模板名称，如：工作日晚间"
          value={newTemplateName}
          onChange={e => setNewTemplateName(e.target.value)}
          maxLength={32}
        />
        <Button onClick={handleSaveAsTemplate} loading={savingTemplate}>
          保存为模板
        </Button>
      </div>
    </Modal>
  );
}
