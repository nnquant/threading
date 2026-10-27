import type { EntryKind, Health, Id } from './types';

/** What the home tab can show; projects open in tabs of their own. */
export type HomeView = { kind: 'focus' } | { kind: 'threads' } | { kind: 'review' } | { kind: 'org'; id: Id };
export type Writable = Exclude<EntryKind, 'event'>;

/** A record being written in the editor tab: a new entry on a project or thread, or an edit of `entryId`. */
export interface Draft {
  projectId: Id;
  threadId: Id | null;
  entryId?: Id;
  kind: Writable;
  health: Health;
}

export type Tab =
  | { id: 'home'; kind: 'home'; view: HomeView; selected: Id | null }
  | { id: string; kind: 'project'; projectId: Id; selected: Id | null }
  /** `from` is the tab to return to once the record is saved; `inbox` is text waiting to be added to the open editor. */
  | { id: string; kind: 'editor'; draft: Draft; from?: string; inbox?: { text: string; at: number } };
export type EditorTab = Extract<Tab, { kind: 'editor' }>;

export interface Tabs { tabs: Tab[]; active: string }

const TABS_KEY = 'threading.tabs.v1';
const DRAFT_KEY = 'threading.draft.v1.';
const HOME: Extract<Tab, { kind: 'home' }> = { id: 'home', kind: 'home', view: { kind: 'focus' }, selected: null };
const HOME_VIEWS = ['focus', 'threads', 'review', 'org'];

/** Restores the open tabs; whatever looks wrong is dropped, and the home tab always comes first. */
export function readTabs(): Tabs {
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_KEY) || 'null') as Tabs | null;
    if (saved && Array.isArray(saved.tabs)) {
      const home = saved.tabs.find(tab => tab?.kind === 'home') as Extract<Tab, { kind: 'home' }> | undefined;
      const rest = saved.tabs.filter(tab => (tab?.kind === 'project' && typeof tab.projectId === 'string')
        || (tab?.kind === 'editor' && typeof tab.draft?.projectId === 'string'));
      const tabs: Tab[] = [
        home && HOME_VIEWS.includes(home.view?.kind) ? { ...HOME, view: home.view, selected: home.selected ?? null } : HOME,
        ...rest.map(tab => tab.kind === 'project' ? { ...tab, selected: tab.selected ?? null } : tab),
      ];
      return { tabs, active: tabs.some(tab => tab.id === saved.active) ? saved.active : 'home' };
    }
  } catch { /* fall through */ }
  return { tabs: [HOME], active: 'home' };
}
export function saveTabs(state: Tabs) {
  try { localStorage.setItem(TABS_KEY, JSON.stringify(state)); } catch { /* per-viewer convenience only */ }
}

// Draft bodies live apart from the tab list, so typing never re-renders the whole window.
const bodies = new Map<string, string>();
// A closing editor may still save on its way out; once a draft is dropped it stays dropped (tab ids are never reused).
const dropped = new Set<string>();
export function readDraft(tabId: string) {
  if (bodies.has(tabId)) return bodies.get(tabId)!;
  try { return localStorage.getItem(DRAFT_KEY + tabId) ?? ''; } catch { return ''; }
}
export function writeDraft(tabId: string, body: string) {
  if (dropped.has(tabId)) return;
  bodies.set(tabId, body);
  try { localStorage.setItem(DRAFT_KEY + tabId, body); } catch { /* the in-memory copy still holds it */ }
}
export function dropDraft(tabId: string) {
  dropped.add(tabId);
  bodies.delete(tabId);
  try { localStorage.removeItem(DRAFT_KEY + tabId); } catch { /* nothing to drop */ }
}

export const newTabId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
export const sameTarget = (a: Draft, b: Draft) => a.projectId === b.projectId && a.threadId === b.threadId && (a.entryId ?? null) === (b.entryId ?? null);
