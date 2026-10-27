import { useRef, useState } from 'react';
import { CalendarDays, ChevronRight, MessageSquarePlus, Pencil, Plus } from 'lucide-react';
import { useApp } from './context';
import HillChart from './HillChart';
import { HEALTHS, HEALTH_LABEL, STATUSES, STATUS_LABEL, dayDiff, gist, parseIso, relativeTime, shortDate, todayIso } from './labels';
import ThreadsView from './ThreadsView';
import { Composer, Timeline } from './Timeline';
import { Dropdown, HealthDot, Markdown, OrgMark } from './ui';
import type { Id, IsoDate, Millis, Project } from './types';

type Tab = 'threads' | 'hill' | 'activity';
const TAB_KEY = 'threading.project.tab.v1';

/** The target date, with how much of the project's time is used up: counted from the day it was created. */
function TargetFact({ project, target, now, onEdit }: { project: Project; target: IsoDate; now: Millis; onEdit: () => void }) {
  const today = todayIso(now);
  const start = todayIso(project.createdAt);
  const left = dayDiff(today, target);
  const span = dayDiff(start, target);
  const used = Math.round((span > 0 ? Math.min(1, Math.max(0, dayDiff(start, today) / span)) : 1) * 100);
  const live = project.status === 'active';
  return (
    <button className={`brief-fact ${live && left < 0 ? 'is-overdue' : ''}`} onClick={onEdit} title="修改目标日期">
      <CalendarDays size={13} />
      <span>{shortDate(parseIso(target).getTime(), now)}截止</span>
      {live && (
        <>
          <span className="time-bar" role="img" aria-label={`时间已用去 ${used}%`} title={`从 ${shortDate(project.createdAt, now)}建项算起，时间已用去 ${used}%`}>
            <i style={{ width: `${used}%` }} />
          </span>
          <span className="brief-fact-note">{left > 0 ? `还有 ${left} 天` : left === 0 ? '就是今天' : `已过 ${-left} 天`}</span>
        </>
      )}
    </button>
  );
}

export default function ProjectView({ id }: { id: Id }) {
  const { index, run, go, newThread, editProject, now } = useApp();
  const [tab, setTab] = useState<Tab>(() => { try { return (localStorage.getItem(TAB_KEY) as Tab) || 'threads'; } catch { return 'threads'; } });
  const root = useRef<HTMLDivElement>(null);
  const project = index.project.get(id);
  if (!project) return null;
  const org = index.org.get(project.orgId);
  const threads = index.threadsOf.get(project.id) ?? [];
  const entries = index.projectEntries.get(project.id) ?? [];
  const latest = entries.find(entry => entry.kind === 'update');
  const latestHealth = latest?.health ?? project.health;
  const choose = (next: Tab) => { setTab(next); try { localStorage.setItem(TAB_KEY, next); } catch { /* per-viewer convenience only */ } };
  const writeUpdate = () => { choose('activity'); requestAnimationFrame(() => root.current?.querySelector<HTMLTextAreaElement>('.activity .composer textarea')?.focus()); };
  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: 'threads', label: '策略线', count: threads.filter(thread => thread.state !== 'closed').length },
    { value: 'hill', label: '山丘图' },
    { value: 'activity', label: '动态', count: entries.filter(entry => entry.kind !== 'event').length },
  ];

  return (
    <div className="view" ref={root}>
      <header className="view-head project-head">
        <div className="view-title">
          {org && <button className="crumb" onClick={() => go({ kind: 'org', id: org.id })}><OrgMark org={org} />{org.name}</button>}
          <h1>{project.name}</h1>
          <button className="icon-btn" onClick={() => editProject(project.id)} aria-label="编辑项目" title="编辑项目"><Pencil size={13} /></button>
        </div>
        <div className="view-actions">
          <Dropdown
            label="健康度"
            value={project.health}
            onChange={health => void run(api => api.updateProject(project.id, { health }))}
            options={HEALTHS.map(value => ({ value, label: HEALTH_LABEL[value], icon: <HealthDot health={value} decorative /> }))}
          />
          <Dropdown
            label="项目状态"
            value={project.status}
            onChange={status => void run(api => api.updateProject(project.id, { status }))}
            options={STATUSES.map(value => ({ value, label: STATUS_LABEL[value] }))}
          />
          <button className="btn btn-primary" onClick={() => newThread({ projectId: project.id })}><Plus size={14} />新建策略线</button>
        </div>
      </header>
      <div className="project-brief">
        {project.goal ? <Markdown text={project.goal} className="project-goal" /> : <button className="summary-empty" onClick={() => editProject(project.id)}>添加目标</button>}
        <div className="brief-meta">
          {project.targetDate
            ? <TargetFact project={project} target={project.targetDate} now={now} onEdit={() => editProject(project.id)} />
            : <button className="brief-fact is-empty" onClick={() => editProject(project.id)}><CalendarDays size={13} />设定目标日期</button>}
          {!latest && <button className="brief-fact is-empty" onClick={writeUpdate}><MessageSquarePlus size={13} />写一条项目进展</button>}
        </div>
        {latest && (
          <button className="brief-update" onClick={() => choose('activity')}>
            <span className="brief-update-head">
              <strong>最新进展</strong>
              <span className={`health-label is-${latestHealth}`}><HealthDot health={latestHealth} decorative />{HEALTH_LABEL[latestHealth]}</span>
              <span className="muted">{relativeTime(latest.createdAt, now)}</span>
            </span>
            <span className="brief-update-body">{gist(latest.body)}</span>
            <ChevronRight size={14} className="brief-update-more" aria-hidden="true" />
          </button>
        )}
      </div>
      <nav className="tabs" aria-label="项目视图">
        {tabs.map(item => (
          <button key={item.value} className={tab === item.value ? 'is-current' : ''} aria-current={tab === item.value ? 'page' : undefined} onClick={() => choose(item.value)}>
            {item.label}{item.count ? <em>{item.count}</em> : null}
          </button>
        ))}
      </nav>
      <div className="view-body">
        {tab === 'threads' && <ThreadsView threads={threads} scope="project" projectId={project.id} />}
        {tab === 'hill' && <HillChart threads={threads} />}
        {tab === 'activity' && (
          <div className="activity">
            <Composer projectId={project.id} />
            <Timeline entries={entries} showThread />
          </div>
        )}
      </div>
    </div>
  );
}
