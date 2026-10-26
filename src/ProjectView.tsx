import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { useApp } from './context';
import HillChart from './HillChart';
import { HEALTHS, HEALTH_LABEL, STATUSES, STATUS_LABEL, relativeTime, targetLabel, todayIso } from './labels';
import ThreadsView from './ThreadsView';
import { Composer, Timeline } from './Timeline';
import { Dropdown, HealthDot, Markdown, OrgMark } from './ui';
import type { Id } from './types';

type Tab = 'threads' | 'hill' | 'activity';
const TAB_KEY = 'threading.project.tab.v1';

export default function ProjectView({ id }: { id: Id }) {
  const { index, run, go, newThread, editProject, now } = useApp();
  const [tab, setTab] = useState<Tab>(() => { try { return (localStorage.getItem(TAB_KEY) as Tab) || 'threads'; } catch { return 'threads'; } });
  const project = index.project.get(id);
  if (!project) return null;
  const org = index.org.get(project.orgId);
  const threads = index.threadsOf.get(project.id) ?? [];
  const entries = index.projectEntries.get(project.id) ?? [];
  const latest = entries.find(entry => entry.kind === 'update');
  const choose = (next: Tab) => { setTab(next); try { localStorage.setItem(TAB_KEY, next); } catch { /* per-viewer convenience only */ } };
  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: 'threads', label: '策略线', count: threads.filter(thread => thread.state !== 'closed').length },
    { value: 'hill', label: '山丘图' },
    { value: 'activity', label: '动态', count: entries.filter(entry => entry.kind !== 'event').length },
  ];

  return (
    <div className="view">
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
        {project.goal ? <Markdown text={project.goal} className="project-goal" /> : <button className="summary-empty" onClick={() => editProject(project.id)}>写下这个项目要达成的目标</button>}
        <dl>
          {project.targetDate && <><dt>目标日期</dt><dd className={project.targetDate < todayIso(now) && project.status === 'active' ? 'is-overdue' : ''}>{targetLabel(project.targetDate, now)}</dd></>}
          {latest && <><dt>最新进展</dt><dd><span className={`health-label is-${latest.health ?? project.health}`}>{HEALTH_LABEL[latest.health ?? project.health]}</span>{relativeTime(latest.createdAt, now)}：{latest.body.split('\n')[0]}</dd></>}
        </dl>
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
            <Timeline entries={entries} showThread empty="还没有动态。写一条项目进展，记下它现在是否在轨道上。" />
          </div>
        )}
      </div>
    </div>
  );
}
