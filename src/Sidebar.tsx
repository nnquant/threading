import { useState } from 'react';
import { ChevronRight, Crosshair, ListTree, Plus, RotateCcw, Settings } from 'lucide-react';
import { useApp, type View } from './context';
import { todayIso } from './labels';
import { HealthDot, OrgMark } from './ui';
import { isOpen } from './workspace';
import type { Focus } from './workspace';

const COLLAPSE_KEY = 'threading.sidebar.collapsed.v1';
function readCollapsed(): string[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []; }
  catch { return []; }
}

export default function Sidebar({ focus, reviewCount, onSettings }: { focus: Focus; reviewCount: number; onSettings: () => void }) {
  const { index, view, go, newOrg, newProject, now } = useApp();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(readCollapsed()));
  const [showArchived, setShowArchived] = useState(false);
  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id); else next.add(id);
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next])); } catch { /* per-viewer convenience only */ }
  };
  const isView = (target: View) => view.kind === target.kind && ('id' in view ? 'id' in target && view.id === target.id : true);
  const dueNow = focus.due.filter(item => item.todo.due! <= todayIso(now)).length;
  const attention = dueNow + focus.stale.length + focus.noNext.length;
  const orgs = index.orgs.filter(org => showArchived || !org.archived);
  const hiddenCount = index.orgs.filter(org => org.archived).length
    + index.orgs.flatMap(org => index.projectsOf.get(org.id) ?? []).filter(project => project.status === 'archived').length;

  return (
    <nav className="sidebar" aria-label="导航">
      <div className="nav-group">
        <button className={`nav-item ${isView({ kind: 'focus' }) ? 'is-current' : ''}`} onClick={() => go({ kind: 'focus' })} title="Ctrl+1">
          <Crosshair size={15} /><span>焦点</span>{attention > 0 && <em>{attention}</em>}
        </button>
        <button className={`nav-item ${isView({ kind: 'threads' }) ? 'is-current' : ''}`} onClick={() => go({ kind: 'threads' })} title="Ctrl+2">
          <ListTree size={15} /><span>全部策略线</span>{focus.activeCount > 0 && <em>{focus.activeCount}</em>}
        </button>
        <button className={`nav-item ${isView({ kind: 'review' }) ? 'is-current' : ''}`} onClick={() => go({ kind: 'review' })} title="Ctrl+3">
          <RotateCcw size={15} /><span>周回顾</span>{reviewCount > 0 && <em>{reviewCount}</em>}
        </button>
      </div>

      <div className="nav-section">
        <span>组织</span>
        <button className="icon-btn icon-btn-sm" onClick={newOrg} aria-label="新建组织" title="新建组织"><Plus size={13} /></button>
      </div>
      <div className="nav-tree">
        {orgs.length === 0 && <button className="nav-empty" onClick={newOrg}>添加第一个组织，例如一个客户或你自己的自营研究。</button>}
        {orgs.map(org => {
          const projects = (index.projectsOf.get(org.id) ?? []).filter(project => showArchived || project.status !== 'archived');
          const folded = collapsed.has(org.id);
          return (
            <div key={org.id} className={`nav-org ${org.archived ? 'is-archived' : ''}`}>
              <div className={`nav-row nav-org-row ${isView({ kind: 'org', id: org.id }) ? 'is-current' : ''}`}>
                <button className={`nav-fold ${folded ? '' : 'is-open'}`} onClick={() => toggle(org.id)} aria-label={folded ? `展开 ${org.name}` : `收起 ${org.name}`} aria-expanded={!folded}>
                  <ChevronRight size={12} />
                </button>
                <button className="nav-link" onClick={() => go({ kind: 'org', id: org.id })}>
                  <OrgMark org={org} /><span className="truncate">{org.name}</span><small>{org.code}</small>
                </button>
                <button className="icon-btn icon-btn-sm nav-add" onClick={() => newProject(org.id)} aria-label={`在 ${org.name} 中新建项目`} title="新建项目"><Plus size={12} /></button>
              </div>
              {!folded && projects.map(project => {
                const open = (index.threadsOf.get(project.id) ?? []).filter(isOpen).length;
                return (
                  <button
                    key={project.id}
                    className={`nav-row nav-project ${isView({ kind: 'project', id: project.id }) ? 'is-current' : ''} ${project.status !== 'active' ? 'is-dim' : ''}`}
                    onClick={() => go({ kind: 'project', id: project.id })}
                  >
                    <HealthDot health={project.health} />
                    <span className="truncate">{project.name}</span>
                    {open > 0 && <em>{open}</em>}
                  </button>
                );
              })}
              {!folded && projects.length === 0 && <button className="nav-row nav-project nav-hint" onClick={() => newProject(org.id)}>新建项目</button>}
            </div>
          );
        })}
      </div>

      <div className="nav-foot">
        <button className="nav-item" onClick={onSettings}><Settings size={15} /><span>设置</span></button>
        {hiddenCount > 0 && (
          <button className="link-btn nav-archived" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? '隐藏已归档' : `显示已归档（${hiddenCount}）`}
          </button>
        )}
      </div>
    </nav>
  );
}
