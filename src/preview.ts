// Browser preview backend: an in-memory store seeded with demo data that follows docs/backend-contract.md,
// so the interface can be developed and reviewed without the desktop shell. It is never used in the desktop app.
import type { Api } from './bridge';
import { seedWorkspace } from './demo';
import { applyChange } from './workspace';
import {
  ORG_COLORS, type Change, type EntityKind, type Entry, type EntryEvent, type EventField, type Id, type Metric, type Organization,
  type Project, type Settings, type Thread, type Todo, type Workspace,
} from './types';

// v3: threads carry `parentId`, and the demo data has sub-lines.
const STORAGE_KEY = 'threading.preview.v3';
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
  /** Records work on a line, which is also work on every line above it. */
  touch(threadId: Id) {
    const seen = new Set<Id>();
    for (let id: Id | null = threadId; id && !seen.has(id);) {
      seen.add(id);
      const thread: Thread = this.get('thread', id, '找不到该策略线，可能已被删除。');
      this.put('thread', { ...thread, lastActivityAt: this.time, updatedAt: this.time });
      id = thread.parentId;
    }
  }
  /** Every line below a thread. */
  subtree(threadId: Id): Thread[] {
    const threads = this.all('thread');
    const found: Thread[] = [];
    const seen = new Set([threadId]);
    const visit = (parentId: Id) => {
      for (const child of threads.filter(row => row.parentId === parentId && !seen.has(row.id))) { seen.add(child.id); found.push(child); visit(child.id); }
    };
    visit(threadId);
    return found;
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
  const removeThread = (tx: Tx, threadId: Id) => {
    for (const todo of tx.all('todo').filter(row => row.threadId === threadId)) tx.remove('todo', todo.id);
    for (const entry of tx.all('entry').filter(row => row.threadId === threadId)) tx.remove('entry', entry.id);
    tx.remove('thread', threadId);
  };
  const cascadeThread = (tx: Tx, threadId: Id) => {
    for (const thread of tx.subtree(threadId)) removeThread(tx, thread.id);
    removeThread(tx, threadId);
  };
  // Sub-lines share their parent's project, so removing every line of the project covers all of them.
  const cascadeProject = (tx: Tx, projectId: Id) => {
    for (const thread of tx.all('thread').filter(row => row.projectId === projectId)) removeThread(tx, thread.id);
    for (const entry of tx.all('entry').filter(row => row.projectId === projectId)) tx.remove('entry', entry.id);
    tx.remove('project', projectId);
  };
  const cascadeOrganization = (tx: Tx, orgId: Id) => {
    for (const project of tx.all('project').filter(row => row.orgId === orgId)) cascadeProject(tx, project.id);
    tx.remove('organization', orgId);
  };
  /** A parent must exist, share the project, and not sit inside the line being placed under it. */
  const checkParent = (tx: Tx, parentId: Id, projectId: Id, self?: Id) => {
    const parent = tx.get('thread', parentId, '找不到上级策略线，可能已被删除。');
    if (parent.projectId !== projectId) fail('上级策略线必须在同一个项目里。');
    const threads = new Map(tx.all('thread').map(row => [row.id, row]));
    const seen = new Set<Id>();
    for (let at: Thread | undefined = parent; at && !seen.has(at.id); at = at.parentId ? threads.get(at.parentId) : undefined) {
      if (at.id === self) fail('不能把策略线放到它自己或它的子策略线下面。');
      seen.add(at.id);
    }
    return parent;
  };

  return {
    loadWorkspace: () => Promise.resolve(structuredClone(workspace)),
    createOrganization: input => commit(tx => {
      const name = text(input.name, '组织名称', 60, true);
      const code = (text(input.code, '简称', 6) || [...name].slice(0, 2).join('')).toUpperCase();
      const count = tx.all('organization').length;
      tx.put('organization', {
        id: crypto.randomUUID(), name, code, color: input.color ?? ORG_COLORS[count % ORG_COLORS.length], note: text(input.note, '备注', 2000),
        archived: false, demo: false, position: tx.nextPosition('organization', () => true), createdAt: tx.time, updatedAt: tx.time,
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
    deleteOrganization: id => commit(tx => { tx.get('organization', id, MISSING.organization); cascadeOrganization(tx, id); }),
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
      const parentId = input.parentId ?? null;
      if (parentId) checkParent(tx, parentId, input.projectId);
      const state = input.state ?? 'active';
      const thread = tx.put('thread', {
        id: crypto.randomUUID(), projectId: input.projectId, parentId, title: text(input.title, '策略线名称', 120, true),
        summary: text(input.summary, '说明', 20000), stage: input.stage ?? 'idea', state, priority: input.priority ?? 'normal', hill: 0,
        waitingOn: '', waitingSince: state === 'waiting' ? tx.time : null, tags: tags(input.tags), metrics: [],
        position: tx.nextPosition('thread', row => row.projectId === input.projectId && row.parentId === parentId), createdAt: tx.time, updatedAt: tx.time,
        lastActivityAt: tx.time, reviewedAt: null, closedAt: state === 'closed' ? tx.time : null,
      });
      tx.event(thread.projectId, thread.id, 'created', null, thread.stage);
      if (parentId) tx.touch(parentId);
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
      // A line moves to another project with all its sub-lines, and lands at the top level unless a parent there is given.
      const moving = patch.projectId !== undefined && patch.projectId !== thread.projectId;
      if (moving) tx.get('project', patch.projectId!, MISSING.project);
      next.projectId = moving ? patch.projectId! : thread.projectId;
      next.parentId = patch.parentId !== undefined ? patch.parentId : moving ? null : thread.parentId;
      const reparenting = next.parentId !== thread.parentId;
      if (next.parentId && (moving || reparenting)) checkParent(tx, next.parentId, next.projectId, id);
      if (moving || reparenting) next.position = tx.nextPosition('thread', row => row.projectId === next.projectId && row.parentId === next.parentId && row.id !== id);
      const subtree = moving ? tx.subtree(id) : [];
      tx.put('thread', next);
      if (working && next.parentId) tx.touch(next.parentId);
      if (next.stage !== thread.stage) tx.event(next.projectId, id, 'stage', thread.stage, next.stage);
      if (next.state !== thread.state) tx.event(next.projectId, id, 'state', thread.state, next.state);
      if (moving) {
        const from = tx.get('project', thread.projectId, MISSING.project).name;
        const to = tx.get('project', next.projectId, MISSING.project).name;
        for (const row of [next, ...subtree]) {
          if (row !== next) tx.put('thread', { ...row, projectId: next.projectId, updatedAt: tx.time });
          for (const entry of tx.all('entry').filter(item => item.threadId === row.id)) tx.put('entry', { ...entry, projectId: next.projectId });
          tx.event(next.projectId, row.id, 'project', from, to);
        }
      }
      if (reparenting) {
        const title = (parentId: Id | null) => parentId ? tx.get('thread', parentId, MISSING.thread).title : null;
        tx.event(next.projectId, id, 'parent', title(thread.parentId), title(next.parentId));
      }
    }),
    deleteThread: id => commit(tx => {
      const thread = tx.get('thread', id, MISSING.thread);
      cascadeThread(tx, id);
      if (thread.parentId) tx.touch(thread.parentId);
    }),
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
      const parentKeys = { organization: [], project: ['orgId'], thread: ['projectId', 'parentId'], todo: ['threadId'] }[kind];
      const sameParent = (row: Record<string, unknown>) => parentKeys.every(key => row[key] === rows[0]?.[key]);
      const siblings = (tx.all(kind) as unknown as Record<string, unknown>[]).filter(sameParent);
      if (new Set(ids).size !== ids.length || !rows.every(sameParent) || siblings.length !== ids.length) fail('排序列表必须包含同一层级的全部条目。');
      rows.forEach((row, position) => tx.put(kind, { ...row, position } as never));
    }),
    updateSettings: patch => commit(tx => {
      const settings = { ...workspace.settings, ...patch };
      if (!Number.isInteger(settings.staleDays) || settings.staleDays < 1 || settings.staleDays > 90) fail('停滞天数必须是 1–90 的整数。');
      if (!Number.isInteger(settings.wipLimit) || settings.wipLimit < 0 || settings.wipLimit > 50) fail('进行中上限必须是 0–50 的整数。');
      tx.settings = settings;
    }),
    backupNow: () => Promise.reject(new Error('浏览器预览不写入本机文件，请在桌面客户端中备份。')),
    importDemoData: seed => commit(tx => {
      if (tx.all('organization').some(org => org.demo)) fail('示例数据已经添加过了，先清理再重新添加。');
      const ids = new Set<Id>((Object.keys(TABLE) as EntityKind[]).flatMap(kind => tx.all(kind).map(row => row.id)));
      for (const row of [...seed.organizations, ...seed.projects, ...seed.threads, ...seed.todos, ...seed.entries]) {
        if (ids.has(row.id)) fail('示例数据的 id 重复或与已有记录冲突。');
        ids.add(row.id);
      }
      const orgs = new Set(seed.organizations.map(row => row.id));
      const projects = new Set(seed.projects.map(row => row.id));
      const threadProject = new Map(seed.threads.map(row => [row.id, row.projectId]));
      if (!seed.projects.every(row => orgs.has(row.orgId))) fail('示例项目必须引用本次导入的组织。');
      if (!seed.threads.every(row => projects.has(row.projectId))) fail('示例策略线必须引用本次导入的项目。');
      const seedThread = new Map(seed.threads.map(row => [row.id, row]));
      if (!seed.threads.every(row => row.parentId == null || seedThread.get(row.parentId)?.projectId === row.projectId)) fail('示例策略线的上级必须是本次导入的同一项目里的策略线。');
      for (const row of seed.threads) {
        let steps = 0;
        for (let at: Thread | undefined = row; at?.parentId; at = seedThread.get(at.parentId)) if (++steps > seed.threads.length) fail('示例策略线的上级不能成环。');
      }
      if (!seed.todos.every(row => threadProject.has(row.threadId))) fail('示例待办必须引用本次导入的策略线。');
      if (!seed.entries.every(row => projects.has(row.projectId))) fail('示例条目必须引用本次导入的项目。');
      if (!seed.entries.every(row => row.threadId == null || threadProject.get(row.threadId) === row.projectId)) fail('示例条目的策略线必须属于本次导入的同一项目。');
      let position = tx.nextPosition('organization', () => true);
      for (const org of seed.organizations) tx.put('organization', { ...org, demo: true, position: position++ });
      for (const project of seed.projects) tx.put('project', project);
      for (const thread of seed.threads) tx.put('thread', thread);
      for (const todo of seed.todos) tx.put('todo', todo);
      for (const entry of seed.entries) tx.put('entry', entry);
    }),
    clearDemoData: () => commit(tx => { for (const org of tx.all('organization').filter(row => row.demo)) cascadeOrganization(tx, org.id); }),
  };
}

