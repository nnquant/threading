import type { EntryKind, EventField, Health, IsoDate, Millis, OrgColor, Priority, ProjectStatus, Stage, ThreadState } from './types';

export const STAGE_LABEL: Record<Stage, string> = {
  idea: '构想', research: '研究', backtest: '回测', paper: '模拟', live: '实盘', retired: '退役',
};
export const STATE_LABEL: Record<ThreadState, string> = {
  active: '进行中', waiting: '等待', paused: '搁置', closed: '已结束',
};
export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: '紧急', high: '高', normal: '普通', low: '低',
};
export const PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low'];
export const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
export const HEALTH_LABEL: Record<Health, string> = { onTrack: '正常', atRisk: '有风险', offTrack: '偏离' };
export const HEALTHS: Health[] = ['onTrack', 'atRisk', 'offTrack'];
export const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: '进行中', paused: '暂停', done: '已完成', archived: '已归档',
};
export const STATUSES: ProjectStatus[] = ['active', 'paused', 'done', 'archived'];
export const STATES: ThreadState[] = ['active', 'waiting', 'paused', 'closed'];
export const KIND_LABEL: Record<EntryKind, string> = {
  note: '笔记', decision: '决策', result: '结果', update: '进展', event: '变更',
};
export const EVENT_LABEL: Record<EventField, string> = {
  created: '创建', stage: '阶段', state: '状态', project: '项目', parent: '上级', health: '健康度', status: '项目状态',
};
export const ORG_COLOR: Record<OrgColor, string> = {
  slate: '#6b7280', blue: '#3b6fd8', teal: '#14897f', green: '#3f8f3a',
  amber: '#c08a12', orange: '#d0631f', red: '#c7423a', violet: '#7c5bd1',
};

/** Human label for an event value; stage/state/health/status values are stored as keys. */
export function eventValue(field: EventField, value: string | null) {
  if (value == null) return '';
  const table: Partial<Record<EventField, Record<string, string>>> = {
    created: STAGE_LABEL, stage: STAGE_LABEL, state: STATE_LABEL, health: HEALTH_LABEL, status: STATUS_LABEL,
  };
  return table[field]?.[value] ?? value;
}

export const DAY = 86_400_000;
const pad = (value: number) => String(value).padStart(2, '0');
export const isoDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const todayIso = (now = Date.now()) => isoDate(new Date(now));
export const parseIso = (value: IsoDate) => { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (value: IsoDate, days: number) => { const date = parseIso(value); date.setDate(date.getDate() + days); return isoDate(date); };
/** Whole calendar days from `from` to `to` (positive when `to` is later). */
export const dayDiff = (from: IsoDate, to: IsoDate) => Math.round((parseIso(to).getTime() - parseIso(from).getTime()) / DAY);
/** Calendar days elapsed since a timestamp, in local time. */
export const daysSince = (time: Millis, now = Date.now()) => dayDiff(todayIso(time), todayIso(now));

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function dueLabel(due: IsoDate, now = Date.now()) {
  const diff = dayDiff(todayIso(now), due);
  if (diff < 0) return `逾期 ${-diff} 天`;
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  const date = parseIso(due);
  if (diff < 7) return WEEKDAYS[date.getDay()];
  return shortDate(date.getTime(), now);
}
export const waitedLabel = (since: Millis, now = Date.now()) => {
  const days = daysSince(since, now);
  return days === 0 ? '今天开始等' : `已等 ${days} 天`;
};
/** A project's target date relative to today, e.g. `11月30日，还有 35 天`. */
export function targetLabel(target: IsoDate, now = Date.now()) {
  const diff = dayDiff(todayIso(now), target);
  const date = shortDate(parseIso(target).getTime(), now);
  if (diff > 0) return `${date}，还有 ${diff} 天`;
  if (diff === 0) return `${date}，就是今天`;
  return `${date}，已过 ${-diff} 天`;
}
export function shortDate(time: Millis, now = Date.now()) {
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return sameYear ? `${date.getMonth() + 1}月${date.getDate()}日` : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
export function relativeTime(time: Millis, now = Date.now()) {
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const days = daysSince(time, now);
  if (days === 0) return `${Math.floor(minutes / 60)} 小时前`;
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return shortDate(time, now);
}
export function fullTime(time: Millis) {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function longToday(now = Date.now()) {
  const date = new Date(now);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
}
