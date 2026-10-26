import { createContext, useContext } from 'react';
import type { Api } from './bridge';
import type { Index } from './workspace';
import type { Change, Id, Stage, Workspace } from './types';

export type View =
  | { kind: 'focus' }
  | { kind: 'threads' }
  | { kind: 'review' }
  | { kind: 'org'; id: Id }
  | { kind: 'project'; id: Id };

export interface NewThreadPreset { projectId?: Id; stage?: Stage }
export interface ConfirmRequest { title: string; body: string; confirmLabel: string; onConfirm: () => Promise<unknown> | void }
export interface Notice { text: string; error?: boolean; action?: { label: string; run: () => void } }

export interface AppContext {
  workspace: Workspace;
  index: Index;
  /** Refreshed every minute so relative times and due labels stay current. */
  now: number;
  view: View;
  go: (view: View) => void;
  selected: Id | null;
  openThread: (id: Id | null) => void;
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
}

export const Ctx = createContext<AppContext | null>(null);
export function useApp() {
  const value = useContext(Ctx);
  if (!value) throw new Error('useApp must be used inside the workspace provider');
  return value;
}
