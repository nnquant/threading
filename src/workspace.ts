import { DAY, PRIORITY_RANK, STATES, addDays, todayIso } from './labels';
import { STAGES, type Change, type EntityKind, type Entry, type Id, type Millis, type Organization, type Project, type Settings, type Stage, type Thread, type ThreadState, type Todo, type Workspace } from './types';

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
  /** Direct sub-lines of a thread, by position. */
  childrenOf: Map<Id, Thread[]>;
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
    childrenOf: group(threads.filter(thread => thread.parentId), thread => thread.parentId!),
    todosOf: group(todos, todo => todo.threadId),
    entriesOf: group(entries.filter(entry => entry.threadId), entry => entry.threadId!),
    projectEntries: group(entries, entry => entry.projectId),
  };
}

export const parentOf = (index: Index, thread: Thread) => thread.parentId ? index.thread.get(thread.parentId) : undefined;

/** The lines above a thread, top-level first. */
export function ancestorsOf(index: Index, thread: Thread): Thread[] {
  const chain: Thread[] = [];
  for (let parent = parentOf(index, thread); parent && parent.id !== thread.id && !chain.includes(parent); parent = parentOf(index, parent)) chain.unshift(parent);
  return chain;
}

/** Every line below a thread, depth first in position order. */
export function descendantsOf(index: Index, id: Id): Thread[] {
  const found: Thread[] = [];
  const seen = new Set([id]);
  const visit = (parentId: Id) => {
    for (const child of index.childrenOf.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      found.push(child);
      visit(child.id);
    }
  };
  visit(id);
  return found;
}

/** One row of a thread tree, with what it takes to draw the tree rails in front of it. */
export interface TreeRow {
  thread: Thread;
  depth: number;
  /** For each ancestor level below the top, whether that ancestor has a later sibling, so its rail runs past this row. */
  rails: boolean[];
  /** The last of its siblings: its rail turns into it rather than branching off. */
  last: boolean;
  /** Sub-lines of this row in the list, shown or collapsed. */
  children: number;
  /** Rows hidden under this one while it is collapsed. */
  hidden: number;
  /** It has a parent that is not in the list (filtered out, closed, or grouped elsewhere). */
  detached: boolean;
}

/**
 * Lays out `threads`, already in display order, as a forest: a line sits under its parent when the parent is in the list,
 * otherwise it starts a tree of its own. A collapsed line keeps its row and hides everything below it.
 */
export function threadTree(threads: Thread[], collapsed: ReadonlySet<Id> = new Set()): TreeRow[] {
  const ids = new Set(threads.map(thread => thread.id));
  const kids = new Map<Id, Thread[]>();
  const roots: Thread[] = [];
  for (const thread of threads) {
    if (!thread.parentId || !ids.has(thread.parentId)) { roots.push(thread); continue; }
    const list = kids.get(thread.parentId);
    if (list) list.push(thread); else kids.set(thread.parentId, [thread]);
  }
  const rows: TreeRow[] = [];
  const seen = new Set<Id>();
  // Lines folded away count as placed, so they are not picked up again as trees of their own.
  const below = (id: Id): number => {
    let sum = 0;
    for (const child of kids.get(id) ?? []) if (!seen.has(child.id)) { seen.add(child.id); sum += 1 + below(child.id); }
    return sum;
  };
  const visit = (thread: Thread, depth: number, rails: boolean[], last: boolean) => {
    if (seen.has(thread.id)) return;
    seen.add(thread.id);
    const children = kids.get(thread.id) ?? [];
    const folded = children.length > 0 && collapsed.has(thread.id);
    rows.push({ thread, depth, rails, last, children: children.length, hidden: folded ? below(thread.id) : 0, detached: depth === 0 && !!thread.parentId });
    if (folded) return;
    children.forEach((child, at) => visit(child, depth + 1, depth ? [...rails, !last] : [], at === children.length - 1));
  };
  for (const root of roots) visit(root, 0, [], true);
  // Only a corrupt parent cycle leaves lines unvisited; show them rather than lose them.
  for (const thread of threads) visit(thread, 0, [], true);
  return rows;
}

export const nextTodo = (index: Index, threadId: Id) => index.todosOf.get(threadId)?.find(todo => !todo.done) ?? null;
export const openTodos = (index: Index, threadId: Id) => (index.todosOf.get(threadId) ?? []).filter(todo => !todo.done);
export const isOpen = (thread: Thread) => thread.state === 'active' || thread.state === 'waiting';
/** An active line without an open todo is missing its next step, unless its work goes on in an open sub-line. */
export const needsNext = (index: Index, thread: Thread) =>
  thread.state === 'active' && !nextTodo(index, thread.id) && !(index.childrenOf.get(thread.id) ?? []).some(isOpen);

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
    noNext: active.filter(thread => needsNext(index, thread)).sort(compareThreads),
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

/** A stretch of a thread's life with one stage and one state. */
export interface Span { start: Millis; end: Millis; stage: Stage; state: ThreadState }

const isStage = (value: string | null): value is Stage => (STAGES as readonly (string | null)[]).includes(value);
const isState = (value: string | null): value is ThreadState => (STATES as (string | null)[]).includes(value);

/**
 * Rebuilds a thread's stage and state over time from its change events, oldest first, ending at `now`.
 * It walks back from the thread's current values using each event's `from`, so a deleted event only blurs one boundary.
 * Changes after `now` are rolled back, so callers that want the current state should pass a fresh clock.
 */
export function threadSpans(thread: Thread, entries: Entry[], now = Date.now()): Span[] {
  const changes = entries
    .filter(entry => entry.kind === 'event' && (entry.event?.field === 'stage' || entry.event?.field === 'state') && entry.createdAt > thread.createdAt)
    .sort((a, b) => b.createdAt - a.createdAt);
  const spans: Span[] = [];
  let { stage, state } = thread;
  let end = now;
  for (const entry of changes) {
    if (entry.createdAt < end) { spans.push({ start: entry.createdAt, end, stage, state }); end = entry.createdAt; }
    const { field, from } = entry.event!;
    if (field === 'stage' && isStage(from)) stage = from;
    if (field === 'state' && isState(from)) state = from;
  }
  if (thread.createdAt < end) spans.push({ start: thread.createdAt, end, stage, state });
  spans.reverse();
  return spans.reduce<Span[]>((merged, span) => {
    const last = merged[merged.length - 1];
    if (last && last.stage === span.stage && last.state === span.state) last.end = span.end;
    else merged.push(span);
    return merged;
  }, []);
}

/** Matches a free-text query against a thread's title, tags, the lines above it, its project and organization. */
export function matchesThread(index: Index, thread: Thread, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const project = index.project.get(thread.projectId);
  const org = project && index.org.get(project.orgId);
  return [thread.title, ...thread.tags, ...ancestorsOf(index, thread).map(parent => parent.title), project?.name, org?.name, org?.code]
    .some(text => text?.toLocaleLowerCase().includes(needle));
}
