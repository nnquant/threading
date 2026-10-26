import { describe, expect, it } from 'vitest';
import { dayDiff, dueLabel, targetLabel, todayIso } from '../src/labels';
import { seedWorkspace } from '../src/preview';
import { applyChange, buildIndex, focusOf, reviewQueue } from '../src/workspace';
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
      '补 2015–2017 年样本外回测', '排查 10 月超额回撤的原因', '去掉涨跌停样本后重算 IC', '加入资金面指标',
      '核对模拟盘与回测的成交差异', '给客户写月度归因说明', '确定对冲预算上限',
    ]);
  });

  it('finds waiting, stale and next-step-less lines, longest waiting first', () => {
    expect(focus.waiting.map(thread => thread.title)).toEqual(['50ETF 波动率曲面套利', '风格中性约束']);
    expect(focus.stale.map(thread => thread.title)).toEqual(['基差动量', '高频量价因子']);
    expect(focus.noNext.map(thread => thread.title)).toEqual(['基差动量']);
    expect(focus.activeCount).toBe(7);
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
    expect(next.waiting.map(thread => thread.title)).toEqual(['50ETF 波动率曲面套利']);
    expect(next.risky.map(project => project.name)).toEqual(['期权波动率']);
  });
});

describe('weekly review queue', () => {
  it('includes open lines not reviewed in the last six days, never-reviewed first', () => {
    const workspace = seedWorkspace(NOW);
    const index = buildIndex(workspace);
    expect(reviewQueue(workspace, index, NOW)).toHaveLength(9);
    const reviewed = applyChange(workspace, {
      threads: [
        { ...titled(workspace, '基差动量'), reviewedAt: NOW - 86_400_000 },
        { ...titled(workspace, '尾部对冲'), reviewedAt: NOW - 8 * 86_400_000 },
      ],
    });
    const queue = reviewQueue(reviewed, buildIndex(reviewed), NOW).map(thread => thread.title);
    expect(queue).toHaveLength(8);
    expect(queue).not.toContain('基差动量');
    expect(queue[queue.length - 1]).toBe('尾部对冲');
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
