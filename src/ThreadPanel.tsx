import { useEffect, useRef, useState, type FocusEvent } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { useApp } from './context';
import { PRIORITIES, PRIORITY_LABEL, STATES, STATE_LABEL, fullTime, relativeTime, waitedLabel } from './labels';
import { Composer, Timeline } from './Timeline';
import Todos from './Todos';
import { AutoTextarea, Dropdown, InlineEdit, Markdown, OrgMark, PriorityIcon, Segmented, StageIcon, StagePicker, StateIcon, StateLabel, TreeLead } from './ui';
import { ancestorsOf, compareThreads, descendantsOf, isStale, threadTree } from './workspace';
import type { Id, Metric, Thread, ThreadPatch } from './types';

export default function ThreadPanel({ id, onClose }: { id: Id; onClose: () => void }) {
  const { index, run, go, confirm, notify, openThread, newThread, workspace, now } = useApp();
  const thread = index.thread.get(id);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [id]);
  if (!thread) return null;
  const project = index.project.get(thread.projectId);
  const org = project && index.org.get(project.orgId);
  const entries = index.entriesOf.get(thread.id) ?? [];
  const patch = (value: ThreadPatch) => run(api => api.updateThread(thread.id, value));
  const stale = isStale(thread, workspace.settings, now);
  const ancestors = ancestorsOf(index, thread);
  const subtree = descendantsOf(index, thread.id);
  const projectOptions = index.orgs.flatMap(item => (index.projectsOf.get(item.id) ?? [])
    .filter(option => option.status !== 'archived' || option.id === thread.projectId)
    .map(option => ({ value: option.id, label: option.name, hint: item.code, icon: <OrgMark org={item} /> })));
  // A line can go under any line of its project except itself and the lines below it.
  const below = new Set([thread.id, ...subtree.map(item => item.id)]);
  const parentOptions = [
    { value: '', label: '无' },
    ...threadTree([...(index.threadsOf.get(thread.projectId) ?? [])].sort(compareThreads))
      .filter(row => !below.has(row.thread.id))
      .map(row => ({ value: row.thread.id, label: row.thread.title, depth: row.depth, icon: <StageIcon stage={row.thread.stage} /> })),
  ];
  const move = async (projectId: Id) => {
    const change = await run(api => api.updateThread(thread.id, { projectId }));
    if (change && subtree.length) notify({ text: `已连同 ${subtree.length} 条子策略线移到「${index.project.get(projectId)?.name ?? ''}」` });
  };
  const remove = () => {
    const lines = [thread, ...subtree];
    const count = (of: Map<Id, unknown[]>) => lines.reduce((sum, line) => sum + (of.get(line.id)?.length ?? 0), 0);
    const rows = `${count(index.todosOf)} 条待办和 ${count(index.entriesOf)} 条记录`;
    confirm({
      title: `删除策略线「${thread.title}」？`,
      body: `${subtree.length ? `它的 ${subtree.length} 条子策略线，以及这些线的 ${rows}` : `它的 ${rows}`}会一起永久删除。只是不再推进的话，可以把状态改为「已结束」。`,
      confirmLabel: '永久删除',
      onConfirm: async () => { const change = await run(api => api.deleteThread(thread.id)); if (change) onClose(); },
    });
  };

  return (
    <aside className="panel" aria-label={`策略线：${thread.title}`}>
      <div className="panel-head">
        <nav className="panel-crumbs" aria-label="位置">
          {org && <button className="crumb" onClick={() => go({ kind: 'org', id: org.id })}><OrgMark org={org} />{org.code}</button>}
          <span className="crumb-sep">/</span>
          {project && <button className="crumb truncate" onClick={() => go({ kind: 'project', id: project.id })}>{project.name}</button>}
          {ancestors.map(item => (
            <span key={item.id} className="crumb-step">
              <span className="crumb-sep">/</span>
              <button className="crumb truncate" onClick={() => openThread(item.id)} title={item.title}>{item.title}</button>
            </span>
          ))}
        </nav>
        <button className="icon-btn danger-hover" onClick={remove} aria-label="删除策略线" title="删除策略线"><Trash2 size={14} /></button>
        <button className="icon-btn" onClick={onClose} aria-label="关闭详情" title="关闭（Esc）"><X size={15} /></button>
      </div>
      <div className="panel-body" ref={body}>
        <InlineEdit className="panel-title" label="策略线名称" value={thread.title} maxLength={120} onCommit={title => void patch({ title })} />
        <StagePicker stage={thread.stage} onChange={stage => void patch({ stage, hill: 0 })} />

        <dl className="props">
          <dt>状态</dt>
          <dd>
            <Segmented
              label="状态"
              value={thread.state}
              onChange={state => void patch({ state })}
              options={STATES.map(value => ({ value, label: STATE_LABEL[value], icon: <StateIcon state={value} size={12} /> }))}
            />
          </dd>
          {thread.state === 'waiting' && (
            <>
              <dt>等待</dt>
              <dd className="waiting-field">
                <WaitingInput thread={thread} />
                {thread.waitingSince && <span className="muted">{waitedLabel(thread.waitingSince, now)}</span>}
              </dd>
            </>
          )}
          <dt>优先级</dt>
          <dd>
            <Dropdown
              label="优先级"
              value={thread.priority}
              onChange={priority => void patch({ priority })}
              options={PRIORITIES.map(value => ({ value, label: PRIORITY_LABEL[value], icon: <PriorityIcon priority={value} /> }))}
            />
          </dd>
          <dt>项目</dt>
          <dd>
            <Dropdown label="所属项目" value={thread.projectId} onChange={projectId => void move(projectId)} options={projectOptions} />
          </dd>
          <dt>上级</dt>
          <dd>
            <Dropdown label="上级策略线" value={thread.parentId ?? ''} onChange={parentId => void patch({ parentId: parentId || null })} options={parentOptions} />
          </dd>
          <dt>山丘</dt>
          <dd><HillSlider thread={thread} /></dd>
          <dt>标签</dt>
          <dd><Tags thread={thread} /></dd>
          <dt>推进</dt>
          <dd className="props-meta">
            <span className={stale ? 'is-stale' : ''} title={fullTime(thread.lastActivityAt)}>最近推进 {relativeTime(thread.lastActivityAt, now)}</span>
            <span title={thread.reviewedAt ? fullTime(thread.reviewedAt) : undefined}>{thread.reviewedAt ? `回顾于 ${relativeTime(thread.reviewedAt, now)}` : '尚未回顾'}</span>
          </dd>
        </dl>

        <section className="panel-section">
          <h3>下一步</h3>
          <Todos threadId={thread.id} />
        </section>

        <section className="panel-section">
          <h3>子策略线{subtree.length > 0 && <em>{subtree.length}</em>}</h3>
          <SubLines thread={thread} />
          <button className="link-btn sub-line-add" onClick={() => newThread({ projectId: thread.projectId, parentId: thread.id, stage: thread.stage })}>
            <Plus size={12} />新建子策略线
          </button>
        </section>

        <section className="panel-section">
          <h3>指标</h3>
          <Metrics thread={thread} />
        </section>

        <section className="panel-section">
          <h3>说明</h3>
          <Summary thread={thread} />
        </section>

        <section className="panel-section">
          <h3>记录<em>{entries.filter(entry => entry.kind !== 'event').length}</em></h3>
          <Composer projectId={thread.projectId} threadId={thread.id} compact />
          <Timeline entries={entries} empty="还没有记录。结果、决策和想法都记在这里，回头能看清这条线是怎么走过来的。" />
        </section>
      </div>
    </aside>
  );
}

