import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ChevronDown, ChevronRight, CircleCheck, Hourglass, ImageOff, Pause, X } from 'lucide-react';
import { desktop } from './bridge';
import { useApp } from './context';
import { ATTACHMENT, imageUrl } from './images';
import { HEALTH_LABEL, ORG_COLOR, PRIORITY_LABEL, STAGE_LABEL, STATE_LABEL } from './labels';
import type { TreeRow } from './workspace';
import { STAGES, type Health, type Id, type Organization, type Priority, type Stage, type Thread, type ThreadState } from './types';

/** Closes a popover when the pointer goes down outside of `ref`. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) close(); };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [ref, open, close]);
}

/** Pie wedges for the stage icon: each stage fills one more sixth, so retired is a full disc. */
const STAGE_PIE = Object.fromEntries(STAGES.map((stage, index) => {
  const fraction = (index + 1) / STAGES.length;
  if (fraction >= 1) return [stage, null];
  const angle = fraction * 2 * Math.PI;
  const x = (8 + 7 * Math.sin(angle)).toFixed(2);
  const y = (8 - 7 * Math.cos(angle)).toFixed(2);
  return [stage, `M8 8V1A7 7 0 ${fraction > .5 ? 1 : 0} 1 ${x} ${y}Z`];
})) as Record<Stage, string | null>;

