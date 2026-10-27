import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useApp } from './context';
import { DAY, KIND_LABEL, STAGE_LABEL, STATE_LABEL, addDays, daysSince, dueLabel, fullTime, gist, parseIso, shortDate, todayIso, waitedLabel } from './labels';
import { EmptyState, OrgMark, PriorityIcon, StageLabel, TreeLead, TreePath, fitText, textWidth, treeStep } from './ui';
import { ancestorsOf, isOpen, isStale, nextTodo, threadSpans, threadTree, type TreeRow } from './workspace';
import { STAGES, type Id, type IsoDate, type Millis, type Project, type Stage, type Thread } from './types';

export type LoomRange = '4w' | '12w' | '26w';
export const LOOM_RANGES: { value: LoomRange; label: string; back: number; ahead: number }[] = [
  { value: '4w', label: '4 周', back: 28, ahead: 7 },
  { value: '12w', label: '12 周', back: 84, ahead: 28 },
  { value: '26w', label: '半年', back: 182, ahead: 42 },
];

/** Later stages draw a heavier thread. */
const WEIGHT: Record<Stage, number> = { idea: 1, research: 1.5, backtest: 2.25, paper: 3, live: 3.75, retired: 1 };
const ROW = 40;
const LINE = 25;
const CAPTION = 13;
const PAD = 8;
const FALLBACK_WIDTH = 640;
/** Corner radius of the branch that joins a sub-line to its parent's thread. */
const BEND = 5;

export interface Scale { start: Millis; end: Millis; width: number; pxPerDay: number; x: (time: Millis) => number }

/** Maps the chosen range around today (whole local days) onto `width` pixels. */
export function loomScale(range: LoomRange, now: Millis, width: number): Scale {
  const { back, ahead } = LOOM_RANGES.find(item => item.value === range) ?? LOOM_RANGES[1];
  const today = todayIso(now);
  const start = parseIso(addDays(today, -back)).getTime();
  const end = parseIso(addDays(today, ahead + 1)).getTime();
  const usable = Math.max(1, width - PAD * 2);
  return { start, end, width, pxPerDay: usable / ((end - start) / DAY), x: time => PAD + ((time - start) / (end - start)) * usable };
}

export interface Tick { time: Millis; label: string }

/** Mondays when a week has room for a date label, otherwise the first of each month. */
export function loomTicks(scale: Scale): Tick[] {
  const weekly = scale.pxPerDay * 7 >= 52;
  const ticks: Tick[] = [];
  for (const date = new Date(scale.start); date.getTime() < scale.end; date.setDate(date.getDate() + 1)) {
    if (weekly ? date.getDay() !== 1 : date.getDate() !== 1) continue;
    const label = weekly ? `${date.getMonth() + 1}/${date.getDate()}`
      : date.getMonth() === 0 ? `${date.getFullYear()}年1月` : `${date.getMonth() + 1}月`;
    ticks.push({ time: date.getTime(), label });
  }
  return ticks;
}

const middayOf = (date: IsoDate) => parseIso(date).getTime() + DAY / 2;

interface Group { project: Project | undefined; threads: Thread[]; rows: TreeRow[] }
/** Where a sub-line branches off its parent's row, `rows` above it: when both lines exist, and no earlier than either. */
interface Branch { rows: number; time: Millis }

function branchOf(rows: TreeRow[], at: number): Branch | null {
  const row = rows[at];
  if (!row.depth) return null;
  for (let up = at - 1; up >= 0; up--) {
    if (rows[up].depth === row.depth - 1) return { rows: at - up, time: Math.max(row.thread.createdAt, rows[up].thread.createdAt) };
  }
  return null;
}

/**
 * Every strategy line as a thread across time: weight is the stage, dashes are waiting, dots are paused,
 * and a line that has not moved fades toward today. Knots are timeline entries; rings ahead of today are due dates.
 */
