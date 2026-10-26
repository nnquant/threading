// The browser preview store mirrors docs/backend-contract.md, so the interface behaves the same in both shells.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPreviewApi } from '../src/preview';
import { applyChange } from '../src/workspace';
import type { Workspace } from '../src/types';

beforeEach(() => localStorage.clear());

async function setup() {
  const api = createPreviewApi();
  let workspace: Workspace = await api.loadWorkspace();
  const project = (name: string) => workspace.projects.find(row => row.name === name)!;
  const thread = (title: string) => workspace.threads.find(row => row.title === title)!;
  const apply = async (change: ReturnType<typeof api.updateThread>) => { const value = await change; workspace = applyChange(workspace, value); return value; };
  return { api, project, thread, apply, get workspace() { return workspace; } };
}

describe('preview store', () => {
  it('creates a thread with a creation event and its first next step', async () => {
    const { api, project, apply } = await setup();
    const change = await apply(api.createThread({ projectId: project('期权波动率').id, title: '  偏度因子 ', stage: 'research', nextAction: '拉取期权链' }));
    expect(change.threads?.[0]).toMatchObject({ title: '偏度因子', stage: 'research', state: 'active', hill: 0, position: 2 });
    expect(change.entries?.[0]).toMatchObject({ kind: 'event', event: { field: 'created', from: null, to: 'research' } });
    expect(change.todos?.[0]).toMatchObject({ text: '拉取期权链', position: 0, done: false });
  });

  it('rejects an empty title with a readable message', async () => {
    const { api, project } = await setup();
    await expect(api.createThread({ projectId: project('期权波动率').id, title: '   ' })).rejects.toThrow('策略线名称不能为空。');
  });

  it('tracks waiting time and clears it when the line moves on', async () => {
    const { api, thread, apply } = await setup();
    const id = thread('尾部对冲').id;
    const waiting = await apply(api.updateThread(id, { state: 'waiting', waitingOn: '风控审批' }));
    expect(waiting.threads?.[0]).toMatchObject({ state: 'waiting', waitingOn: '风控审批' });
    expect(waiting.threads?.[0].waitingSince).toEqual(expect.any(Number));
    expect(waiting.entries?.map(entry => entry.event)).toEqual([{ field: 'state', from: 'active', to: 'waiting' }]);
    const resumed = await apply(api.updateThread(id, { state: 'active' }));
    expect(resumed.threads?.[0]).toMatchObject({ waitingOn: '', waitingSince: null });
  });

  it('stamps a review without counting it as progress', async () => {
    const { api, thread, apply } = await setup();
    const before = thread('基差动量');
    const change = await apply(api.updateThread(before.id, { reviewed: true }));
    expect(change.threads?.[0].lastActivityAt).toBe(before.lastActivityAt);
    expect(change.threads?.[0].reviewedAt).toEqual(expect.any(Number));
    expect(change.entries).toBeUndefined();
  });

  it('moves the timeline with a thread and records the move', async () => {
    const { api, thread, project, apply, workspace } = await setup();
    const moving = thread('期限结构因子');
    const target = project('期权波动率');
    const change = await apply(api.updateThread(moving.id, { projectId: target.id }));
    const history = workspace.entries.filter(entry => entry.threadId === moving.id);
    expect(change.entries?.filter(entry => entry.kind !== 'event' || entry.event?.field !== 'project')).toHaveLength(history.length);
    expect(change.entries?.every(entry => entry.projectId === target.id)).toBe(true);
    expect(change.entries?.find(entry => entry.event?.field === 'project')?.event).toEqual({ field: 'project', from: '商品 CTA 多因子', to: '期权波动率' });
  });

  it('lets a project update set health without a separate health event', async () => {
    const { api, project, apply } = await setup();
    const vol = project('期权波动率');
    const change = await apply(api.createEntry({ projectId: vol.id, kind: 'update', body: '数据补齐了', health: 'onTrack' }));
    expect(change.projects?.[0].health).toBe('onTrack');
    expect(change.entries).toHaveLength(1);
    expect(change.entries?.[0]).toMatchObject({ kind: 'update', health: 'onTrack', threadId: null });
    await expect(api.createEntry({ projectId: vol.id, kind: 'note', body: 'x', health: 'atRisk' })).rejects.toThrow('只有项目进展');
    // The backend treats an explicit null as a health value too; callers must leave the field out.
    await expect(api.createEntry({ projectId: vol.id, kind: 'note', body: 'x', health: null })).rejects.toThrow('只有项目进展');
  });

  it('cascades a project delete and reports every removed row', async () => {
    const { api, project, workspace } = await setup();
    const cta = project('商品 CTA 多因子');
    const threads = workspace.threads.filter(row => row.projectId === cta.id).map(row => row.id);
    const change = await api.deleteProject(cta.id);
    const deleted = change.deleted ?? [];
    expect(deleted).toContainEqual({ kind: 'project', id: cta.id });
    for (const id of threads) expect(deleted).toContainEqual({ kind: 'thread', id });
    expect(deleted.filter(row => row.kind === 'todo')).toHaveLength(workspace.todos.filter(row => threads.includes(row.threadId)).length);
    expect(deleted.filter(row => row.kind === 'entry')).toHaveLength(workspace.entries.filter(row => row.projectId === cta.id).length);
  });

  it('reorders only a complete sibling list', async () => {
    const { api, project, workspace } = await setup();
    const ids = workspace.threads.filter(row => row.projectId === project('商品 CTA 多因子').id).map(row => row.id);
    await expect(api.reorder('thread', ids.slice(1))).rejects.toThrow('同一层级的全部条目');
    const change = await api.reorder('thread', [...ids].reverse());
    expect(change.threads?.map(row => [row.id, row.position])).toEqual([...ids].reverse().map((id, position) => [id, position]));
  });
});
