import { useState, type FormEvent, type ReactNode } from 'react';
import { CircleAlert, FolderOpen, HardDriveDownload, TriangleAlert } from 'lucide-react';
import { desktop, isDesktop, type Api } from './bridge';
import { useApp, type ConfirmRequest, type NewThreadPreset } from './context';
import { ORG_COLOR, PRIORITIES, PRIORITY_LABEL, STAGE_LABEL, STATUSES, STATUS_LABEL } from './labels';
import { Dialog, PriorityIcon, Segmented } from './ui';
import { ORG_COLORS, STAGES, type Change, type Id, type OrgColor, type Priority, type Stage } from './types';

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Form body shared by the dialogs: shows the backend's error inline instead of as a toast. */
function useSubmit(task: (api: Api) => Promise<Change>, done: (change: Change) => void) {
  const { run } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    let failure: unknown = null;
    const change = await run(async api => { try { return await task(api); } catch (caught) { failure = caught; throw caught; } }, { silent: true });
    setBusy(false);
    if (change) done(change); else if (failure) setError(messageOf(failure));
  };
  return { busy, error, submit };
}

const FormError = ({ error }: { error: string | null }) => error ? <div className="form-error" role="alert"><CircleAlert size={14} /><span>{error}</span></div> : null;
const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <label className="field"><span>{label}{hint && <em>{hint}</em>}</span>{children}</label>
);