export default function ThreadLoom({ threads, scope, range, filtered, collapsed, onFold }: {
  threads: Thread[]; scope: 'all' | 'project'; range: LoomRange; filtered: boolean; collapsed: ReadonlySet<Id>; onFold: (id: Id, open?: boolean) => void;
}) {
  const { index, workspace, now: clock, selected, openThread } = useApp();
  // The shared clock ticks once a minute; read a fresh one whenever data changes so a change just made lands before today.
  const now = useMemo(() => Math.max(clock, Date.now()), [clock, workspace]);
  const stripRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    setMeasured(strip.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setMeasured(strip.clientWidth));
    observer.observe(strip);
    return () => observer.disconnect();
  }, []);
  const scale = useMemo(() => loomScale(range, now, measured || FALLBACK_WIDTH), [range, now, measured]);
  const ticks = useMemo(() => loomTicks(scale), [scale]);

  const groups = useMemo<Group[]>(() => {
    // A line closed before the visible range has nothing left to draw.
    const shown = threads.filter(thread => thread.state !== 'closed' || (thread.closedAt ?? thread.updatedAt) >= scale.start);
    const grouped = scope === 'project'
      ? (shown.length ? [{ project: index.project.get(shown[0].projectId), threads: shown }] : [])
      : index.orgs
        .flatMap(org => index.projectsOf.get(org.id) ?? [])
        .map(project => ({ project, threads: shown.filter(thread => thread.projectId === project.id) }))
        .filter(group => group.threads.length);
    return grouped.map(group => ({ ...group, rows: threadTree(group.threads, collapsed) }));
  }, [threads, scope, index, scale.start, collapsed]);
  const flat = groups.flatMap(group => group.rows);
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

  const nowX = scale.x(now);
  const headTarget = scope === 'project' ? groups[0]?.project?.targetDate ?? null : null;
  const headTargetBox = headTarget ? targetLabel(headTarget, scale, now) : null;
  // A tick label gives way to the today label and to the target label it would run into.
  const tickLabelFits = (x: number, label: string) => Math.abs(x - nowX) > 30
    && (!headTargetBox || x + 4 + textWidth(label, 11) < headTargetBox.x1 - 6 || x + 4 > headTargetBox.x2 + 6);
  return (
    <div className="loom" ref={listRef} onKeyDown={onKeyDown}>
      <div className="loom-head">
        <span className="loom-name" aria-hidden="true">策略线</span>
        <div className="loom-strip" ref={stripRef}>
          <svg width={scale.width} height={30} aria-hidden="true">
            {ticks.map(tick => {
              const x = scale.x(tick.time);
              return (
                <g key={tick.time}>
                  <line className="loom-axis-tick" x1={x} x2={x} y1={24} y2={30} />
                  {tickLabelFits(x, tick.label) && <text className="loom-axis-label" x={x + 4} y={19}>{tick.label}</text>}
                </g>
              );
            })}
            <line className="loom-today" x1={nowX} x2={nowX} y1={22} y2={30} />
            <text className="loom-today-label" x={nowX} y={18} textAnchor="middle">今天</text>
            {headTarget && <TargetMark target={headTarget} scale={scale} height={30} labelY={19} now={now} />}
          </svg>
        </div>
      </div>
      {!groups.length && (
        <EmptyState title={filtered ? '没有匹配的策略线' : '这段时间没有策略线'} />
      )}
      {groups.map(group => {
        const org = group.project && index.org.get(group.project.orgId);
        const target = group.project?.targetDate ?? null;
        return (
          <section key={group.project?.id ?? 'all'} className="loom-group" aria-label={group.project?.name ?? '策略线'}>
            {scope === 'all' && group.project && (
              <div className="loom-group-head">
                <h3 className="loom-name">
                  {org && <OrgMark org={org} />}
                  {org && <small>{org.code}</small>}
                  <span className="truncate">{group.project.name}</span>
                  <em>{group.threads.length}</em>
                </h3>
                <svg width={scale.width} height={30} aria-hidden="true">
                  <line className="loom-today" x1={nowX} x2={nowX} y1={0} y2={30} />
                  {target && <TargetMark target={target} scale={scale} height={30} labelY={19} now={now} />}
                </svg>
              </div>
            )}
            {group.rows.map((row, at) => (
              <LoomRow
                key={row.thread.id}
                row={row}
                nested={nested}
                branch={branchOf(group.rows, at)}
                scale={scale}
                ticks={ticks}
                now={now}
                target={target}
                selected={selected === row.thread.id}
                onOpen={() => openThread(row.thread.id)}
                onFold={onFold}
              />
            ))}
          </section>
        );
      })}
      {groups.length > 0 && <Legend />}
    </div>
  );
}

/** Where a target date's label goes: beside its rule, or named at the right edge when the date is beyond the range. */
function targetLabel(target: IsoDate, scale: Scale, now: Millis) {
  const time = middayOf(target);
  if (time < scale.start) return null;
  const text = `目标 ${shortDate(time, now)}`;
  const width = textWidth(text, 11);
  if (time >= scale.end) return { text, rule: null, x1: scale.width - PAD - width, x2: scale.width - PAD };
  const rule = scale.x(time);
  return rule + 5 + width <= scale.width ? { text, rule, x1: rule + 5, x2: rule + 5 + width } : { text, rule, x1: rule - 5 - width, x2: rule - 5 };
}

