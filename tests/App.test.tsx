// Interface tests run against the browser preview store, which follows the same contract as the Rust backend.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from '../src/App';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

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
    expect(screen.getByText('当前为浏览器预览，使用演示数据，改动只保存在本浏览器。请运行 Threading 桌面客户端管理真实数据。')).toBeTruthy();
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
    await user.selectOptions(within(dialog).getByRole('combobox'), '期权波动率');
    await user.click(within(dialog).getByRole('radio', { name: '研究' }));
    await user.type(within(dialog).getByPlaceholderText('接下来要做的第一件具体的事'), '拉取期权链');
    await user.click(within(dialog).getByRole('button', { name: '创建策略线' }));
    const panel = await screen.findByRole('complementary', { name: '策略线：偏度因子' });
    expect(within(panel).getByRole('radio', { name: '研究' }).getAttribute('aria-checked')).toBe('true');
    expect((within(panel).getByRole('textbox', { name: '待办内容' }) as HTMLTextAreaElement).value).toBe('拉取期权链');
    expect(within(panel).getByText('创建于研究阶段')).toBeTruthy();
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

  it('shows a project with its threads, hill chart and activity', async () => {
    const user = await start();
    await user.click(within(screen.getByRole('navigation', { name: '导航' })).getByRole('button', { name: /中证 1000 指数增强/ }));
    expect(await screen.findByRole('heading', { name: '中证 1000 指数增强', level: 1 })).toBeTruthy();
    expect(screen.getByText('基本面 Alpha 模型')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '山丘图' }));
    expect(screen.getByRole('slider', { name: '高频量价因子，回测' }).getAttribute('aria-valuenow')).toBe('55');
    await user.click(screen.getByRole('button', { name: /^动态/ }));
    await user.type(screen.getByRole('textbox', { name: '记录内容' }), '回撤原因找到了，是小盘因子暴露。');
    await user.click(screen.getByRole('radio', { name: '正常' }));
    await user.click(screen.getByRole('button', { name: '记录进展' }));
    expect(await screen.findByText('回撤原因找到了，是小盘因子暴露。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '健康度：正常' })).toBeTruthy();
  });
});
