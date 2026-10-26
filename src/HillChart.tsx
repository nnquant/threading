import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useApp } from './context';
import { STAGE_LABEL } from './labels';
import { EmptyState } from './ui';
import type { Id, Thread } from './types';

const W = 760;
const H = 280;
const LEFT = 36;
const RIGHT = W - 36;
const BASE = 214;
const PEAK = 64;
const xAt = (hill: number) => LEFT + (RIGHT - LEFT) * (hill / 100);
const yAt = (hill: number) => BASE - (BASE - PEAK) * (1 - Math.cos(2 * Math.PI * (hill / 100))) / 2;
const CURVE = Array.from({ length: 81 }, (_, i) => `${i ? 'L' : 'M'}${xAt(i * 1.25).toFixed(1)} ${yAt(i * 1.25).toFixed(1)}`).join(' ');
/** Rough rendered width of a label: CJK glyphs are about one em, Latin about half. */
const labelWidth = (text: string) => [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? 12 : 6.6), 0) + 6;

/** Shape Up hill chart: each open thread is a dot; drag it along the hill to say how much is still unknown. */
export default function HillChart({ threads }: { threads: Thread[] }) {
  const { run, openThread, selected } = useApp();
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ id: Id; hill: number; moved: boolean; startX: number } | null>(null);
  const open = threads.filter(thread => thread.state !== 'closed');
  if (!open.length) return <EmptyState title="没有进行中的策略线">新建或恢复一条策略线后，它会出现在山丘上。</EmptyState>;

  const toHill = (event: ReactPointerEvent) => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return 0;
    const x = (event.clientX - matrix.e) / matrix.a;
    return Math.round(Math.min(100, Math.max(0, ((x - LEFT) / (RIGHT - LEFT)) * 100)));
  };
  const start = (event: ReactPointerEvent, thread: Thread) => {
    if (event.button !== 0) return;
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    setDrag({ id: thread.id, hill: thread.hill, moved: false, startX: event.clientX });
  };
  const move = (event: ReactPointerEvent) => {
    if (!drag) return;
    if (!drag.moved && Math.abs(event.clientX - drag.startX) < 3) return;
    setDrag({ ...drag, hill: toHill(event), moved: true });
  };
  const end = (thread: Thread) => {
    if (!drag) return;
    const { hill, moved } = drag;
    setDrag(null);
    if (!moved) openThread(thread.id);
    else if (hill !== thread.hill) void run(api => api.updateThread(thread.id, { hill }));
  };

  // Lay labels out left to right, lifting a label until it no longer overlaps the ones already placed.
  const placed: { x1: number; x2: number; y: number }[] = [];
  const dots = open
    .map(thread => ({ thread, hill: drag?.id === thread.id ? drag.hill : thread.hill }))
    .sort((a, b) => a.hill - b.hill)
    .map(({ thread, hill }) => {
      const x = xAt(hill);
      const y = yAt(hill);
      const width = labelWidth(thread.title);
      const right = x + 10 + width <= W - 4;
      const x1 = right ? x + 10 : x - 10 - width;
      let ly = y - 12;
      for (let tries = 0; tries < 6 && placed.some(box => box.x1 < x1 + width && x1 < box.x2 && Math.abs(box.y - ly) < 15); tries++) ly -= 16;
      placed.push({ x1, x2: x1 + width, y: ly });
      return { thread, hill, x, y, lx: right ? x + 10 : x - 10, ly, anchor: right ? 'start' : 'end' } as const;
    });

  return (
    <div className="hill-chart">
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="山丘图">
        <line className="hill-mid" x1={xAt(50)} x2={xAt(50)} y1={PEAK - 18} y2={BASE} />
        <line className="hill-base" x1={LEFT - 12} x2={RIGHT + 12} y1={BASE} y2={BASE} />
        <path className="hill-curve" d={CURVE} />
        <text className="hill-caption" x={xAt(25)} y={BASE + 30} textAnchor="middle">摸索中</text>
        <text className="hill-caption" x={xAt(75)} y={BASE + 30} textAnchor="middle">推进中</text>
        <text className="hill-note" x={xAt(25)} y={BASE + 48} textAnchor="middle">还有没想清楚的问题</text>
        <text className="hill-note" x={xAt(75)} y={BASE + 48} textAnchor="middle">方法已确定，只剩执行</text>
        {dots.map(({ thread, hill, x, y, lx, ly, anchor }) => (
          <g
            key={thread.id}
            className={`hill-dot is-${thread.state} ${selected === thread.id ? 'is-selected' : ''} ${drag?.id === thread.id ? 'is-dragging' : ''}`}
            onPointerDown={event => start(event, thread)}
            onPointerMove={move}
            onPointerUp={() => end(thread)}
            onPointerCancel={() => setDrag(null)}
            tabIndex={0}
            role="slider"
            aria-label={`${thread.title}，${STAGE_LABEL[thread.stage]}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={hill}
            onKeyDown={event => {
              const step = event.shiftKey ? 10 : 2;
              const next = event.key === 'ArrowRight' ? hill + step : event.key === 'ArrowLeft' ? hill - step : null;
              if (event.key === 'Enter') openThread(thread.id);
              if (next == null) return;
              event.preventDefault();
              void run(api => api.updateThread(thread.id, { hill: Math.min(100, Math.max(0, next)) }));
            }}
          >
            {Math.abs(ly - (y - 12)) > 1 && <line className="hill-leader" x1={x} y1={y - 6} x2={x} y2={ly + 4} />}
            <circle cx={x} cy={y} r={14} className="hill-hit" />
            <circle cx={x} cy={y} r={5.5} className="hill-knot" />
            <text x={lx} y={ly} textAnchor={anchor}>{thread.title}</text>
          </g>
        ))}
      </svg>
      <p className="hint hill-hint">拖动圆点更新位置，点击打开策略线。空心圆点表示等待或搁置中的线。</p>
    </div>
  );
}
