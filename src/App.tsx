import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
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
import ThreadPanel from './ThreadPanel';
import ThreadsView from './ThreadsView';
import { applyChange, buildIndex, focusOf, reviewQueue } from './workspace';
import type { Change, Id, Workspace } from './types';
import { version } from '../package.json';
import './App.css';

type DialogState =
  | { kind: 'thread'; preset: NewThreadPreset }
  | { kind: 'project'; id?: Id; orgId?: Id }
  | { kind: 'org'; id?: Id }
  | { kind: 'settings' };

const VIEW_KEY = 'threading.view.v1';
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const isWindowChrome = (target: EventTarget) => !(target instanceof Element && target.closest('button, input, select, a, [role="dialog"]'));
const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || !!target.closest('input, textarea, select'));
function readView(): View {
  try {
    const value = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null') as View | null;
    if (value && ['focus', 'threads', 'review', 'org', 'project'].includes(value.kind)) return value;
  } catch { /* fall through */ }
  return { kind: 'focus' };
}

export default function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>(readView);
  const [selected, setSelected] = useState<Id | null>(null);
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

  const go = useCallback((next: View) => {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
  }, []);
  // Leave views and panels whose rows were deleted.
  useEffect(() => {
    if (!index) return;
    if ((view.kind === 'org' && !index.org.has(view.id)) || (view.kind === 'project' && !index.project.has(view.id))) go({ kind: 'focus' });
    if (selected && !index.thread.has(selected)) setSelected(null);
  }, [index, view, selected, go]);

  const newThread = useCallback((preset: NewThreadPreset = {}) => {
    const fallback = view.kind === 'project' ? view.id : selected ? index?.thread.get(selected)?.projectId : undefined;
    setDialog({ kind: 'thread', preset: { ...preset, projectId: preset.projectId ?? fallback } });
  }, [view, selected, index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const modal = !!dialog || !!confirmRequest;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        if (modal) return;
        event.preventDefault();
        setPalette(open => !open);
        return;
      }
      if (modal || palette || event.defaultPrevented) return;
      if ((event.ctrlKey || event.metaKey) && ['1', '2', '3'].includes(event.key)) {
        event.preventDefault();
        go([{ kind: 'focus' }, { kind: 'threads' }, { kind: 'review' }][Number(event.key) - 1] as View);
        return;
      }
      if (isTyping(event.target)) return;
      if (event.key === 'Escape' && selected) { setSelected(null); return; }
      if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && workspace) { event.preventDefault(); newThread(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, confirmRequest, palette, selected, go, newThread, workspace]);

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

  const context: AppContext | null = workspace && index && api ? {
    workspace, index, now, view, go, selected, api, run, notify, newThread,
    openThread: setSelected,
    newProject: orgId => setDialog({ kind: 'project', orgId }),
    editProject: id => setDialog({ kind: 'project', id }),
    newOrg: () => setDialog({ kind: 'org' }),
    editOrg: id => setDialog({ kind: 'org', id }),
    confirm: setConfirmRequest,
  } : null;

  // "All threads" keeps paused and finished projects in view; only archived projects and organizations drop out.
  const listedThreads = workspace && index ? workspace.threads.filter(thread => {
    const project = index.project.get(thread.projectId);
    return !!project && project.status !== 'archived' && !index.org.get(project.orgId)?.archived;
  }) : [];
  const activeProjects = workspace ? workspace.projects.filter(project => project.status === 'active').length : 0;
  const overLimit = !!focus && workspace!.settings.wipLimit > 0 && focus.activeCount > workspace!.settings.wipLimit;

  let content = null;
  if (context && focus) {
    if (view.kind === 'focus') content = <FocusView focus={focus} />;
    else if (view.kind === 'threads') {
      content = (
        <div className="view">
          <header className="view-head">
            <div className="view-title"><h1>全部策略线</h1><span className="view-date">{listedThreads.filter(thread => thread.state !== 'closed').length} 条未结束</span></div>
            <div className="view-actions"><button className="btn btn-primary" onClick={() => newThread()}><Plus size={14} />新建策略线</button></div>
          </header>
          <div className="view-body"><ThreadsView threads={listedThreads} scope="all" /></div>
        </div>
      );
    } else if (view.kind === 'review') content = <ReviewView />;
    else if (view.kind === 'org') content = <OrgView key={view.id} id={view.id} />;
    else content = <ProjectView key={view.id} id={view.id} />;
  }

  return (
    <div className={`app ${isDesktop && !maximized ? 'is-framed' : ''}`}>
      <header className="titlebar" onMouseDown={titlebarMouseDown} onMouseMove={titlebarMouseMove} onMouseUp={() => { dragOrigin.current = null; }} onDoubleClick={titlebarDoubleClick}>
        <div className="wordmark" aria-label="Threading 策略线">
          <svg className="wordmark-icon" viewBox="0 0 64 64" aria-hidden="true">
            <path d="M9 43h16c9 0 16-6 16-15a9 9 0 1 0-18 0c0 9 7 15 16 15h16" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Threading
        </div>
        <button className="search-trigger" onClick={() => setPalette(true)} disabled={!context}>
          <Search size={13} /><span>搜索或跳转</span><kbd>Ctrl K</kbd>
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

      {!isDesktop && <div className="banner"><CircleAlert size={13} />当前为浏览器预览，使用演示数据，改动只保存在本浏览器。请运行 Threading 桌面客户端管理真实数据。</div>}

      {context && focus ? (
        <Ctx.Provider value={context}>
          <div className={`shell ${selected ? 'has-panel' : ''}`}>
            <Sidebar focus={focus} reviewCount={reviewCount} onSettings={() => setDialog({ kind: 'settings' })} />
            <main className="main">{content}</main>
            {selected && <ThreadPanel key={selected} id={selected} onClose={() => setSelected(null)} />}
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