/** Every line below this one, drawn as the tree that hangs from it. */
function SubLines({ thread }: { thread: Thread }) {
  const { index, openThread, now } = useApp();
  const rows = threadTree([thread, ...descendantsOf(index, thread.id).sort(compareThreads)]).slice(1);
  if (!rows.length) return null;
  return (
    <ul className="sub-lines">
      {rows.map(row => (
        <li key={row.thread.id}>
          <button className={`sub-line is-${row.thread.state}`} onClick={() => openThread(row.thread.id)}>
            <TreeLead row={row} />
            <StageIcon stage={row.thread.stage} />
            <span className="truncate">{row.thread.title}</span>
            {row.thread.state !== 'active' && <StateLabel state={row.thread.state} />}
            <time title={`最近推进：${fullTime(row.thread.lastActivityAt)}`}>{relativeTime(row.thread.lastActivityAt, now)}</time>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function WaitingInput({ thread }: { thread: Thread }) {
  const { run } = useApp();
  const [value, setValue] = useState(thread.waitingOn);
  useEffect(() => setValue(thread.waitingOn), [thread.waitingOn]);
  const commit = () => { if (value.trim() !== thread.waitingOn) void run(api => api.updateThread(thread.id, { waitingOn: value })); };
  return (
    <input
      className="plain-input"
      value={value}
      maxLength={80}
      placeholder="在等谁或什么？"
      aria-label="等待对象"
      onChange={event => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={event => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }}
    />
  );
}

const sliderX = (hill: number) => 4 + 152 * (hill / 100);
const sliderY = (hill: number) => 23 - 19 * (1 - Math.cos(2 * Math.PI * (hill / 100))) / 2;
const SLIDER_CURVE = Array.from({ length: 41 }, (_, i) => `${i ? 'L' : 'M'}${sliderX(i * 2.5).toFixed(1)} ${sliderY(i * 2.5).toFixed(1)}`).join(' ');

export const hillLabel = (hill: number) => hill <= 50 ? '摸索中' : hill >= 100 ? '已完成' : '推进中';

/** Uphill (0–50) is still figuring the work out; downhill (50–100) is execution. */
export function HillSlider({ thread }: { thread: Thread }) {
  const { run } = useApp();
  const [value, setValue] = useState(thread.hill);
  useEffect(() => setValue(thread.hill), [thread.hill]);
  const commit = () => { if (value !== thread.hill) void run(api => api.updateThread(thread.id, { hill: value })); };
  return (
    <div className="hill-slider">
      <svg width="160" height="26" viewBox="0 0 160 26" aria-hidden="true">
        <path d={SLIDER_CURVE} />
        <circle cx={sliderX(value)} cy={sliderY(value)} r="4" />
      </svg>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label="山丘位置"
        aria-valuetext={`${hillLabel(value)} ${value}`}
        onChange={event => setValue(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="hill-value">{hillLabel(value)}<em>{value}</em></span>
    </div>
  );
}

function Tags({ thread }: { thread: Thread }) {
  const { run } = useApp();
  const [draft, setDraft] = useState('');
  const save = (tags: string[]) => void run(api => api.updateThread(thread.id, { tags }));
  const add = () => {
    const tag = draft.trim().replace(/[,，]$/, '');
    setDraft('');
    if (tag && !thread.tags.some(item => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) save([...thread.tags, tag]);
  };
  return (
    <div className="tag-editor">
      {thread.tags.map(tag => (
        <span key={tag} className="tag">
          {tag}
          <button onClick={() => save(thread.tags.filter(item => item !== tag))} aria-label={`移除标签 ${tag}`}><X size={10} /></button>
        </span>
      ))}
      <input
        value={draft}
        maxLength={24}
        placeholder={thread.tags.length ? '' : '添加标签'}
        aria-label="添加标签"
        onChange={event => setDraft(event.target.value)}
        onBlur={add}
        onKeyDown={event => {
          if ((event.key === 'Enter' || event.key === ',' || event.key === '，') && !event.nativeEvent.isComposing) { event.preventDefault(); add(); }
          if (event.key === 'Backspace' && !draft && thread.tags.length) save(thread.tags.slice(0, -1));
        }}
      />
    </div>
  );
}

function Metrics({ thread }: { thread: Thread }) {
  const { run } = useApp();
  const [rows, setRows] = useState<Metric[]>(thread.metrics);
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setRows(thread.metrics); }, [thread.metrics]);
  const commit = (next: Metric[]) => {
    editing.current = false;
    const clean = next.map(row => ({ label: row.label.trim(), value: row.value.trim() })).filter(row => row.label);
    if (JSON.stringify(clean) !== JSON.stringify(thread.metrics)) void run(api => api.updateThread(thread.id, { metrics: clean }));
    else setRows(thread.metrics);
  };
  const set = (at: number, field: keyof Metric, value: string) => setRows(rows.map((row, index) => index === at ? { ...row, [field]: value } : row));
  const onBlur = (event: FocusEvent<HTMLDivElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) commit(rows); };
  return (
    <div className="metrics" onFocus={() => { editing.current = true; }} onBlur={onBlur}>
      {rows.length > 0 && (
        <div className="metric-grid">
          {rows.map((row, at) => (
            <div key={at} className="metric">
              <input className="metric-label" value={row.label} maxLength={24} placeholder="名称" aria-label="指标名称" autoFocus={at === rows.length - 1 && !row.label && !row.value} onChange={event => set(at, 'label', event.target.value)} />
              <input className="metric-value" value={row.value} maxLength={40} placeholder="数值" aria-label="指标值" onChange={event => set(at, 'value', event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} />
              <button className="icon-btn icon-btn-sm" onClick={() => { const next = rows.filter((_, index) => index !== at); setRows(next); commit(next); }} aria-label={`删除指标 ${row.label}`}><X size={11} /></button>
            </div>
          ))}
        </div>
      )}
      {rows.length < 12 && (
        <button className="link-btn metric-add" onClick={() => { editing.current = true; setRows([...rows, { label: '', value: '' }]); }}>
          <Plus size={12} />{rows.length ? '添加指标' : '记录夏普、年化、回撤等关键指标'}
        </button>
      )}
    </div>
  );
}

function Summary({ thread }: { thread: Thread }) {
  const { run } = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.summary);
  const save = async () => {
    if (draft.trim() !== thread.summary) { const change = await run(api => api.updateThread(thread.id, { summary: draft })); if (!change) return; }
    setEditing(false);
  };
  if (editing) {
    return (
      <div className="summary-edit">
        <AutoTextarea
          value={draft}
          onChange={setDraft}
          minRows={4}
          autoFocus
          aria-label="说明"
          placeholder="假设、范围、数据来源、相关链接……"
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(false); }
          }}
        />
        <div className="composer-foot">
          <span className="muted">支持 Markdown，Ctrl+Enter 保存</span>
          <button className="btn btn-ghost" onClick={() => setEditing(false)}>取消</button>
          <button className="btn btn-primary" onClick={() => void save()}>保存</button>
        </div>
      </div>
    );
  }
  if (!thread.summary) return <button className="summary-empty" onClick={() => { setDraft(''); setEditing(true); }}>写下这条线的假设、范围和相关链接</button>;
  return (
    <div className="summary" onDoubleClick={() => { setDraft(thread.summary); setEditing(true); }}>
      <Markdown text={thread.summary} />
      <button className="link-btn" onClick={() => { setDraft(thread.summary); setEditing(true); }}>编辑说明</button>
    </div>
  );
}
