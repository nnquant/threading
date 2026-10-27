import { useRef, useState, type ReactNode } from 'react';
import { CalendarClock, CircleAlert, CircleDashed, Flag, Hourglass, Plus, Snail } from 'lucide-react';
import { useApp } from './context';
import { HEALTH_LABEL, daysSince, dueLabel, longToday, relativeTime, todayIso, waitedLabel } from './labels';
import { EmptyState, HealthDot, OrgMark, PriorityIcon } from './ui';
import { parentOf, type Focus } from './workspace';
import type { Thread } from './types';

function Section({ title, count, icon, children }: { title: string; count: number; icon: ReactNode; children: ReactNode }) {
  if (!count) return null;
  return (
    <section className="focus-section">
      <h2><span className="focus-badge" aria-hidden="true">{icon}</span><span>{title}</span><em>{count}</em></h2>
      <ul>{children}</ul>
    </section>
  );
}

function Where({ thread }: { thread: Thread }) {
  const { index } = useApp();
  const project = index.project.get(thread.projectId);
  const org = project && index.org.get(project.orgId);
  const parent = parentOf(index, thread);
  return (
    <span className="focus-where">
      {org && <OrgMark org={org} />}{org?.code}<span className="crumb-sep">/</span>{project?.name}
      {parent && <><span className="crumb-sep">/</span>{parent.title}</>}
    </span>
  );
}

function AddNext({ thread }: { thread: Thread }) {
  const { run } = useApp();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  // Enter submits, and removing the input afterwards also blurs it; only the first submit counts.
  const submitting = useRef(false);
  if (!open) return <button className="btn btn-ghost focus-inline" onClick={() => setOpen(true)}><Plus size={13} />写下一步</button>;
  const submit = async () => {
    if (submitting.current) return;
    if (!text.trim()) { setOpen(false); return; }
    submitting.current = true;
    const change = await run(api => api.createTodo({ threadId: thread.id, text }));
    submitting.current = false;
    if (change) { setText(''); setOpen(false); }
  };
  return (
    <input
      className="plain-input focus-next-input"
      autoFocus
      value={text}
      maxLength={500}
      placeholder="下一步"
      aria-label={`${thread.title} 的下一步`}
      onChange={event => setText(event.target.value)}
      onBlur={() => void submit()}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
        if (event.key === 'Escape') { event.stopPropagation(); setText(''); setOpen(false); }
      }}
    />
  );
}