export function ThreadDialog({ preset, onClose }: { preset: NewThreadPreset; onClose: () => void }) {
  const { index, openThread } = useApp();
  const projects = index.orgs.filter(org => !org.archived).map(org => ({
    org, projects: (index.projectsOf.get(org.id) ?? []).filter(project => project.status === 'active' || project.id === preset.projectId),
  })).filter(group => group.projects.length);
  const [projectId, setProjectId] = useState(preset.projectId ?? projects[0]?.projects[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [stage, setStage] = useState<Stage>(preset.stage ?? 'idea');
  const [priority, setPriority] = useState<Priority>('normal');
  const [nextAction, setNextAction] = useState('');
  const { busy, error, submit } = useSubmit(
    api => api.createThread({ projectId, title, stage, priority, nextAction }),
    change => { onClose(); const created = change.threads?.[0]; if (created) openThread(created.id); },
  );
  if (!projects.length) {
    return (
      <Dialog title="新建策略线" onClose={onClose}>
        <div className="dialog-body"><p className="dialog-text">策略线要放在一个进行中的项目里。先新建一个项目吧。</p><div className="dialog-foot"><button className="btn" onClick={onClose}>知道了</button></div></div>
      </Dialog>
    );
  }
  return (
    <Dialog title="新建策略线" subtitle="项目里一条独立推进的研究或交易线" onClose={onClose}>
      <form className="dialog-body" onSubmit={submit}>
        <FormError error={error} />
        <Field label="名称">
          <input data-autofocus value={title} onChange={event => setTitle(event.target.value)} maxLength={120} placeholder="例如：期限结构因子" required />
        </Field>
        <Field label="项目">
          <select value={projectId} onChange={event => setProjectId(event.target.value)}>
            {projects.map(group => (
              <optgroup key={group.org.id} label={`${group.org.name}（${group.org.code}）`}>
                {group.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
              </optgroup>
            ))}
          </select>
        </Field>
        <div className="field"><span>阶段</span>
          <Segmented<Stage> label="阶段" value={stage} onChange={setStage} options={STAGES.map(value => ({ value, label: STAGE_LABEL[value] }))} />
        </div>
        <div className="field"><span>优先级</span>
          <Segmented<Priority> label="优先级" value={priority} onChange={setPriority} options={PRIORITIES.map(value => ({ value, label: PRIORITY_LABEL[value], icon: <PriorityIcon priority={value} size={12} /> }))} />
        </div>
        <Field label="下一步" hint="可选">
          <input value={nextAction} onChange={event => setNextAction(event.target.value)} maxLength={500} placeholder="接下来要做的第一件具体的事" />
        </Field>
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !title.trim() || !projectId}>创建策略线</button>
        </div>
      </form>
    </Dialog>
  );
}

export function ProjectDialog({ id, orgId, onClose }: { id?: Id; orgId?: Id; onClose: () => void }) {
  const { index, go, confirm, run } = useApp();
  const existing = id ? index.project.get(id) : undefined;
  const orgs = index.orgs.filter(org => !org.archived || org.id === existing?.orgId || org.id === orgId);
  const [form, setForm] = useState({
    orgId: existing?.orgId ?? orgId ?? orgs[0]?.id ?? '',
    name: existing?.name ?? '',
    goal: existing?.goal ?? '',
    targetDate: existing?.targetDate ?? '',
    status: existing?.status ?? 'active',
  });
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const { busy, error, submit } = useSubmit(
    api => existing
      ? api.updateProject(existing.id, { orgId: form.orgId, name: form.name, goal: form.goal, targetDate: form.targetDate || null, status: form.status })
      : api.createProject({ orgId: form.orgId, name: form.name, goal: form.goal, targetDate: form.targetDate || null }),
    change => { onClose(); const project = change.projects?.[0]; if (!existing && project) go({ kind: 'project', id: project.id }); },
  );
  if (!orgs.length) {
    return (
      <Dialog title="新建项目" onClose={onClose}>
        <div className="dialog-body"><p className="dialog-text">项目要归属于一个组织。先新建一个组织吧。</p><div className="dialog-foot"><button className="btn" onClick={onClose}>知道了</button></div></div>
      </Dialog>
    );
  }
  const remove = () => {
    if (!existing) return;
    const threads = index.threadsOf.get(existing.id) ?? [];
    onClose();
    confirm({
      title: `删除项目「${existing.name}」？`,
      body: `其中的 ${threads.length} 条策略线及它们的待办、记录会一起永久删除。项目结束的话，可以把状态改为「已完成」或「已归档」。`,
      confirmLabel: '永久删除',
      onConfirm: async () => { const change = await run(api => api.deleteProject(existing.id)); if (change) go({ kind: 'org', id: existing.orgId }); },
    });
  };
  return (
    <Dialog title={existing ? '编辑项目' : '新建项目'} subtitle={existing ? undefined : '为一个组织做的一件事，下面再分出多条策略线'} onClose={onClose}>
      <form className="dialog-body" onSubmit={submit}>
        <FormError error={error} />
        <Field label="名称">
          <input data-autofocus value={form.name} onChange={event => set({ name: event.target.value })} maxLength={80} placeholder="例如：中证 1000 指数增强" required />
        </Field>
        <Field label="组织">
          <select value={form.orgId} onChange={event => set({ orgId: event.target.value })}>
            {orgs.map(org => <option key={org.id} value={org.id}>{org.name}（{org.code}）</option>)}
          </select>
        </Field>
        <Field label="目标" hint="可选，支持 Markdown">
          <textarea rows={3} value={form.goal} onChange={event => set({ goal: event.target.value })} maxLength={2000} placeholder="做成什么样算完成？例如：年化超额 8%，跟踪误差 5% 以内" />
        </Field>
        <div className="field-row">
          <Field label="目标日期" hint="可选">
            <input type="date" value={form.targetDate} onChange={event => set({ targetDate: event.target.value })} />
          </Field>
          {existing && (
            <Field label="状态">
              <select value={form.status} onChange={event => set({ status: event.target.value as typeof form.status })}>
                {STATUSES.map(status => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
              </select>
            </Field>
          )}
        </div>
        <div className="dialog-foot">
          {existing && <button type="button" className="btn btn-ghost danger-text" onClick={remove}>删除项目</button>}
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !form.name.trim() || !form.orgId}>{existing ? '保存' : '创建项目'}</button>
        </div>
      </form>
    </Dialog>
  );
}

export function OrgDialog({ id, onClose }: { id?: Id; onClose: () => void }) {
  const { index, go, confirm, run } = useApp();
  const existing = id ? index.org.get(id) : undefined;
  const [form, setForm] = useState({
    name: existing?.name ?? '',
    code: existing?.code ?? '',
    color: existing?.color ?? ORG_COLORS[index.orgs.length % ORG_COLORS.length],
    note: existing?.note ?? '',
    archived: existing?.archived ?? false,
  });
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const { busy, error, submit } = useSubmit(
    api => existing ? api.updateOrganization(existing.id, form) : api.createOrganization({ name: form.name, code: form.code, color: form.color, note: form.note }),
    change => { onClose(); const org = change.organizations?.[0]; if (!existing && org) go({ kind: 'org', id: org.id }); },
  );
  const remove = () => {
    if (!existing) return;
    const projects = index.projectsOf.get(existing.id) ?? [];
    const threads = projects.reduce((sum, project) => sum + (index.threadsOf.get(project.id)?.length ?? 0), 0);
    onClose();
    confirm({
      title: `删除组织「${existing.name}」？`,
      body: `其中的 ${projects.length} 个项目、${threads} 条策略线及全部待办和记录会一起永久删除。不再合作的话，归档即可保留历史。`,
      confirmLabel: '永久删除',
      onConfirm: async () => { const change = await run(api => api.deleteOrganization(existing.id)); if (change) go({ kind: 'focus' }); },
    });
  };
  return (
    <Dialog title={existing ? '编辑组织' : '新建组织'} subtitle={existing ? undefined : '一个客户、基金或你自己的自营研究'} onClose={onClose}>
      <form className="dialog-body" onSubmit={submit}>
        <FormError error={error} />
        <div className="field-row">
          <Field label="名称">
            <input data-autofocus value={form.name} onChange={event => set({ name: event.target.value })} maxLength={60} placeholder="例如：澜湾资产" required />
          </Field>
          <Field label="简称" hint="最多 6 字">
            <input value={form.code} onChange={event => set({ code: event.target.value.toUpperCase() })} maxLength={6} placeholder={[...form.name.trim()].slice(0, 2).join('').toUpperCase() || 'LW'} />
          </Field>
        </div>
        <div className="field"><span>颜色</span>
          <div className="swatches" role="radiogroup" aria-label="颜色">
            {ORG_COLORS.map(color => (
              <button key={color} type="button" role="radio" aria-checked={form.color === color} aria-label={color} className={form.color === color ? 'is-selected' : ''} style={{ background: ORG_COLOR[color] }} onClick={() => set({ color: color as OrgColor })} />
            ))}
          </div>
        </div>
        <Field label="备注" hint="可选，支持 Markdown">
          <textarea rows={3} value={form.note} onChange={event => set({ note: event.target.value })} maxLength={2000} placeholder="联系人、合作方式、费用结构……" />
        </Field>
        {existing && (
          <label className="check-toggle">
            <input type="checkbox" checked={form.archived} onChange={event => set({ archived: event.target.checked })} />
            归档：从侧边栏、焦点和回顾中隐藏，数据保留
          </label>
        )}
        <div className="dialog-foot">
          {existing && <button type="button" className="btn btn-ghost danger-text" onClick={remove}>删除组织</button>}
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !form.name.trim()}>{existing ? '保存' : '创建组织'}</button>
        </div>
      </form>
    </Dialog>
  );
}

export function ConfirmDialog({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={request.title} onClose={onClose} className="confirm-dialog">
      <div className="dialog-body">
        <div className="delete-warning"><TriangleAlert size={16} /><p>{request.body}</p></div>
        <div className="dialog-foot">
          <button className="btn" onClick={onClose} data-autofocus>取消</button>
          <button className="btn btn-danger" disabled={busy} onClick={async () => { setBusy(true); await request.onConfirm(); setBusy(false); onClose(); }}>{request.confirmLabel}</button>
        </div>
      </div>
    </Dialog>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { workspace, notify, api } = useApp();
  const [staleDays, setStaleDays] = useState(String(workspace.settings.staleDays));
  const [wipLimit, setWipLimit] = useState(String(workspace.settings.wipLimit));
  const [backingUp, setBackingUp] = useState(false);
  const { busy, error, submit } = useSubmit(api => api.updateSettings({ staleDays: Number(staleDays), wipLimit: Number(wipLimit) }), onClose);
  const backup = async () => {
    setBackingUp(true);
    try {
      const path = await api.backupNow();
      notify({ text: `已备份到 ${path}`, action: { label: '打开文件夹', run: () => void desktop.revealPath(path) } });
    } catch (caught) { notify({ text: `备份失败：${messageOf(caught)}`, error: true }); }
    setBackingUp(false);
  };
  return (
    <Dialog title="设置" onClose={onClose}>
      <form className="dialog-body" onSubmit={submit}>
        <FormError error={error} />
        <div className="field-row is-even">
          <Field label="停滞提醒" hint="天">
            <input type="number" min={1} max={90} value={staleDays} onChange={event => setStaleDays(event.target.value)} />
          </Field>
          <Field label="进行中上限" hint="0 为不提醒">
            <input type="number" min={0} max={50} value={wipLimit} onChange={event => setWipLimit(event.target.value)} />
          </Field>
        </div>
        <p className="hint">进行中的策略线超过停滞天数没有推进，会出现在焦点的「停滞」里；同时进行的线超过上限时，焦点会提醒你先搁置一些。</p>
        <div className="field"><span>数据文件</span>
          <div className="data-path">
            <code title={workspace.dataPath}>{workspace.dataPath}</code>
            {isDesktop && <button type="button" className="icon-btn" onClick={() => void desktop.revealPath(workspace.dataPath)} aria-label="在文件夹中显示" title="在文件夹中显示"><FolderOpen size={14} /></button>}
          </div>
        </div>
        <p className="hint">每天第一次打开时自动备份到数据目录的 backups 文件夹，保留最近 14 份。</p>
        <div className="dialog-foot">
          {isDesktop && <button type="button" className="btn btn-ghost" disabled={backingUp} onClick={() => void backup()}><HardDriveDownload size={14} />立即备份</button>}
          <button type="button" className="btn" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>保存</button>
        </div>
      </form>
    </Dialog>
  );
}
