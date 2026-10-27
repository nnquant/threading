import { describe, expect, it } from 'vitest';
import { tidyMarkdown } from '../src/Editor';

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
