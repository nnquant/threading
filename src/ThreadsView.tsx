import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Columns3, List, Plus, Search, X } from 'lucide-react';
import { useApp } from './context';
import { PRIORITIES, PRIORITY_LABEL, STAGE_LABEL, STATES, STATE_LABEL, daysSince, dueLabel, fullTime, relativeTime, todayIso } from './labels';
import { Dropdown, EmptyState, OrgMark, PriorityIcon, Segmented, StageTrack, StateLabel } from './ui';
import { compareThreads, isOpen, isStale, matchesThread, nextTodo } from './workspace';
import { STAGES, type Id, type Stage, type Thread } from './types';

type Layout = 'list' | 'board';
type GroupBy = 'project' | 'stage' | 'state' | 'priority' | 'none';
interface Prefs { layout: Layout; group: GroupBy; showClosed: boolean }
const GROUPS: { value: GroupBy; label: string }[] = [
  { value: 'project', label: '按项目' }, { value: 'stage', label: '按阶段' }, { value: 'state', label: '按状态' },
  { value: 'priority', label: '按优先级' }, { value: 'none', label: '不分组' },
];

function readPrefs(key: string, fallback: Prefs): Prefs {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return fallback; }
}

interface Group { key: string; label: string; threads: Thread[] }

export default function ThreadsView({ threads, scope, projectId }: { threads: Thread[]; scope: 'all' | 'project'; projectId?: Id }) {
  const { index, run, newThread } = useApp();
  const prefsKey = `threading.threads.${scope}.v1`;
  const [prefs, setPrefs] = useState<Prefs>(() => readPrefs(prefsKey, { layout: 'list', group: scope === 'all' ? 'project' : 'state', showClosed: false }));
  const [query, setQuery] = useState('');
  const update = (patch: Partial<Prefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try { localStorage.setItem(prefsKey, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
  };
  const groupBy = scope === 'project' && prefs.group === 'project' ? 'state' : prefs.group;
  const closedCount = threads.filter(thread => thread.state === 'closed').length;
  const visible = useMemo(
    () => threads.filter(thread => (prefs.showClosed || thread.state !== 'closed') && matchesThread(index, thread, query)).sort(compareThreads),
    [threads, prefs.showClosed, query, index],
  );
  const moveStage = (id: Id, stage: Stage) => {
    const thread = index.thread.get(id);
    if (thread && thread.stage !== stage) void run(api => api.updateThread(id, { stage, hill: 0 }));
  };

  return (
    <div className="threads-view">
      <div className="view-toolbar">
        <Segmented<Layout>
          label="布局"
          value={prefs.layout}
          onChange={layout => update({ layout })}
          options={[{ value: 'list', label: '列表', icon: <List size={13} /> }, { value: 'board', label: '看板', icon: <Columns3 size={13} /> }]}
        />
        {prefs.layout === 'list' && (
          <Dropdown<GroupBy>
            label="分组"
            value={groupBy}
            onChange={group => update({ group })}
            options={GROUPS.filter(group => scope === 'all' || group.value !== 'project')}
          />
        )}
        {closedCount > 0 && (
          <label className="check-toggle">
            <input type="checkbox" checked={prefs.showClosed} onChange={event => update({ showClosed: event.target.checked })} />
            显示已结束（{closedCount}）
          </label>
        )}
        <div className="filter-field">
          <Search size={13} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="筛选策略线、标签" aria-label="筛选策略线" />
          {query && <button className="filter-clear" onClick={() => setQuery('')} aria-label="清除筛选"><X size={12} /></button>}
        </div>
      </div>
      {threads.length === 0
        ? (
          <EmptyState
            title={scope === 'project' ? '这个项目还没有策略线' : '还没有策略线'}
            action={<button className="btn btn-primary" onClick={() => newThread({ projectId })}><Plus size={14} />新建策略线</button>}
          >
            每条策略线是项目里一条独立推进的研究或交易线，例如一个因子、一个模型或一次实盘迭代。
          </EmptyState>
        )
        : prefs.layout === 'board'
          ? <Board threads={visible} scope={scope} projectId={projectId} onMove={moveStage} />
          : <ThreadList threads={visible} scope={scope} groupBy={groupBy} filtered={!!query} />}
    </div>
  );
}

function ThreadList({ threads, scope, groupBy, filtered }: { threads: Thread[]; scope: 'all' | 'project'; groupBy: GroupBy; filtered: boolean }) {
  const { index, selected, openThread } = useApp();
  // The project column only adds information when rows are not already grouped by project.
  const showProject = scope === 'all' && groupBy !== 'project';
  const listRef = useRef<HTMLDivElement>(null);
  const groups = useMemo<Group[]>(() => {
    if (groupBy === 'none') return [{ key: 'all', label: '', threads }];
    const keyOf = (thread: Thread) => groupBy === 'project' ? thread.projectId : thread[groupBy];
    const order: string[] = groupBy === 'stage' ? [...STAGES] : groupBy === 'state' ? STATES : groupBy === 'priority' ? PRIORITIES
      : index.orgs.flatMap(org => (index.projectsOf.get(org.id) ?? []).map(project => project.id));
    return order.map(key => {
      const project = groupBy === 'project' ? index.project.get(key) : undefined;
      const label = groupBy === 'stage' ? STAGE_LABEL[key as Stage] : groupBy === 'state' ? STATE_LABEL[key as Thread['state']]
        : groupBy === 'priority' ? `${PRIORITY_LABEL[key as Thread['priority']]}优先级` : project?.name ?? '';
      return { key, label, threads: threads.filter(thread => keyOf(thread) === key) };
    }).filter(group => group.threads.length);
  }, [threads, groupBy, index]);
  const flat = groups.flatMap(group => group.threads);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const at = flat.findIndex(thread => thread.id === selected);
    const next = flat[at < 0 ? 0 : Math.min(flat.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    openThread(next.id);
    listRef.current?.querySelector<HTMLElement>(`[data-thread="${next.id}"]`)?.focus();
  };
  if (!threads.length) return <EmptyState title={filtered ? '没有匹配的策略线' : '没有进行中的策略线'}>{filtered ? '换个关键词试试。' : '已结束的策略线可以通过上方的开关显示。'}</EmptyState>;
  return (
    <div className={`thread-list ${showProject ? 'is-all' : 'is-project'}`} ref={listRef} onKeyDown={onKeyDown}>
      <div className="thread-head" aria-hidden="true">
        <span className="cell-priority" />
        <span className="cell-title">策略线</span>
        {showProject && <span className="cell-project">项目</span>}
        <span className="cell-stage">阶段</span>
        <span className="cell-state">状态</span>
        <span className="cell-next">下一步</span>
        <span className="cell-activity">最近推进</span>
      </div>
      {groups.map(group => {
        const project = groupBy === 'project' ? index.project.get(group.key) : undefined;
        const org = project && index.org.get(project.orgId);
        return (
          <section key={group.key} className="thread-group" aria-label={group.label || '策略线'}>
            {group.label && (
              <h3 className="group-head">
                {org && <OrgMark org={org} />}
                {org && <small>{org.code}</small>}
                <span>{group.label}</span>
                <em>{group.threads.length}</em>
              </h3>
            )}
            {group.threads.map(thread => <ThreadRow key={thread.id} thread={thread} showProject={showProject} selected={selected === thread.id} onOpen={() => openThread(thread.id)} />)}
          </section>
        );
      })}
    </div>
  );
}

function ThreadRow({ thread, showProject, selected, onOpen }: { thread: Thread; showProject: boolean; selected: boolean; onOpen: () => void }) {
  const { index, workspace, now } = useApp();
  const project = index.project.get(thread.projectId);
  const org = project && index.org.get(project.orgId);
  const next = nextTodo(index, thread.id);
  const stale = isStale(thread, workspace.settings, now);
  const overdue = !!next?.due && next.due < todayIso(now);
  return (
    <button data-thread={thread.id} className={`thread-row ${selected ? 'is-selected' : ''} is-${thread.state}`} onClick={onOpen}>
      <span className="cell-priority"><PriorityIcon priority={thread.priority} /></span>
      <span className="cell-title">
        <span className="truncate">{thread.title}</span>
        {thread.tags.slice(0, 3).map(tag => <span key={tag} className="tag">{tag}</span>)}
      </span>
      {showProject && (
        <span className="cell-project truncate">{org && <OrgMark org={org} />}<span className="truncate">{project?.name}</span></span>
      )}
      <span className="cell-stage"><StageTrack stage={thread.stage} /><span>{STAGE_LABEL[thread.stage]}</span></span>
      <span className="cell-state">{thread.state === 'waiting' ? <span className="state-label is-waiting" title={thread.waitingOn}><StateLabel state="waiting" /></span> : <StateLabel state={thread.state} />}</span>
      <span className="cell-next">
        {next
          ? <><span className="truncate">{next.text}</span>{next.due && <time className={overdue ? 'is-overdue' : ''}>{dueLabel(next.due, now)}</time>}</>
          : thread.state === 'waiting'
            ? <span className="truncate muted">等 {thread.waitingOn || '外部条件'}</span>
            : isOpen(thread) ? <span className="is-missing">缺少下一步</span> : <span className="muted">—</span>}
      </span>
      <span className={`cell-activity ${stale ? 'is-stale' : ''}`} title={`最近推进：${fullTime(thread.lastActivityAt)}`}>{relativeTime(thread.lastActivityAt, now)}</span>
    </button>
  );
}

function Board({ threads, scope, projectId, onMove }: { threads: Thread[]; scope: 'all' | 'project'; projectId?: Id; onMove: (id: Id, stage: Stage) => void }) {
  const { index, selected, openThread, workspace, now, newThread } = useApp();
  const [over, setOver] = useState<Stage | null>(null);
  const onDrop = (event: DragEvent, stage: Stage) => {
    event.preventDefault();
    setOver(null);
    const id = event.dataTransfer.getData('application/x-threading-thread');
    if (id) onMove(id, stage);
  };
  return (
    <div className="board">
      {STAGES.map(stage => {
        const column = threads.filter(thread => thread.stage === stage);
        return (
          <section
            key={stage}
            className={`board-column ${over === stage ? 'is-over' : ''}`}
            aria-label={STAGE_LABEL[stage]}
            onDragOver={event => { if (event.dataTransfer.types.includes('application/x-threading-thread')) { event.preventDefault(); setOver(stage); } }}
            onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(null); }}
            onDrop={event => onDrop(event, stage)}
          >
            <h3 className="board-head"><StageTrack stage={stage} /><span>{STAGE_LABEL[stage]}</span><em>{column.length}</em></h3>
            <div className="board-cards">
              {column.map(thread => {
                const project = index.project.get(thread.projectId);
                const org = project && index.org.get(project.orgId);
                const next = nextTodo(index, thread.id);
                const stale = isStale(thread, workspace.settings, now);
                return (
                  <button
                    key={thread.id}
                    className={`board-card ${selected === thread.id ? 'is-selected' : ''} is-${thread.state}`}
                    draggable
                    onDragStart={event => { event.dataTransfer.setData('application/x-threading-thread', thread.id); event.dataTransfer.effectAllowed = 'move'; }}
                    onClick={() => openThread(thread.id)}
                  >
                    <span className="board-card-title">{thread.title}</span>
                    {scope === 'all' && project && <span className="board-card-project">{org && <OrgMark org={org} />}<span className="truncate">{project.name}</span></span>}
                    {next
                      ? <span className="board-card-next"><span className="truncate">{next.text}</span>{next.due && <time className={next.due < todayIso(now) ? 'is-overdue' : ''}>{dueLabel(next.due, now)}</time>}</span>
                      : thread.state === 'active' && <span className="board-card-next is-missing">缺少下一步</span>}
                    <span className="board-card-foot">
                      <PriorityIcon priority={thread.priority} size={13} />
                      {thread.state !== 'active' && <StateLabel state={thread.state} />}
                      {stale && <span className="is-stale">{daysSince(thread.lastActivityAt, now)} 天未推进</span>}
                    </span>
                  </button>
                );
              })}
              <button className="board-add" onClick={() => newThread({ projectId, stage })}><Plus size={13} />新建</button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
