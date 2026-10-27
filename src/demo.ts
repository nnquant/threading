// Demo data shared by the browser preview and the ENABLE_SAMPLE_DATA command typed into the search box.
// Every timestamp is relative to `now`, so the lines arrive with a few months of history behind them.
import { DAY, addDays, parseIso, todayIso } from './labels';
import type { DemoSeed, Entry, EntryEvent, Id, Organization, Project, Thread, Todo, Workspace } from './types';

/** The browser preview starts from the demo rows with default settings. */
export function seedWorkspace(now = Date.now()): Workspace {
  return { ...demoSeed(now), settings: { staleDays: 7, wipLimit: 8 }, dataPath: '浏览器预览（不写入本机文件）' };
}

/** Three organizations with quant strategy projects at different stages and states. */
export function demoSeed(now = Date.now()): DemoSeed {
  // Hours only order events within a day: a time is kept on the calendar day `days` back, so "12 天" stays 12 just after midnight.
  const ago = (days: number, hours = 0) => Math.max(parseIso(addDays(today, -days)).getTime(), now - days * DAY - hours * 3_600_000);
  const today = todayIso(now);
  const organizations: Organization[] = [];
  const projects: Project[] = [];
  const threads: Thread[] = [];
  const todos: Todo[] = [];
  const entries: Entry[] = [];
  const org = (name: string, code: string, color: Organization['color']) => {
    const row: Organization = { id: crypto.randomUUID(), name, code, color, note: '', archived: false, demo: true, position: organizations.length, createdAt: ago(150), updatedAt: ago(150) };
    organizations.push(row);
    return row.id;
  };
  const project = (orgId: Id, name: string, goal: string, health: Project['health'], status: Project['status'] = 'active', targetDate: string | null = null) => {
    const row: Project = { id: crypto.randomUUID(), orgId, name, goal, status, health, targetDate, position: projects.filter(p => p.orgId === orgId).length, createdAt: ago(130), updatedAt: ago(3) };
    projects.push(row);
    return row.id;
  };
  // `born` and every `days` value count days back from now; `history` lists stage and state changes as [days, field, from, to].
  // `under` makes it a sub-line; a parent's own `idle` should be no longer than its sub-lines', since their work counts as its work.
  type Spec = Partial<Thread> & Pick<Thread, 'title' | 'stage'> & {
    idle: number; born?: number; under?: Thread; todo?: [string, number | null][]; done?: [string, number][];
    log?: [Entry['kind'], string, number][]; history?: [number, 'stage' | 'state', string, string][];
  };
  const thread = (projectId: Id, spec: Spec) => {
    const { idle, born = 60, under, todo = [], done = [], log = [], history = [], ...fields } = spec;
    const parentId = under?.id ?? null;
    const row: Thread = {
      id: crypto.randomUUID(), projectId, parentId, summary: '', state: 'active', priority: 'normal', hill: 0, waitingOn: '', waitingSince: null, tags: [], metrics: [],
      position: threads.filter(t => t.projectId === projectId && t.parentId === parentId).length,
      createdAt: ago(born), updatedAt: ago(idle), lastActivityAt: ago(idle, 2), reviewedAt: null, closedAt: null,
      ...fields,
    };
    threads.push(row);
    const event = (createdAt: number, value: EntryEvent) => entries.push({ id: crypto.randomUUID(), projectId, threadId: row.id, kind: 'event', body: '', health: null, event: value, createdAt, editedAt: null });
    event(row.createdAt, { field: 'created', from: null, to: 'idea' });
    history.forEach(([days, field, from, to]) => event(ago(days, 4), { field, from, to }));
    todo.forEach(([text, due], position) => todos.push({
      id: crypto.randomUUID(), threadId: row.id, text, due: due == null ? null : addDays(today, due), done: false, doneAt: null, position, createdAt: ago(idle + 3), updatedAt: ago(idle + 3),
    }));
    done.forEach(([text, days], offset) => todos.push({
      id: crypto.randomUUID(), threadId: row.id, text, due: null, done: true, doneAt: ago(days, 5), position: todo.length + offset, createdAt: ago(days + 4), updatedAt: ago(days, 5),
    }));
    log.forEach(([kind, body, days]) => entries.push({ id: crypto.randomUUID(), projectId, threadId: row.id, kind, body, health: null, event: null, createdAt: ago(days, 3), editedAt: null }));
    return row;
  };

  const own = org('自营研究', 'ZY', 'slate');
  const bay = org('澜湾资产', 'LW', 'blue');
  const dawn = org('启明投顾', 'QM', 'teal');

  const cta = project(own, '商品 CTA 多因子', '年底前完成 3 条低相关因子线的模拟盘验证，组合夏普 > 1.5。', 'onTrack', 'active', addDays(today, 66));
  const vol = project(own, '期权波动率', '搭建波动率曲面数据与回测框架，验证两条波动率策略。', 'atRisk');
  const enhance = project(bay, '中证 1000 指数增强', '年化超额 8% 以上，跟踪误差控制在 5% 以内。', 'atRisk', 'active', addDays(today, 35));
  const cb = project(bay, '可转债轮动', '双低框架改进，等客户确认额度后重启。', 'onTrack', 'paused');
  const bond = project(dawn, '国债期货择时', '为客户的利率债组合提供久期择时信号。', 'onTrack', 'active', addDays(today, 20));

  const term = thread(cta, {
    title: '期限结构因子', stage: 'backtest', priority: 'high', hill: 62, idle: 1, born: 58, tags: ['展期收益', '截面'],
    summary: '用主力与次主力的展期收益率构造截面因子，按板块中性化。\n\n- 数据：日频收盘价、持仓量\n- 调仓：周频',
    metrics: [{ label: '夏普', value: '1.42' }, { label: '年化', value: '18.6%' }, { label: '最大回撤', value: '-9.8%' }],
    todo: [['补 2015–2017 年样本外回测', -1], ['检查换月逻辑对收益的影响', null]],
    done: [['清洗主力合约换月数据', 40], ['写第一版截面回测', 26], ['按板块做中性化', 9]],
    history: [[52, 'stage', 'idea', 'research'], [24, 'stage', 'research', 'backtest']],
    log: [
      ['note', '展期收益在黑色和能化板块分化明显，先做板块内排序。', 45], ['result', 'IC 0.045，IR 0.6，值得进回测。', 27],
      ['result', '样本内夏普 1.6，样本外降到 1.1，主要被黑色系拖累。', 4], ['decision', '换月改为按持仓量切换，不再按固定日期。', 2],
    ],
  });
  const ferrous = thread(cta, {
    title: '黑色板块', under: term, stage: 'backtest', hill: 58, idle: 1, born: 30, tags: ['黑色'],
    todo: [['补焦煤、焦炭的展期数据', 3]],
    done: [['拆出黑色板块样本', 18]],
    history: [[28, 'stage', 'idea', 'research'], [16, 'stage', 'research', 'backtest']],
    log: [['result', '黑色板块单独回测夏普 1.3，换月日附近波动最大。', 6]],
  });
  thread(cta, {
    title: '换月规则对比', under: ferrous, stage: 'research', hill: 25, idle: 2, born: 9,
    todo: [['跑按持仓量换月的对照组', 1]],
    history: [[8, 'stage', 'idea', 'research']],
    log: [['note', '固定日期换月在 2016 年焦炭上有明显跳空。', 2]],
  });
  thread(cta, {
    title: '能化板块', under: term, stage: 'research', state: 'waiting', hill: 30, idle: 5, born: 20, waitingOn: '数据组补甲醇、PTA 的仓单数据', waitingSince: ago(5, 4),
    history: [[17, 'stage', 'idea', 'research'], [5, 'state', 'active', 'waiting']],
    log: [['note', '能化板块展期收益和库存周期关系更紧，可能要单独建模。', 9]],
  });
  thread(cta, {
    title: '动量与波动率择时', stage: 'paper', hill: 78, idle: 2, born: 75, tags: ['时序'],
    metrics: [{ label: '夏普', value: '1.21' }, { label: '模拟天数', value: '23' }],
    todo: [['核对模拟盘与回测的成交差异', 2]],
    done: [['参数稳健性扫描', 30], ['接入模拟盘账户', 24]],
    history: [[71, 'stage', 'idea', 'research'], [52, 'stage', 'research', 'backtest'], [23, 'stage', 'backtest', 'paper']],
    log: [
      ['decision', '波动率用 20 日 ATR，不用标准差。', 47], ['result', '回测夏普 1.35，换手可控。', 31],
      ['note', '模拟盘第三周，滑点比假设高 0.6 bp，先观察到月底。', 2],
    ],
  });
  thread(cta, {
    title: '基差动量', stage: 'research', hill: 30, idle: 12, born: 40, tags: ['基差'],
    history: [[34, 'stage', 'idea', 'research'], [28, 'state', 'active', 'waiting'], [21, 'state', 'waiting', 'active']],
    log: [['note', '初步 IC 0.03，偏弱，需要换现货价格源再看。', 12]],
  });
  thread(cta, { title: '仓单因子', stage: 'idea', state: 'paused', priority: 'low', hill: 5, idle: 20, born: 44, history: [[20, 'state', 'active', 'paused']] });

  thread(vol, {
    title: '50ETF 波动率曲面套利', stage: 'backtest', state: 'waiting', hill: 40, idle: 6, born: 70, waitingOn: '数据组补齐 2019 年分钟数据', waitingSince: ago(6, 4),
    todo: [['数据到位后重跑 2019 年', null]],
    done: [['搭建曲面拟合流程', 38]],
    history: [[63, 'stage', 'idea', 'research'], [33, 'stage', 'research', 'backtest'], [6, 'state', 'active', 'waiting']],
    log: [['decision', '曲面用 SVI 参数化，放弃样条。', 41], ['note', '2019 年分钟数据缺口较大，曲面拟合不稳定。', 8]],
  });
  thread(vol, {
    title: '尾部对冲', stage: 'research', priority: 'high', hill: 20, idle: 3, born: 21, todo: [['确定对冲预算上限', 5]],
    history: [[15, 'stage', 'idea', 'research']], log: [['note', '比较虚值看跌期权和 VIX 期货两种对冲方式的成本。', 3]],
  });

  const alpha = thread(enhance, {
    title: '基本面 Alpha 模型', stage: 'live', priority: 'urgent', hill: 90, idle: 0, born: 120, tags: ['实盘'],
    metrics: [{ label: '超额年化', value: '9.2%' }, { label: '跟踪误差', value: '4.1%' }, { label: '信息比', value: '1.9' }],
    todo: [['排查 10 月超额回撤的原因', 0], ['给客户写月度归因说明', 4]],
    done: [['上线前风控检查', 42], ['9 月归因说明', 26], ['调整行业偏离约束', 12]],
    history: [[112, 'stage', 'idea', 'research'], [95, 'stage', 'research', 'backtest'], [72, 'stage', 'backtest', 'paper'], [41, 'stage', 'paper', 'live']],
    log: [
      ['result', '模拟盘 4 周超额 1.1%，跟踪误差 3.8%。', 44], ['decision', '客户同意 11 月起按 3000 万规模实盘。', 42],
      ['result', '9 月超额 1.4%。', 25], ['result', '10 月以来超额回撤 2.3%，集中在小盘成长。', 1],
    ],
  });
  thread(enhance, {
    title: '盈利预测修正因子', under: alpha, stage: 'backtest', hill: 52, idle: 4, born: 35,
    todo: [['和现有模型做正交化', 2]],
    history: [[32, 'stage', 'idea', 'research'], [14, 'stage', 'research', 'backtest']],
    log: [['result', '单因子 IC 0.038，与动量因子相关性 0.2。', 5]],
  });
  thread(enhance, {
    title: '分析师情绪因子', under: alpha, stage: 'research', state: 'paused', priority: 'low', hill: 15, idle: 13, born: 28,
    history: [[25, 'stage', 'idea', 'research'], [13, 'state', 'active', 'paused']],
  });
  thread(enhance, {
    title: '高频量价因子', stage: 'backtest', priority: 'high', hill: 55, idle: 9, born: 50, todo: [['去掉涨跌停样本后重算 IC', 1]],
    history: [[45, 'stage', 'idea', 'research'], [19, 'stage', 'research', 'backtest']],
    log: [['result', '分钟级反转因子 IC 0.06，衰减很快。', 22]],
  });
  thread(enhance, {
    title: '风格中性约束', stage: 'research', state: 'waiting', hill: 35, idle: 3, born: 30, waitingOn: '客户确认行业偏离上限', waitingSince: ago(3, 4),
    history: [[26, 'stage', 'idea', 'research'], [3, 'state', 'active', 'waiting']],
    log: [['note', '行业偏离放到 ±3% 时跟踪误差降到 4% 以内。', 5]],
  });

  thread(cb, {
    title: '双低策略改进', stage: 'paper', state: 'paused', hill: 70, idle: 25, born: 90,
    history: [[84, 'stage', 'idea', 'backtest'], [55, 'stage', 'backtest', 'paper'], [25, 'state', 'active', 'paused']],
    log: [['result', '加入正股动量后年化提高 3%。', 60]],
  });

  thread(bond, {
    title: '宏观因子择时', stage: 'backtest', hill: 48, idle: 1, born: 35, todo: [['加入资金面指标', 1]],
    history: [[31, 'stage', 'idea', 'research'], [12, 'stage', 'research', 'backtest']],
    log: [['decision', '信号频率定为周度，月度太慢。', 1]],
  });
  thread(bond, {
    title: '技术面趋势', stage: 'retired', state: 'closed', hill: 100, idle: 30, born: 75, closedAt: ago(30, 4),
    history: [[70, 'stage', 'idea', 'research'], [52, 'stage', 'research', 'backtest'], [30, 'stage', 'backtest', 'retired'], [30, 'state', 'active', 'closed']],
    log: [['result', '扣费后不显著，停止。', 30]],
  });

  entries.push({ id: crypto.randomUUID(), projectId: enhance, threadId: null, kind: 'update', body: '实盘超额回撤，客户已在问。本周优先排查回撤原因，高频因子线往后放。', health: 'atRisk', event: null, createdAt: ago(1, 5), editedAt: null });
  entries.push({ id: crypto.randomUUID(), projectId: cta, threadId: null, kind: 'update', body: '两条线进入回测以后，进度符合预期。', health: 'onTrack', event: null, createdAt: ago(5), editedAt: null });

  return { organizations, projects, threads, todos, entries };
}
