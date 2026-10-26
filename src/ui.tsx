import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject, type TextareaHTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ChevronDown, CircleCheck, Hourglass, Pause, X } from 'lucide-react';
import { desktop } from './bridge';
import { HEALTH_LABEL, ORG_COLOR, PRIORITY_LABEL, STAGE_LABEL, STATE_LABEL } from './labels';
import { STAGES, type Health, type Organization, type Priority, type Stage, type ThreadState } from './types';

/** Closes a popover when the pointer goes down outside of `ref`. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) close(); };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [ref, open, close]);
}

/** The thread itself: six knots for the six stages, inked up to the current one. */
export function StageTrack({ stage, onChange, size = 'sm' }: { stage: Stage; onChange?: (stage: Stage) => void; size?: 'sm' | 'lg' }) {
  const current = STAGES.indexOf(stage);
  const ratio = current / (STAGES.length - 1);
  const progress = `${ratio * 100}%`;
  if (!onChange) {
    return (
      <span className={`stage-track is-${size} ${stage === 'retired' ? 'is-retired' : ''}`} style={{ '--progress': progress } as CSSProperties} title={STAGE_LABEL[stage]} aria-label={`阶段：${STAGE_LABEL[stage]}`}>
        {STAGES.map((item, index) => <i key={item} className={index < current ? 'is-past' : index === current ? 'is-current' : ''} />)}
      </span>
    );
  }
  return (
    <div className={`stage-picker ${stage === 'retired' ? 'is-retired' : ''}`} role="radiogroup" aria-label="阶段" style={{ '--ratio': ratio } as CSSProperties}>
      <span className="stage-picker-line" aria-hidden="true" />
      {STAGES.map((item, index) => (
        <button
          key={item}
          type="button"
          role="radio"
          aria-checked={index === current}
          className={index < current ? 'is-past' : index === current ? 'is-current' : ''}
          onClick={() => onChange(item)}
        >
          <i aria-hidden="true" />
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

export interface Option<T extends string> { value: T; label: string; icon?: ReactNode; hint?: string }

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
export function Dialog({ title, subtitle, onClose, children, className = '', wide = false }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; className?: string; wide?: boolean;
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
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" className="icon-btn dialog-close" onClick={onClose} aria-label="关闭"><X size={15} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Markdown with GFM; links open in the system browser and HTML is not rendered. */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`markdown ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} onClick={event => { event.preventDefault(); if (href) void desktop.openUrl(href); }} title={href}>{children}</a>
          ),
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

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
