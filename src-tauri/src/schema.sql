CREATE TABLE organizations (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, code TEXT NOT NULL,
  color TEXT NOT NULL, note TEXT NOT NULL, archived INTEGER NOT NULL CHECK (archived IN (0,1)),
  position INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY NOT NULL, orgId TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL, health TEXT NOT NULL,
  targetDate TEXT, position INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE INDEX projects_parent ON projects(orgId, position);
CREATE TABLE threads (
  id TEXT PRIMARY KEY NOT NULL, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, summary TEXT NOT NULL, stage TEXT NOT NULL, state TEXT NOT NULL,
  priority TEXT NOT NULL, hill INTEGER NOT NULL CHECK (hill BETWEEN 0 AND 100),
  waitingOn TEXT NOT NULL, waitingSince INTEGER,
  tags TEXT NOT NULL CHECK (json_valid(tags) AND json_type(tags) = 'array'),
  metrics TEXT NOT NULL CHECK (json_valid(metrics) AND json_type(metrics) = 'array'),
  position INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
  lastActivityAt INTEGER NOT NULL, reviewedAt INTEGER, closedAt INTEGER,
  UNIQUE(id, projectId)
);
CREATE INDEX threads_parent ON threads(projectId, position);
CREATE TABLE todos (
  id TEXT PRIMARY KEY NOT NULL, threadId TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  text TEXT NOT NULL, due TEXT, done INTEGER NOT NULL CHECK (done IN (0,1)), doneAt INTEGER,
  position INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
);
CREATE INDEX todos_parent ON todos(threadId, position);
CREATE TABLE entries (
  id TEXT PRIMARY KEY NOT NULL, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  threadId TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, health TEXT,
  event TEXT CHECK (event IS NULL OR (json_valid(event) AND json_type(event) = 'object')),
  createdAt INTEGER NOT NULL, editedAt INTEGER,
  FOREIGN KEY(threadId, projectId) REFERENCES threads(id, projectId) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX entries_project ON entries(projectId, createdAt);
CREATE INDEX entries_thread ON entries(threadId);
CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL);
INSERT INTO settings VALUES ('staleDays', 7), ('wipLimit', 8);
