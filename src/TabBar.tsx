import { useEffect, useRef, type ReactNode } from 'react';
import { Crosshair, FilePenLine, FileText, ListTree, RotateCcw, X } from 'lucide-react';
import { useApp } from './context';
import { KIND_LABEL, gist, titleOf } from './labels';
import type { Tab } from './tabs';
import { HealthDot, OrgMark } from './ui';

/** Icon and name of a tab, from what it shows right now. */
export function useTabLabel() {
  const { index, workspace } = useApp();
  return (tab: Tab): { icon: ReactNode; label: string } => {
    if (tab.kind === 'project') {
      const project = index.project.get(tab.projectId);
      return { icon: project ? <HealthDot health={project.health} decorative /> : null, label: project?.name ?? '已删除的项目' };
    }
    if (tab.kind === 'record') {
      const entry = workspace.entries.find(row => row.id === tab.entryId);
      const where = entry && ((entry.threadId ? index.thread.get(entry.threadId)?.title : index.project.get(entry.projectId)?.name) ?? '已删除');
      // Named by its title, or else by how it begins.
      return { icon: <FileText size={13} />, label: entry ? gist(entry.body) || `${KIND_LABEL[entry.kind]}：${where}` : '已删除的记录' };
    }
    if (tab.kind === 'editor') {
      const { draft } = tab;
      const entry = draft.entryId ? workspace.entries.find(row => row.id === draft.entryId) : undefined;
      const where = (entry && titleOf(entry.body).title)
        ?? (draft.threadId ? index.thread.get(draft.threadId)?.title : index.project.get(draft.projectId)?.name) ?? '已删除';
      const kind = draft.entryId ? `编辑${KIND_LABEL[entry?.kind ?? draft.kind]}` : KIND_LABEL[draft.kind];
      return { icon: <FilePenLine size={13} />, label: `${kind}：${where}` };
    }
    const { view } = tab;
    if (view.kind === 'org') {
      const org = index.org.get(view.id);
      return { icon: org ? <OrgMark org={org} /> : null, label: org?.name ?? '组织' };
    }
    if (view.kind === 'threads') return { icon: <ListTree size={13} />, label: '全部策略线' };
    if (view.kind === 'review') return { icon: <RotateCcw size={13} />, label: '周回顾' };
    return { icon: <Crosshair size={13} />, label: '焦点' };
  };
}

export default function TabBar({ tabs, active, onSelect, onClose }: {
  tabs: Tab[]; active: string; onSelect: (id: string) => void; onClose: (id: string) => void;
}) {
  const describe = useTabLabel();
  const strip = useRef<HTMLDivElement>(null);
  // Keep the current tab in view when the strip scrolls.
  useEffect(() => { strip.current?.querySelector<HTMLElement>('.tab.is-active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [active, tabs.length]);
  return (
    <div className="tabbar" role="tablist" aria-label="标签页" ref={strip}>
      {tabs.map(tab => {
        const { icon, label } = describe(tab);
        const current = tab.id === active;
        const closable = tab.kind !== 'home';
        return (
          <div key={tab.id} className={`tab is-${tab.kind} ${current ? 'is-active' : ''}`} onAuxClick={event => { if (event.button === 1 && closable) { event.preventDefault(); onClose(tab.id); } }}>
            <button type="button" role="tab" aria-selected={current} className="tab-main" title={label} onClick={() => onSelect(tab.id)}>
              <span className="tab-icon">{icon}</span>
              <span className="truncate">{label}</span>
            </button>
            {closable && (
              <button type="button" className="tab-close" aria-label={`关闭 ${label}`} title="关闭（Ctrl+W）" tabIndex={current ? 0 : -1} onClick={() => onClose(tab.id)}>
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
