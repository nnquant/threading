import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { BlockMath, InlineMath } from '@tiptap/extension-mathematics';
import { Slice, type Node as PMNode } from '@tiptap/pm/model';
import { findDollarMath, pasteMath, texFromHTML, tidyMarkdown } from '../src/Editor';

let editor: Editor | undefined;
afterEach(() => { editor?.destroy(); editor = undefined; });
const open = (content = '') => {
  editor = new Editor({ element: document.createElement('div'), extensions: [StarterKit, Markdown, InlineMath, BlockMath], content, contentType: 'markdown' });
  return editor;
};
const paragraphs = (editor: Editor, ...lines: string[]) =>
  lines.map(line => editor.schema.nodes.paragraph.create(null, line ? editor.schema.text(line) : null));
const describeNodes = (nodes: readonly PMNode[]) => nodes.map(node => node.isText ? node.text : `${node.type.name}:${node.attrs.latex ?? node.textContent}`);

describe('record editor formulas', () => {
  it('keeps formulas as formulas through Markdown', () => {
    const markdown = '其中 $P_t$ 是永续价格\n\n$$\n\\frac{a}{b}\n$$';
    const doc = open(markdown);
    expect(doc.state.doc.child(0).child(1).type.name).toBe('inlineMath');
    expect(doc.state.doc.child(1).type.name).toBe('blockMath');
    expect(tidyMarkdown(doc.getMarkdown())).toBe(markdown);
  });

  it('turns pasted LaTeX text into formulas', () => {
    const doc = open();
    const lone = pasteMath(new Slice(doc.schema.nodes.doc.create(null, paragraphs(doc, '\\[ x^2 \\]')).content, 1, 1), doc.schema);
    expect(describeNodes(lone.content.content)).toEqual(['blockMath:x^2']);
    expect([lone.openStart, lone.openEnd]).toEqual([0, 0]);

    const lines = pasteMath(new Slice(doc.schema.nodes.doc.create(null, paragraphs(doc, '设：', '\\[', 'B_t = P_t - S_t', '\\]', '于是')).content, 1, 1), doc.schema);
    expect(describeNodes(lines.content.content)).toEqual(['paragraph:设：', 'blockMath:B_t = P_t - S_t', 'paragraph:于是']);
    expect([lines.openStart, lines.openEnd]).toEqual([1, 1]);

    const text = pasteMath(new Slice(doc.schema.nodes.doc.create(null, paragraphs(doc, '其中 \\(P_t\\) 涨了 $5 到 $x$')).content, 1, 1), doc.schema);
    expect(describeNodes(text.content.child(0).content.content)).toEqual(['其中 ', 'inlineMath:P_t', ' 涨了 $5 到 ', 'inlineMath:x']);
  });

  it('pastes rendered formulas as their LaTeX', () => {
    const katex = (tex: string, rendered: string) =>
      `<span class="katex"><span class="katex-mathml"><math><semantics><mrow></mrow><annotation encoding="application/x-tex">${tex}</annotation></semantics></math></span><span class="katex-html">${rendered}</span></span>`;
    const html = texFromHTML(`<p>价格 ${katex('P_t', 'Pt')}</p><span class="katex-display">${katex('a=1', 'a=1')}</span>`);
    expect(html).toBe('<p>价格 \\(P_t\\)</p><p>\\[a=1\\]</p>');
  });

  it('sets $…$ typed in the text as a formula, but not prices', () => {
    expect(findDollarMath('其中 $x^2$')?.data).toEqual({ latex: 'x^2' });
    expect(findDollarMath('从 $5 涨到 $')).toBeNull();
    expect(findDollarMath('$$x$')).toBeNull();
  });
});

describe('record editor markdown', () => {
  it('drops runs of blank lines but keeps code blocks as written', () => {
    expect(tidyMarkdown('\n\n段落\n\n\n\n| a |\n| - |\n\n\n```\nx\n\n\ny\n```\n\n')).toBe('段落\n\n| a |\n| - |\n\n```\nx\n\n\ny\n```');
  });

  it('keeps back-to-back lists apart by switching their markers', () => {
    expect(tidyMarkdown('- 一\n- 二\n  - 嵌套\n\n- [ ] 待办\n- [x] 完成\n\n- 再一个')).toBe('- 一\n- 二\n  - 嵌套\n\n* [ ] 待办\n* [x] 完成\n\n- 再一个');
    expect(tidyMarkdown('1. 甲\n2. 乙\n\n1. 丙')).toBe('1. 甲\n2. 乙\n\n1) 丙');
  });

  it('leaves lists alone when something else sits between them', () => {
    expect(tidyMarkdown('- 一\n\n段落\n\n- 二\n\n1. 甲')).toBe('- 一\n\n段落\n\n- 二\n\n1. 甲');
  });
});