/** A project's target date: a dashed rule through its rows, labelled once in its header. */
function TargetMark({ target, scale, height, labelY, now }: { target: IsoDate; scale: Scale; height: number; labelY: number; now: Millis }) {
  const label = targetLabel(target, scale, now);
  if (!label) return null;
  return (
    <>
      {label.rule != null && <line className="loom-target" x1={label.rule} x2={label.rule} y1={labelY + 3} y2={height} />}
      <text className="loom-target-label" x={label.x1} y={labelY}>{label.text}</text>
    </>
  );
}

function LoomRow({ row, nested, branch, scale, ticks, now, target, selected, onOpen, onFold }: {
  row: TreeRow; nested: boolean; branch: Branch | null; scale: Scale; ticks: Tick[]; now: Millis; target: IsoDate | null;
  selected: boolean; onOpen: () => void; onFold: (id: Id) => void;
}) {
  const { thread } = row;
  const { index, workspace } = useApp();
  const entries = index.entriesOf.get(thread.id);
  const todos = index.todosOf.get(thread.id);
  const spans = useMemo(() => threadSpans(thread, entries ?? [], now), [thread, entries, now]);
  const { start, end, x } = scale;
  const within = (time: Millis) => time >= start && time < end;
  const clip = (time: Millis) => x(Math.min(end, Math.max(start, time)));
  const nowX = x(now);
  const today = todayIso(now);

  // Stage runs ignore state changes, so a label marks where a stage begins rather than every pause.
  const runs: { stage: Stage; start: Millis; end: Millis }[] = [];
  for (const span of spans) {
    if (span.state === 'closed') continue;
    const last = runs[runs.length - 1];
    if (last && last.stage === span.stage && last.end === span.start) last.end = span.end;
    else runs.push({ stage: span.stage, start: span.start, end: span.end });
  }

  const idleDays = (now - thread.lastActivityAt) / DAY;
  const fadeId = `loom-fade-${thread.id}`;
  const bandFadeId = `loom-band-fade-${thread.id}`;
  const fading = thread.state === 'active' && idleDays >= 1;
  const fadeTo = 1 - .85 * Math.min(1, idleDays / workspace.settings.staleDays);
  const lastSpan = spans[spans.length - 1];
  const drawn = spans.filter(span => span.state !== 'closed' && span.end > start && span.start < end);
  const isFaded = (span: typeof lastSpan) => fading && span === lastSpan && span.state === 'active';

  const open = (todos ?? []).filter(todo => !todo.done && todo.due);
  const aheadX = isOpen(thread)
    ? Math.max(nowX, ...open.map(todo => middayOf(todo.due!)).filter(time => time < end).map(x))
    : nowX;

  const next = nextTodo(index, thread.id);
  const openKids = (index.childrenOf.get(thread.id) ?? []).filter(isOpen).length;
  const note: { text: string; warn?: boolean; spoken?: string } | null =
    thread.state === 'waiting' ? { text: thread.waitingSince ? `${waitedLabel(thread.waitingSince, now)}${thread.waitingOn ? `：${thread.waitingOn}` : ''}` : `等${thread.waitingOn || '外部条件'}` }
    : thread.state === 'paused' ? { text: '已搁置' }
    : thread.state === 'closed' ? null
    : isStale(thread, workspace.settings, now) ? { text: `${daysSince(thread.lastActivityAt, now)} 天未推进`, warn: true }
    : !next && openKids ? { text: `${openKids} 条子线在推进` }
    : !next ? { text: '缺少下一步', warn: true }
    : { text: next.text, spoken: `下一步：${next.text}` };
  const noteX = nowX + 8;
  const noteText = note ? fitText(note.text, scale.width - PAD - noteX, 11) : '';
  const path = thread.parentId ? ancestorsOf(index, thread) : [];
  const label = [
    thread.title, path.length ? `${path[path.length - 1].title} 的子策略线` : '', row.hidden ? `收起了 ${row.hidden} 条子策略线` : '',
    STAGE_LABEL[thread.stage], STATE_LABEL[thread.state], note?.spoken ?? note?.text,
  ].filter(Boolean).join('，');
  // The branch leaves the parent's thread a little before the split, drops, and bends into the start of this line.
  const branchX = branch && within(branch.time) && branch.time < now ? x(branch.time) : null;
  const branchTop = branch ? LINE - branch.rows * ROW : 0;

  return (
    <button
      data-thread={thread.id}
      className={`loom-row is-${thread.state} ${selected ? 'is-selected' : ''}`}
      onClick={onOpen}
      aria-label={label}
      aria-expanded={row.children ? !row.hidden : undefined}
    >
      <span className="loom-name">
        <PriorityIcon priority={thread.priority} />
        {nested && <TreeLead row={row} onFold={onFold} />}
        {row.detached && <TreePath path={path} />}
        <span className="truncate">{thread.title}</span>
        {row.hidden > 0 && <em className="tree-hidden">+{row.hidden}</em>}
      </span>
      <svg width={scale.width} height={ROW} aria-hidden="true">
        {fading && (
          <defs>
            <linearGradient id={fadeId} className="loom-fade" gradientUnits="userSpaceOnUse" x1={x(thread.lastActivityAt)} x2={nowX} y1={0} y2={0}>
              <stop offset={0} stopOpacity={1} />
              <stop offset={1} stopOpacity={fadeTo} />
            </linearGradient>
            <linearGradient id={bandFadeId} className={`loom-band-fade stage-${lastSpan.stage}`} gradientUnits="userSpaceOnUse" x1={x(thread.lastActivityAt)} x2={nowX} y1={0} y2={0}>
              <stop offset={0} stopOpacity={1} />
              <stop offset={1} stopOpacity={fadeTo} />
            </linearGradient>
          </defs>
        )}
        {ticks.map(tick => <line key={tick.time} className="loom-grid" x1={x(tick.time)} x2={x(tick.time)} y1={0} y2={ROW} />)}
        {target && within(middayOf(target)) && <line className="loom-target" x1={x(middayOf(target))} x2={x(middayOf(target))} y1={0} y2={ROW} />}
        <line className="loom-today" x1={nowX} x2={nowX} y1={0} y2={ROW} />

        {branchX != null && (
          <path
            className="loom-branch"
            d={`M${branchX - 2 * BEND} ${branchTop}Q${branchX - BEND} ${branchTop} ${branchX - BEND} ${branchTop + BEND}V${LINE - BEND}Q${branchX - BEND} ${LINE} ${branchX} ${LINE}`}
          />
        )}
        {aheadX > nowX && <line className="loom-ahead" x1={nowX} x2={aheadX} y1={LINE} y2={LINE} />}
        {drawn.map(span => (
          <rect
            key={span.start}
            className={`loom-band stage-${span.stage} is-${span.state}`}
            x={clip(span.start)}
            y={LINE - 4.5}
            width={clip(span.end) - clip(span.start)}
            height={9}
            style={isFaded(span) ? { fill: `url(#${bandFadeId})` } : undefined}
          />
        ))}
        {drawn.map(span => {
          const weight = span.state === 'paused' ? Math.max(2, WEIGHT[span.stage]) : WEIGHT[span.stage];
          const faded = isFaded(span);
          return (
            <line
              key={span.start}
              className={`loom-span is-${span.state}`}
              x1={clip(span.start)}
              x2={clip(span.end)}
              y1={LINE}
              y2={LINE}
              strokeWidth={weight}
              strokeDasharray={span.state === 'paused' ? `0 ${weight + 3}` : undefined}
              style={faded ? { stroke: `url(#${fadeId})` } : undefined}
            />
          );
        })}

        {runs.map((run, at) => {
          const x1 = clip(run.start);
          const x2 = clip(run.end);
          const text = STAGE_LABEL[run.stage];
          const changed = at > 0 && runs[at - 1].end === run.start && within(run.start);
          return (
            <g key={run.start}>
              {changed && (
                <line className="loom-stage-tick" x1={x1} x2={x1} y1={LINE - 6} y2={LINE + 6}>
                  <title>{`进入${text}阶段，${fullTime(run.start)}`}</title>
                </line>
              )}
              {x2 - x1 >= textWidth(text, 10.5) + 8 && <text className="loom-stage" x={x1 + 3} y={CAPTION}>{text}</text>}
            </g>
          );
        })}

        {within(thread.createdAt) && branchX == null && (
          <circle className="loom-start" cx={x(thread.createdAt)} cy={LINE} r={2}>
            <title>{`创建于 ${fullTime(thread.createdAt)}`}</title>
          </circle>
        )}
        {spans.filter(span => span.state === 'closed' && within(span.start)).map(span => (
          <line key={span.start} className="loom-end" x1={x(span.start)} x2={x(span.start)} y1={LINE - 5} y2={LINE + 5}>
            <title>{`结束于 ${fullTime(span.start)}`}</title>
          </line>
        ))}
        {(todos ?? []).filter(todo => todo.done && todo.doneAt && within(todo.doneAt)).map(todo => (
          <line key={todo.id} className="loom-done" x1={x(todo.doneAt!)} x2={x(todo.doneAt!)} y1={LINE + 4} y2={LINE + 9}>
            <title>{`完成：${todo.text}，${fullTime(todo.doneAt!)}`}</title>
          </line>
        ))}
        {(entries ?? []).filter(entry => entry.kind !== 'event' && entry.kind !== 'update' && within(entry.createdAt)).map(entry => {
          const cx = x(entry.createdAt);
          const tip = <title>{`${KIND_LABEL[entry.kind]}，${fullTime(entry.createdAt)}\n${gist(entry.body).slice(0, 80)}`}</title>;
          return entry.kind === 'decision'
            ? <rect key={entry.id} className="loom-mark is-decision" x={cx - 3.2} y={LINE - 3.2} width={6.4} height={6.4} transform={`rotate(45 ${cx} ${LINE})`}>{tip}</rect>
            : <circle key={entry.id} className={`loom-mark is-${entry.kind}`} cx={cx} cy={LINE} r={entry.kind === 'result' ? 4 : 3.5}>{tip}</circle>;
        })}
        {open.filter(todo => within(middayOf(todo.due!))).map(todo => (
          <circle
            key={todo.id}
            className={`loom-due ${todo.due! < today ? 'is-overdue' : todo.due === today ? 'is-today' : ''}`}
            cx={x(middayOf(todo.due!))}
            cy={LINE}
            r={3.5}
          >
            <title>{`${todo.text}，${dueLabel(todo.due!, now)}`}</title>
          </circle>
        ))}

        {noteText && <text className={`loom-note ${note?.warn ? 'is-warn' : ''}`} x={noteX} y={CAPTION}>{noteText}</text>}
      </svg>
    </button>
  );
}

