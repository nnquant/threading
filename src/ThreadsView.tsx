import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Columns3, CornerDownRight, GitBranch, GitBranchPlus, GitCommitHorizontal, List, Plus, Search, X } from 'lucide-react';
import { useApp } from './context';
import { PRIORITIES, PRIORITY_LABEL, STAGE_LABEL, STATES, STATE_LABEL, daysSince, dueLabel, fullTime, relativeTime, todayIso } from './labels';
import ThreadLoom, { LOOM_RANGES, type LoomRange } from './ThreadLoom';
import { Dropdown, EmptyState, OrgMark, PriorityIcon, Segmented, StageIcon, StageLabel, StateLabel, TreeLead, TreePath, treeStep, useCollapsed } from './ui';
import { ancestorsOf, compareThreads, isOpen, isStale, matchesThread, needsNext, nextTodo, parentOf, threadTree, type TreeRow } from './workspace';
import { STAGES, type Id, type Stage, type Thread } from './types';

type Layout = 'list' | 'board' | 'loom';
type GroupBy = 'project' | 'stage' | 'state' | 'priority' | 'none';
interface Prefs { layout: Layout; group: GroupBy; showClosed: boolean; range: LoomRange }
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
  const [prefs, setPrefs] = useState<Prefs>(() => readPrefs(prefsKey, { layout: 'list', group: scope === 'all' ? 'project' : 'state', showClosed: false, range: '12w' }));
  const [query, setQuery] = useState('');
  const [collapsed, fold] = useCollapsed();
  const update =(patch: Partial<Prefs>) => {
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
          options={[
            { value: 'list', label: '列表', icon: <List size={13} /> },
            { value: 'board', label: '看板', icon: <Columns3 size={13} /> },
            { value: 'loom', label: '线程', icon: <GitCommitHorizontal size={13} /> },
          ]}
        />
        {prefs.layout === 'loom' && (
          <Segmented<LoomRange> label="时间范围" value={prefs.range} onChange={range => update({ range })} options={LOOM_RANGES.map(({ value, label }) => ({ value, label }))} />
        )}
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
          />
        )
        : prefs.layout === 'board'
          ? <Board threads={visible} scope={scope} projectId={projectId} onMove={moveStage} />
          : prefs.layout === 'loom'
            ? <ThreadLoom threads={visible} scope={scope} range={prefs.range} filtered={!!query} collapsed={collapsed} onFold={fold} />
            : <ThreadList threads={visible} scope={scope} groupBy={groupBy} filtered={!!query} collapsed={collapsed} onFold={fold} />}
    </div>
  );
}

