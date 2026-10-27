// The browser preview store mirrors docs/backend-contract.md, so the interface behaves the same in both shells.
import { beforeEach, describe, expect, it } from 'vitest';
import { demoSeed } from '../src/demo';
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
    const moving = thread('动量与波动率择时');
    const target = project('期权波动率');
    const change = await apply(api.updateThread(moving.id, { projectId: target.id }));
    const history = workspace.entries.filter(entry => entry.threadId === moving.id);
    expect(change.entries?.filter(entry => entry.kind !== 'event' || entry.event?.field !== 'project')).toHaveLength(history.length);
    expect(change.entries?.every(entry => entry.projectId === target.id)).toBe(true);
    expect(change.entries?.find(entry => entry.event?.field === 'project')?.event).toEqual({ field: 'project', from: '商品 CTA 多因子', to: '期权波动率' });
  });

  it('creates a sub-line at the end of its siblings and counts it as work on every line above', async () => {
    const { api, project, thread, apply } = await setup();
    const ferrous = thread('黑色板块');
    const change = await apply(api.createThread({ projectId: ferrous.projectId, parentId: ferrous.id, title: '焦煤单独回测' }));
    const created = change.threads?.find(row => row.title === '焦煤单独回测');
    expect(created).toMatchObject({ parentId: ferrous.id, position: 1 });
    expect(change.entries?.map(entry => entry.event?.field)).toEqual(['created']);
    const touched = change.threads?.filter(row => row !== created).map(row => [row.title, row.lastActivityAt]);
    expect(touched).toEqual([['黑色板块', created!.createdAt], ['期限结构因子', created!.createdAt]]);
    await expect(api.createThread({ projectId: project('期权波动率').id, parentId: ferrous.id, title: 'x' })).rejects.toThrow('上级策略线必须在同一个项目里。');
    await expect(api.createThread({ projectId: ferrous.projectId, parentId: 'missing', title: 'x' })).rejects.toThrow('找不到上级策略线，可能已被删除。');
  });

  it('re-parents a line with a parent event and refuses cycles', async () => {
    const { api, thread, apply, workspace } = await setup();
    const term = thread('期限结构因子');
    await expect(api.updateThread(term.id, { parentId: thread('换月规则对比').id })).rejects.toThrow('不能把策略线放到它自己或它的子策略线下面。');
    await expect(api.updateThread(term.id, { parentId: term.id })).rejects.toThrow('不能把策略线放到它自己或它的子策略线下面。');
    const moved = await apply(api.updateThread(thread('能化板块').id, { parentId: thread('黑色板块').id }));
    expect(moved.threads?.[0]).toMatchObject({ parentId: thread('黑色板块').id, position: 1 });
    expect(moved.entries?.map(entry => entry.event)).toEqual([{ field: 'parent', from: '期限结构因子', to: '黑色板块' }]);
    const lifted = await apply(api.updateThread(thread('能化板块').id, { parentId: null }));
    const roots = workspace.threads.filter(row => row.projectId === term.projectId && !row.parentId);
    expect(lifted.threads?.[0]).toMatchObject({ parentId: null, position: roots.length });
    expect(lifted.entries?.map(entry => entry.event)).toEqual([{ field: 'parent', from: '黑色板块', to: null }]);
  });

  it('moves a line to another project together with every line below it', async () => {
    const { api, thread, project, apply, workspace } = await setup();
    const term = thread('期限结构因子');
    const target = project('期权波动率');
    const subtree = ['期限结构因子', '黑色板块', '换月规则对比', '能化板块'].map(title => thread(title).id);
    const change = await apply(api.updateThread(term.id, { projectId: target.id }));
    expect(change.threads?.map(row => row.id).sort()).toEqual([...subtree].sort());
    expect(change.threads?.every(row => row.projectId === target.id)).toBe(true);
    expect(thread('换月规则对比').parentId).toBe(thread('黑色板块').id);
    expect(change.entries?.filter(entry => entry.event?.field === 'project').map(entry => entry.threadId).sort()).toEqual([...subtree].sort());
    const moved = new Map(change.entries?.map(entry => [entry.id, entry.projectId]));
    expect(workspace.entries.filter(entry => entry.threadId && subtree.includes(entry.threadId)).every(entry => moved.get(entry.id) === target.id)).toBe(true);
    // A sub-line moved on its own leaves its parent behind.
    const alone = await apply(api.updateThread(thread('黑色板块').id, { projectId: project('商品 CTA 多因子').id }));
    expect(alone.threads?.find(row => row.title === '黑色板块')?.parentId).toBeNull();
    expect(alone.entries?.find(entry => entry.event?.field === 'parent')?.event).toEqual({ field: 'parent', from: '期限结构因子', to: null });
  });

  it('deletes a line with everything below it and refreshes the lines above', async () => {
    const { api, thread, apply, workspace } = await setup();
    const leaf = await apply(api.deleteThread(thread('换月规则对比').id));
    expect(leaf.threads?.map(row => row.title)).toEqual(['黑色板块', '期限结构因子']);
    const subtree = ['期限结构因子', '黑色板块', '能化板块'].map(title => thread(title).id);
    const change = await api.deleteThread(thread('期限结构因子').id);
    expect(change.deleted?.filter(row => row.kind === 'thread').map(row => row.id).sort()).toEqual([...subtree].sort());
    expect(change.deleted?.filter(row => row.kind === 'todo')).toHaveLength(workspace.todos.filter(row => subtree.includes(row.threadId)).length);
    expect(change.deleted?.filter(row => row.kind === 'entry')).toHaveLength(workspace.entries.filter(row => row.threadId && subtree.includes(row.threadId)).length);
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
    const ids = workspace.threads.filter(row => row.projectId === project('商品 CTA 多因子').id && !row.parentId).map(row => row.id);
    await expect(api.reorder('thread', ids.slice(1))).rejects.toThrow('同一层级的全部条目');
    // Sub-lines are siblings only of the lines under the same parent.
    const ferrous = workspace.threads.find(row => row.title === '黑色板块')!.id;
    await expect(api.reorder('thread', [...ids.slice(1), ferrous])).rejects.toThrow('同一层级的全部条目');
    const change = await api.reorder('thread', [...ids].reverse());
    expect(change.threads?.map(row => [row.id, row.position])).toEqual([...ids].reverse().map((id, position) => [id, position]));
  });

  it('clears only the demo organizations and adds them back once, after the user’s own', async () => {
    const { api, apply } = await setup();
    const before = (await api.loadWorkspace());
    const cleared = await apply(api.clearDemoData());
    const rows = before.organizations.length + before.projects.length + before.threads.length + before.todos.length + before.entries.length;
    expect(cleared.deleted).toHaveLength(rows);
    await apply(api.createOrganization({ name: '我的组织' }));
    expect(await apply(api.clearDemoData())).toEqual({});

    const seed = demoSeed();
    const added = await apply(api.importDemoData(seed));
    expect(added.organizations?.map(org => [org.name, org.demo, org.position])).toEqual([['自营研究', true, 1], ['澜湾资产', true, 2], ['启明投顾', true, 3]]);
    // Rows keep their ids and timestamps, so the threads arrive with their history.
    expect(added.threads).toEqual(seed.threads);
    expect(added.entries).toHaveLength(seed.entries.length);
    await expect(api.importDemoData(demoSeed())).rejects.toThrow('示例数据已经添加过了，先清理再重新添加。');

    await apply(api.clearDemoData());
    expect((await api.loadWorkspace()).organizations.map(org => org.name)).toEqual(['我的组织']);
  });

  it('rejects demo rows that point outside the seed', async () => {
    const { api } = await setup();
    await api.clearDemoData();
    const seed = demoSeed();
    seed.threads[0] = { ...seed.threads[0], projectId: 'missing' };
    await expect(api.importDemoData(seed)).rejects.toThrow('示例策略线必须引用本次导入的项目。');
    expect((await api.loadWorkspace()).organizations).toHaveLength(0);
  });

  it('rejects demo sub-lines whose parents loop', async () => {
    const { api } = await setup();
    await api.clearDemoData();
    const seed = demoSeed();
    const [term, ferrous] = seed.threads;
    seed.threads[0] = { ...term, parentId: ferrous.id };
    await expect(api.importDemoData(seed)).rejects.toThrow('示例策略线的上级不能成环。');
  });

  it('saves images by their content and reads them back', async () => {
    const { api } = await setup();
    const png = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3));
    const saved = await api.saveImage(png);
    expect(saved).toMatchObject({ mime: 'image/png', size: 11 });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect([...new Uint8Array(await api.readImage(saved.id))].slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // A WebP is recognised by its header, whatever the caller thinks it is.
    expect((await api.saveImage(btoa('RIFF\0\0\0\0WEBPVP8 '))).mime).toBe('image/webp');
    // Stored ones survive a new session of the preview.
    expect((await createPreviewApi().readImage(saved.id)).byteLength).toBe(11);
  });

  it('rejects images it cannot use', async () => {
    const { api } = await setup();
    await expect(api.saveImage('not base64!')).rejects.toThrow('图片数据无法读取。');
    await expect(api.saveImage('')).rejects.toThrow('图片是空的。');
    await expect(api.saveImage(btoa('%PDF-1.7'))).rejects.toThrow('只支持 PNG、JPEG、GIF 和 WebP 图片。');
    await expect(api.readImage('../threading.db')).rejects.toThrow('图片地址无效。');
    await expect(api.readImage('3F2A9C1E-8B7D-4E6F-A1B2-C3D4E5F60789.png')).rejects.toThrow('图片地址无效。');
    await expect(api.readImage('3f2a9c1e-8b7d-4e6f-a1b2-c3d4e5f60789.png')).rejects.toThrow('找不到这张图片，可能已被删除。');
  });
});
