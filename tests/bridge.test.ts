import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke, isTauri: tauri.isTauri }));

beforeEach(() => vi.resetModules());

describe('desktop bridge', () => {
  it('sends each mutation to the contract command with camelCase arguments', async () => {
    tauri.isTauri.mockReturnValue(true);
    tauri.invoke.mockResolvedValue({});
    const { createApi } = await import('../src/bridge');
    const api = await createApi();
    await api.updateThread('t1', { stage: 'paper', hill: 0 });
    await api.createEntry({ projectId: 'p1', threadId: null, kind: 'update', body: '进展', health: 'atRisk' });
    await api.reorder('todo', ['a', 'b']);
    await api.loadWorkspace();
    expect(tauri.invoke.mock.calls).toEqual([
      ['update_thread', { id: 't1', patch: { stage: 'paper', hill: 0 } }],
      ['create_entry', { input: { projectId: 'p1', threadId: null, kind: 'update', body: '进展', health: 'atRisk' } }],
      ['reorder', { kind: 'todo', ids: ['a', 'b'] }],
      ['load_workspace'],
    ]);
  });

  it('only calls commands the Rust backend registers', () => {
    const bridge = readFileSync(resolve('src/bridge.ts'), 'utf8');
    const lib = readFileSync(resolve('src-tauri/src/lib.rs'), 'utf8');
    const used = [...bridge.matchAll(/invoke\('([a-z_]+)'/g)].map(match => match[1]);
    const handler = lib.slice(lib.indexOf('generate_handler!['));
    const registered = [...handler.slice(0, handler.indexOf(']')).matchAll(/([a-z_]+),/g)].map(match => match[1]);
    expect(used.length).toBe(19);
    expect(new Set(used)).toEqual(new Set(registered));
  });

  it('uses the in-memory preview store outside the desktop shell', async () => {
    tauri.isTauri.mockReturnValue(false);
    const { createApi, isDesktop } = await import('../src/bridge');
    expect(isDesktop).toBe(false);
    const workspace = await (await createApi()).loadWorkspace();
    expect(workspace.organizations.length).toBeGreaterThan(0);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