function Legend() {
  const line = (state: Thread['state'], dash?: string) => (
    <svg width={26} height={10} aria-hidden="true"><line className={`loom-span is-${state}`} x1={1} x2={25} y1={5} y2={5} strokeWidth={2} strokeDasharray={dash} /></svg>
  );
  const mark = (child: ReactNode) => <svg width={12} height={12} aria-hidden="true">{child}</svg>;
  return (
    <footer className="loom-legend" aria-label="图例">
      <span>{line('active')}进行中</span>
      <span>{line('waiting')}等待</span>
      <span>{line('paused', '0 5')}搁置</span>
      <span>
        <svg width={26} height={10} aria-hidden="true">
          <defs><linearGradient id="loom-legend-fade" className="loom-fade"><stop offset={0} stopOpacity={1} /><stop offset={1} stopOpacity={.15} /></linearGradient></defs>
          <rect x={1} y={4} width={24} height={2} fill="url(#loom-legend-fade)" />
        </svg>
        久未推进
      </span>
      <span className="loom-legend-stages">{STAGES.map(stage => <StageLabel key={stage} stage={stage} />)}</span>
      <span>{mark(<line className="loom-stage-tick" x1={6} x2={6} y1={0} y2={12} />)}换阶段</span>
      <span>
        <svg width={24} height={14} aria-hidden="true">
          <line className="loom-span is-active" x1={0} x2={24} y1={2} y2={2} strokeWidth={1.5} />
          <path className="loom-branch" d={`M2 2Q${2 + BEND} 2 ${2 + BEND} ${2 + BEND}V${12 - BEND}Q${2 + BEND} 12 ${2 + 2 * BEND} 12`} />
          <line className="loom-span is-active" x1={2 + 2 * BEND} x2={24} y1={12} y2={12} strokeWidth={1.5} />
        </svg>
        子策略线
      </span>
      <span>{mark(<circle className="loom-mark is-note" cx={6} cy={6} r={3.5} />)}笔记</span>
      <span>{mark(<rect className="loom-mark is-decision" x={2.8} y={2.8} width={6.4} height={6.4} transform="rotate(45 6 6)" />)}决策</span>
      <span>{mark(<circle className="loom-mark is-result" cx={6} cy={6} r={4} />)}结果</span>
      <span>{mark(<line className="loom-done" x1={6} x2={6} y1={3} y2={9} />)}完成待办</span>
      <span>{mark(<circle className="loom-due" cx={6} cy={6} r={3.5} />)}待办截止日</span>
    </footer>
  );
}
