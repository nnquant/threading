import { describe, expect, it } from 'vitest';
import { normalizeMath } from '../src/math';

describe('formula delimiters', () => {
  it('turns ChatGPT-style \\( \\) and \\[ \\] into dollars', () => {
    expect(normalizeMath('其中 \\(P_t\\) 是永续价格')).toBe('其中 $P_t$ 是永续价格');
    expect(normalizeMath('设：\n\\[\nB_t = P_t - S_t\n\\]\n于是')).toBe('设：\n$$\nB_t = P_t - S_t\n$$\n于是');
    expect(normalizeMath('\\[ \\frac{a}{b} \\]')).toBe('$$\n\\frac{a}{b}\n$$');
  });

  it('reads formulas the editor saved escaped', () => {
    expect(normalizeMath('休市时的 \\\\(P\\_t-I\\_t\\\\)，可能')).toBe('休市时的 $P_t-I_t$，可能');
    expect(normalizeMath('\\\\\\[ \\\\text{净值} = E\\_t\\[x\\] \\\\\\]')).toBe('$$\n\\text{净值} = E_t[x]\n$$');
    expect(normalizeMath('\\\\\\[ \\\\begin{aligned} &amp;a,\\\\\\\\ &amp;b \\\\end{aligned} \\\\\\]'))
      .toBe('$$\n\\begin{aligned} &a,\\\\ &b \\end{aligned}\n$$');
    // Two display formulas run together on one line become two blocks.
    expect(normalizeMath('\\\\\\[ a=1 \\\\\\]\\\\\\[ b=2 \\\\\\]')).toBe('$$\na=1\n$$\n\n$$\nb=2\n$$');
    // In a table row a display formula stays inline.
    expect(normalizeMath('| \\\\\\[ x \\\\\\] | 价格 |')).toBe('| $x$ | 价格 |');
  });

  it('keeps the indentation of a formula inside a list item', () => {
    expect(normalizeMath('- 收益：\n\n  \\[ \\Pi = q(F_0 - S_0) \\]')).toBe('- 收益：\n\n  $$\n  \\Pi = q(F_0 - S_0)\n  $$');
  });

  it('pairs single dollars only around a formula, so prices stay text', () => {
    expect(normalizeMath('其中 $x^2$ 和 $y$')).toBe('其中 $x^2$ 和 $y$');
    expect(normalizeMath('成本 $5，收益 $8')).toBe('成本 \\$5，收益 \\$8');
    expect(normalizeMath('从 $60,000 涨到 $65,000')).toBe('从 \\$60,000 涨到 \\$65,000');
    expect(normalizeMath('$ x $ 与 \\$5')).toBe('\\$ x \\$ 与 \\$5');
    expect(normalizeMath('$$\nx = 1\n$$\n\n行内 $$y$$')).toBe('$$\nx = 1\n$$\n\n行内 $$y$$');
    expect(normalizeMath('`$PATH` 与 $5')).toBe('`$PATH` 与 \\$5');
  });

  it('leaves escaped brackets, prices and code alone', () => {
    // The editor writes literal brackets as \[ \]; only LaTeX-looking ones on a line of their own are formulas.
    expect(normalizeMath('数组 a\\[0\\] 和 b\\[1\\]')).toBe('数组 a\\[0\\] 和 b\\[1\\]');
    expect(normalizeMath('\\[注\\]')).toBe('\\[注\\]');
    expect(normalizeMath('路径 D:\\data\\dacolz 下')).toBe('路径 D:\\data\\dacolz 下');
    expect(normalizeMath('用 `re.sub(r"\\(x\\)", s)` 替换')).toBe('用 `re.sub(r"\\(x\\)", s)` 替换');
    expect(normalizeMath('```\n\\(x\\)\n```\n\\(y\\)')).toBe('```\n\\(x\\)\n```\n$y$');
  });
});
