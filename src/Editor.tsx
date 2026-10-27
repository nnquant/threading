// The record editor: a what-you-see-is-what-you-get Markdown document in its own tab.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { EditorContent, Extension, InputRule, useEditor, useEditorState, type Editor as Tiptap, type InputRuleMatch } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics';
import { Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { Placeholder } from '@tiptap/extensions';
import katex from 'katex';
import {
  Bold, CircleAlert, Code, Heading1, Heading2, Heading3, ImagePlus, Italic, Link2, List, ListChecks, ListOrdered, Minus, Redo2,
  Sigma, SquareCode, Strikethrough, Table, TextQuote, Undo2,
} from 'lucide-react';
import { useApp } from './context';
import { ATTACHMENT, fileToBase64, imageUrl, isImageFile } from './images';
import { HEALTHS, HEALTH_LABEL, KIND_LABEL } from './labels';
import { KATEX_OPTIONS, normalizeMath } from './math';
import { readDraft, writeDraft, type EditorTab, type Writable } from './tabs';
import { AutoTextarea, HealthDot, OrgMark, Segmented, useDismiss } from './ui';

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

const BULLET = /^[-*+] /;
const ORDERED = /^(\d+)[.)] /;

/**
 * Cleans the serializer's output, keeping code blocks as written: drops runs of blank lines, and gives two lists of
 * the same kind that follow each other different markers, since Markdown would otherwise read them as one list
 * (a bullet list right before a to-do list, say).
 */
export function tidyMarkdown(markdown: string) {
  const lines: string[] = [];
  let fenced = false;
  let gap = false;
  let list: { kind: 'bullet' | 'ordered'; mark: string } | null = null;
  for (let line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && !line.trim()) {
      gap = true;
      if (!lines.length || !lines[lines.length - 1].trim()) continue;
    } else if (!fenced && /^\S/.test(line)) {
      const kind = BULLET.test(line) ? 'bullet' : ORDERED.test(line) ? 'ordered' : null;
      if (!kind) list = null;
      else {
        if (!list || list.kind !== kind) list = { kind, mark: kind === 'bullet' ? '-' : '.' };
        else if (gap) list = { kind, mark: kind === 'bullet' ? (list.mark === '-' ? '*' : '-') : (list.mark === '.' ? ')' : '.') };
        line = kind === 'bullet' ? list.mark + line.slice(1) : line.replace(ORDERED, `$1${list.mark} `);
      }
      gap = false;
    } else if (!fenced) gap = false;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

/** Bare domains get https; anything with a scheme is kept as typed. */
const normalizeUrl = (value: string) => {
  const url = value.trim();
  if (!url) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
};

/** A freshly inserted image or formula is left selected, and the next insert would replace it: move on to the line after it. */
function leaveNode(editor: Tiptap) {
  const { selection, doc } = editor.state;
  if (!(selection instanceof NodeSelection)) return;
  const after = selection.to;
  if (doc.resolve(after).nodeAfter?.isTextblock) editor.commands.setTextSelection(after + 1);
  else editor.chain().insertContentAt(after, { type: 'paragraph' }).setTextSelection(after + 1).run();
}

/** The image node shows saved images (`attachment:` references) through the backend. */
const SavedImage = Image.extend<{ resolve: (src: string) => Promise<string> } & Record<string, unknown>>({
  addOptions() {
    return { ...this.parent?.(), resolve: (src: string) => Promise.resolve(src) };
  },
  addNodeView() {
    const resolve = this.options.resolve;
    return ({ node }) => {
      const dom = document.createElement('img');
      dom.className = 'doc-image';
      let current = node;
      const show = () => {
        const src = String(current.attrs.src ?? '');
        dom.alt = current.attrs.alt ?? '';
        dom.dataset.src = src;
        dom.classList.remove('is-broken');
        resolve(src).then(url => { if (dom.dataset.src === src) dom.src = url; }, () => dom.classList.add('is-broken'));
      };
      show();
      return {
        dom,
        update: next => {
          if (next.type !== current.type) return false;
          const moved = next.attrs.src !== current.attrs.src;
          current = next;
          if (moved) show(); else dom.alt = current.attrs.alt ?? '';
          return true;
        },
      };
    };
  },
});

/** `$x^2$` typed in the text becomes a formula, as in other Markdown editors; a space just inside either dollar keeps prices as text. */
export const findDollarMath = (text: string): InputRuleMatch | null => {
  const match = /\$([^\s$](?:[^$]*[^\s$\\])?)\$$/.exec(text);
  if (!match || /[$\\]/.test(text[match.index - 1] ?? '')) return null;
  return { index: match.index, text: match[0], data: { latex: match[1] } };
};

const Formula = InlineMath.extend({
  addInputRules() {
    return [
      ...(this.parent?.() ?? []),
      new InputRule({
        find: findDollarMath,
        handler: ({ state, range, match }) => { state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match.data?.latex })); },
      }),
    ];
  },
});

