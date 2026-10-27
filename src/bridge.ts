import { invoke, isTauri } from '@tauri-apps/api/core';
import type {
  Change, DemoSeed, EntityKind, EntryInput, EntryPatch, Id, OrganizationInput, OrganizationPatch, ProjectInput, ProjectPatch,
  SettingsPatch, ThreadInput, ThreadPatch, TodoInput, TodoPatch, Workspace,
} from './types';

export const isDesktop = isTauri();

export interface Api {
  loadWorkspace(): Promise<Workspace>;
  createOrganization(input: OrganizationInput): Promise<Change>;
  updateOrganization(id: Id, patch: OrganizationPatch): Promise<Change>;
  deleteOrganization(id: Id): Promise<Change>;
  createProject(input: ProjectInput): Promise<Change>;
  updateProject(id: Id, patch: ProjectPatch): Promise<Change>;
  deleteProject(id: Id): Promise<Change>;
  createThread(input: ThreadInput): Promise<Change>;
  updateThread(id: Id, patch: ThreadPatch): Promise<Change>;
  deleteThread(id: Id): Promise<Change>;
  createTodo(input: TodoInput): Promise<Change>;
  updateTodo(id: Id, patch: TodoPatch): Promise<Change>;
  deleteTodo(id: Id): Promise<Change>;
  createEntry(input: EntryInput): Promise<Change>;
  updateEntry(id: Id, patch: EntryPatch): Promise<Change>;
  deleteEntry(id: Id): Promise<Change>;
  reorder(kind: Exclude<EntityKind, 'entry'>, ids: Id[]): Promise<Change>;
  updateSettings(patch: SettingsPatch): Promise<Change>;
  backupNow(): Promise<string>;
  importDemoData(seed: DemoSeed): Promise<Change>;
  clearDemoData(): Promise<Change>;
}

const desktopApi: Api = {
  loadWorkspace: () => invoke('load_workspace'),
  createOrganization: input => invoke('create_organization', { input }),
  updateOrganization: (id, patch) => invoke('update_organization', { id, patch }),
  deleteOrganization: id => invoke('delete_organization', { id }),
  createProject: input => invoke('create_project', { input }),
  updateProject: (id, patch) => invoke('update_project', { id, patch }),
  deleteProject: id => invoke('delete_project', { id }),
  createThread: input => invoke('create_thread', { input }),
  updateThread: (id, patch) => invoke('update_thread', { id, patch }),
  deleteThread: id => invoke('delete_thread', { id }),
  createTodo: input => invoke('create_todo', { input }),
  updateTodo: (id, patch) => invoke('update_todo', { id, patch }),
  deleteTodo: id => invoke('delete_todo', { id }),
  createEntry: input => invoke('create_entry', { input }),
  updateEntry: (id, patch) => invoke('update_entry', { id, patch }),
  deleteEntry: id => invoke('delete_entry', { id }),
  reorder: (kind, ids) => invoke('reorder', { kind, ids }),
  updateSettings: patch => invoke('update_settings', { patch }),
  backupNow: () => invoke('backup_now'),
  importDemoData: seed => invoke('import_demo_data', { seed }),
  clearDemoData: () => invoke('clear_demo_data'),
};

/** Desktop builds talk to the Rust store; the browser preview runs an in-memory demo with the same rules. */
export async function createApi(): Promise<Api> {
  if (isDesktop) return desktopApi;
  const { createPreviewApi } = await import('./preview');
  return createPreviewApi();
}

export const desktop = {
  openUrl: async (url: string) => {
    if (!/^https?:\/\//i.test(url)) return;
    if (!isDesktop) { window.open(url, '_blank', 'noopener'); return; }
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  },
  revealPath: async (path: string) => {
    if (!isDesktop) return;
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(path);
  },
};

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export const appWindow = {
  minimize: async () => { if (isDesktop) await (await currentWindow()).minimize(); },
  toggleMaximize: async () => { if (isDesktop) await (await currentWindow()).toggleMaximize(); },
  close: async () => { if (isDesktop) await (await currentWindow()).close(); },
  startDragging: async () => { if (isDesktop) await (await currentWindow()).startDragging(); },
  isMaximized: async () => isDesktop ? (await currentWindow()).isMaximized() : false,
  onResized: async (callback: () => void): Promise<() => void> => isDesktop ? (await currentWindow()).onResized(callback) : () => {},
};
