import { Pencil, Plus } from 'lucide-react';
import { useApp } from './context';
import { HEALTH_LABEL, STAGE_LABEL, STATUS_LABEL, relativeTime, targetLabel, todayIso } from './labels';
import { EmptyState, HealthDot, Markdown, OrgMark } from './ui';
import { isOpen, nextTodo } from './workspace';
import { STAGES, type Id, type Thread } from './types';

/** Open threads of a project laid along the stage line: one knot per thread, stacked per stage. */
function StageSpread({ threads }: { threads: Thread[] }) {
  return (
    <span className="stage-spread" aria-label={STAGES.map(stage => `${STAGE_LABEL[stage]} ${threads.filter(thread => thread.stage === stage).length}`).join('，')}>
      {STAGES.map(stage => {
        const count = threads.filter(thread => thread.stage === stage).length;
        return (
          <span key={stage} className={`spread-col stage-${stage}`} title={`${STAGE_LABEL[stage]}：${count} 条`}>
            {Array.from({ length: Math.min(count, 4) }, (_, i) => <i key={i} />)}
            {count > 4 && <small>+{count - 4}</small>}
          </span>
        );
      })}
    </span>
  );
}

export default function OrgView({ id }: { id: Id }) {
  const { index, go, newProject, editOrg, now } = useApp();
  const org = index.org.get(id);
  if (!org) return null;
  const projects = index.projectsOf.get(org.id) ?? [];
  return (
    <div className="view">
      <header className="view-head">
        <div className="view-title">
          <OrgMark org={org} />
          <h1>{org.name}</h1>
          <span className="view-code">{org.code}</span>
          {org.demo && <span className="pill">示例</span>}
          {org.archived && <span className="pill">已归档</span>}
          <button className="icon-btn" onClick={() => editOrg(org.id)} aria-label="编辑组织" title="编辑组织"><Pencil size={13} /></button>
        </div>
        <div className="view-actions">
          <button className="btn btn-primary" onClick={() => newProject(org.id)}><Plus size={14} />新建项目</button>
        </div>
      </header>
      {org.note && <div className="project-brief"><Markdown text={org.note} className="project-goal" /></div>}
      <div className="view-body">
        {projects.length === 0
          ? <EmptyState title="还没有策略项目" action={<button className="btn btn-primary" onClick={() => newProject(org.id)}><Plus size={14} />新建项目</button>}>项目是你为这个组织做的一件事，比如一个指数增强产品或一套 CTA 组合，下面再分出多条策略线。</EmptyState>
          : (
            <div className="project-list">
              <div className="project-row project-row-head" aria-hidden="true">
                <span />
                <span>项目</span>
                <span className="spread-head">{STAGES.map(stage => <span key={stage}>{STAGE_LABEL[stage]}</span>)}</span>
                <span>进行中</span>
                <span>需要关注</span>
                <span>目标日期</span>
                <span className="align-right">最近更新</span>
              </div>
              {projects.map(project => {
                const threads = index.threadsOf.get(project.id) ?? [];
                const open = threads.filter(isOpen);
                const waiting = threads.filter(thread => thread.state === 'waiting').length;
                const missing = threads.filter(thread => thread.state === 'active' && !nextTodo(index, thread.id)).length;
                const latest = Math.max(project.updatedAt, ...threads.map(thread => thread.lastActivityAt));
                return (
                  <button key={project.id} className={`project-row ${project.status !== 'active' ? 'is-dim' : ''}`} onClick={() => go({ kind: 'project', id: project.id })}>
                    <HealthDot health={project.health} />
                    <span className="project-name">
                      <strong className="truncate">{project.name}</strong>
                      <span className="truncate muted">{project.status !== 'active' ? `${STATUS_LABEL[project.status]} ` : ''}{project.goal.split('\n')[0] || HEALTH_LABEL[project.health]}</span>
                    </span>
                    <StageSpread threads={open} />
                    <span className="num">{open.length}</span>
                    <span className="attention">
                      {waiting > 0 && <span>{waiting} 条等待</span>}
                      {missing > 0 && <span className="is-missing">{missing} 条缺少下一步</span>}
                      {!waiting && !missing && <span className="muted">—</span>}
                    </span>
                    <span className={project.targetDate && project.targetDate < todayIso(now) && project.status === 'active' ? 'is-overdue' : 'muted'} title={project.targetDate ?? undefined}>{project.targetDate ? targetLabel(project.targetDate, now).split('，')[1] : '—'}</span>
                    <span className="muted align-right">{relativeTime(latest, now)}</span>
                  </button>
                );
              })}
            </div>
          )}
      </div>
    </div>
  );
}
