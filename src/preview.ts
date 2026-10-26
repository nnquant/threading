// Browser preview backend: an in-memory store seeded with demo data that follows docs/backend-contract.md,
// so the interface can be developed and reviewed without the desktop shell. It is never used in the desktop app.
import type { Api } from './bridge';
import { DAY, addDays, todayIso } from './labels';
import { applyChange } from './workspace';
import {
  ORG_COLORS, type Change, type EntityKind, type Entry, type EntryEvent, type EventField, type Id, type Metric, type Organization,
  type Project, type Settings, type Thread, type Todo, type Workspace,
} from './types';

const STORAGE_KEY = 'threading.preview.v1';
type RowOf = { organization: Organization; project: Project; thread: Thread; todo: Todo; entry: Entry };
const TABLE = { organization: 'organizations', project: 'projects', thread: 'threads', todo: 'todos', entry: 'entries' } as const;

function fail(message: string): never { throw new Error(message); }
const chars = (value: string) => [...value].length;
function text(value: string | undefined, label: string, max: number, required = false) {
  const trimmed = (value ?? '').trim();
  if (required && !trimmed) fail(`${label}不能为空。`);
  if (chars(trimmed) > max) fail(`${label}不能超过 ${max} 个字符。`);
  return trimmed;
}
function date(value: string | null | undefined, label: string) {
  if (value == null || value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00`))) fail(`${label}不是有效日期。`);
  return value;
}
function tags(values: string[] | undefined) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values ?? []) {
    const tag = text(raw, '标签', 24);
    if (!tag || seen.has(tag.toLocaleLowerCase())) continue;
    seen.add(tag.toLocaleLowerCase());
    result.push(tag);
  }
  if (result.length > 12) fail('标签最多 12 个。');
  return result;
}
function metrics(values: Metric[]) {
  const result = values.map(metric => ({ label: text(metric.label, '指标名称', 24), value: text(metric.value, '指标值', 40) })).filter(metric => metric.label);
  if (result.length > 12) fail('指标最多 12 项。');
  return result;
}

/** Collects the rows one command touches so it can be returned as a `Change` and merged atomically. */
class Tx {
  readonly time = Date.now();
  private puts: { [K in EntityKind]: Map<Id, RowOf[K]> } = {
    organization: new Map(), project: new Map(), thread: new Map(), todo: new Map(), entry: new Map(),
  };
  private deleted: { kind: EntityKind; id: Id }[] = [];
  settings?: Settings;
  constructor(private workspace: Workspace) {}

  all<K extends EntityKind>(kind: K): RowOf[K][] {
    const gone = new Set(this.deleted.filter(row => row.kind === kind).map(row => row.id));
    const fresh = new Map(this.puts[kind]);
    const rows = (this.workspace[TABLE[kind]] as RowOf[K][]).map(row => { const next = fresh.get(row.id); fresh.delete(row.id); return next ?? row; });
    return [...rows, ...fresh.values()].filter(row => !gone.has(row.id));
  }
  get<K extends EntityKind>(kind: K, id: Id, missing: string): RowOf[K] {
    return this.all(kind).find(row => row.id === id) ?? fail(missing);
  }
  put<K extends EntityKind>(kind: K, row: RowOf[K]) { this.puts[kind].set(row.id, row); return row; }
  remove(kind: EntityKind, id: Id) { this.puts[kind].delete(id); this.deleted.push({ kind, id }); }
  nextPosition<K extends EntityKind>(kind: K, sameParent: (row: RowOf[K]) => boolean) {
    const rows = this.all(kind).filter(sameParent) as unknown as { position: number }[];
    return rows.length ? Math.max(...rows.map(row => row.position)) + 1 : 0;
  }
  event(projectId: Id, threadId: Id | null, field: EventField, from: string | null, to: string | null) {
    const event: EntryEvent = { field, from, to };
    this.put('entry', { id: crypto.randomUUID(), projectId, threadId, kind: 'event', body: '', health: null, event, createdAt: this.time, editedAt: null });
  }
  touch(threadId: Id) {
    const thread = this.get('thread', threadId, '找不到该策略线，可能已被删除。');
    this.put('thread', { ...thread, lastActivityAt: this.time, updatedAt: this.time });
  }
  change(): Change {
    const change: Change = {};
    if (this.puts.organization.size) change.organizations = [...this.puts.organization.values()];
    if (this.puts.project.size) change.projects = [...this.puts.project.values()];
    if (this.puts.thread.size) change.threads = [...this.puts.thread.values()];
    if (this.puts.todo.size) change.todos = [...this.puts.todo.values()];
    if (this.puts.entry.size) change.entries = [...this.puts.entry.values()];
    if (this.settings) change.settings = this.settings;
    if (this.deleted.length) change.deleted = this.deleted;
    return change;
  }
}

const MISSING = {
  organization: '找不到该组织，可能已被删除。',
  project: '找不到该项目，可能已被删除。',
  thread: '找不到该策略线，可能已被删除。',
  todo: '找不到该待办，可能已被删除。',
  entry: '找不到该记录，可能已被删除。',
};

function readStored(): Workspace | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as Workspace | null;
    return value && Array.isArray(value.threads) && value.settings ? value : null;
  } catch { return null; }
}

export function createPreviewApi(): Api {
  let workspace = readStored() ?? seedWorkspace();
  const commit = <T>(run: (tx: Tx) => T): Promise<Change> => {
    try {
      const tx = new Tx(workspace);
      run(tx);
      const change = tx.change();
      workspace = applyChange(workspace, change);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace)); } catch { /* preview data stays in memory */ }
      return Promise.resolve(structuredClone(change));
    } catch (error) { return Promise.reject(error); }
  };
  const cascadeThread = (tx: Tx, threadId: Id) => {
    for (const todo of tx.all('todo').filter(row => row.threadId === threadId)) tx.remove('todo', todo.id);
    for (const entry of tx.all('entry').filter(row => row.threadId === threadId)) tx.remove('entry', entry.id);
    tx.remove('thread', threadId);
  };
  const cascadeProject = (tx: Tx, projectId: Id) => {
    for (const thread of tx.all('thread').filter(row => row.projectId === projectId)) cascadeThread(tx, thread.id);
    for (const entry of tx.all('entry').filter(row => row.projectId === projectId)) tx.remove('entry', entry.id);
    tx.remove('project', projectId);
  };

  return {
    loadWorkspace: () => Promise.resolve(structuredClone(workspace)),
    createOrganization: input => commit(tx => {
      const name = text(input.name, '组织名称', 60, true);
      const code = (text(input.code, '简称', 6) || [...name].slice(0, 2).join('')).toUpperCase();
      const count = tx.all('organization').length;
      tx.put('organization', {
        id: crypto.randomUUID(), name, code, color: input.color ?? ORG_COLORS[count % ORG_COLORS.length], note: text(input.note, '备注', 2000),
        archived: false, position: tx.nextPosition('organization', () => true), createdAt: tx.time, updatedAt: tx.time,
      });
    }),
    updateOrganization: (id, patch) => commit(tx => {
      const org = tx.get('organization', id, MISSING.organization);
      const name = patch.name === undefined ? org.name : text(patch.name, '组织名称', 60, true);
      const code = patch.code === undefined ? org.code : (text(patch.code, '简称', 6) || [...name].slice(0, 2).join('')).toUpperCase();
      tx.put('organization', {
        ...org, name, code, color: patch.color ?? org.color, archived: patch.archived ?? org.archived,
        note: patch.note === undefined ? org.note : text(patch.note, '备注', 2000), updatedAt: tx.time,
      });
    }),
    deleteOrganization: id => commit(tx => {
      tx.get('organization', id, MISSING.organization);
      for (const project of tx.all('project').filter(row => row.orgId === id)) cascadeProject(tx, project.id);
      tx.remove('organization', id);
    }),
    createProject: input => commit(tx => {
      tx.get('organization', input.orgId, MISSING.organization);
      tx.put('project', {
        id: crypto.randomUUID(), orgId: input.orgId, name: text(input.name, '项目名称', 80, true), goal: text(input.goal, '项目目标', 2000),
        status: input.status ?? 'active', health: input.health ?? 'onTrack', targetDate: date(input.targetDate, '目标日期'),
        position: tx.nextPosition('project', row => row.orgId === input.orgId), createdAt: tx.time, updatedAt: tx.time,
      });
    }),
    updateProject: (id, patch) => commit(tx => {
      const project = tx.get('project', id, MISSING.project);
      if (patch.orgId) tx.get('organization', patch.orgId, MISSING.organization);
      const next: Project = {
        ...project,
        orgId: patch.orgId ?? project.orgId,
        name: patch.name === undefined ? project.name : text(patch.name, '项目名称', 80, true),
        goal: patch.goal === undefined ? project.goal : text(patch.goal, '项目目标', 2000),
        status: patch.status ?? project.status,
        health: patch.health ?? project.health,
        targetDate: patch.targetDate === undefined ? project.targetDate : date(patch.targetDate, '目标日期'),
        updatedAt: tx.time,
      };
      if (next.orgId !== project.orgId) next.position = tx.nextPosition('project', row => row.orgId === next.orgId && row.id !== id);
      tx.put('project', next);
      if (next.health !== project.health) tx.event(id, null, 'health', project.health, next.health);
      if (next.status !== project.status) tx.event(id, null, 'status', project.status, next.status);
    }),
    deleteProject: id => commit(tx => { tx.get('project', id, MISSING.project); cascadeProject(tx, id); }),
    createThread: input => commit(tx => {
      tx.get('project', input.projectId, MISSING.project);
      const state = input.state ?? 'active';
      const thread = tx.put('thread', {
        id: crypto.randomUUID(), projectId: input.projectId, title: text(input.title, '策略线名称', 120, true),
        summary: text(input.summary, '说明', 20000), stage: input.stage ?? 'idea', state, priority: input.priority ?? 'normal', hill: 0,
        waitingOn: '', waitingSince: state === 'waiting' ? tx.time : null, tags: tags(input.tags), metrics: [],
        position: tx.nextPosition('thread', row => row.projectId === input.projectId), createdAt: tx.time, updatedAt: tx.time,
        lastActivityAt: tx.time, reviewedAt: null, closedAt: state === 'closed' ? tx.time : null,
      });
      tx.event(thread.projectId, thread.id, 'created', null, thread.stage);
      const action = text(input.nextAction, '下一步', 500);
      if (action) tx.put('todo', { id: crypto.randomUUID(), threadId: thread.id, text: action, due: null, done: false, doneAt: null, position: 0, createdAt: tx.time, updatedAt: tx.time });
    }),
    updateThread: (id, patch) => commit(tx => {
      const thread = tx.get('thread', id, MISSING.thread);
      if (patch.hill !== undefined && (!Number.isInteger(patch.hill) || patch.hill < 0 || patch.hill > 100)) fail('山丘位置必须是 0–100 的整数。');
      const next: Thread = {
        ...thread,
        title: patch.title === undefined ? thread.title : text(patch.title, '策略线名称', 120, true),
        summary: patch.summary === undefined ? thread.summary : text(patch.summary, '说明', 20000),
        stage: patch.stage ?? thread.stage,
        state: patch.state ?? thread.state,
        priority: patch.priority ?? thread.priority,
        hill: patch.hill ?? thread.hill,
        waitingOn: patch.waitingOn === undefined ? thread.waitingOn : text(patch.waitingOn, '等待对象', 80),
        tags: patch.tags === undefined ? thread.tags : tags(patch.tags),
        metrics: patch.metrics === undefined ? thread.metrics : metrics(patch.metrics),
      };
      if (next.state === 'waiting' && thread.state !== 'waiting') next.waitingSince = tx.time;
      if (next.state !== 'waiting') { next.waitingSince = null; next.waitingOn = ''; }
      if (next.state === 'closed' && thread.state !== 'closed') next.closedAt = tx.time;
      if (next.state !== 'closed') next.closedAt = null;
      if (patch.reviewed) next.reviewedAt = tx.time;
      const working = Object.keys(patch).some(key => key !== 'reviewed');
      if (working) { next.lastActivityAt = tx.time; next.updatedAt = tx.time; }
      const moving = patch.projectId !== undefined && patch.projectId !== thread.projectId;
      if (moving) {
        tx.get('project', patch.projectId!, MISSING.project);
        next.projectId = patch.projectId!;
        next.position = tx.nextPosition('thread', row => row.projectId === next.projectId);
      }
      tx.put('thread', next);
      if (next.stage !== thread.stage) tx.event(next.projectId, id, 'stage', thread.stage, next.stage);
      if (next.state !== thread.state) tx.event(next.projectId, id, 'state', thread.state, next.state);
      if (moving) {
        for (const entry of tx.all('entry').filter(row => row.threadId === id)) tx.put('entry', { ...entry, projectId: next.projectId });
        tx.event(next.projectId, id, 'project', tx.get('project', thread.projectId, MISSING.project).name, tx.get('project', next.projectId, MISSING.project).name);
      }
    }),
    deleteThread: id => commit(tx => { tx.get('thread', id, MISSING.thread); cascadeThread(tx, id); }),
    createTodo: input => commit(tx => {
      tx.get('thread', input.threadId, MISSING.thread);
      tx.put('todo', {
        id: crypto.randomUUID(), threadId: input.threadId, text: text(input.text, '待办内容', 500, true), due: date(input.due, '截止日期'),
        done: false, doneAt: null, position: tx.nextPosition('todo', row => row.threadId === input.threadId), createdAt: tx.time, updatedAt: tx.time,
      });
      tx.touch(input.threadId);
    }),
    updateTodo: (id, patch) => commit(tx => {
      const todo = tx.get('todo', id, MISSING.todo);
      const done = patch.done ?? todo.done;
      tx.put('todo', {
        ...todo, text: patch.text === undefined ? todo.text : text(patch.text, '待办内容', 500, true),
        due: patch.due === undefined ? todo.due : date(patch.due, '截止日期'),
        done, doneAt: done ? (todo.done ? todo.doneAt : tx.time) : null, updatedAt: tx.time,
      });
      tx.touch(todo.threadId);
    }),
    deleteTodo: id => commit(tx => { const todo = tx.get('todo', id, MISSING.todo); tx.remove('todo', id); tx.touch(todo.threadId); }),
    createEntry: input => commit(tx => {
      const project = tx.get('project', input.projectId, MISSING.project);
      const threadId = input.threadId ?? null;
      if (input.kind === 'update' && threadId) fail('项目进展只能记在项目上。');
      if (input.kind !== 'update' && input.health !== undefined) fail('只有项目进展条目可以传入健康度。');
      if (threadId && tx.get('thread', threadId, MISSING.thread).projectId !== project.id) fail('该策略线不属于这个项目。');
      tx.put('entry', {
        id: crypto.randomUUID(), projectId: project.id, threadId, kind: input.kind, body: text(input.body, '记录内容', 20000, true),
        health: input.health ?? null, event: null, createdAt: tx.time, editedAt: null,
      });
      if (input.health && input.health !== project.health) tx.put('project', { ...project, health: input.health, updatedAt: tx.time });
      if (threadId) tx.touch(threadId);
    }),
    updateEntry: (id, patch) => commit(tx => {
      const entry = tx.get('entry', id, MISSING.entry);
      if (entry.kind === 'event') fail('自动记录不能编辑。');
      tx.put('entry', { ...entry, body: text(patch.body, '记录内容', 20000, true), editedAt: tx.time });
      if (entry.threadId) tx.touch(entry.threadId);
    }),
    deleteEntry: id => commit(tx => { tx.get('entry', id, MISSING.entry); tx.remove('entry', id); }),
    reorder: (kind, ids) => commit(tx => {
      const rows = ids.map(id => tx.get(kind, id, MISSING[kind]) as unknown as { id: Id; position: number } & Record<string, unknown>);
      const parentKey = { organization: null, project: 'orgId', thread: 'projectId', todo: 'threadId' }[kind];
      const parent = parentKey ? rows[0]?.[parentKey] : null;
      const siblings = (tx.all(kind) as unknown as Record<string, unknown>[]).filter(row => !parentKey || row[parentKey] === parent);
      if (new Set(ids).size !== ids.length || siblings.length !== ids.length) fail('排序列表必须包含同一层级的全部条目。');
      rows.forEach((row, position) => tx.put(kind, { ...row, position } as never));
    }),
    updateSettings: patch => commit(tx => {
      const settings = { ...workspace.settings, ...patch };
      if (!Number.isInteger(settings.staleDays) || settings.staleDays < 1 || settings.staleDays > 90) fail('停滞天数必须是 1–90 的整数。');
      if (!Number.isInteger(settings.wipLimit) || settings.wipLimit < 0 || settings.wipLimit > 50) fail('进行中上限必须是 0–50 的整数。');
      tx.settings = settings;
    }),
    backupNow: () => Promise.reject(new Error('浏览器预览不写入本机文件，请在桌面客户端中备份。')),
  };
}

/** Demo workspace: three organizations with quant strategy projects at different stages and states. */
export function seedWorkspace(now = Date.now()): Workspace {
  const ago = (days: number, hours = 0) => now - days * DAY - hours * 3_600_000;
  const today = todayIso(now);
  const organizations: Organization[] = [];
  const projects: Project[] = [];
  const threads: Thread[] = [];
  const todos: Todo[] = [];
  const entries: Entry[] = [];
  const org = (name: string, code: string, color: Organization['color']) => {
    const row: Organization = { id: crypto.randomUUID(), name, code, color, note: '', archived: false, position: organizations.length, createdAt: ago(90), updatedAt: ago(90) };
    organizations.push(row);
    return row.id;
  };
  const project = (orgId: Id, name: string, goal: string, health: Project['health'], status: Project['status'] = 'active', targetDate: string | null = null) => {
    const row: Project = { id: crypto.randomUUID(), orgId, name, goal, status, health, targetDate, position: projects.filter(p => p.orgId === orgId).length, createdAt: ago(80), updatedAt: ago(3) };
    projects.push(row);
    return row.id;
  };
  type Spec = Partial<Thread> & Pick<Thread, 'title' | 'stage'> & { idle: number; todo?: [string, number | null][]; log?: [Entry['kind'], string, number][] };
  const thread = (projectId: Id, spec: Spec) => {
    const { idle, todo = [], log = [], ...fields } = spec;
    const row: Thread = {
      id: crypto.randomUUID(), projectId, summary: '', state: 'active', priority: 'normal', hill: 0, waitingOn: '', waitingSince: null, tags: [], metrics: [],
      position: threads.filter(t => t.projectId === projectId).length, createdAt: ago(60), updatedAt: ago(idle), lastActivityAt: ago(idle, 2), reviewedAt: null, closedAt: null,
      ...fields,
    };
    threads.push(row);
    entries.push({ id: crypto.randomUUID(), projectId, threadId: row.id, kind: 'event', body: '', health: null, event: { field: 'created', from: null, to: 'idea' }, createdAt: row.createdAt, editedAt: null });
    todo.forEach(([text, due], position) => todos.push({
      id: crypto.randomUUID(), threadId: row.id, text, due: due == null ? null : addDays(today, due), done: false, doneAt: null, position, createdAt: ago(idle + 3), updatedAt: ago(idle + 3),
    }));
    log.forEach(([kind, body, days]) => entries.push({ id: crypto.randomUUID(), projectId, threadId: row.id, kind, body, health: null, event: null, createdAt: ago(days, 3), editedAt: null }));
    return row;
  };

  const own = org('自营研究', 'ZY', 'slate');
  const bay = org('澜湾资产', 'LW', 'blue');
  const dawn = org('启明投顾', 'QM', 'teal');

  const cta = project(own, '商品 CTA 多因子', '年底前完成 3 条低相关因子线的模拟盘验证，组合夏普 > 1.5。', 'onTrack', 'active', addDays(today, 66));
  const vol = project(own, '期权波动率', '搭建波动率曲面数据与回测框架，验证两条波动率策略。', 'atRisk');
  const enhance = project(bay, '中证 1000 指数增强', '年化超额 8% 以上，跟踪误差控制在 5% 以内。', 'atRisk', 'active', addDays(today, 35));
  const cb = project(bay, '可转债轮动', '双低框架改进，等客户确认额度后重启。', 'onTrack', 'paused');
  const bond = project(dawn, '国债期货择时', '为客户的利率债组合提供久期择时信号。', 'onTrack', 'active', addDays(today, 20));

  thread(cta, {
    title: '期限结构因子', stage: 'backtest', priority: 'high', hill: 62, idle: 1, tags: ['展期收益', '截面'],
    summary: '用主力与次主力的展期收益率构造截面因子，按板块中性化。\n\n- 数据：日频收盘价、持仓量\n- 调仓：周频',
    metrics: [{ label: '夏普', value: '1.42' }, { label: '年化', value: '18.6%' }, { label: '最大回撤', value: '-9.8%' }],
    todo: [['补 2015–2017 年样本外回测', -1], ['检查换月逻辑对收益的影响', null]],
    log: [['result', '样本内夏普 1.6，样本外降到 1.1，主要被黑色系拖累。', 4], ['decision', '换月改为按持仓量切换，不再按固定日期。', 2]],
  });
  thread(cta, {
    title: '动量与波动率择时', stage: 'paper', hill: 78, idle: 2, tags: ['时序'],
    metrics: [{ label: '夏普', value: '1.21' }, { label: '模拟天数', value: '23' }],
    todo: [['核对模拟盘与回测的成交差异', 2]],
    log: [['note', '模拟盘第三周，滑点比假设高 0.6 bp，先观察到月底。', 2]],
  });
  thread(cta, { title: '基差动量', stage: 'research', hill: 30, idle: 12, tags: ['基差'], log: [['note', '初步 IC 0.03，偏弱，需要换现货价格源再看。', 12]] });
  thread(cta, { title: '仓单因子', stage: 'idea', state: 'paused', priority: 'low', hill: 5, idle: 20 });

  thread(vol, {
    title: '50ETF 波动率曲面套利', stage: 'backtest', state: 'waiting', hill: 40, idle: 6, waitingOn: '数据组补齐 2019 年分钟数据', waitingSince: ago(6),
    todo: [['数据到位后重跑 2019 年', null]],
  });
  thread(vol, { title: '尾部对冲', stage: 'research', priority: 'high', hill: 20, idle: 3, todo: [['确定对冲预算上限', 5]] });

  thread(enhance, {
    title: '基本面 Alpha 模型', stage: 'live', priority: 'urgent', hill: 90, idle: 0, tags: ['实盘'],
    metrics: [{ label: '超额年化', value: '9.2%' }, { label: '跟踪误差', value: '4.1%' }, { label: '信息比', value: '1.9' }],
    todo: [['排查 10 月超额回撤的原因', 0], ['给客户写月度归因说明', 4]],
    log: [['result', '10 月以来超额回撤 2.3%，集中在小盘成长。', 1]],
  });
  thread(enhance, { title: '高频量价因子', stage: 'backtest', priority: 'high', hill: 55, idle: 9, todo: [['去掉涨跌停样本后重算 IC', 1]] });
  thread(enhance, { title: '风格中性约束', stage: 'research', state: 'waiting', hill: 35, idle: 3, waitingOn: '客户确认行业偏离上限', waitingSince: ago(3) });

  thread(cb, { title: '双低策略改进', stage: 'paper', state: 'paused', hill: 70, idle: 25 });

  thread(bond, { title: '宏观因子择时', stage: 'backtest', hill: 48, idle: 1, todo: [['加入资金面指标', 1]], log: [['decision', '信号频率定为周度，月度太慢。', 1]] });
  thread(bond, { title: '技术面趋势', stage: 'retired', state: 'closed', hill: 100, idle: 30, closedAt: ago(30), log: [['result', '扣费后不显著，停止。', 30]] });

  entries.push({ id: crypto.randomUUID(), projectId: enhance, threadId: null, kind: 'update', body: '实盘超额回撤，客户已在问。本周优先排查回撤原因，高频因子线往后放。', health: 'atRisk', event: null, createdAt: ago(1, 5), editedAt: null });
  entries.push({ id: crypto.randomUUID(), projectId: cta, threadId: null, kind: 'update', body: '两条线进入回测以后，进度符合预期。', health: 'onTrack', event: null, createdAt: ago(5), editedAt: null });

  return { organizations, projects, threads, todos, entries, settings: { staleDays: 7, wipLimit: 8 }, dataPath: '浏览器预览（不写入本机文件）' };
}
