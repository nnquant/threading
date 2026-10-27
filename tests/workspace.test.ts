import { describe, expect, it } from 'vitest';
import { dayDiff, daysSince, dueLabel, targetLabel, todayIso } from '../src/labels';
import { seedWorkspace } from '../src/demo';
import { loomScale, loomTicks } from '../src/ThreadLoom';
import { ancestorsOf, applyChange, buildIndex, compareThreads, descendantsOf, focusOf, matchesThread, reviewQueue, threadSpans, threadTree } from '../src/workspace';
import type { Workspace } from '../src/types';

// A Monday morning, so weekday labels are stable.
const NOW = new Date(2026, 9, 26, 10, 0).getTime();
const titled = (workspace: Workspace, title: string) => workspace.threads.find(thread => thread.title === title)!;

describe('applyChange', () => {
  it('replaces returned rows, appends new ones and drops deleted ones', () => {
    const workspace = seedWorkspace(NOW);
    const thread = titled(workspace, '基差动量');
    const todo = workspace.todos[0];
    const next = applyChange(workspace, {
      threads: [{ ...thread, stage: 'backtest' }],
      todos: [{ ...todo, id: 'new-todo', text: '新的下一步' }],
      deleted: [{ kind: 'todo', id: todo.id }],
      settings: { staleDays: 3, wipLimit: 0 },
    });
    expect(titled(next, '基差动量').stage).toBe('backtest');
    expect(next.threads).toHaveLength(workspace.threads.length);
    expect(next.todos.some(row => row.id === todo.id)).toBe(false);
    expect(next.todos.some(row => row.id === 'new-todo')).toBe(true);
    expect(next.settings).toEqual({ staleDays: 3, wipLimit: 0 });
    expect(workspace.todos.some(row => row.id === todo.id)).toBe(true);
  });

  it('returns the same arrays when a change does not touch them', () => {
    const workspace = seedWorkspace(NOW);
    const next = applyChange(workspace, { settings: workspace.settings });
    expect(next.threads).toBe(workspace.threads);
    expect(next.entries).toBe(workspace.entries);
  });
});

describe('focus', () => {
  const workspace = seedWorkspace(NOW);
  const index = buildIndex(workspace);
  const focus = focusOf(workspace, index, NOW);

  it('lists next steps due within a week, overdue first, then by priority', () => {
    expect(focus.due.map(item => item.todo.text)).toEqual([
      '补 2015–2017 年样本外回测', '排查 10 月超额回撤的原因', '去掉涨跌停样本后重算 IC', '跑按持仓量换月的对照组', '加入资金面指标',
      '和现有模型做正交化', '核对模拟盘与回测的成交差异', '补焦煤、焦炭的展期数据', '给客户写月度归因说明', '确定对冲预算上限',
    ]);
  });

  it('finds waiting, stale and next-step-less lines, longest waiting first', () => {
    expect(focus.waiting.map(thread => thread.title)).toEqual(['50ETF 波动率曲面套利', '能化板块', '风格中性约束']);
    expect(focus.stale.map(thread => thread.title)).toEqual(['基差动量', '高频量价因子']);
    expect(focus.noNext.map(thread => thread.title)).toEqual(['基差动量']);
    expect(focus.activeCount).toBe(10);
  });

  it('does not ask a line for a next step while one of its sub-lines is open', () => {
    const term = titled(workspace, '期限结构因子');
    const cleared = applyChange(workspace, { deleted: workspace.todos.filter(todo => todo.threadId === term.id).map(todo => ({ kind: 'todo' as const, id: todo.id })) });
    expect(focusOf(cleared, buildIndex(cleared), NOW).noNext.map(thread => thread.title)).toEqual(['基差动量']);
    const finished = applyChange(cleared, { threads: workspace.threads.filter(thread => thread.parentId === term.id).map(thread => ({ ...thread, state: 'closed' as const })) });
    expect(focusOf(finished, buildIndex(finished), NOW).noNext.map(thread => thread.title)).toEqual(['期限结构因子', '基差动量']);
  });

  it('flags at-risk projects in sidebar order and leaves paused projects out of today', () => {
    expect(focus.risky.map(project => project.name)).toEqual(['期权波动率', '中证 1000 指数增强']);
    const paused = titled(workspace, '双低策略改进');
    const all = [...focus.waiting, ...focus.stale, ...focus.noNext, ...focus.due.map(item => item.thread)];
    expect(all).not.toContain(paused);
  });

  it('drops threads of archived organizations from every list', () => {
    const bay = workspace.organizations.find(org => org.name === '澜湾资产')!;
    const archived = applyChange(workspace, { organizations: [{ ...bay, archived: true }] });
    const next = focusOf(archived, buildIndex(archived), NOW);
    expect(next.waiting.map(thread => thread.title)).toEqual(['50ETF 波动率曲面套利', '能化板块']);
    expect(next.risky.map(project => project.name)).toEqual(['期权波动率']);
  });
});