/** Formulas copied from a rendered page keep their LaTeX in an annotation (KaTeX and MathML both do); paste that as `\(…\)` / `\[…\]`. */
export function texFromHTML(html: string) {
  if (!html.includes('application/x-tex')) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Outer elements come first; the formula inside one that was already replaced is detached and skipped.
  for (const element of doc.body.querySelectorAll('.katex-display, .katex, math')) {
    const tex = element.isConnected && element.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    if (!tex) continue;
    if (element.classList.contains('katex-display') || element.getAttribute('display') === 'block') {
      const line = doc.createElement('p');
      line.textContent = `\\[${tex}\\]`;
      element.replaceWith(line);
    } else element.replaceWith(`\\(${tex}\\)`);
  }
  return doc.body.innerHTML;
}

const PASTED_INLINE = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$\$([^$]+?)\$\$|(^|[^$\\])\$(?=[^\s$])([^$\n]*?[^\s$\\])\$(?!\d)/g;
const PASTED_DISPLAY = /^\s*(?:\\\[((?:(?!\\\])[\s\S])+)\\\]|\$\$([^$]+)\$\$)\s*$/;
const OPENS_DISPLAY = /^\s*(\\\[|\$\$)\s*$/;

/**
 * Formulas pasted as text become formula nodes. A paragraph that is only `\[…\]` or `$$…$$`, or those delimiters on lines of
 * their own around the LaTeX, becomes a display formula; `\(…\)`, `$…$` and the rest inside text become inline ones.
 */
export function pasteMath(slice: Slice, schema: Schema) {
  const { inlineMath, blockMath, paragraph } = schema.nodes;
  if (!inlineMath || !blockMath) return slice;
  const inline = (node: PMNode): PMNode[] => {
    if (node.isText) {
      if (node.marks.some(mark => mark.type.spec.code)) return [node];
      const text = node.text ?? '';
      const parts: PMNode[] = [];
      let last = 0;
      for (const match of text.matchAll(PASTED_INLINE)) {
        const latex = (match[1] ?? match[2] ?? match[3] ?? match[5]).trim();
        if (!latex) continue;
        const start = match.index + (match[4]?.length ?? 0);
        if (start > last) parts.push(schema.text(text.slice(last, start), node.marks));
        parts.push(inlineMath.create({ latex }));
        last = match.index + match[0].length;
      }
      if (!parts.length) return [node];
      if (last < text.length) parts.push(schema.text(text.slice(last), node.marks));
      return parts;
    }
    if (node.isLeaf || node.type.spec.code) return [node];
    const children: PMNode[] = [];
    node.content.forEach(child => { children.push(...inline(child)); });
    return [node.copy(Fragment.from(children))];
  };
  const lineOf = (node: PMNode) => node.textBetween(0, node.content.size, '\n', '\n');
  const top = slice.content;
  const nodes: PMNode[] = [];
  let { openStart, openEnd } = slice;
  for (let i = 0; i < top.childCount; i++) {
    const node = top.child(i);
    let latex: string | undefined;
    let end = i;
    if (node.type === paragraph) {
      const whole = PASTED_DISPLAY.exec(lineOf(node));
      latex = whole?.[1] ?? whole?.[2];
      const opening = !whole && OPENS_DISPLAY.exec(lineOf(node))?.[1];
      if (opening) {
        const lines: string[] = [];
        for (let j = i + 1; j < top.childCount && top.child(j).type === paragraph; j++) {
          const line = lineOf(top.child(j)).trim();
          if (line === (opening === '$$' ? '$$' : '\\]')) { latex = lines.join('\n'); end = j; break; }
          lines.push(line);
        }
      }
    }
    if (latex?.trim()) {
      nodes.push(blockMath.create({ latex: latex.trim() }));
      // A formula has no inside to stay open into.
      if (i === 0) openStart = 0;
      if (end === top.childCount - 1) openEnd = 0;
      i = end;
    } else nodes.push(...inline(node));
  }
  return new Slice(Fragment.from(nodes), openStart, openEnd);
}

function Tool({ label, keys, active = false, disabled = false, onClick, children }: {
  label: string; keys?: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`tool ${active ? 'is-active' : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={keys ? `${label}（${keys}）` : label}
      disabled={disabled}
      // Keep the selection in the document while clicking the toolbar.
      onMouseDown={event => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function LinkForm({ editor, onClose }: { editor: Tiptap; onClose: () => void }) {
  const current = editor.getAttributes('link').href as string | undefined;
  const bare = editor.state.selection.empty && !current;
  const [text, setText] = useState('');
  const [href, setHref] = useState(current ?? '');
  const apply = () => {
    const url = normalizeUrl(href);
    const chain = editor.chain().focus();
    if (!url) { if (current) chain.extendMarkRange('link').unsetLink().run(); onClose(); return; }
    if (bare) chain.insertContent({ type: 'text', text: text.trim() || url, marks: [{ type: 'link', attrs: { href: url } }] }).unsetMark('link').run();
    else chain.extendMarkRange('link').setLink({ href: url }).run();
    onClose();
  };
  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'Enter') { event.preventDefault(); apply(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editor.commands.focus(); onClose(); }
  };
  return (
    <div className="tool-pop" role="dialog" aria-label="链接">
      {bare && <input className="plain-input" value={text} onChange={event => setText(event.target.value)} onKeyDown={onKey} placeholder="显示的文字" aria-label="链接文字" />}
      <input className="plain-input" value={href} onChange={event => setHref(event.target.value)} onKeyDown={onKey} placeholder="https://" aria-label="链接地址" autoFocus />
      <div className="tool-pop-foot">
        {current && <button type="button" className="btn btn-ghost" onClick={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); onClose(); }}>移除链接</button>}
        <button type="button" className="btn btn-primary" onClick={apply}>{current ? '更新' : '插入'}</button>
      </div>
    </div>
  );
}

function ImageForm({ editor, onPick, onClose }: { editor: Tiptap; onPick: () => void; onClose: () => void }) {
  const [href, setHref] = useState('');
  const insert = () => {
    const url = normalizeUrl(href);
    if (url) { editor.chain().focus().setImage({ src: url }).run(); leaveNode(editor); }
    onClose();
  };
  return (
    <div className="tool-pop" role="dialog" aria-label="图片">
      <button type="button" className="btn" onClick={() => { onClose(); onPick(); }}><ImagePlus size={14} />从本机选择图片…</button>
      <input
        className="plain-input"
        value={href}
        onChange={event => setHref(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); insert(); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editor.commands.focus(); onClose(); }
        }}
        placeholder="或填图片地址 https://…"
        aria-label="图片地址"
      />
      <div className="tool-pop-foot"><button type="button" className="btn btn-primary" disabled={!href.trim()} onClick={insert}>插入</button></div>
    </div>
  );
}

const FORMULAS = new Set(['inlineMath', 'blockMath']);

function FormulaForm({ editor, onClose }: { editor: Tiptap; onClose: () => void }) {
  // Opened on a formula it edits that one. Otherwise it inserts one: on a line of its own when the line is empty, starting from any
  // selected text.
  const [target] = useState(() => {
    const { selection } = editor.state;
    return selection instanceof NodeSelection && FORMULAS.has(selection.node.type.name) ? selection.node : null;
  });
  const [display] = useState(() => target ? target.type.name === 'blockMath' : !editor.state.selection.$from.parent.content.size);
  const [latex, setLatex] = useState<string>(() => {
    const { from, to } = editor.state.selection;
    return target ? target.attrs.latex : editor.state.doc.textBetween(from, to, ' ');
  });
  // Rendered into the element rather than set as HTML: the desktop app's content policy blocks style attributes in parsed HTML.
  const preview = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (preview.current) katex.render(latex, preview.current, { ...KATEX_OPTIONS, displayMode: display }); }, [latex, display]);
  const apply = () => {
    const value = latex.trim();
    if (!value) return;
    const chain = editor.chain().focus();
    if (target) chain.updateAttributes(target.type.name, { latex: value }).run();
    else { chain.insertContent({ type: display ? 'blockMath' : 'inlineMath', attrs: { latex: value } }).run(); leaveNode(editor); }
    onClose();
  };
  return (
    <div className="tool-pop is-math" role="dialog" aria-label="公式">
      <AutoTextarea
        className="plain-input math-input"
        value={latex}
        onChange={setLatex}
        placeholder="LaTeX，如 \frac{a}{b}"
        aria-label="LaTeX"
        spellCheck={false}
        autoFocus
        onKeyDown={event => {
          // Shift+Enter starts a new line, for environments such as aligned.
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); apply(); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editor.commands.focus(); onClose(); }
        }}
      />
      {latex.trim() && <div className="math-preview" ref={preview} />}
      <div className="tool-pop-foot">
        {target && <button type="button" className="btn btn-ghost" onClick={() => { editor.chain().focus().deleteSelection().run(); onClose(); }}>删除公式</button>}
        <button type="button" className="btn btn-primary" disabled={!latex.trim()} onClick={apply}>{target ? '更新' : '插入'}</button>
      </div>
    </div>
  );
}

export default function EditorView({ tab, active }: { tab: EditorTab; active: boolean }) {
  const { api, index, workspace, run, notify, go, patchDraft, clearInbox, closeTab } = useApp();
  const { draft } = tab;
  const project = index.project.get(draft.projectId);
  const org = project && index.org.get(project.orgId);
  const thread = draft.threadId ? index.thread.get(draft.threadId) : undefined;
  const entry = draft.entryId ? workspace.entries.find(row => row.id === draft.entryId) : undefined;
  const missing = !project || (!!draft.threadId && !thread) || (!!draft.entryId && !entry);
  const kinds: Writable[] = draft.threadId ? ['note', 'decision', 'result'] : ['update', 'note', 'decision'];

  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [pop, setPop] = useState<'link' | 'image' | 'formula' | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  useDismiss(toolbar, !!pop, () => setPop(null));

  // Handlers the editor's key and paste bindings call; refreshed every render.
  const actions = useRef({ submit: () => {}, link: () => {}, formula: (_pos: number) => {}, insertImages: async (_files: File[], _at?: number) => {} });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const extensions = useMemo(() => [
    StarterKit.configure({
      underline: false,
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https' },
    }),
    Markdown,
    SavedImage.configure({ resolve: (src: string) => imageUrl(api, src) }),
    TaskList,
    TaskItem.configure({ nested: true, a11y: { checkboxLabel: (node, checked) => `${checked ? '已完成' : '待办'}：${node.textContent}` } }),
    TableKit.configure({ table: { resizable: false } }),
    Formula.configure({ katexOptions: KATEX_OPTIONS, onClick: (_node, pos) => actions.current.formula(pos) }),
    BlockMath.configure({ katexOptions: { ...KATEX_OPTIONS, displayMode: true }, onClick: (_node, pos) => actions.current.formula(pos) }),
    Placeholder.configure({ placeholder: '开始写…' }),
    Extension.create({
      name: 'recordKeys',
      priority: 1000,
      addKeyboardShortcuts: () => ({
        'Mod-Enter': () => { actions.current.submit(); return true; },
        'Mod-k': () => { actions.current.link(); return true; },
      }),
    }),
  ], [api]);

  const flush = (editor: Tiptap) => { clearTimeout(saveTimer.current); writeDraft(tab.id, tidyMarkdown(editor.getMarkdown())); };
  const editor = useEditor({
    extensions,
    content: normalizeMath(readDraft(tab.id)),
    contentType: 'markdown',
    editable: !missing,
    editorProps: {
      attributes: { class: 'markdown editor-doc', 'aria-label': '正文', 'aria-multiline': 'true', role: 'textbox' },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])].filter(isImageFile);
        if (!files.length) return false;
        void actions.current.insertImages(files);
        return true;
      },
      transformPastedHTML: texFromHTML,
      transformPasted: (slice, view) => pasteMath(slice, view.state.schema),
      handleDrop: (view, event, _slice, moved) => {
        const files = [...(event.dataTransfer?.files ?? [])].filter(isImageFile);
        if (moved || !files.length) return false;
        event.preventDefault();
        void actions.current.insertImages(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
    },
    onUpdate: ({ editor }) => { clearTimeout(saveTimer.current); saveTimer.current = setTimeout(() => flush(editor), 300); },
    onBlur: ({ editor }) => flush(editor),
  }, [extensions]);
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const state = useEditorState({
    editor,
    selector: ({ editor }) => editor ? {
      h1: editor.isActive('heading', { level: 1 }), h2: editor.isActive('heading', { level: 2 }), h3: editor.isActive('heading', { level: 3 }),
      bold: editor.isActive('bold'), italic: editor.isActive('italic'), strike: editor.isActive('strike'), code: editor.isActive('code'),
      bullet: editor.isActive('bulletList'), ordered: editor.isActive('orderedList'), task: editor.isActive('taskList'),
      quote: editor.isActive('blockquote'), codeBlock: editor.isActive('codeBlock'), link: editor.isActive('link'), table: editor.isActive('table'),
      formula: editor.isActive('inlineMath') || editor.isActive('blockMath'),
      undo: editor.can().undo(), redo: editor.can().redo(), empty: editor.isEmpty,
    } : null,
  });

  // Text sent from a composer while this draft was already open goes to the end.
  useEffect(() => {
    if (!editor || editor.isDestroyed || !tab.inbox) return;
    editor.chain().insertContentAt(editor.state.doc.content.size, normalizeMath(tab.inbox.text), { contentType: 'markdown' }).focus('end').run();
    clearInbox(tab.id);
  }, [editor, tab.inbox, tab.id, clearInbox]);
  // StrictMode remounts destroy the first instance, so effects check it is still alive.
  useEffect(() => { if (active && editor && !editor.isDestroyed && !missing) editor.commands.focus(); }, [active, editor, missing]);

  const submit = async () => {
    if (!editor || busy || missing || uploading) return;
    flush(editor);
    const body = tidyMarkdown(editor.getMarkdown());
    if (!body) return;
    setBusy(true);
    const change = await run(api => draft.entryId
      ? api.updateEntry(draft.entryId, { body })
      : api.createEntry({ projectId: draft.projectId, threadId: draft.threadId, kind: draft.kind, body, ...(draft.kind === 'update' ? { health: draft.health } : {}) }));
    setBusy(false);
    if (!change) return;
    notify({ text: draft.entryId ? '已保存修改' : `已记录${KIND_LABEL[draft.kind]}` });
    closeTab(tab.id, { saved: true });
  };
  const insertImages = async (files: File[], at?: number) => {
    if (!editor) return;
    setUploading(count => count + files.length);
    // A drop goes where it landed; the rest follow one another.
    let pos = at;
    for (const file of files) {
      try {
        const saved = await api.saveImage(await fileToBase64(file));
        const name = file.name.replace(/\.[^.]+$/, '');
        const node = { type: 'image', attrs: { src: ATTACHMENT + saved.id, alt: /^image$/i.test(name) ? '' : name } };
        if (pos == null) editor.chain().focus().insertContent(node).run();
        else editor.chain().focus().insertContentAt(pos, node).run();
        pos = undefined;
        leaveNode(editor);
      } catch (error) {
        notify({ text: messageOf(error), error: true });
      } finally {
        setUploading(count => count - 1);
      }
    }
  };
  const formula = (pos: number) => {
    if (!editor || missing) return;
    editor.commands.setNodeSelection(pos);
    setPop('formula');
  };
  actions.current = { submit: () => void submit(), link: () => setPop('link'), formula, insertImages };

  const chain = () => editor!.chain().focus();
  return (
    <div className="view editor-view">
      <header className="view-head">
        <div className="view-title">
          {thread
            ? project && <button className="crumb" onClick={() => go({ kind: 'project', id: project.id })}>{org && <OrgMark org={org} />}{project.name}</button>
            : org && <span className="crumb">{<OrgMark org={org} />}{org.name}</span>}
          <h1>{thread?.title ?? project?.name ?? '已删除'}</h1>
          {draft.entryId && <span className="pill">编辑{KIND_LABEL[entry?.kind ?? draft.kind]}</span>}
        </div>
        <div className="view-actions">
          {!draft.entryId && (
            <Segmented<Writable> label="记录类型" value={draft.kind} onChange={kind => patchDraft(tab.id, { kind })} options={kinds.map(value => ({ value, label: KIND_LABEL[value] }))} />
          )}
          {!draft.entryId && draft.kind === 'update' && (
            <Segmented label="健康度" value={draft.health} onChange={health => patchDraft(tab.id, { health })} options={HEALTHS.map(value => ({ value, label: HEALTH_LABEL[value], icon: <HealthDot health={value} decorative /> }))} />
          )}
          <button className="btn btn-ghost" onClick={() => closeTab(tab.id)}>{draft.entryId ? '取消' : '放弃'}</button>
          <button className="btn btn-primary" title="Ctrl+Enter" disabled={busy || missing || !!uploading || !state || state.empty} onClick={() => void submit()}>
            {draft.entryId ? '保存修改' : `记录${KIND_LABEL[draft.kind]}`}
          </button>
        </div>
      </header>
      {missing && (
        <div className="editor-missing" role="alert">
          <CircleAlert size={14} />
          这份草稿要{draft.entryId ? '修改的记录' : thread || !draft.threadId ? '记到的项目' : '记到的策略线'}已被删除，无法保存。需要的话可以把正文复制出去。
        </div>
      )}
      {editor && state && (
        <div className="editor-toolbar" role="toolbar" aria-label="格式" ref={toolbar}>
          <Tool label="标题 1" keys="Ctrl+Alt+1" active={state.h1} disabled={missing} onClick={() => chain().toggleHeading({ level: 1 }).run()}><Heading1 size={15} /></Tool>
          <Tool label="标题 2" keys="Ctrl+Alt+2" active={state.h2} disabled={missing} onClick={() => chain().toggleHeading({ level: 2 }).run()}><Heading2 size={15} /></Tool>
          <Tool label="标题 3" keys="Ctrl+Alt+3" active={state.h3} disabled={missing} onClick={() => chain().toggleHeading({ level: 3 }).run()}><Heading3 size={15} /></Tool>
          <i className="tool-sep" />
          <Tool label="粗体" keys="Ctrl+B" active={state.bold} disabled={missing} onClick={() => chain().toggleBold().run()}><Bold size={15} /></Tool>
          <Tool label="斜体" keys="Ctrl+I" active={state.italic} disabled={missing} onClick={() => chain().toggleItalic().run()}><Italic size={15} /></Tool>
          <Tool label="删除线" keys="Ctrl+Shift+S" active={state.strike} disabled={missing} onClick={() => chain().toggleStrike().run()}><Strikethrough size={15} /></Tool>
          <Tool label="行内代码" keys="Ctrl+E" active={state.code} disabled={missing} onClick={() => chain().toggleCode().run()}><Code size={15} /></Tool>
          <i className="tool-sep" />
          <Tool label="无序列表" keys="Ctrl+Shift+8" active={state.bullet} disabled={missing} onClick={() => chain().toggleBulletList().run()}><List size={15} /></Tool>
          <Tool label="有序列表" keys="Ctrl+Shift+7" active={state.ordered} disabled={missing} onClick={() => chain().toggleOrderedList().run()}><ListOrdered size={15} /></Tool>
          <Tool label="待办列表" keys="Ctrl+Shift+9" active={state.task} disabled={missing} onClick={() => chain().toggleTaskList().run()}><ListChecks size={15} /></Tool>
          <Tool label="引用" keys="Ctrl+Shift+B" active={state.quote} disabled={missing} onClick={() => chain().toggleBlockquote().run()}><TextQuote size={15} /></Tool>
          <Tool label="代码块" keys="Ctrl+Alt+C" active={state.codeBlock} disabled={missing} onClick={() => chain().toggleCodeBlock().run()}><SquareCode size={15} /></Tool>
          <i className="tool-sep" />
          <span className="tool-anchor">
            <Tool label="链接" keys="Ctrl+K" active={state.link || pop === 'link'} disabled={missing} onClick={() => setPop(pop === 'link' ? null : 'link')}><Link2 size={15} /></Tool>
            {pop === 'link' && <LinkForm editor={editor} onClose={() => setPop(null)} />}
          </span>
          <span className="tool-anchor">
            <Tool label="图片" active={pop === 'image'} disabled={missing} onClick={() => setPop(pop === 'image' ? null : 'image')}><ImagePlus size={15} /></Tool>
            {pop === 'image' && <ImageForm editor={editor} onPick={() => picker.current?.click()} onClose={() => setPop(null)} />}
          </span>
          <span className="tool-anchor">
            <Tool label="公式" active={state.formula || pop === 'formula'} disabled={missing} onClick={() => setPop(pop === 'formula' ? null : 'formula')}><Sigma size={15} /></Tool>
            {pop === 'formula' && <FormulaForm editor={editor} onClose={() => setPop(null)} />}
          </span>
          <Tool label="表格" active={state.table} disabled={missing || state.table} onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Table size={15} /></Tool>
          <Tool label="分割线" disabled={missing} onClick={() => chain().setHorizontalRule().run()}><Minus size={15} /></Tool>
          <i className="tool-sep" />
          <Tool label="撤销" keys="Ctrl+Z" disabled={!state.undo} onClick={() => chain().undo().run()}><Undo2 size={15} /></Tool>
          <Tool label="重做" keys="Ctrl+Y" disabled={!state.redo} onClick={() => chain().redo().run()}><Redo2 size={15} /></Tool>
          {state.table && (
            <span className="tool-table" role="group" aria-label="表格">
              <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => chain().addRowAfter().run()}>加一行</button>
              <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => chain().addColumnAfter().run()}>加一列</button>
              <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => chain().deleteRow().run()}>删除行</button>
              <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => chain().deleteColumn().run()}>删除列</button>
              <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => chain().deleteTable().run()}>删除表格</button>
            </span>
          )}
          <span className="editor-status" aria-live="polite">{uploading ? `正在保存 ${uploading} 张图片…` : ''}</span>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void insertImages(files); }}
          />
        </div>
      )}
      <div className="editor-scroll" onMouseDown={event => { if (event.target === event.currentTarget && editor) { event.preventDefault(); editor.commands.focus('end'); } }}>
        <EditorContent editor={editor} className="editor-page" />
      </div>
    </div>
  );
}