function ThreadList({ threads, scope, groupBy, filtered, collapsed, onFold }: {
  threads: Thread[]; scope: 'all' | 'project'; groupBy: GroupBy; filtered: boolean; collapsed: ReadonlySet<Id>; onFold: (id: Id, open?: boolean) => void;
}) {
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
  // Inside each group a sub-line sits under its parent; one whose parent is elsewhere names it instead.
  const trees = useMemo(() => groups.map(group => ({ ...group, rows: threadTree(group.threads, collapsed) })), [groups, collapsed]);
  const flat = trees.flatMap(group => group.rows);
  const nested = flat.some(row => row.depth > 0 || row.children > 0);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const step = treeStep(flat, selected, event.key);
    if (!step) return;
    event.preventDefault();
    if (step.fold) onFold(...step.fold);
    if (step.select) {
      openThread(step.select);
      listRef.current?.querySelector<HTMLElement>(`[data-thread="${step.select}"]`)?.focus();
    }
  };
  if (!threads.length) return <EmptyState title={filtered ? '没有匹配的策略线' : '没有进行中的策略线'} />;
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
      {trees.map(group => {
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
            {group.rows.map(row => (
              <ThreadRow
                key={row.thread.id}
                row={row}
                nested={nested}
                showProject={showProject}
                selected={selected === row.thread.id}
                onOpen={() => openThread(row.thread.id)}
                onFold={onFold}
              />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function ThreadRow({ row, nested, showProject, selected, onOpen, onFold }: {
  row: TreeRow; nested: boolean; showProject: boolean; selected: boolean; onOpen: () => void; onFold: (id: Id) => void;
}) {
  const { thread } = row;
  const { index, workspace, now, newThread } = useApp();
  const project = index.project.get(thread.projectId);
  const org = project && index.org.get(project.orgId);
  const next = nextTodo(index, thread.id);
  const stale = isStale(thread, workspace.settings, now);
  const overdue = !!next?.due && next.due < todayIso(now);
  const openKids = (index.childrenOf.get(thread.id) ?? []).filter(isOpen).length;
  return (
    <button
      data-thread={thread.id}
      className={`thread-row ${selected ? 'is-selected' : ''} is-${thread.state}`}
      onClick={onOpen}
      aria-expanded={row.children ? !row.hidden : undefined}
    >
      <span className="cell-priority"><PriorityIcon priority={thread.priority} /></span>
      <span className="cell-title">
        {nested && <TreeLead row={row} onFold={onFold} />}
        {row.detached && <TreePath path={ancestorsOf(index, thread)} />}
        <span className="truncate">{thread.title}</span>
        {row.hidden > 0 && <em className="tree-hidden" title={`收起了 ${row.hidden} 条子策略线`}>+{row.hidden}</em>}
        {thread.tags.slice(0, 3).map(tag => <span key={tag} className="tag">{tag}</span>)}
        {/* Inside the row button, so like the fold toggle it is a pointer shortcut; from the keyboard it is Shift+N. */}
        <span
          className="row-action"
          aria-hidden="true"
          title="新建子策略线（Shift+N）"
          onClick={event => { event.stopPropagation(); newThread({ projectId: thread.projectId, parentId: thread.id, stage: thread.stage }); }}
        >
          <GitBranchPlus size={14} />
        </span>
      </span>
      {showProject && (
        <span className="cell-project truncate">{org && <OrgMark org={org} />}<span className="truncate">{project?.name}</span></span>
      )}
      <span className="cell-stage"><StageLabel stage={thread.stage} /></span>
      <span className="cell-state">{thread.state === 'waiting' ? <span className="state-label is-waiting" title={thread.waitingOn}><StateLabel state="waiting" /></span> : <StateLabel state={thread.state} />}</span>
      <span className="cell-next">
        {next
          ? <><span className="truncate">{next.text}</span>{next.due && <time className={overdue ? 'is-overdue' : ''}>{dueLabel(next.due, now)}</time>}</>
          : thread.state === 'waiting'
            ? <span className="truncate muted">等 {thread.waitingOn || '外部条件'}</span>
            : thread.state === 'active' && openKids ? <span className="truncate muted">{openKids} 条子线在推进</span>
            : thread.state === 'active' ? <span className="is-missing">缺少下一步</span> : <span className="muted">—</span>}
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
            <h3 className={`board-head stage-${stage}`}><StageIcon stage={stage} /><span>{STAGE_LABEL[stage]}</span><em>{column.length}</em></h3>
            <div className="board-cards">
              {column.map(thread => {
                const project = index.project.get(thread.projectId);
                const org = project && index.org.get(project.orgId);
                const next = nextTodo(index, thread.id);
                const stale = isStale(thread, workspace.settings, now);
                const parent = parentOf(index, thread);
                const kids = index.childrenOf.get(thread.id)?.length ?? 0;
                return (
                  <button
                    key={thread.id}
                    className={`board-card ${selected === thread.id ? 'is-selected' : ''} is-${thread.state}`}
                    draggable
                    onDragStart={event => { event.dataTransfer.setData('application/x-threading-thread', thread.id); event.dataTransfer.effectAllowed = 'move'; }}
                    onClick={() => openThread(thread.id)}
                  >
                    {parent && (
                      <span className="board-card-parent" title={[...ancestorsOf(index, thread).map(item => item.title), thread.title].join(' / ')}>
                        <CornerDownRight size={11} /><span className="truncate">{parent.title}</span>
                      </span>
                    )}
                    <span className="board-card-title">{thread.title}</span>
                    {scope === 'all' && project && <span className="board-card-project">{org && <OrgMark org={org} />}<span className="truncate">{project.name}</span></span>}
                    {next
                      ? <span className="board-card-next"><span className="truncate">{next.text}</span>{next.due && <time className={next.due < todayIso(now) ? 'is-overdue' : ''}>{dueLabel(next.due, now)}</time>}</span>
                      : needsNext(index, thread) && <span className="board-card-next is-missing">缺少下一步</span>}
                    <span className="board-card-foot">
                      <PriorityIcon priority={thread.priority} size={13} />
                      {thread.state !== 'active' && <StateLabel state={thread.state} />}
                      {kids > 0 && <span className="board-card-kids" title={`${kids} 条子策略线`}><GitBranch size={12} />{kids}</span>}
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