describe('weekly review queue', () => {
  it('includes open lines not reviewed in the last six days, never-reviewed first', () => {
    const workspace = seedWorkspace(NOW);
    const index = buildIndex(workspace);
    expect(reviewQueue(workspace, index, NOW)).toHaveLength(13);
    const reviewed = applyChange(workspace, {
      threads: [
        { ...titled(workspace, '基差动量'), reviewedAt: NOW - 86_400_000 },
        { ...titled(workspace, '尾部对冲'), reviewedAt: NOW - 8 * 86_400_000 },
      ],
    });
    const queue = reviewQueue(reviewed, buildIndex(reviewed), NOW).map(thread => thread.title);
    expect(queue).toHaveLength(12);
    expect(queue).not.toContain('基差动量');
    expect(queue[queue.length - 1]).toBe('尾部对冲');
  });
});

describe('sub-lines', () => {
  const workspace = seedWorkspace(NOW);
  const index = buildIndex(workspace);
  const cta = workspace.projects.find(project => project.name === '商品 CTA 多因子')!;
  const lines = [...index.threadsOf.get(cta.id)!].sort(compareThreads);
  const draw = (rows: ReturnType<typeof threadTree>) => rows.map(row => `${'  '.repeat(row.depth)}${row.thread.title}`);

  it('walks up and down the hierarchy', () => {
    expect(ancestorsOf(index, titled(workspace, '换月规则对比')).map(thread => thread.title)).toEqual(['期限结构因子', '黑色板块']);
    expect(descendantsOf(index, titled(workspace, '期限结构因子').id).map(thread => thread.title)).toEqual(['黑色板块', '换月规则对比', '能化板块']);
    expect(matchesThread(index, titled(workspace, '换月规则对比'), '期限结构')).toBe(true);
  });

  it('lays a project out as a tree in display order', () => {
    const rows = threadTree(lines);
    expect(draw(rows)).toEqual(['期限结构因子', '  黑色板块', '    换月规则对比', '  能化板块', '动量与波动率择时', '基差动量', '仓单因子']);
    const [, ferrous, rule, chem] = rows;
    expect([ferrous.last, chem.last]).toEqual([false, true]);
    // The grandchild's rail under 黑色板块 continues because 能化板块 follows it.
    expect(rule.rails).toEqual([true]);
    expect(rows[0]).toMatchObject({ children: 2, hidden: 0, detached: false });
  });

  it('folds a line away and counts what it hides', () => {
    const rows = threadTree(lines, new Set([titled(workspace, '期限结构因子').id]));
    expect(draw(rows)).toEqual(['期限结构因子', '动量与波动率择时', '基差动量', '仓单因子']);
    expect(rows[0]).toMatchObject({ children: 2, hidden: 3 });
  });

  it('starts a new tree at a line whose parent is not in the list', () => {
    const rows = threadTree(lines.filter(thread => thread.title !== '期限结构因子'));
    expect(draw(rows)).toEqual(['黑色板块', '  换月规则对比', '能化板块', '动量与波动率择时', '基差动量', '仓单因子']);
    expect(rows.filter(row => row.detached).map(row => row.thread.title)).toEqual(['黑色板块', '能化板块']);
  });
});

