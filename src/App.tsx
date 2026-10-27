import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Check, CircleAlert, LoaderCircle, Plus, Search, X } from 'lucide-react';
import { appWindow, createApi, desktop, isDesktop, type Api } from './bridge';
import CommandPalette from './CommandPalette';
import { Ctx, type AppContext, type ConfirmRequest, type NewThreadPreset, type Notice, type View } from './context';
import { ConfirmDialog, OrgDialog, ProjectDialog, SettingsDialog, ThreadDialog } from './dialogs';
import FocusView from './FocusView';
import OrgView from './OrgView';
import ProjectView from './ProjectView';
import ReviewView from './ReviewView';
import Sidebar from './Sidebar';
import TabBar from './TabBar';
import { dropDraft, newTabId, readDraft, readTabs, sameTarget, saveTabs, writeDraft, type Draft, type EditorTab, type Tab, type Tabs } from './tabs';
import ThreadPanel from './ThreadPanel';
import ThreadsView from './ThreadsView';
import { applyChange, buildIndex, focusOf, reviewQueue } from './workspace';
import type { Change, Id, Workspace } from './types';
import { version } from '../package.json';
import './App.css';

// The editor pulls in the rich-text engine, so it loads the first time a draft is opened.
const EditorView = lazy(() => import('./Editor'));

type DialogState =
  | { kind: 'thread'; preset: NewThreadPreset }
  | { kind: 'project'; id?: Id; orgId?: Id }
  | { kind: 'org'; id?: Id }
  | { kind: 'settings' };

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const isWindowChrome = (target: EventTarget) => !(target instanceof Element && target.closest('button, input, select, a, [role="dialog"]'));
const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || !!target.closest('input, textarea, select'));
const viewOf = (tab: Tab): View => tab.kind === 'home' ? tab.view : tab.kind === 'project' ? { kind: 'project', id: tab.projectId } : { kind: 'editor', id: tab.id };
const withSelected = (tab: Tab, id: Id | null): Tab => tab.kind === 'editor' ? tab : { ...tab, selected: id };

