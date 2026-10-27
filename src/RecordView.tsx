// A record read on its own in a tab, with the room a long research note needs.
import { Pencil } from 'lucide-react';
import { useApp } from './context';
import { HEALTH_LABEL, KIND_LABEL, fullTime, relativeTime } from './labels';
import type { RecordTab, Writable } from './tabs';
import { Markdown, OrgMark } from './ui';

export default function RecordView({ tab }: { tab: RecordTab }) {
  const { workspace, index, now, go, openEditor } = useApp();
  const entry = workspace.entries.find(row => row.id === tab.entryId);
  // A deleted record's tab closes on its own.
  if (!entry) return null;
  const project = index.project.get(entry.projectId);
  const org = project && index.org.get(project.orgId);
  const thread = entry.threadId ? index.thread.get(entry.threadId) : undefined;
  const edit = () => openEditor({
    projectId: entry.projectId, threadId: entry.threadId, entryId: entry.id, kind: entry.kind as Writable, health: entry.health ?? 'onTrack',
  }, entry.body);
  return (
    <div className="view record-view">
      <header className="view-head">
        <div className="view-title">
          {thread
            ? project && <button className="crumb" onClick={() => go({ kind: 'project', id: project.id })}>{org && <OrgMark org={org} />}{project.name}</button>
            : org && <span className="crumb">{<OrgMark org={org} />}{org.name}</span>}
          <h1>{thread?.title ?? project?.name ?? '已删除'}</h1>
          <span className="pill">{KIND_LABEL[entry.kind]}</span>
          {entry.health && <span className={`health-label is-${entry.health}`}>{HEALTH_LABEL[entry.health]}</span>}
          <time className="view-date" title={fullTime(entry.createdAt)}>{relativeTime(entry.createdAt, now)}</time>
          {entry.editedAt && <span className="view-date" title={fullTime(entry.editedAt)}>已编辑</span>}
        </div>
        {entry.kind !== 'event' && (
          <div className="view-actions">
            <button className="btn" onClick={edit}><Pencil size={13} />编辑</button>
          </div>
        )}
      </header>
      <div className="view-body">
        <article className="record-page"><Markdown text={entry.body} className="record-doc" /></article>
      </div>
    </div>
  );
}
