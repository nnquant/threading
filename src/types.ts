// Shared contract between the React UI and the Rust backend (src-tauri).
// Every field name here is the exact serde camelCase name the backend emits and accepts.
// See docs/backend-contract.md for validation and side-effect rules.

export type Id = string;
/** Unix epoch milliseconds (UTC). */
export type Millis = number;
/** Calendar date `YYYY-MM-DD` without a time zone. */
export type IsoDate = string;

export const STAGES = ['idea', 'research', 'backtest', 'paper', 'live', 'retired'] as const;
export type Stage = typeof STAGES[number];
export type ThreadState = 'active' | 'waiting' | 'paused' | 'closed';
export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export type Health = 'onTrack' | 'atRisk' | 'offTrack';
export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived';
export type EntryKind = 'note' | 'decision' | 'result' | 'update' | 'event';
export const ORG_COLORS = ['slate', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'violet'] as const;
export type OrgColor = typeof ORG_COLORS[number];
export type EntityKind = 'organization' | 'project' | 'thread' | 'todo' | 'entry';

export interface Organization {
  id: Id;
  name: string;
  /** Short label shown in dense lists, e.g. `HQ`. */
  code: string;
  color: OrgColor;
  note: string;
  archived: boolean;
  /** Added by `import_demo_data`; `clear_demo_data` removes it with everything under it. */
  demo: boolean;
  position: number;
  createdAt: Millis;
  updatedAt: Millis;
}

export interface Project {
  id: Id;
  orgId: Id;
  name: string;
  goal: string;
  status: ProjectStatus;
  health: Health;
  targetDate: IsoDate | null;
  position: number;
  createdAt: Millis;
  updatedAt: Millis;
}

export interface Metric { label: string; value: string }

/** A strategy line: one parallel line of work inside a project. Lines nest: a sub-line lives in its parent's project. */
export interface Thread {
  id: Id;
  projectId: Id;
  /** The line this one branched from, or null for a top-level line of the project. Any depth, never a cycle. */
  parentId: Id | null;
  title: string;
  /** Markdown: hypothesis, scope, links. */
  summary: string;
  stage: Stage;
  state: ThreadState;
  priority: Priority;
  /** Hill chart position 0–100: below 50 is still figuring it out, above 50 is execution. */
  hill: number;
  waitingOn: string;
  waitingSince: Millis | null;
  tags: string[];
  metrics: Metric[];
  position: number;
  createdAt: Millis;
  updatedAt: Millis;
  /** Last real work on the line or any of its sub-lines: edits, todos or entries. Reviews do not count. */
  lastActivityAt: Millis;
  reviewedAt: Millis | null;
  closedAt: Millis | null;
}

/** A next action on a thread. The first open todo by position is the thread's next step. */
export interface Todo {
  id: Id;
  threadId: Id;
  text: string;
  due: IsoDate | null;
  done: boolean;
  doneAt: Millis | null;
  position: number;
  createdAt: Millis;
  updatedAt: Millis;
}

export type EventField = 'created' | 'stage' | 'state' | 'project' | 'parent' | 'health' | 'status';
export interface EntryEvent { field: EventField; from: string | null; to: string | null }

/** A timeline entry. `threadId` null means a project-level entry. */
export interface Entry {
  id: Id;
  projectId: Id;
  threadId: Id | null;
  kind: EntryKind;
  body: string;
  health: Health | null;
  event: EntryEvent | null;
  createdAt: Millis;
  editedAt: Millis | null;
}

export interface Settings {
  /** An active thread with no activity for this many days is stale. 1–90. */
  staleDays: number;
  /** Soft cap on active threads; 0 turns the warning off. 0–50. */
  wipLimit: number;
}

export interface Workspace {
  organizations: Organization[];
  projects: Project[];
  threads: Thread[];
  todos: Todo[];
  entries: Entry[];
  settings: Settings;
  /** Absolute path of the database file. */
  dataPath: string;
}

/** Every mutation returns the full current state of each row it touched, plus removed rows. */
export interface Change {
  organizations?: Organization[];
  projects?: Project[];
  threads?: Thread[];
  todos?: Todo[];
  entries?: Entry[];
  settings?: Settings;
  deleted?: { kind: EntityKind; id: Id }[];
}

export interface OrganizationInput { name: string; code?: string; color?: OrgColor; note?: string }
export interface OrganizationPatch { name?: string; code?: string; color?: OrgColor; note?: string; archived?: boolean }

export interface ProjectInput { orgId: Id; name: string; goal?: string; status?: ProjectStatus; health?: Health; targetDate?: IsoDate | null }
export interface ProjectPatch { orgId?: Id; name?: string; goal?: string; status?: ProjectStatus; health?: Health; targetDate?: IsoDate | null }

export interface ThreadInput {
  projectId: Id;
  /** Creates a sub-line; the parent must be in `projectId`. */
  parentId?: Id | null;
  title: string;
  summary?: string;
  stage?: Stage;
  state?: ThreadState;
  priority?: Priority;
  tags?: string[];
  /** When non-empty, also creates the first todo. */
  nextAction?: string;
}
export interface ThreadPatch {
  /** Moves the line with all its sub-lines; it lands under `parentId` when given, otherwise at the top level. */
  projectId?: Id;
  /** `null` makes it a top-level line. The parent must be in the same project and outside this line's own subtree. */
  parentId?: Id | null;
  title?: string;
  summary?: string;
  stage?: Stage;
  state?: ThreadState;
  priority?: Priority;
  hill?: number;
  waitingOn?: string;
  tags?: string[];
  metrics?: Metric[];
  /** `true` stamps `reviewedAt` with the current time. */
  reviewed?: boolean;
}

export interface TodoInput { threadId: Id; text: string; due?: IsoDate | null }
export interface TodoPatch { text?: string; due?: IsoDate | null; done?: boolean }

export interface EntryInput { projectId: Id; threadId?: Id | null; kind: Exclude<EntryKind, 'event'>; body: string; health?: Health | null }
export interface EntryPatch { body: string }

export interface SettingsPatch { staleDays?: number; wipLimit?: number }

/** Demo rows built by the frontend, stored as given (ids and timestamps included) so they arrive with history. */
export interface DemoSeed {
  organizations: Organization[];
  projects: Project[];
  threads: Thread[];
  todos: Todo[];
  entries: Entry[];
}
