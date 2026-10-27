// Formulas in records: Markdown math, `$…$` within a line and `$$…$$` on lines of their own, set with KaTeX.
import type { KatexOptions } from 'katex';

/** KaTeX settings shared by rendered records and the editor: Chinese in `\text{}` is fine, and a typo shows in red instead of throwing. */
export const KATEX_OPTIONS: KatexOptions = { throwOnError: false, strict: false, errorColor: '#c0362c' };

/** Undoes the editor's escaping of plain text, which backslash-escapes Markdown punctuation and encodes `&`, `<` and `>`. */
const unescapeText = (text: string) => text.replace(/\\([\\`*_[\]~])/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// `\[…\]` and `\(…\)` as ChatGPT and LaTeX write them, each in two spellings: escaped first (the editor saved pasted formulas
// as plain text, `\\\[ \\frac… \\\]` and `\\(H\_t\\)`), then as written. Neither crosses a blank line.
const SPAN = String.raw`((?:(?!\n[ \t]*\n)[\s\S])+?)`;
const DELIMITED = new RegExp(String.raw`\\\\\\\[${SPAN}\\\\\\\]|\\\\\(${SPAN}\\\\\)|\\\[${SPAN}\\\]|\\\(${SPAN}\\\)`, 'g');
const DISPLAY = new RegExp(String.raw`\\\\\\\[${SPAN}\\\\\\\]|\\\[${SPAN}\\\]`, 'g');
// The editor writes literal brackets as `\[…\]` too, so an unescaped `\[…\]` only counts when it looks like LaTeX.
const TEX = /[\\^_={}]|\n/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const CODE_SPAN = /(^|[^\\`])(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?[^`]\2(?!`)/g;

/** Where the `$` opened at `from` closes: before a non-space and not before a digit, within the paragraph. */
function closingDollar(masked: string, from: number) {
  for (let i = from + 1; i < masked.length; i++) {
    if (masked[i] === '\n' && /^\n[ \t]*\n/.test(masked.slice(i))) return -1;
    if (masked[i] === '$' && masked[i - 1] !== '\\' && /\S/.test(masked[i - 1]) && !/[\d$]/.test(masked[i + 1] ?? '')) return i;
  }
  return -1;
}

/**
 * Single dollars make a formula only in pairs Pandoc would read as one, `$x$` with no space just inside; every other `$` is
 * escaped, so prices written as text (which the editor saves unescaped) stay text. `$$` is left alone.
 */
function escapeStrayDollars(text: string, masked: string) {
  if (!masked.includes('$')) return text;
  let out = '';
  let from = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '$' || masked[i - 1] === '\\') continue;
    if (masked[i + 1] === '$') { while (masked[i + 1] === '$') i++; continue; }
    const close = /\S/.test(masked[i + 1] ?? '') ? closingDollar(masked, i) : -1;
    if (close > 0) { i = close; continue; }
    out += `${text.slice(from, i)}\\`;
    from = i;
  }
  return out + text.slice(from);
}

function rewrite(text: string) {
  // Code spans are blanked out, keeping every offset, so nothing inside them is read as a formula.
  const masked = text.replace(CODE_SPAN, (span, lead: string) => lead + span.slice(lead.length).replace(/[^\n]/g, '\0'));
  let out = '';
  let last = 0;
  const keep = (to: number) => { out += escapeStrayDollars(text.slice(last, to), masked.slice(last, to)); };
  for (const match of masked.matchAll(DELIMITED)) {
    const [whole, escapedDisplay, escapedInline, display, inline] = match;
    const start = match.index;
    const end = start + whole.length;
    const escaped = escapedDisplay ?? escapedInline;
    const latex = (escaped != null ? unescapeText(escaped) : display ?? inline).trim();
    if (!latex || latex.includes('$') || whole.includes('\0') || (display != null && !TEX.test(display))) continue;
    let formula = `$${latex.replace(/\s*\n\s*/g, ' ')}$`;
    if (escapedDisplay != null || display != null) {
      const lineStart = masked.lastIndexOf('\n', start - 1) + 1;
      const lineEnd = masked.indexOf('\n', end);
      const before = masked.slice(lineStart, start);
      const after = masked.slice(end, lineEnd < 0 ? undefined : lineEnd);
      // A display formula alone on its line (or beside other display formulas) becomes a `$$` block; elsewhere, inline.
      if (!before.replace(DISPLAY, '').trim() && !after.replace(DISPLAY, '').trim()) {
        const indent = /^[ \t]*/.exec(before)![0];
        const block = ['$$', ...latex.split('\n').map(line => line.trim()).filter(Boolean), '$$'].join(`\n${indent}`);
        formula = (before.trim() ? `\n${indent}` : '') + block + (after.trim() ? '\n' : '');
      }
    }
    keep(start);
    out += formula;
    last = end;
  }
  keep(text.length);
  return out;
}

/**
 * Rewrites `\(…\)` and `\[…\]` formulas, including ones the editor saved escaped, as `$…$` and `$$…$$`, and escapes dollars
 * that do not pair up as a formula, leaving code alone. Records are rendered and opened in the editor through this, so older
 * records show their formulas too.
 */
export function normalizeMath(markdown: string) {
  if (!/[\\$]/.test(markdown)) return markdown;
  const out: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  const flush = () => { if (prose.length) out.push(rewrite(prose.join('\n'))); prose = []; };
  for (const line of markdown.split('\n')) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (marker) {
      flush();
      fence = marker;
      out.push(line);
    } else prose.push(line);
  }
  flush();
  return out.join('\n');
}