export default function FocusView({ focus }: { focus: Focus }) {
  const { index, workspace, now, run, notify, openThread, selected, go, newOrg, newThread } = useApp();
  const today = todayIso(now);
  const { wipLimit } = workspace.settings;
  const total = focus.due.length + focus.waiting.length + focus.stale.length + focus.noNext.length + focus.risky.length;
  const complete = async (todoId: string, text: string) => {
    const change = await run(api => api.updateTodo(todoId, { done: true }));
    if (change) notify({ text: `已完成：${text}`, action: { label: '撤销', run: () => void run(api => api.updateTodo(todoId, { done: false })) } });
  };
  const row = (thread: Thread) => `focus-row ${selected === thread.id ? 'is-selected' : ''}`;

  return (
    <div className="view focus-view">
      <header className="view-head">
        <div className="view-title"><h1>焦点</h1><span className="view-date">{longToday(now)}</span></div>
      </header>
      <div className="view-body focus-body">
        {wipLimit > 0 && focus.activeCount > wipLimit && (
          <div className="notice">
            <CircleAlert size={14} />
            <span>进行中 {focus.activeCount} 条，超过上限 {wipLimit} 条</span>
            <button className="link-btn" onClick={() => go({ kind: 'threads' })}>查看全部</button>
          </div>
        )}
        {index.orgs.length === 0 && (
          <EmptyState title="从一个组织开始" action={<button className="btn btn-primary" onClick={newOrg}><Plus size={14} />新建组织</button>} />
        )}
        {index.orgs.length > 0 && total === 0 && (
          <EmptyState title="没有需要处理的事" action={<button className="btn" onClick={() => newThread()}><Plus size={14} />新建策略线</button>} />
        )}

        <Section title="下一步日程" count={focus.due.length} icon={<CalendarClock size={14} />}>
          {focus.due.map(({ thread, todo }) => (
            <li key={todo.id} className={row(thread)}>
              <button className="todo-check" role="checkbox" aria-checked="false" onClick={() => void complete(todo.id, todo.text)} aria-label={`完成：${todo.text}`} />
              <button className="focus-main" onClick={() => openThread(thread.id)}>
                <span className="focus-text truncate">{todo.text}</span>
                <span className="focus-context truncate"><PriorityIcon priority={thread.priority} size={12} />{thread.title}<Where thread={thread} /></span>
              </button>
              <time className={`focus-meta ${todo.due! < today ? 'is-overdue' : todo.due === today ? 'is-today' : ''}`}>{dueLabel(todo.due!, now)}</time>
            </li>
          ))}
        </Section>

        <Section title="等待中" count={focus.waiting.length} icon={<Hourglass size={14} />}>
          {focus.waiting.map(thread => (
            <li key={thread.id} className={row(thread)}>
              <Hourglass size={13} className="focus-icon" />
              <button className="focus-main" onClick={() => openThread(thread.id)}>
                <span className="focus-text truncate">{thread.waitingOn || '等待外部条件'}</span>
                <span className="focus-context truncate">{thread.title}<Where thread={thread} /></span>
              </button>
              <span className={`focus-meta ${thread.waitingSince && daysSince(thread.waitingSince, now) >= workspace.settings.staleDays ? 'is-stale' : ''}`}>
                {thread.waitingSince ? waitedLabel(thread.waitingSince, now) : ''}
              </span>
            </li>
          ))}
        </Section>

        <Section title="停滞" count={focus.stale.length} icon={<Snail size={14} />}>
          {focus.stale.map(thread => (
            <li key={thread.id} className={row(thread)}>
              <PriorityIcon priority={thread.priority} size={13} />
              <button className="focus-main" onClick={() => openThread(thread.id)}>
                <span className="focus-text truncate">{thread.title}</span>
                <span className="focus-context truncate"><Where thread={thread} /></span>
              </button>
              <span className="focus-meta is-stale">{daysSince(thread.lastActivityAt, now)} 天未推进</span>
            </li>
          ))}
        </Section>

        <Section title="缺少下一步" count={focus.noNext.length} icon={<CircleDashed size={14} />}>
          {focus.noNext.map(thread => (
            <li key={thread.id} className={row(thread)}>
              <PriorityIcon priority={thread.priority} size={13} />
              <button className="focus-main" onClick={() => openThread(thread.id)}>
                <span className="focus-text truncate">{thread.title}</span>
                <span className="focus-context truncate"><Where thread={thread} /></span>
              </button>
              <AddNext thread={thread} />
            </li>
          ))}
        </Section>

        <Section title="需要关注的项目" count={focus.risky.length} icon={<Flag size={14} />}>
          {focus.risky.map(project => {
            const org = index.org.get(project.orgId);
            const update = (index.projectEntries.get(project.id) ?? []).find(entry => entry.kind === 'update');
            return (
              <li key={project.id} className="focus-row">
                <HealthDot health={project.health} decorative />
                <button className="focus-main" onClick={() => go({ kind: 'project', id: project.id })}>
                  <span className="focus-text truncate">{project.name}</span>
                  <span className="focus-context truncate">
                    {org && <span className="focus-where"><OrgMark org={org} />{org.code}</span>}
                    {update ? `${relativeTime(update.createdAt, now)}：${update.body.split('\n')[0]}` : '还没有写过项目进展'}
                  </span>
                </button>
                <span className={`focus-meta health-label is-${project.health}`}>{HEALTH_LABEL[project.health]}</span>
              </li>
            );
          })}
        </Section>
      </div>
    </div>
  );
}