describe('thread history', () => {
  const workspace = seedWorkspace(NOW);
  const index = buildIndex(workspace);
  const entriesOf = (title: string) => index.entriesOf.get(titled(workspace, title).id) ?? [];

  it('rebuilds stage and state stretches from change events, back to back', () => {
    const thread = titled(workspace, '基差动量');
    const spans = threadSpans(thread, entriesOf('基差动量'), NOW);
    expect(spans.map(span => `${span.stage}/${span.state}`)).toEqual(['idea/active', 'research/active', 'research/waiting', 'research/active']);
    expect(spans[0].start).toBe(thread.createdAt);
    expect(spans[spans.length - 1].end).toBe(NOW);
    spans.slice(1).forEach((span, at) => expect(span.start).toBe(spans[at].end));
  });

  it('ends a closed line in the closed state', () => {
    const spans = threadSpans(titled(workspace, '技术面趋势'), entriesOf('技术面趋势'), NOW);
    expect(spans.map(span => `${span.stage}/${span.state}`)).toEqual(['idea/active', 'research/active', 'backtest/active', 'retired/closed']);
  });

  it('only blurs one boundary when a change event was deleted', () => {
    const entries = entriesOf('期限结构因子').filter(entry => entry.event?.to !== 'research');
    const spans = threadSpans(titled(workspace, '期限结构因子'), entries, NOW);
    expect(spans.map(span => span.stage)).toEqual(['research', 'backtest']);
  });

  it('rolls back changes made after the given time', () => {
    const thread = titled(workspace, '期限结构因子');
    const moved = { ...thread, stage: 'paper' as const };
    const later = { ...entriesOf('期限结构因子')[0], id: 'later', kind: 'event' as const, event: { field: 'stage' as const, from: 'backtest', to: 'paper' }, createdAt: NOW + 30_000 };
    const spans = threadSpans(moved, [later, ...entriesOf('期限结构因子')], NOW);
    expect(spans[spans.length - 1]).toMatchObject({ stage: 'backtest', end: NOW });
  });
});

describe('demo data', () => {
  it('keeps whole days just after midnight and never lands in the future', () => {
    const late = new Date(2026, 9, 27, 0, 6).getTime();
    const workspace = seedWorkspace(late);
    expect(daysSince(titled(workspace, '基差动量').lastActivityAt, late)).toBe(12);
    expect(daysSince(titled(workspace, '50ETF 波动率曲面套利').waitingSince!, late)).toBe(6);
    const times = [...workspace.threads.map(row => row.lastActivityAt), ...workspace.entries.map(row => row.createdAt), ...workspace.todos.map(row => row.updatedAt)];
    expect(Math.max(...times)).toBeLessThanOrEqual(late);
  });
});

describe('loom scale', () => {
  it('covers whole days around today and labels Mondays when a week has room', () => {
    const scale = loomScale('4w', NOW, 1000);
    expect(scale.start).toBe(new Date(2026, 8, 28).getTime());
    expect(scale.end).toBe(new Date(2026, 10, 3).getTime());
    expect(scale.x(scale.start)).toBe(8);
    expect(scale.x(scale.end)).toBe(992);
    expect(loomTicks(scale).map(tick => tick.label)).toEqual(['9/28', '10/5', '10/12', '10/19', '10/26', '11/2']);
  });

  it('falls back to months when weeks are too narrow', () => {
    expect(loomTicks(loomScale('26w', NOW, 600)).map(tick => tick.label)).toEqual(['5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']);
  });
});

describe('date labels', () => {
  it('describes due dates relative to today', () => {
    const today = todayIso(NOW);
    expect(dayDiff(today, '2026-10-30')).toBe(4);
    expect(dueLabel('2026-10-25', NOW)).toBe('逾期 1 天');
    expect(dueLabel(today, NOW)).toBe('今天');
    expect(dueLabel('2026-10-27', NOW)).toBe('明天');
    expect(dueLabel('2026-10-29', NOW)).toBe('周四');
    expect(dueLabel('2026-11-30', NOW)).toBe('11月30日');
    expect(targetLabel('2026-11-30', NOW)).toBe('11月30日，还有 35 天');
    expect(targetLabel('2026-10-20', NOW)).toBe('10月20日，已过 6 天');
  });
});
