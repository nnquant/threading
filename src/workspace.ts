import { DAY, PRIORITY_RANK, addDays, todayIso } from './labels';
import type { Change, EntityKind, Entry, Id, Organization, Project, Settings, Thread, Todo, Workspace } from './types';

type Row = { id: Id };

/** Merges a backend `Change` into the workspace: upserts every returned row and drops deleted ones. */
export function applyChange(workspace: Workspace, change: Change): Workspace {
  const removed = new Map<EntityKind, Set<Id>>();
  for (const { kind, id } of change.deleted ?? []) {
    if (!removed.has(kind)) removed.set(kind, new Set());
    removed.get(kind)!.add(id);
  }
  const merge = <T extends Row>(rows: T[], updates: T[] | undefined, kind: EntityKind): T[] => {
    const gone = removed.get(kind);
    if (!updates?.length && !gone?.size) return rows;
    const fresh = new Map((updates ?? []).map(row => [row.id, row]));
    const next = rows.map(row => { const update = fresh.get(row.id); fresh.delete(row.id); return update ?? row; });
    return [...next, ...fresh.values()].filter(row => !gone?.has(row.id));
  };
  return {
    ...workspace,
    organizations: merge(workspace.organizations, change.organizations, 'organization'),
    projects: merge(workspace.projects, change.projects, 'project'),
    threads: merge(workspace.threads, change.threads, 'thread'),
    todos: merge(workspace.todos, change.todos, 'todo'),
    entries: merge(workspace.entries, change.entries, 'entry'),
    settings: change.settings ?? workspace.settings,
  };
}

export interface Index {
  orgs: Organization[];
  org: Map<Id, Organization>;
  project: Map<Id, Project>;
  projectsOf: Map<Id, Project[]>;
  thread: Map<Id, Thread>;
  threadsOf: Map<Id, Thread[]>;
  todosOf: Map<Id, Todo[]>;
  /** Thread timeline, newest first. */
  entriesOf: Map<Id, Entry[]>;
  /** Project timeline including its threads' entries, newest first. */
  projectEntries: Map<Id, Entry[]>;
}

const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position;
const group = <T, K>(rows: T[], key: (row: T) => K) => {
  const map = new Map<K, T[]>();
  for (const row of rows) { const k = key(row); const list = map.get(k); if (list) list.push(row); else map.set(k, [row]); }
  return map;
};

export function buildIndex(workspace: Workspace): Index {
  const orgs = [...workspace.organizations].sort(byPosition);
  const projects = [...workspace.projects].sort(byPosition);
  const threads = [...workspace.threads].sort(byPosition);
  const todos = [...workspace.todos].sort(byPosition);
  const entries = [...workspace.entries].sort((a, b) => b.createdAt - a.createdAt);
  return {
    orgs,
    org: new Map(orgs.map(org => [org.id, org])),
    project: new Map(projects.map(project => [project.id, project])),
    projectsOf: group(projects, project => project.orgId),
    thread: new Map(threads.map(thread => [thread.id, thread])),
    threadsOf: group(threads, thread => thread.projectId),
    todosOf: group(todos, todo => todo.threadId),
    entriesOf: group(entries.filter(entry => entry.threadId), entry => entry.threadId!),
    projectEntries: group(entries, entry => entry.projectId),
  };
}

export const nextTodo = (index: Index, threadId: Id) => index.todosOf.get(threadId)?.find(todo => !todo.done) ?? null;
export const openTodos = (index: Index, threadId: Id) => (index.todosOf.get(threadId) ?? []).filter(todo => !todo.done);
export const isOpen = (thread: Thread) => thread.state === 'active' || thread.state === 'waiting';

/** A thread counts toward today's work only when its project is active and its organization is not archived. */
export function isLive(index: Index, thread: Thread) {
  const project = index.project.get(thread.projectId);
  if (!project || project.status !== 'active') return false;
  return !index.org.get(project.orgId)?.archived;
}
export const isStale = (thread: Thread, settings: Settings, now = Date.now()) =>
  thread.state === 'active' && now - thread.lastActivityAt >= settings.staleDays * DAY;

export const compareThreads = (a: Thread, b: Thread) =>
  PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.position - b.position;

export interface FocusItem { thread: Thread; todo: Todo }
export interface Focus {
  /** Open next steps due within the coming week, overdue first. */
  due: FocusItem[];
  waiting: Thread[];
  stale: Thread[];
  /** Active threads with no open todo: every running line needs a next step. */
  noNext: Thread[];
  risky: Project[];
  activeCount: number;
}

export function focusOf(workspace: Workspace, index: Index, now = Date.now()): Focus {
  const horizon = addDays(todayIso(now), 7);
  const live = workspace.threads.filter(thread => isLive(index, thread));
  const due: FocusItem[] = [];
  for (const thread of live) {
    if (!isOpen(thread)) continue;
    for (const todo of openTodos(index, thread.id)) if (todo.due && todo.due <= horizon) due.push({ thread, todo });
  }
  due.sort((a, b) => a.todo.due!.localeCompare(b.todo.due!) || compareThreads(a.thread, b.thread));
  const active = live.filter(thread => thread.state === 'active');
  const orgRank = new Map(index.orgs.map((org, rank) => [org.id, rank]));
  return {
    due,
    waiting: live.filter(thread => thread.state === 'waiting').sort((a, b) => (a.waitingSince ?? 0) - (b.waitingSince ?? 0)),
    stale: active.filter(thread => isStale(thread, workspace.settings, now)).sort((a, b) => a.lastActivityAt - b.lastActivityAt),
    noNext: active.filter(thread => !nextTodo(index, thread.id)).sort(compareThreads),
    risky: workspace.projects
      .filter(project => project.status === 'active' && project.health !== 'onTrack' && !index.org.get(project.orgId)?.archived)
      .sort((a, b) => (a.health === 'offTrack' ? 0 : 1) - (b.health === 'offTrack' ? 0 : 1)
        || (orgRank.get(a.orgId) ?? 0) - (orgRank.get(b.orgId) ?? 0) || a.position - b.position),
    activeCount: active.length,
  };
}

/** Weekly review: every live, open thread not reviewed in the last six days, least recently reviewed first. */
export const REVIEW_WINDOW = 6 * DAY;
export function reviewQueue(workspace: Workspace, index: Index, now = Date.now()) {
  return workspace.threads
    .filter(thread => isLive(index, thread) && isOpen(thread) && (!thread.reviewedAt || now - thread.reviewedAt >= REVIEW_WINDOW))
    .sort((a, b) => (a.reviewedAt ?? 0) - (b.reviewedAt ?? 0) || a.lastActivityAt - b.lastActivityAt);
}

/** Matches a free-text query against a thread's title, tags, project and organization. */
export function matchesThread(index: Index, thread: Thread, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const project = index.project.get(thread.projectId);
  const org = project && index.org.get(project.orgId);
  return [thread.title, ...thread.tags, project?.name, org?.name, org?.code]
    .some(text => text?.toLocaleLowerCase().includes(needle));
}