export default function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tabState, setTabState] = useState<Tabs>(readTabs);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [palette, setPalette] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [now, setNow] = useState(Date.now);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const next = await createApi();
      setApi(next);
      setWorkspace(await next.loadWorkspace());
    } catch (error) { setLoadError(messageOf(error)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);

  const notify = useCallback((next: Notice) => {
    clearTimeout(noticeTimer.current);
    setNotice(next);
    noticeTimer.current = setTimeout(() => setNotice(null), next.action ? 6500 : next.error ? 8000 : 3500);
  }, []);
  const run = useCallback(async (task: (api: Api) => Promise<Change>, options?: { silent?: boolean }) => {
    if (!api) return null;
    try {
      const change = await task(api);
      setWorkspace(current => current && applyChange(current, change));
      setNow(Date.now());
      return change;
    } catch (error) {
      if (!options?.silent) notify({ text: messageOf(error), error: true });
      return null;
    }
  }, [api, notify]);

  const index = useMemo(() => workspace && buildIndex(workspace), [workspace]);
  const focus = useMemo(() => workspace && index && focusOf(workspace, index, now), [workspace, index, now]);
  const reviewCount = useMemo(() => workspace && index ? reviewQueue(workspace, index, now).length : 0, [workspace, index, now]);

  // Tabs: the home tab shows focus, all lines, review and organizations; each project and each draft gets a tab of its own.
  const tabsRef = useRef(tabState);
  tabsRef.current = tabState;
  useEffect(() => saveTabs(tabState), [tabState]);
  const { tabs } = tabState;
  const current = tabs.find(tab => tab.id === tabState.active) ?? tabs[0];
  const view = viewOf(current);
  const selected = current.kind === 'editor' ? null : current.selected;
  const editors = useMemo(() => tabs.filter((tab): tab is EditorTab => tab.kind === 'editor'), [tabs]);

  const showTab = useCallback((id: string) => setTabState(state => state.tabs.some(tab => tab.id === id) && state.active !== id ? { ...state, active: id } : state), []);
  const go = useCallback((next: View) => setTabState(state => {
    if (next.kind === 'editor') return state.tabs.some(tab => tab.id === next.id) ? { ...state, active: next.id } : state;
    if (next.kind === 'project') {
      const open = state.tabs.find(tab => tab.kind === 'project' && tab.projectId === next.id);
      if (open) return { ...state, active: open.id };
      const tab: Tab = { id: newTabId(), kind: 'project', projectId: next.id, selected: null };
      return { tabs: [...state.tabs, tab], active: tab.id };
    }
    return { tabs: state.tabs.map(tab => tab.kind === 'home' ? { ...tab, view: next } : tab), active: 'home' };
  }), []);
  const selectIn = useCallback((tabId: string, id: Id | null) => setTabState(state => ({
    ...state, tabs: state.tabs.map(tab => tab.id === tabId ? withSelected(tab, id) : tab),
  })), []);
  const openThread = useCallback((id: Id | null) => {
    const here = tabsRef.current.tabs.find(tab => tab.id === tabsRef.current.active);
    if (here && here.kind !== 'editor') { selectIn(here.id, id); return; }
    // From an editor tab, a line opens in its project's tab.
    const projectId = id ? index?.thread.get(id)?.projectId : undefined;
    if (!id || !projectId) return;
    setTabState(state => {
      const open = state.tabs.find(tab => tab.kind === 'project' && tab.projectId === projectId);
      if (open) return { tabs: state.tabs.map(tab => tab.id === open.id ? withSelected(tab, id) : tab), active: open.id };
      const tab: Tab = { id: newTabId(), kind: 'project', projectId, selected: id };
      return { tabs: [...state.tabs, tab], active: tab.id };
    });
  }, [index, selectIn]);

  const closeTab = useCallback((id: string, options?: { saved?: boolean }) => {
    const tab = tabsRef.current.tabs.find(row => row.id === id);
    if (!tab || tab.kind === 'home') return;
    const remove = () => {
      if (tab.kind === 'editor') dropDraft(id);
      setTabState(state => {
        const at = state.tabs.findIndex(row => row.id === id);
        if (at < 0) return state;
        const rest = state.tabs.filter(row => row.id !== id);
        if (state.active !== id) return { ...state, tabs: rest };
        const back = tab.kind === 'editor' && tab.from && rest.some(row => row.id === tab.from) ? tab.from : rest[Math.max(0, at - 1)].id;
        return { tabs: rest, active: back };
      });
    };
    if (tab.kind === 'editor' && !options?.saved && readDraft(id).trim()) {
      setConfirmRequest({ title: '放弃这份草稿？', body: '草稿里的文字会被删除，无法恢复。已插入的图片仍保存在数据目录里。', confirmLabel: '放弃草稿', onConfirm: remove });
      return;
    }
    remove();
  }, []);
  const openEditor = useCallback((draft: Draft, body = '') => {
    const text = body.trim() ? body : '';
    const open = tabsRef.current.tabs.find((tab): tab is EditorTab => tab.kind === 'editor' && sameTarget(tab.draft, draft));
    // An entry already being edited keeps its own text; a new record collects what each composer hands over.
    if (open && draft.entryId) { showTab(open.id); return; }
    if (open) {
      setTabState(state => ({
        tabs: text ? state.tabs.map(tab => tab.id === open.id && tab.kind === 'editor'
          ? { ...tab, inbox: { text: tab.inbox ? `${tab.inbox.text}\n\n${text}` : text, at: Date.now() } }
          : tab) : state.tabs,
        active: open.id,
      }));
      return;
    }
    const id = newTabId();
    writeDraft(id, text);
    setTabState(state => ({ tabs: [...state.tabs, { id, kind: 'editor', draft, from: state.active }], active: id }));
  }, [showTab]);
  const patchDraft = useCallback((tabId: string, patch: Partial<Draft>) => setTabState(state => ({
    ...state, tabs: state.tabs.map(tab => tab.id === tabId && tab.kind === 'editor' ? { ...tab, draft: { ...tab.draft, ...patch } } : tab),
  })), []);
  const clearInbox = useCallback((tabId: string) => setTabState(state => state.tabs.some(tab => tab.id === tabId && tab.kind === 'editor' && tab.inbox)
    ? { ...state, tabs: state.tabs.map(tab => tab.id === tabId && tab.kind === 'editor' ? { ...tab, inbox: undefined } : tab) }
    : state), []);

  // Close tabs whose project was deleted and panels whose line was; editor tabs stay so the text can still be copied.
  useEffect(() => {
    if (!index) return;
    setTabState(state => {
      let changed = false;
      const next = state.tabs.flatMap((tab): Tab[] => {
        if (tab.kind === 'project' && !index.project.has(tab.projectId)) { changed = true; return []; }
        let kept = tab;
        if (kept.kind === 'home' && kept.view.kind === 'org' && !index.org.has(kept.view.id)) { changed = true; kept = { ...kept, view: { kind: 'focus' } }; }
        if (kept.kind !== 'editor' && kept.selected && !index.thread.has(kept.selected)) { changed = true; kept = withSelected(kept, null); }
        return [kept];
      });
      if (!changed) return state;
      return { tabs: next, active: next.some(tab => tab.id === state.active) ? state.active : 'home' };
    });
  }, [index]);

  const newThread = useCallback((preset: NewThreadPreset = {}) => {
    const fallback = view.kind === 'project' ? view.id
      : current.kind === 'editor' ? current.draft.projectId
        : selected ? index?.thread.get(selected)?.projectId : undefined;
    setDialog({ kind: 'thread', preset: { ...preset, projectId: preset.projectId ?? fallback } });
  }, [view, current, selected, index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const modal = !!dialog || !!confirmRequest;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'k') {
        // The editor takes Ctrl+K for links.
        if (modal || event.defaultPrevented) return;
        event.preventDefault();
        setPalette(open => !open);
        return;
      }
      if (modal || palette || event.defaultPrevented) return;
      if (mod && ['1', '2', '3'].includes(event.key)) {
        event.preventDefault();
        go([{ kind: 'focus' }, { kind: 'threads' }, { kind: 'review' }][Number(event.key) - 1] as View);
        return;
      }
      if (mod && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        // Blurring first lets an editor save what was just typed before it is asked about.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        closeTab(current.id);
        return;
      }
      if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault();
        const at = tabs.indexOf(current);
        showTab(tabs[(at + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id);
        return;
      }
      if (isTyping(event.target)) return;
      if (event.key === 'Escape' && selected) { selectIn(current.id, null); return; }
      if (event.key.toLowerCase() === 'n' && !mod && !event.altKey && workspace) {
        event.preventDefault();
        // Shift+N branches a sub-line off the open line.
        const parent = event.shiftKey && selected ? index?.thread.get(selected) : undefined;
        newThread(parent ? { projectId: parent.projectId, parentId: parent.id, stage: parent.stage } : {});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, confirmRequest, palette, selected, current, tabs, go, showTab, closeTab, selectIn, newThread, workspace, index]);

  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = () => { void appWindow.isMaximized().then(value => { if (!disposed) setMaximized(value); }).catch(() => {}); };
    sync();
    appWindow.onResized(sync).then(cleanup => { if (disposed) cleanup(); else unlisten = cleanup; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, []);
  // Title bar: drag only once the pointer moves, so double-clicks always reach the page.
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const titlebarMouseDown = (event: ReactMouseEvent) => {
    dragOrigin.current = event.button === 0 && event.detail === 1 && isWindowChrome(event.target) ? { x: event.clientX, y: event.clientY } : null;
  };
  const titlebarMouseMove = (event: ReactMouseEvent) => {
    const origin = dragOrigin.current;
    if (!origin) return;
    if ((event.buttons & 1) === 0) { dragOrigin.current = null; return; }
    if (Math.abs(event.clientX - origin.x) + Math.abs(event.clientY - origin.y) < 4) return;
    dragOrigin.current = null;
    void appWindow.startDragging();
  };
  const titlebarDoubleClick = (event: ReactMouseEvent) => {
    dragOrigin.current = null;
    if (isWindowChrome(event.target)) void appWindow.toggleMaximize();
  };

  const addDemo = useCallback(async () => {
    const { demoSeed } = await import('./demo');
    const change = await run(api => api.importDemoData(demoSeed(Date.now())));
    if (change) notify({ text: `已添加 ${change.organizations?.length ?? 0} 个示例组织` });
  }, [run, notify]);
  const clearDemo = useCallback(() => {
    const demos = workspace?.organizations.filter(org => org.demo) ?? [];
    if (!demos.length) { notify({ text: '没有示例数据' }); return; }
    setConfirmRequest({
      title: '清理示例数据？',
      body: `将删除 ${demos.length} 个示例组织（${demos.map(org => org.name).join('、')}）及其下的全部项目、策略线、待办和记录，包括你在这些组织里新加的内容。其他数据不受影响。`,
      confirmLabel: '清理示例数据',
      onConfirm: async () => { if (await run(api => api.clearDemoData())) notify({ text: '已清理示例数据' }); },
    });
  }, [workspace, run, notify]);

  const context: AppContext | null = workspace && index && api ? {
    workspace, index, now, view, go, selected, api, run, notify, newThread, openThread,
    editors, openEditor, patchDraft, clearInbox, showTab, closeTab,
    newProject: orgId => setDialog({ kind: 'project', orgId }),
    editProject: id => setDialog({ kind: 'project', id }),
    newOrg: () => setDialog({ kind: 'org' }),
    editOrg: id => setDialog({ kind: 'org', id }),
    confirm: setConfirmRequest,
    addDemo: () => void addDemo(),
    clearDemo,
  } : null;

  // "All threads" keeps paused and finished projects in view; only archived projects and organizations drop out.
  const listedThreads = workspace && index ? workspace.threads.filter(thread => {
    const project = index.project.get(thread.projectId);
    return !!project && project.status !== 'archived' && !index.org.get(project.orgId)?.archived;
  }) : [];
  const activeProjects = workspace ? workspace.projects.filter(project => project.status === 'active').length : 0;
  const overLimit = !!focus && workspace!.settings.wipLimit > 0 && focus.activeCount > workspace!.settings.wipLimit;

  const contentOf = (tab: Exclude<Tab, EditorTab>) => {
    if (tab.kind === 'project') return <ProjectView key={tab.projectId} id={tab.projectId} />;
    const { view: shown } = tab;
    if (shown.kind === 'focus') return <FocusView focus={focus!} />;
    if (shown.kind === 'review') return <ReviewView />;
    if (shown.kind === 'org') return <OrgView key={shown.id} id={shown.id} />;
    return (
      <div className="view">
        <header className="view-head">
          <div className="view-title"><h1>全部策略线</h1></div>
          <div className="view-actions"><button className="btn btn-primary" onClick={() => newThread()}><Plus size={14} />新建策略线</button></div>
        </header>
        <div className="view-body"><ThreadsView threads={listedThreads} scope="all" /></div>
      </div>
    );
  };

  return (
    <div className={`app ${isDesktop && !maximized ? 'is-framed' : ''}`}>
      <header className="titlebar" onMouseDown={titlebarMouseDown} onMouseMove={titlebarMouseMove} onMouseUp={() => { dragOrigin.current = null; }} onDoubleClick={titlebarDoubleClick}>
        <div className="wordmark" aria-label="Threading 策略线">
          <svg className="wordmark-icon" viewBox="0 0 64 64" aria-hidden="true">
            <path d="M9 43h16c9 0 16-6 16-15a9 9 0 1 0-18 0c0 9 7 15 16 15h16" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Threading
        </div>
        {context
          ? <Ctx.Provider value={context}><TabBar tabs={tabs} active={current.id} onSelect={showTab} onClose={closeTab} /></Ctx.Provider>
          : <div className="tabbar" />}
        <button className="search-trigger" onClick={() => setPalette(true)} disabled={!context} aria-label="搜索或跳转" title="搜索或跳转（Ctrl+K）">
          <Search size={13} /><span>搜索或跳转</span>
        </button>
        <div className="titlebar-actions">
          <button className="btn btn-primary" onClick={() => newThread()} disabled={!context}><Plus size={14} />新建策略线</button>
        </div>
        {isDesktop && (
          <div className="window-controls">
            <button aria-label="最小化" title="最小化" onClick={() => void appWindow.minimize()}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" /></svg>
            </button>
            <button aria-label={maximized ? '向下还原' : '最大化'} title={maximized ? '向下还原' : '最大化'} onClick={() => void appWindow.toggleMaximize()}>
              {maximized
                ? <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" fill="none" stroke="currentColor" /></svg>
                : <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M.5.5h9v9h-9z" fill="none" stroke="currentColor" /></svg>}
            </button>
            <button className="window-close" aria-label="关闭" title="关闭" onClick={() => void appWindow.close()}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M.5.5l9 9m0-9l-9 9" stroke="currentColor" /></svg>
            </button>
          </div>
        )}
      </header>

      {!isDesktop && <div className="banner"><CircleAlert size={13} />浏览器预览，改动只保存在本浏览器</div>}

      {context && focus ? (
        <Ctx.Provider value={context}>
          <div className="shell">
            <Sidebar focus={focus} reviewCount={reviewCount} onSettings={() => setDialog({ kind: 'settings' })} />
            <div className="panes">
              {tabs.map(tab => {
                const shown = tab === current;
                // Every tab keeps its own view state and side panel; hidden tabs stay mounted so scroll and drafts survive.
                const paneSelected = tab.kind === 'editor' ? null : tab.selected;
                const scope: AppContext = { ...context, view: viewOf(tab), selected: paneSelected, openThread: tab.kind === 'editor' ? openThread : id => selectIn(tab.id, id) };
                return (
                  <Ctx.Provider key={tab.id} value={scope}>
                    <section className={`pane ${paneSelected ? 'has-panel' : ''}`} hidden={!shown} data-tab={tab.kind}>
                      {tab.kind === 'editor'
                        ? <Suspense fallback={<div className="loading"><LoaderCircle size={18} className="spin" /></div>}><EditorView tab={tab} active={shown} /></Suspense>
                        : (
                          <>
                            <main className="main">{contentOf(tab)}</main>
                            {paneSelected && <ThreadPanel key={paneSelected} id={paneSelected} onClose={() => selectIn(tab.id, null)} />}
                          </>
                        )}
                    </section>
                  </Ctx.Provider>
                );
              })}
            </div>
          </div>
          {palette && <CommandPalette onClose={() => setPalette(false)} onSettings={() => setDialog({ kind: 'settings' })} />}
          {dialog?.kind === 'thread' && <ThreadDialog preset={dialog.preset} onClose={() => setDialog(null)} />}
          {dialog?.kind === 'project' && <ProjectDialog id={dialog.id} orgId={dialog.orgId} onClose={() => setDialog(null)} />}
          {dialog?.kind === 'org' && <OrgDialog id={dialog.id} onClose={() => setDialog(null)} />}
          {dialog?.kind === 'settings' && <SettingsDialog onClose={() => setDialog(null)} />}
          {confirmRequest && <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(null)} />}
        </Ctx.Provider>
      ) : (
        <div className="loading">
          {loadError
            ? <><CircleAlert size={18} className="danger" /><strong>无法打开数据</strong><p>{loadError}</p><button className="btn" onClick={() => void load()}>重试</button></>
            : <><LoaderCircle size={18} className="spin" /><span className="muted">正在打开数据…</span></>}
        </div>
      )}

      <footer className="statusbar" aria-live="polite">
        <span className="status-item"><span className={`dot ${loadError ? 'is-error' : isDesktop ? 'is-ok' : 'off'}`} />{loadError ? '数据未打开' : isDesktop ? '已保存到本机' : '浏览器预览'}</span>
        {workspace && <span className="status-item">{workspace.organizations.filter(org => !org.archived).length} 个组织</span>}
        {workspace && <span className="status-item">{activeProjects} 个进行中的项目</span>}
        {focus && (
          <span className={`status-item ${overLimit ? 'is-warn' : ''}`} title="进行中的策略线 / 设定的上限">
            {focus.activeCount} 条进行中{workspace!.settings.wipLimit > 0 ? `，上限 ${workspace!.settings.wipLimit}` : ''}
          </span>
        )}
        {workspace && isDesktop && (
          <button className="status-item status-path" onClick={() => void desktop.revealPath(workspace.dataPath)} title={`${workspace.dataPath}（点击在文件夹中显示）`}>
            <span className="truncate">{workspace.dataPath}</span>
          </button>
        )}
        <span className="status-item status-version muted">v{version}</span>
      </footer>

      {notice && (
        <div className={`toast ${notice.error ? 'toast-error' : ''}`} role={notice.error ? 'alert' : 'status'}>
          {notice.error ? <CircleAlert size={14} /> : <Check size={14} />}
          <span>{notice.text}</span>
          {notice.action && <button className="toast-action" onClick={() => { notice.action!.run(); setNotice(null); }}>{notice.action.label}</button>}
          <button className="icon-btn" onClick={() => setNotice(null)} aria-label="关闭提示"><X size={13} /></button>
        </div>
      )}
    </div>
  );
}