/** A stage at a glance: a pale disc in the stage colour with a deep wedge, one sixth larger for each step along the pipeline. */
export function StageIcon({ stage, size = 14 }: { stage: Stage; size?: number }) {
  const pie = STAGE_PIE[stage];
  return (
    <svg className={`stage-icon stage-${stage}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle className="stage-icon-disc" cx={8} cy={8} r={7} />
      {pie ? <path className="stage-icon-pie" d={pie} /> : <circle className="stage-icon-pie" cx={8} cy={8} r={7} />}
    </svg>
  );
}

/** The stage icon followed by its name in the stage colour. */
export const StageLabel = ({ stage }: { stage: Stage }) => <span className={`stage-label stage-${stage}`}><StageIcon stage={stage} />{STAGE_LABEL[stage]}</span>;

/** The thread itself as a control: six knots for the six stages, inked up to the current one. */
export function StagePicker({ stage, onChange }: { stage: Stage; onChange: (stage: Stage) => void }) {
  const current = STAGES.indexOf(stage);
  return (
    <div className="stage-picker" role="radiogroup" aria-label="阶段" style={{ '--ratio': current / (STAGES.length - 1) } as CSSProperties}>
      <span className="stage-picker-line" aria-hidden="true" />
      {STAGES.map((item, index) => (
        <button
          key={item}
          type="button"
          role="radio"
          aria-checked={index === current}
          className={`stage-${item} ${index < current ? 'is-past' : index === current ? 'is-current' : ''}`}
          onClick={() => onChange(item)}
        >
          <i aria-hidden="true">{index === current && <StageIcon stage={item} size={20} />}</i>
          <span>{STAGE_LABEL[item]}</span>
        </button>
      ))}
    </div>
  );
}

export function PriorityIcon({ priority, size = 14 }: { priority: Priority; size?: number }) {
  const label = `优先级：${PRIORITY_LABEL[priority]}`;
  if (priority === 'urgent') {
    return (
      <svg className="priority-icon is-urgent" width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label}>
        <title>{label}</title>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
        <path d="M7 3.8v4M7 9.6v.6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  const level = priority === 'high' ? 3 : priority === 'normal' ? 2 : 1;
  return (
    <svg className="priority-icon" width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={label}>
      <title>{label}</title>
      {[0, 1, 2].map(bar => (
        <rect key={bar} x={1.5 + bar * 4} y={10 - bar * 3} width="3" height={3 + bar * 3} rx="1" fill="currentColor" opacity={bar < level ? 1 : 0.22} />
      ))}
    </svg>
  );
}

export function StateIcon({ state, size = 13 }: { state: ThreadState; size?: number }) {
  if (state === 'waiting') return <Hourglass size={size} className="state-icon is-waiting" aria-hidden="true" />;
  if (state === 'paused') return <Pause size={size} className="state-icon" aria-hidden="true" />;
  if (state === 'closed') return <CircleCheck size={size} className="state-icon" aria-hidden="true" />;
  return <span className="state-dot" aria-hidden="true" />;
}
export const StateLabel = ({ state }: { state: ThreadState }) => <span className={`state-label is-${state}`}><StateIcon state={state} />{STATE_LABEL[state]}</span>;

/** Pass `decorative` when the health is already spelled out next to the dot. */
export const HealthDot = ({ health, decorative = false }: { health: Health; decorative?: boolean }) => decorative
  ? <span className={`health-dot is-${health}`} aria-hidden="true" />
  : <span className={`health-dot is-${health}`} title={HEALTH_LABEL[health]} aria-label={`健康度：${HEALTH_LABEL[health]}`} role="img" />;
export const OrgMark = ({ org }: { org: Pick<Organization, 'color' | 'name'> }) => <span className="org-mark" style={{ background: ORG_COLOR[org.color] }} aria-hidden="true" />;

export interface Option<T extends string> { value: T; label: string; icon?: ReactNode; hint?: string; /** Indents the option, for picking from a tree. */ depth?: number }

/** A compact dropdown: a ghost button that opens a keyboard-navigable option list. */
export function Dropdown<T extends string>({ value, options, onChange, label, className = '', children, align = 'left' }: {
  value: T; options: Option<T>[]; onChange: (value: T) => void; label: string; className?: string; children?: ReactNode; align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => setOpen(false);
  useDismiss(wrap, open, close);
  const current = options.find(option => option.value === value);
  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex(option => option.value === value)));
    list.current?.focus();
    // Only when opening: re-running on every value change would steal focus back into the list.
  }, [open]);
  const choose = (option: Option<T>) => { setOpen(false); if (option.value !== value) onChange(option.value); };
  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => (index + 1) % options.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => (index - 1 + options.length) % options.length); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(options[active]); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    else if (event.key === 'Tab') setOpen(false);
  };
  return (
    <div className={`dropdown ${className}`} ref={wrap}>
      <button type="button" className={`dropdown-trigger ${open ? 'is-open' : ''}`} aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}：${current?.label ?? ''}`} title={label} onClick={() => setOpen(!open)}>
        {children ?? <>{current?.icon}<span>{current?.label}</span></>}
        <ChevronDown size={12} className="dropdown-chevron" />
      </button>
      {open && (
        <div className={`menu dropdown-menu is-${align}`} role="listbox" id={id} aria-label={label} tabIndex={-1} ref={list} onKeyDown={onKey} aria-activedescendant={`${id}-${active}`}>
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${id}-${index}`}
              role="option"
              aria-selected={option.value === value}
              className={`menu-item ${index === active ? 'is-active' : ''}`}
              style={option.depth ? { paddingLeft: 8 + option.depth * 14 } : undefined}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(option)}
            >
              {option.icon}
              <span className="menu-label">{option.label}</span>
              {option.hint && <span className="menu-hint">{option.hint}</span>}
              {option.value === value && <Check size={13} className="menu-check" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Option<T>[]; onChange: (value: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value} className={option.value === value ? 'is-selected' : ''} onClick={() => option.value !== value && onChange(option.value)}>
          {option.icon}{option.label}
        </button>
      ))}
    </div>
  );
}

/** Modal frame with Escape to close and focus kept inside. */
export function Dialog({ title, onClose, children, className = '', wide = false }: {
  title: string; onClose: () => void; children: ReactNode; className?: string; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select, button:not(.dialog-close)');
    first?.focus();
    return () => previous?.focus?.();
  }, []);
  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select, [tabindex="0"]')];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return (
    <div className="backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`dialog ${wide ? 'is-wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} onKeyDown={onKey}>
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn dialog-close" onClick={onClose} aria-label="关闭"><X size={15} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** An image in rendered Markdown: saved images load through the backend, and a click shows it full size. */
function MarkdownImage({ src = '', alt = '' }: { src?: string; alt?: string }) {
  const { api } = useApp();
  const [url, setUrl] = useState<string | null>(src.startsWith(ATTACHMENT) ? null : src);
  const [broken, setBroken] = useState(false);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    let live = true;
    setBroken(false);
    imageUrl(api, src).then(next => { if (live) setUrl(next); }, () => { if (live) setBroken(true); });
    return () => { live = false; };
  }, [api, src]);
  useEffect(() => {
    if (!zoom) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setZoom(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [zoom]);
  if (broken) return <span className="md-image-broken" title={src}><ImageOff size={13} />{alt || '图片无法显示'}</span>;
  return (
    <>
      <img className="md-image" src={url ?? undefined} alt={alt} title={alt || undefined} onClick={() => setZoom(true)} />
      {zoom && url && createPortal(
        <div className="lightbox" role="dialog" aria-label={alt || '图片'} onClick={() => setZoom(false)}><img src={url} alt={alt} /></div>,
        document.body,
      )}
    </>
  );
}

/** Lets saved-image references through; everything else gets react-markdown's safe-URL check. */
const urlTransform = (url: string) => url.startsWith(ATTACHMENT) ? url : defaultUrlTransform(url);

/** Markdown with GFM; links open in the system browser, images can be saved ones, and HTML is not rendered. */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`markdown ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={urlTransform}
        components={{
          a: ({ href, children }) => (
            <a href={href} onClick={event => { event.preventDefault(); if (href) void desktop.openUrl(href); }} title={href}>{children}</a>
          ),
          img: ({ src, alt }) => <MarkdownImage src={typeof src === 'string' ? src : ''} alt={alt} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Textarea that grows with its content. */
export function AutoTextarea({ value, onChange, minRows = 1, className = '', ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'> & {
  value: string; onChange: (value: string) => void; minRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);
  return <textarea ref={ref} rows={minRows} className={`auto-textarea ${className}`} value={value} onChange={event => onChange(event.target.value)} {...rest} />;
}

/** Text that turns into an input on click and commits on Enter or blur. */
export function InlineEdit({ value, onCommit, placeholder, className = '', multiline = false, label, maxLength }: {
  value: string; onCommit: (value: string) => void; placeholder?: string; className?: string; multiline?: boolean; label: string; maxLength?: number;
}) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(value); }, [value]);
  const commit = () => {
    editing.current = false;
    if (cancelled.current) { cancelled.current = false; setDraft(value); return; }
    const next = draft.trim();
    if (!next) { setDraft(value); return; }
    if (next !== value) onCommit(next);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); (event.target as HTMLTextAreaElement).blur(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; (event.target as HTMLTextAreaElement).blur(); }
  };
  return (
    <AutoTextarea
      className={`inline-edit ${className}`}
      value={draft}
      aria-label={label}
      placeholder={placeholder}
      maxLength={maxLength}
      onFocus={() => { editing.current = true; }}
      onChange={next => setDraft(multiline ? next : next.replace(/\n/g, ' '))}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  );
}

/** Rough rendered width of SVG text, which cannot ellipsize itself: CJK glyphs are about one em, Latin about half. */
export const textWidth = (text: string, size = 12) => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? size : size * .55), 0);

/** Shortens text with an ellipsis until its estimated width fits `max`. */
export function fitText(text: string, max: number, size = 12) {
  if (textWidth(text, size) <= max) return text;
  const chars = [...text];
  while (chars.length && textWidth(`${chars.join('')}…`, size) > max) chars.pop();
  return chars.length ? `${chars.join('')}…` : '';
}

const COLLAPSED_KEY = 'threading.collapsed.v1';

/** Which lines have their sub-lines folded away, remembered per viewer and shared by every tree view. */
export function useCollapsed() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<Id>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]') as Id[]); } catch { return new Set(); }
  });
  /** Folds or unfolds a line; without `open` it flips. */
  const fold = useCallback((id: Id, open?: boolean) => setCollapsed(current => {
    const next = new Set(current);
    if (open ?? next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* per-viewer convenience only */ }
    return next;
  }), []);
  return [collapsed, fold] as const;
}

/**
 * Arrow keys over a tree of rows: up and down move between rows, left folds a line or climbs to its parent,
 * right unfolds a line or steps into its first sub-line.
 */
export function treeStep(rows: TreeRow[], selected: Id | null, key: string): { select?: Id; fold?: [Id, boolean] } | null {
  const at = rows.findIndex(row => row.thread.id === selected);
  const row = rows[at];
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const next = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (key === 'ArrowDown' ? 1 : -1)))];
    return next ? { select: next.thread.id } : null;
  }
  if (!row || (key !== 'ArrowLeft' && key !== 'ArrowRight')) return null;
  if (key === 'ArrowRight') {
    if (!row.children) return null;
    return row.hidden ? { fold: [row.thread.id, true] } : { select: rows[at + 1].thread.id };
  }
  if (row.children && !row.hidden) return { fold: [row.thread.id, false] };
  for (let up = at - 1; up >= 0 && row.depth > 0; up--) if (rows[up].depth === row.depth - 1) return { select: rows[up].thread.id };
  return null;
}

/**
 * In front of a nested line's title: a rail where an ancestor carries on below, the branch into this line,
 * then its fold toggle or, for a line without sub-lines, a knot. Without `onFold` the tree is drawn but cannot fold.
 */
export function TreeLead({ row, onFold }: { row: TreeRow; onFold?: (id: Id) => void }) {
  return (
    <span className="tree-lead" aria-hidden="true">
      {row.rails.map((rail, at) => <i key={at} className={rail ? 'is-rail' : undefined} />)}
      {row.depth > 0 && <i className={row.last ? 'is-last' : 'is-branch'} />}
      {!onFold ? null : row.children > 0
        ? (
          <span className={`tree-toggle is-fold ${row.hidden ? '' : 'is-open'}`} title={row.hidden ? '展开子策略线' : '收起子策略线'} onClick={event => { event.stopPropagation(); onFold(row.thread.id); }}>
            <ChevronRight size={12} />
          </span>
        )
        : <span className={`tree-toggle ${row.depth ? 'is-leaf' : ''}`} />}
    </span>
  );
}

/** For a sub-line shown away from its parent: the nearest lines above it, so the hierarchy still reads. */
export function TreePath({ path }: { path: Thread[] }) {
  if (!path.length) return null;
  const shown = path.slice(-2).map(thread => thread.title);
  return (
    <span className="tree-path" title={path.map(thread => thread.title).join(' / ')}>
      <span className="truncate">{path.length > 2 ? '… / ' : ''}{shown.join(' / ')}</span>
      <span className="crumb-sep">/</span>
    </span>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
