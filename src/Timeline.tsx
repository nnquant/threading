import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronDown, ChevronUp, FilePenLine, Maximize2, Pencil, Trash2 } from 'lucide-react';
import { useApp } from './context';
import { EVENT_LABEL, HEALTH_LABEL, HEALTHS, KIND_LABEL, eventValue, fullTime, relativeTime, titleOf } from './labels';
import { AutoTextarea, HealthDot, Markdown, Segmented } from './ui';
import type { Writable } from './tabs';
import type { Entry, Health, Id } from './types';

/** Composer for a thread (note / decision / result) or a project (update with health / note / decision). */
export function Composer({ projectId, threadId = null, compact = false }: { projectId: Id; threadId?: Id | null; compact?: boolean }) {
  const { run, index, editors, openEditor, showTab } = useApp();
  const kinds: Writable[] = threadId ? ['note', 'decision', 'result'] : ['update', 'note', 'decision'];
  const [kind, setKind] = useState<Writable>(kinds[0]);
  const [body, setBody] = useState('');
  const [health, setHealth] = useState<Health>(() => index.project.get(projectId)?.health ?? 'onTrack');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    const change = await run(api => api.createEntry({ projectId, threadId, kind, body, ...(kind === 'update' ? { health } : {}) }));
    setBusy(false);
    if (change) setBody('');
  };
  const drafting = editors.find(tab => !tab.draft.entryId && tab.draft.projectId === projectId && tab.draft.threadId === threadId);
  // The editor tab takes over whatever is typed here so far.
  const expand = () => { openEditor({ projectId, threadId, kind, health }, body); setBody(''); };
  const placeholder = kind === 'update' ? '这个项目最近怎么样？下一步重点是什么？'
    : kind === 'decision' ? '做了什么决定，为什么？' : kind === 'result' ? '跑出了什么结果？' : '记录想法、发现或上下文';
  return (
    <div className={`composer ${compact ? 'is-compact' : ''}`}>
      <div className="composer-kinds">
        <Segmented<Writable> label="记录类型" value={kind} onChange={setKind} options={kinds.map(value => ({ value, label: KIND_LABEL[value] }))} />
        {kind === 'update' && (
          <Segmented<Health> label="健康度" value={health} onChange={setHealth} options={HEALTHS.map(value => ({ value, label: HEALTH_LABEL[value], icon: <HealthDot health={value} decorative /> }))} />
        )}
        <button type="button" className="icon-btn composer-expand" onClick={expand} aria-label="在编辑器中写" title="在编辑器中写">
          <Maximize2 size={14} />
        </button>
      </div>
      {drafting && (
        <button type="button" className="composer-draft" onClick={() => showTab(drafting.id)}>
          <FilePenLine size={13} />继续编辑{KIND_LABEL[drafting.draft.kind]}草稿
        </button>
      )}
      <AutoTextarea
        value={body}
        onChange={setBody}
        minRows={compact ? 2 : 3}
        placeholder={placeholder}
        aria-label="记录内容"
        onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submit(); } }}
      />
      <div className="composer-foot">
        <button className="btn btn-primary" title="Ctrl+Enter" disabled={!body.trim() || busy} onClick={() => void submit()}>记录{KIND_LABEL[kind]}</button>
      </div>
    </div>
  );
}

// A record taller than this starts folded (to the height in .entry-fold.is-folded), so one long note does not push the rest of
// the timeline away; a little over that height is shown whole, since folding it would hide only a few lines.
const FOLD_OVER = 340;

/** The body of a record (without the title, which its head shows), folded when long. */
function EntryBody({ entry, text }: { entry: Entry; text: string }) {
  const { openRecord } = useApp();
  const fold = useRef<HTMLDivElement>(null);
  const clip = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    // The clip is what gets folded; the rendered Markdown inside keeps its full height.
    const element = clip.current?.firstElementChild as HTMLElement | null | undefined;
    if (!element || typeof ResizeObserver === 'undefined') return;
    // Images and formulas load late and the panel can be resized, so the height is watched rather than read once.
    const observer = new ResizeObserver(() => setLong(element.offsetHeight > FOLD_OVER));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const toggle = () => {
    setOpen(!open);
    // Folding a long record back from its end would leave the view far below it.
    if (open) requestAnimationFrame(() => fold.current?.closest('.entry')?.scrollIntoView?.({ block: 'nearest' }));
  };
  return (
    <div ref={fold} className={`entry-fold ${long && !open ? 'is-folded' : ''}`}>
      <div ref={clip} className="entry-clip"><Markdown text={text} className="entry-body" /></div>
      {long && (
        <div className="entry-more">
          <button aria-expanded={open} onClick={toggle}>
            {open ? <><ChevronUp size={13} />收起</> : <><ChevronDown size={13} />展开全文</>}
          </button>
          <button onClick={() => openRecord(entry.id)}><Maximize2 size={12} />在标签页中打开</button>
        </div>
      )}
    </div>
  );
}

