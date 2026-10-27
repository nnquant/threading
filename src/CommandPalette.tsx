import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Building2, Crosshair, FlaskConical, FolderKanban, GitBranch, ListTree, Plus, RotateCcw, Search, Settings, Trash2 } from 'lucide-react';
import { useApp } from './context';
import { STAGE_LABEL, STATE_LABEL } from './labels';
import { HealthDot, OrgMark, StageIcon } from './ui';
import { ancestorsOf, matchesThread } from './workspace';

interface Item { id: string; group: string; label: string; detail?: string; icon: ReactNode; run: () => void }

// Sample data has no visible entry: typing one of these words in full is the only way to add or clear it.
const ENABLE_SAMPLE_DATA = 'ENABLE_SAMPLE_DATA';
const DISABLE_SAMPLE_DATA = 'DISABLE_SAMPLE_DATA';

export default function CommandPalette({ onClose, onSettings }: { onClose: () => void; onSettings: () => void }) {
  const { index, workspace, selected, go, openThread, newThread, newProject, newOrg, addDemo, clearDemo } = useApp();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const word = query.trim().toUpperCase();
    if (word === ENABLE_SAMPLE_DATA) return [{ id: 'add-demo', group: '命令', label: '添加示例数据', icon: <FlaskConical size={14} />, run: addDemo }];
    if (word === DISABLE_SAMPLE_DATA) return [{ id: 'clear-demo', group: '命令', label: '清理示例数据', icon: <Trash2 size={14} />, run: clearDemo }];
    const needle = query.trim().toLocaleLowerCase();
    const has = (...texts: (string | undefined)[]) => !needle || texts.some(text => text?.toLocaleLowerCase().includes(needle));
    const open = selected ? index.thread.get(selected) : undefined;
    const actions: Item[] = [
      { id: 'new-thread', group: '操作', label: '新建策略线', detail: 'N', icon: <Plus size={14} />, run: () => newThread() },
      ...(open ? [{
        id: 'new-sub-thread', group: '操作', label: `在「${open.title}」下新建子策略线`, detail: 'Shift+N', icon: <GitBranch size={14} />,
        run: () => newThread({ projectId: open.projectId, parentId: open.id, stage: open.stage }),
      }] : []),
      { id: 'new-project', group: '操作', label: '新建项目', icon: <Plus size={14} />, run: () => newProject() },
      { id: 'new-org', group: '操作', label: '新建组织', icon: <Plus size={14} />, run: newOrg },
      { id: 'focus', group: '操作', label: '打开焦点', detail: 'Ctrl+1', icon: <Crosshair size={14} />, run: () => go({ kind: 'focus' }) },
      { id: 'threads', group: '操作', label: '打开全部策略线', detail: 'Ctrl+2', icon: <ListTree size={14} />, run: () => go({ kind: 'threads' }) },
      { id: 'review', group: '操作', label: '开始周回顾', detail: 'Ctrl+3', icon: <RotateCcw size={14} />, run: () => go({ kind: 'review' }) },
      { id: 'settings', group: '操作', label: '设置', icon: <Settings size={14} />, run: onSettings },
    ].filter(item => has(item.label));
    const threads: Item[] = workspace.threads
      .filter(thread => matchesThread(index, thread, query))
      .sort((a, b) => (a.state === 'closed' ? 1 : 0) - (b.state === 'closed' ? 1 : 0) || b.lastActivityAt - a.lastActivityAt)
      .slice(0, needle ? 30 : 8)
      .map(thread => {
        const project = index.project.get(thread.projectId);
        const org = project && index.org.get(project.orgId);
        const parent = ancestorsOf(index, thread).pop();
        return {
          id: thread.id, group: needle ? '策略线' : '最近推进的策略线', label: thread.title,
          detail: `${[org?.code ?? '', project?.name ?? '', ...(parent ? [parent.title] : [])].join(' / ')}，${STAGE_LABEL[thread.stage]}${thread.state !== 'active' ? `，${STATE_LABEL[thread.state]}` : ''}`,
          icon: <StageIcon stage={thread.stage} />, run: () => openThread(thread.id),
        };
      });
    const projects: Item[] = needle ? [...index.project.values()]
      .filter(project => has(project.name, index.org.get(project.orgId)?.name))
      .slice(0, 10)
      .map(project => ({ id: project.id, group: '项目', label: project.name, detail: index.org.get(project.orgId)?.name, icon: <HealthDot health={project.health} />, run: () => go({ kind: 'project', id: project.id }) })) : [];
    const orgs: Item[] = needle ? index.orgs
      .filter(org => has(org.name, org.code))
      .map(org => ({ id: org.id, group: '组织', label: org.name, detail: org.code, icon: <OrgMark org={org} />, run: () => go({ kind: 'org', id: org.id }) })) : [];
    const creating = actions.filter(item => item.id.startsWith('new-')).length;
    return needle ? [...threads, ...projects, ...orgs, ...actions] : [...actions.slice(0, creating), ...threads, ...actions.slice(creating)];
  }, [query, workspace.threads, index, selected, go, openThread, newThread, newProject, newOrg, onSettings, addDemo, clearDemo]);

  const choose = (item: Item | undefined) => { if (!item) return; onClose(); item.run(); };
  const scrollTo = (at: number) => list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' });
  const groups = items.reduce<{ group: string; items: (Item & { at: number })[] }[]>((acc, item, at) => {
    const last = acc[acc.length - 1];
    if (last?.group === item.group) last.items.push({ ...item, at }); else acc.push({ group: item.group, items: [{ ...item, at }] });
    return acc;
  }, []);

  return (
    <div className="backdrop is-top" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="搜索与命令">
        <div className="palette-search">
          <Search size={15} />
          <input
            autoFocus
            value={query}
            placeholder="搜索策略线、项目、组织，或输入命令"
            aria-label="搜索"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `palette-${active}` : undefined}
            onChange={event => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
              else if (event.key === 'ArrowDown') { event.preventDefault(); const next = Math.min(items.length - 1, active + 1); setActive(next); scrollTo(next); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); const next = Math.max(0, active - 1); setActive(next); scrollTo(next); }
              else if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); choose(items[active]); }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {items.length === 0 && <p className="palette-empty">没有找到「{query}」</p>}
          {groups.map((group, at) => (
            <div key={`${at}-${group.group}`} className="palette-group" role="group" aria-label={group.group}>
              <h3>{group.group === '组织' ? <Building2 size={11} /> : group.group === '项目' ? <FolderKanban size={11} /> : null}{group.group}</h3>
              {group.items.map(item => (
                <div
                  key={item.id}
                  id={`palette-${item.at}`}
                  data-index={item.at}
                  role="option"
                  aria-selected={item.at === active}
                  className={`palette-item ${item.at === active ? 'is-active' : ''}`}
                  onMouseMove={() => item.at !== active && setActive(item.at)}
                  onClick={() => choose(item)}
                >
                  <span className="palette-icon">{item.icon}</span>
                  <span className="palette-label truncate">{item.label}</span>
                  {item.detail && <span className="palette-detail truncate">{item.detail}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
