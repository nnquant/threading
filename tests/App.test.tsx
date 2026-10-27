// Interface tests run against the browser preview store, which follows the same contract as the Rust backend.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

// The record editor measures text ranges to keep the cursor in view; jsdom has no layout, so ranges get empty boxes.
const noBox = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect;
Range.prototype.getBoundingClientRect = () => noBox;
Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function start() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('heading', { name: '焦点', level: 1 });
  return user;
}
const section = (title: string) => screen.getByRole('heading', { name: new RegExp(`^${title}`), level: 2 }).closest('section')!;
const sectionHeading = (title: string) => screen.queryByRole('heading', { name: new RegExp(`^${title}`), level: 2 });

describe('Threading', () => {
  it('opens on focus with what needs attention across organizations', async () => {
    await start();
    expect(screen.getByText('浏览器预览，改动只保存在本浏览器')).toBeTruthy();
    expect(within(section('下一步日程')).getByText('补 2015–2017 年样本外回测')).toBeTruthy();
    expect(within(section('下一步日程')).getByText('逾期 1 天')).toBeTruthy();
    expect(within(section('等待中')).getByText('数据组补齐 2019 年分钟数据')).toBeTruthy();
    expect(within(section('停滞')).getByText('12 天未推进')).toBeTruthy();
    expect(within(section('缺少下一步')).getByText('基差动量')).toBeTruthy();
    expect(within(section('需要关注的项目')).getByText('中证 1000 指数增强')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: '导航' });
    expect(within(nav).getByText('澜湾资产')).toBeTruthy();
    expect(within(nav).getByRole('button', { name: /周回顾\s*13/ })).toBeTruthy();
  });

  it('completes a next step from focus and can undo it', async () => {
    const user = await start();
    await user.click(screen.getByRole('checkbox', { name: '完成：补 2015–2017 年样本外回测' }));
    await waitFor(() => expect(within(section('下一步日程')).queryByText('补 2015–2017 年样本外回测')).toBeNull());
    expect(screen.getByRole('status').textContent).toContain('已完成：补 2015–2017 年样本外回测');
    await user.click(screen.getByRole('button', { name: '撤销' }));
    expect(await within(section('下一步日程')).findByText('补 2015–2017 年样本外回测')).toBeTruthy();
  });

  it('adds a missing next step inline', async () => {
    const user = await start();
    await user.click(within(section('缺少下一步')).getByRole('button', { name: '写下一步' }));
    await user.type(screen.getByRole('textbox', { name: '基差动量 的下一步' }), '换现货价格源重算 IC{Enter}');
    await waitFor(() => expect(sectionHeading('缺少下一步')).toBeNull());
    // Enter submits and the input then unmounts; that must not add the step twice.
    await user.click(screen.getByRole('button', { name: /全部策略线/ }));
    await user.click(await screen.findByText('基差动量'));
    const panel = await screen.findByRole('complementary', { name: '策略线：基差动量' });
    expect(within(panel).getAllByRole('textbox', { name: '待办内容' }).map(box => (box as HTMLTextAreaElement).value)).toEqual(['换现货价格源重算 IC']);
  });

  it('cancels an inline rename with Escape', async () => {
    const user = await start();
    await user.click(within(section('停滞')).getByText('基差动量'));
    const panel = await screen.findByRole('complementary', { name: '策略线：基差动量' });
    const title = within(panel).getByRole('textbox', { name: '策略线名称' }) as HTMLTextAreaElement;
    await user.click(title);
    await user.type(title, '改个名');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(title.value).toBe('基差动量'));
    expect(screen.getByRole('complementary', { name: '策略线：基差动量' })).toBeTruthy();
    await user.click(title);
    await user.type(title, '二期{Enter}');
    expect(await screen.findByRole('complementary', { name: '策略线：基差动量二期' })).toBeTruthy();
  });

  it('creates a thread from the keyboard and opens it', async () => {
    const user = await start();
    await user.keyboard('n');
    const dialog = await screen.findByRole('dialog', { name: '新建策略线' });
    await user.type(within(dialog).getByPlaceholderText('例如：期限结构因子'), '偏度因子');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: '项目' }), '期权波动率');
    await user.click(within(dialog).getByRole('radio', { name: '研究' }));
    await user.type(within(dialog).getByPlaceholderText('接下来要做的第一件具体的事'), '拉取期权链');
    await user.click(within(dialog).getByRole('button', { name: '创建策略线' }));
    const panel = await screen.findByRole('complementary', { name: '策略线：偏度因子' });
    expect(within(panel).getByRole('radio', { name: '研究' }).getAttribute('aria-checked')).toBe('true');
    expect((within(panel).getByRole('textbox', { name: '待办内容' }) as HTMLTextAreaElement).value).toBe('拉取期权链');
    expect(within(panel).getByText('创建于研究阶段')).toBeTruthy();
  });

  it('branches a sub-line off a row and nests it under its parent', async () => {
    const user = await start();
    await user.click(screen.getByRole('button', { name: /全部策略线/ }));
    const row = (await screen.findByText('基差动量')).closest('button')!;
    await user.click(within(row).getByTitle('新建子策略线（Shift+N）'));
    const dialog = await screen.findByRole('dialog', { name: '新建子策略线' });
    expect((within(dialog).getByRole('combobox', { name: /上级/ }) as HTMLSelectElement).selectedOptions[0].textContent).toBe('基差动量');
    await user.type(within(dialog).getByPlaceholderText('例如：黑色板块'), '现货价格源对比');
    await user.click(within(dialog).getByRole('button', { name: '创建策略线' }));
    const panel = await screen.findByRole('complementary', { name: '策略线：现货价格源对比' });
    expect(within(within(panel).getByRole('navigation', { name: '位置' })).getByRole('button', { name: '基差动量' })).toBeTruthy();
    const titles = [...document.querySelectorAll('[data-thread] .cell-title > .truncate')].map(node => node.textContent);
    expect(titles[titles.indexOf('基差动量') + 1]).toBe('现货价格源对比');
    // The parent's work now goes on in its sub-line, which is the one missing a next step.
    await user.click(screen.getByRole('button', { name: /焦点/ }));
    expect(within(section('缺少下一步')).getByText('现货价格源对比')).toBeTruthy();
    expect(within(section('缺少下一步')).queryByText('基差动量')).toBeNull();
  });

  it('records stage changes and notes on the thread timeline', async () => {
    const user = await start();
    await user.click(within(section('停滞')).getByText('基差动量'));
    const panel = await screen.findByRole('complementary', { name: '策略线：基差动量' });
    await user.click(within(panel).getByRole('radio', { name: '回测' }));
    expect(await within(panel).findByText((_, node) => node?.tagName === 'SPAN' && node.textContent === '阶段 研究  回测')).toBeTruthy();
    await user.click(within(panel).getByRole('radio', { name: '决策' }));
    await user.type(within(panel).getByRole('textbox', { name: '记录内容' }), '改用南华现货指数');
    await user.click(within(panel).getByRole('button', { name: '记录决策' }));
    expect(await within(panel).findByText('改用南华现货指数')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    // Working on the line takes it off the stale list.
    expect(within(section('停滞')).queryByText('基差动量')).toBeNull();
  });

  it('sets formulas in records, written directly or through the editor', async () => {
    const user = await start();
    await user.click(within(section('停滞')).getByText('基差动量'));
    const panel = await screen.findByRole('complementary', { name: '策略线：基差动量' });
    const composer = within(panel).getByRole('textbox', { name: '记录内容' });
    const tex = () => [...panel.querySelectorAll('.timeline .katex annotation')].map(node => node.textContent);
    // As ChatGPT writes them.
    await user.click(composer);
    await user.paste('基差 \\(B_t = P_t - S_t\\)');
    await user.click(within(panel).getByRole('button', { name: '记录笔记' }));
    await waitFor(() => expect(tex()).toEqual(['B_t = P_t - S_t']));
    // Carried into the editor, the formula is a formula there and comes back as one.
    await user.click(composer);
    await user.paste('年化 \\(R \\times 365\\)');
    await user.click(within(panel).getByRole('button', { name: '在编辑器中写' }));
    const doc = await screen.findByRole('textbox', { name: '正文' });
    await waitFor(() => expect(doc.querySelector('[data-type="inline-math"]')?.getAttribute('data-latex')).toBe('R \\times 365'));
    await user.click(screen.getByRole('button', { name: '记录笔记' }));
    await waitFor(() => expect(tex()).toEqual(['R \\times 365', 'B_t = P_t - S_t']));
  });

  it('folds a long record and opens it in a tab of its own to read', async () => {
    // jsdom has no layout: every record measures tall, and the observer reports at once.
    vi.stubGlobal('ResizeObserver', class { constructor(private report: () => void) {} observe() { this.report(); } disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(1000);
    const user = await start();
    await user.click(within(section('停滞')).getByText('基差动量'));
    const panel = await screen.findByRole('complementary', { name: '策略线：基差动量' });
    await user.click(within(panel).getByRole('textbox', { name: '记录内容' }));
    await user.paste('# 南华指数对比\n\n换用现货指数后夏普更稳');
    await user.click(within(panel).getByRole('button', { name: '记录笔记' }));
    expect((await within(panel).findAllByRole('button', { name: '展开全文' })).length).toBeGreaterThan(0);
    // The H1 on its first line is the record's title, shown beside the kind rather than in the body.
    const title = within(panel).getByText('南华指数对比');
    expect(title.closest('.entry-head')?.textContent).toMatch(/^笔记南华指数对比/);
    expect(within(title.closest('li')!).queryByRole('heading', { name: '南华指数对比' })).toBeNull();
    await user.click((await within(panel).findAllByRole('button', { name: '在标签页中打开' }))[0]);
    const tabs = screen.getByRole('tablist', { name: '标签页' });
    // The tab is named after the record's first line.
    expect(await within(tabs).findByRole('tab', { name: '南华指数对比', selected: true })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '基差动量', level: 1 })).toBeTruthy();
    expect(within(screen.getByRole('article')).getByText('换用现货指数后夏普更稳')).toBeTruthy();
    // Editing it goes through the editor; closing the record returns to where it was opened.
    await user.click(screen.getByRole('button', { name: '编辑' }));
    expect(await within(tabs).findByRole('tab', { name: '编辑笔记：南华指数对比', selected: true })).toBeTruthy();
    await user.click(within(tabs).getByRole('tab', { name: '南华指数对比' }));
    await user.click(within(tabs).getByRole('button', { name: '关闭 南华指数对比' }));
    expect(within(tabs).getByRole('tab', { name: '焦点', selected: true })).toBeTruthy();
  });

  it('asks before deleting a thread', async () => {
    const user = await start();
    await user.click(within(section('等待中')).getByText('客户确认行业偏离上限'));
    const panel = await screen.findByRole('complementary', { name: '策略线：风格中性约束' });
    await user.click(within(panel).getByRole('button', { name: '删除策略线' }));
    const confirm = await screen.findByRole('dialog', { name: '删除策略线「风格中性约束」？' });
    await user.click(within(confirm).getByRole('button', { name: '永久删除' }));
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    expect(within(section('等待中')).queryByText('客户确认行业偏离上限')).toBeNull();
  });

  it('jumps anywhere through the command palette', async () => {
    const user = await start();
    await user.keyboard('{Control>}k{/Control}');
    const search = await screen.findByRole('combobox', { name: '搜索' });
    await user.type(search, '宏观');
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map(option => option.textContent)).toEqual(['宏观因子择时QM / 国债期货择时，回测']);
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('complementary', { name: '策略线：宏观因子择时' })).toBeTruthy();
  });

  it('draws every line as a thread across time', async () => {
    const user = await start();
    await user.click(screen.getByRole('button', { name: /全部策略线/ }));
    await user.click(await screen.findByRole('radio', { name: '线程' }));
    expect(within(screen.getByRole('radiogroup', { name: '时间范围' })).getByRole('radio', { name: '12 周' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: /^基差动量，研究，进行中，\d+ 天未推进$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^期限结构因子，回测，进行中，下一步：补 2015–2017 年样本外回测$/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^技术面趋势/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: /^50ETF 波动率曲面套利，回测，等待，已等 \d+ 天：数据组补齐 2019 年分钟数据$/ }));
    expect(await screen.findByRole('complementary', { name: '策略线：50ETF 波动率曲面套利' })).toBeTruthy();
    // Arrow keys walk the lines in sidebar order, across projects and organizations.
    await user.keyboard('{ArrowDown}');
    expect(await screen.findByRole('complementary', { name: '策略线：基本面 Alpha 模型' })).toBeTruthy();

    await user.click(screen.getByRole('checkbox', { name: /显示已结束/ }));
    expect(screen.getByRole('button', { name: /^技术面趋势，退役，已结束$/ })).toBeTruthy();
    // It closed 30 days ago, before the four-week range begins.
    await user.click(screen.getByRole('radio', { name: '4 周' }));
    expect(screen.queryByRole('button', { name: /^技术面趋势/ })).toBeNull();
  });

  it('adds and clears the demo data only through words typed into the search box', async () => {
    const user = await start();
    const nav = screen.getByRole('navigation', { name: '导航' });
    const search = async (text: string) => {
      await user.click(screen.getByRole('button', { name: '搜索或跳转' }));
      await user.type(await screen.findByRole('combobox', { name: '搜索' }), text);
    };
    expect(within(nav).getAllByText('示例')).toHaveLength(3);
    await user.click(within(nav).getByRole('button', { name: '设置' }));
    expect(within(await screen.findByRole('dialog', { name: '设置' })).queryByText(/示例数据/)).toBeNull();
    await user.keyboard('{Escape}');
    await search('示例数据');
    expect(screen.queryByRole('option', { name: /示例数据/ })).toBeNull();
    await user.keyboard('{Escape}');

    await search('DISABLE_SAMPLE_DATA');
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['清理示例数据']);
    await user.keyboard('{Enter}');
    const confirm = await screen.findByRole('dialog', { name: '清理示例数据？' });
    expect(confirm.textContent).toContain('3 个示例组织（自营研究、澜湾资产、启明投顾）');
    await user.click(within(confirm).getByRole('button', { name: '清理示例数据' }));
    expect(await screen.findByText('从一个组织开始')).toBeTruthy();
    expect(within(nav).queryByText('澜湾资产')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('已清理示例数据');
    expect(screen.queryByRole('button', { name: /示例数据/ })).toBeNull();

    await search('ENABLE_SAMPLE_DATA');
    await user.keyboard('{Enter}');
    expect(await within(nav).findByText('澜湾资产')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('已添加 3 个示例组织');
  });

  it('shows a project with its threads, hill chart and activity', async () => {
    const user = await start();
    await user.click(within(screen.getByRole('navigation', { name: '导航' })).getByRole('button', { name: /中证 1000 指数增强/ }));
    expect(await screen.findByRole('heading', { name: '中证 1000 指数增强', level: 1 })).toBeTruthy();
    // Its paused sub-line, grouped apart from it, names it as its parent too.
    expect(within(screen.getByRole('main')).getAllByText('基本面 Alpha 模型')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: '山丘图' }));
    expect(screen.getByRole('slider', { name: '高频量价因子，回测' }).getAttribute('aria-valuenow')).toBe('55');
    await user.click(screen.getByRole('button', { name: /^动态/ }));
    await user.type(screen.getByRole('textbox', { name: '记录内容' }), '回撤原因找到了，是小盘因子暴露。');
    await user.click(screen.getByRole('radio', { name: '正常' }));
    await user.click(screen.getByRole('button', { name: '记录进展' }));
    // In the timeline, and as the latest update under the goal
    expect(await within(screen.getByRole('main')).findAllByText('回撤原因找到了，是小盘因子暴露。')).toHaveLength(2);
    expect(screen.getByText('回撤原因找到了，是小盘因子暴露。', { selector: '.brief-update-body' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '健康度：正常' })).toBeTruthy();
  });

  it('opens each project in a tab of its own that keeps its place', async () => {
    const user = await start();
    const nav = screen.getByRole('navigation', { name: '导航' });
    const tabs = screen.getByRole('tablist', { name: '标签页' });
    await user.click(within(nav).getByRole('button', { name: /期权波动率/ }));
    expect(within(tabs).getByRole('tab', { name: '期权波动率', selected: true })).toBeTruthy();
    await user.click(await within(screen.getByRole('main')).findByText('50ETF 波动率曲面套利'));
    expect(await screen.findByRole('complementary', { name: '策略线：50ETF 波动率曲面套利' })).toBeTruthy();
    // Views from the sidebar go to the home tab; the project tab stays as it was.
    await user.click(within(nav).getByRole('button', { name: /周回顾/ }));
    expect(within(tabs).getByRole('tab', { name: '周回顾', selected: true })).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
    await user.click(within(tabs).getByRole('tab', { name: '期权波动率' }));
    expect(screen.getByRole('complementary', { name: '策略线：50ETF 波动率曲面套利' })).toBeTruthy();
    // Opening the project again brings back its tab instead of adding one.
    await user.click(within(nav).getByRole('button', { name: /期权波动率/ }));
    expect(within(tabs).getAllByRole('tab')).toHaveLength(2);
    await user.click(within(tabs).getByRole('button', { name: '关闭 期权波动率' }));
    expect(within(tabs).getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: '周回顾', level: 1 })).toBeTruthy();
  });

  it('carries a record from the composer to the editor tab and files it on the line', async () => {
    const user = await start();
    await user.click(within(section('停滞')).getByText('基差动量'));
    const panel = await screen.findByRole('complementary', { name: '策略线：基差动量' });
    await user.click(within(panel).getByRole('radio', { name: '决策' }));
    await user.type(within(panel).getByRole('textbox', { name: '记录内容' }), '改用南华现货指数');
    await user.click(within(panel).getByRole('button', { name: '在编辑器中写' }));
    const tabs = screen.getByRole('tablist', { name: '标签页' });
    expect(await within(tabs).findByRole('tab', { name: '决策：基差动量', selected: true })).toBeTruthy();
    expect((await screen.findByRole('textbox', { name: '正文' })).textContent).toBe('改用南华现货指数');
    // The composer it came from is empty now and points at the draft.
    await user.click(within(tabs).getByRole('tab', { name: '焦点' }));
    expect((within(panel).getByRole('textbox', { name: '记录内容' }) as HTMLTextAreaElement).value).toBe('');
    await user.click(within(panel).getByRole('button', { name: '继续编辑决策草稿' }));
    await user.click(screen.getByRole('button', { name: '记录决策' }));
    await waitFor(() => expect(within(tabs).getAllByRole('tab')).toHaveLength(1));
    expect(screen.getByRole('status').textContent).toContain('已记录决策');
    expect(await within(panel).findByText('改用南华现货指数')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: '继续编辑决策草稿' })).toBeNull();
  });

  it('asks before throwing away a draft', async () => {
    const user = await start();
    await user.click(within(section('停滞')).getByText('基差动量'));
    const panel = await screen.findByRole('complementary', { name: '策略线：基差动量' });
    await user.type(within(panel).getByRole('textbox', { name: '记录内容' }), '半成品');
    await user.click(within(panel).getByRole('button', { name: '在编辑器中写' }));
    const tabs = screen.getByRole('tablist', { name: '标签页' });
    await user.click(await within(tabs).findByRole('button', { name: '关闭 笔记：基差动量' }));
    const confirm = await screen.findByRole('dialog', { name: '放弃这份草稿？' });
    await user.click(within(confirm).getByRole('button', { name: '放弃草稿' }));
    await waitFor(() => expect(within(tabs).getAllByRole('tab')).toHaveLength(1));
    expect(within(panel).queryByRole('button', { name: /^继续编辑/ })).toBeNull();
  });
});