export function Timeline({ entries, showThread = false }: { entries: Entry[]; showThread?: boolean }) {
  const { run, now, index, openThread, confirm, openEditor } = useApp();
  const [editing, setEditing] = useState<Id | null>(null);
  const [draft, setDraft] = useState('');
  if (!entries.length) return null;
  const save = async (entry: Entry) => {
    if (!draft.trim()) return;
    if (draft.trim() !== entry.body) { const change = await run(api => api.updateEntry(entry.id, { body: draft })); if (!change) return; }
    setEditing(null);
  };
  const remove = (entry: Entry) => confirm({
    title: entry.kind === 'event' ? '删除这条变更记录？' : `删除这条${KIND_LABEL[entry.kind]}？`,
    body: '删除后无法恢复。',
    confirmLabel: '删除',
    onConfirm: () => run(api => api.deleteEntry(entry.id)),
  });
  return (
    <ol className="timeline">
      {entries.map(entry => {
        const thread = showThread && entry.threadId ? index.thread.get(entry.threadId) : undefined;
        const time = <time title={fullTime(entry.createdAt)}>{relativeTime(entry.createdAt, now)}</time>;
        if (entry.kind === 'event' && entry.event) {
          const { field, from, to } = entry.event;
          return (
            <li key={entry.id} className="entry is-event">
              <i className="knot" aria-hidden="true" />
              <div className="entry-line">
                {thread && <button className="entry-thread" onClick={() => openThread(thread.id)}>{thread.title}</button>}
                {field === 'created'
                  ? <span>创建于{eventValue(field, to)}阶段</span>
                  : field === 'parent'
                    ? <span>{to ? `移到「${to}」下` : `移出「${from ?? ''}」，成为一级策略线`}</span>
                    : <span>{EVENT_LABEL[field]} {eventValue(field, from)} <ArrowRight size={11} aria-label="改为" /> {eventValue(field, to)}</span>}
                {time}
                <button className="icon-btn icon-btn-sm entry-action" onClick={() => remove(entry)} aria-label="删除变更记录"><Trash2 size={12} /></button>
              </div>
            </li>
          );
        }
        // A record whose first line is an H1 is titled by it: the title stands beside the kind, the body starts below it.
        const { title, rest } = titleOf(entry.body);
        return (
          <li key={entry.id} className={`entry is-${entry.kind}`}>
            <i className={`knot ${entry.health ? `is-${entry.health}` : ''}`} aria-hidden="true" />
            <div className="entry-head">
              <strong>{KIND_LABEL[entry.kind]}</strong>
              {title && <><i className="entry-sep" aria-hidden="true" /><span className="entry-title" title={title}>{title}</span></>}
              {entry.health && <span className={`health-label is-${entry.health}`}>{HEALTH_LABEL[entry.health]}</span>}
              {thread && <button className="entry-thread" onClick={() => openThread(thread.id)}>{thread.title}</button>}
              {time}
              {entry.editedAt && <span className="muted" title={fullTime(entry.editedAt)}>已编辑</span>}
              <span className="entry-actions">
                <button className="icon-btn icon-btn-sm" onClick={() => { setEditing(entry.id); setDraft(entry.body); }} aria-label="编辑"><Pencil size={12} /></button>
                <button className="icon-btn icon-btn-sm" onClick={() => remove(entry)} aria-label="删除"><Trash2 size={12} /></button>
              </span>
            </div>
            {editing === entry.id
              ? (
                <div className="entry-edit">
                  <AutoTextarea
                    value={draft}
                    onChange={setDraft}
                    minRows={3}
                    autoFocus
                    aria-label="编辑记录"
                    onKeyDown={event => {
                      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(entry); }
                      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); }
                    }}
                  />
                  <div className="composer-foot">
                    <button
                      className="icon-btn entry-expand"
                      aria-label="在编辑器中编辑"
                      title="在编辑器中编辑"
                      onClick={() => { openEditor({ projectId: entry.projectId, threadId: entry.threadId, entryId: entry.id, kind: entry.kind as Writable, health: entry.health ?? 'onTrack' }, draft); setEditing(null); }}
                    >
                      <Maximize2 size={14} />
                    </button>
                    <button className="btn btn-ghost" onClick={() => setEditing(null)}>取消</button>
                    <button className="btn btn-primary" title="Ctrl+Enter" disabled={!draft.trim()} onClick={() => void save(entry)}>保存</button>
                  </div>
                </div>
              )
              : <EntryBody entry={entry} text={rest} />}
          </li>
        );
      })}
    </ol>
  );
}
