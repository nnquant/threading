import { createContext, useContext } from 'react';
import type { Api } from './bridge';
import type { Draft, EditorTab, HomeView } from './tabs';
import type { Index } from './workspace';
import type { Change, Id, Stage, Workspace } from './types';

/** Where a tab is: the home tab's views, a project tab, or an editor tab (by tab id). */
export type View = HomeView | { kind: 'project'; id: Id } | { kind: 'editor'; id: string };

/** Defaults for the new-thread dialog; `parentId` makes it a sub-line. */
export interface NewThreadPreset { projectId?: Id; parentId?: Id; stage?: Stage }
export interface ConfirmRequest { title: string; body: string; confirmLabel: string; onConfirm: () => Promise<unknown> | void }
export interface Notice { text: string; error?: boolean; action?: { label: string; run: () => void } }

export interface AppContext {
  workspace: Workspace;
  index: Index;
  /** Refreshed every minute so relative times and due labels stay current. */
  now: number;
  /** The view of the tab this component sits in. */
  view: View;
  /** Shows a view: projects in their own tab (opened once), everything else in the home tab. */
  go: (view: View) => void;
  /** The line open in this tab's side panel. */
  selected: Id | null;
  openThread: (id: Id | null) => void;
  /** The record editor tabs that are open, so composers can point at a draft in progress. */
  editors: EditorTab[];
  /** Opens the record editor in a tab of its own, or brings back the one already open for the same record; `body` is added to it. */
  openEditor: (draft: Draft, body?: string) => void;
  patchDraft: (tabId: string, patch: Partial<Draft>) => void;
  /** The editor took the text waiting in its inbox. */
  clearInbox: (tabId: string) => void;
  showTab: (id: string) => void;
  /** Closes a tab; an editor with text asks first unless `saved`. */
  closeTab: (id: string, options?: { saved?: boolean }) => void;
  api: Api;
  /** Runs a backend mutation, merges its `Change`, and reports failures unless `silent`. Resolves to null on error. */
  run: (task: (api: Api) => Promise<Change>, options?: { silent?: boolean }) => Promise<Change | null>;
  notify: (notice: Notice) => void;
  newThread: (preset?: NewThreadPreset) => void;
  newProject: (orgId?: Id) => void;
  editProject: (id: Id) => void;
  newOrg: () => void;
  editOrg: (id: Id) => void;
  confirm: (request: ConfirmRequest) => void;
  /** Adds the demo organizations with their history to the current data. Typed as ENABLE_SAMPLE_DATA in the search box. */
  addDemo: () => void;
  /** Asks, then removes every demo organization and everything under it. Typed as DISABLE_SAMPLE_DATA in the search box. */
  clearDemo: () => void;
}

export const Ctx = createContext<AppContext | null>(null);
export function useApp() {
  const value = useContext(Ctx);
  if (!value) throw new Error('useApp must be used inside the workspace provider');
  return value;
}
