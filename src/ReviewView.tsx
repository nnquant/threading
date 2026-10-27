import { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { useApp } from './context';
import { STATES, STATE_LABEL, daysSince, relativeTime } from './labels';
import { HillSlider, WaitingInput } from './ThreadPanel';
import { Composer, Timeline } from './Timeline';
import Todos from './Todos';
import { EmptyState, InlineEdit, OrgMark, PriorityIcon, Segmented, StagePicker, StateIcon } from './ui';
import { ancestorsOf, reviewQueue } from './workspace';
import type { Id } from './types';

/** Weekly review: walk every open line once, confirm where it stands and what happens next. */
export default function ReviewView() {
  const { workspace, index, run, now, go } = useApp();
  const queue = useMemo(() => reviewQueue(workspace, index, now), [workspace, index, now]);
  const [skipped, setSkipped] = useState<Set<Id>>(new Set());
  const [reviewed, setReviewed] = useState(0);
  const [busy, setBusy] = useState(false);
  const pending = queue.filter(thread => !skipped.has(thread.id));
  const thread = pending[0];
  const total = reviewed + queue.length;

  if (!thread) {
    return (
      <div className="view">
        <header className="view-head"><div className="view-title"><h1>周回顾</h1></div></header>
        <div className="view-body">
          <EmptyState
            title={queue.length ? '剩下的都跳过了' : '这周的回顾做完了'}
            action={queue.length
              ? <button className="btn" onClick={() => setSkipped(new Set())}>重新看跳过的 {queue.length} 条</button>
              : <button className="btn" onClick={() => go({ kind: 'focus' })}>回到焦点</button>}
          >
            {reviewed > 0 && `本次回顾了 ${reviewed} 条`}
          </EmptyState>
        </div>
      </div>
    );
  }

  const project = index.project.get(thread.projectId);
  const org = project && index.org.get(project.orgId);
  const recent = (index.entriesOf.get(thread.id) ?? []).filter(entry => entry.kind !== 'event').slice(0, 3);
  const finish = async () => {
    setBusy(true);
    const change = await run(api => api.updateThread(thread.id, { reviewed: true }));
    setBusy(false);
    if (change) setReviewed(count => count + 1);
  };

  return (
    <div className="view">
      <header className="view-head">
        <div className="view-title"><h1>周回顾</h1><span className="view-date">第 {reviewed + skipped.size + 1} 条，共 {total} 条</span></div>
        <div className="review-progress" aria-hidden="true"><span style={{ width: `${((reviewed + skipped.size) / Math.max(1, total)) * 100}%` }} /></div>
      </header>
      <div className="view-body review-body">
        <article className="review-card" key={thread.id}>
          <div className="review-crumbs">
            {org && <><OrgMark org={org} />{org.name}</>}
            <span className="crumb-sep">/</span>
            {project?.name}
            {ancestorsOf(index, thread).map(item => <span key={item.id}><span className="crumb-sep">/</span>{item.title}</span>)}
            <span className="review-since">最近推进 {relativeTime(thread.lastActivityAt, now)}{thread.reviewedAt ? `，上次回顾 ${daysSince(thread.reviewedAt, now)} 天前` : '，还没有回顾过'}</span>
          </div>
          <div className="review-title">
            <PriorityIcon priority={thread.priority} />
            <InlineEdit className="panel-title" label="策略线名称" value={thread.title} maxLength={120} onCommit={title => void run(api => api.updateThread(thread.id, { title }))} />
          </div>
          <StagePicker stage={thread.stage} onChange={stage => void run(api => api.updateThread(thread.id, { stage, hill: 0 }))} />
          <dl className="props">
            <dt>状态</dt>
            <dd>
              <Segmented
                label="状态"
                value={thread.state}
                onChange={state => void run(api => api.updateThread(thread.id, { state }))}
                options={STATES.map(value => ({ value, label: STATE_LABEL[value], icon: <StateIcon state={value} size={12} /> }))}
              />
            </dd>
            {thread.state === 'waiting' && <><dt>等待</dt><dd className="waiting-field"><WaitingInput thread={thread} /></dd></>}
            <dt>山丘</dt>
            <dd><HillSlider thread={thread} /></dd>
          </dl>
          <section className="panel-section">
            <h3>下一步</h3>
            <Todos threadId={thread.id} />
          </section>
          <section className="panel-section">
            <h3>最近记录</h3>
            <Composer projectId={thread.projectId} threadId={thread.id} compact />
            <Timeline entries={recent} />
          </section>
        </article>
        <div className="review-actions">
          <button className="btn btn-ghost" onClick={() => setSkipped(new Set([...skipped, thread.id]))}>跳过</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void finish()}><Check size={14} />完成回顾</button>
        </div>
      </div>
    </div>
  );
}
