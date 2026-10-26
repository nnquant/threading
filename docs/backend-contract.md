# Threading 后端契约

前端（`src/`）与 Rust 后端（`src-tauri/`）之间的唯一约定。类型以 [`src/types.ts`](../src/types.ts) 为准，后端用 serde `rename_all = "camelCase"` 一一对应；本文件规定命令、校验与副作用。前端只调用这里列出的命令，不直接接触数据库。

## 概念

- **组织 Organization**：客户、基金或团队。下设多个策略项目。
- **策略项目 Project**：属于一个组织，有健康度（`onTrack` / `atRisk` / `offTrack`）和状态（`active` / `paused` / `done` / `archived`）。
- **策略线 Thread**：项目里并行推进的一条线。`stage` 是所处研发阶段（构想 → 研究 → 回测 → 模拟 → 实盘 → 退役），`state` 是我当前对它的投入状态（进行中 / 等待 / 搁置 / 已结束），`hill` 是山丘图位置（0–100，<50 仍在摸索，>50 只剩执行）。
- **下一步 Todo**：策略线上的待办。位置最靠前、未完成的一条就是这条线的“下一步”。
- **记录 Entry**：时间线条目。`note` 笔记、`decision` 决策、`result` 结果、`update` 项目进展（可带健康度），`event` 是后端自动生成的变更记录。`threadId` 为 `null` 表示项目级条目。

## 存储

- SQLite（`rusqlite`，`bundled` 特性），文件为 `<app_data_dir>/threading.db`（Windows 上即 `%APPDATA%\com.threading.desktop\threading.db`）。设置了环境变量 `THREADING_DATA_DIR` 时改用该目录，供测试和开发使用。
- 打开时设置 `PRAGMA journal_mode = WAL`、`PRAGMA foreign_keys = ON`；用 `PRAGMA user_version` 做顺序迁移，从 1 开始。
- `tags`、`metrics`、`event` 以 JSON 文本列保存；读出时总是返回合法数组 / 对象。
- 每个变更命令在一个事务内完成，提交成功后才返回 `Change`。失败时不留下部分写入。
- 连接放在 `AppState` 的 `Mutex<Connection>` 中；所有命令为 `async` 并通过 `spawn_blocking` 或同等方式避免阻塞 IPC 线程。

### 备份

- `load_workspace` 首次在某个自然日（本地时间）被调用时，把完整快照写成 `<data_dir>/backups/threading-YYYYMMDD.json`（结构与 `Workspace` 相同，`dataPath` 除外），只保留最近 14 个。写入采用临时文件 + 重命名。备份失败不影响加载，但要记录到 stderr。
- `backup_now` 立即写一份 `threading-YYYYMMDD-HHMMSS.json`，返回绝对路径。它不计入 14 个的轮换上限。

## 命令

参数名在前端为 camelCase，Tauri 自动映射为 Rust 的 snake_case。所有变更命令返回 `Change`。错误统一返回中文 `String`，可直接展示给用户，例如 `找不到该策略线，可能已被删除。`

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `load_workspace` | — | `Workspace` |
| `create_organization` | `input: OrganizationInput` | `Change` |
| `update_organization` | `id, patch: OrganizationPatch` | `Change` |
| `delete_organization` | `id` | `Change` |
| `create_project` | `input: ProjectInput` | `Change` |
| `update_project` | `id, patch: ProjectPatch` | `Change` |
| `delete_project` | `id` | `Change` |
| `create_thread` | `input: ThreadInput` | `Change` |
| `update_thread` | `id, patch: ThreadPatch` | `Change` |
| `delete_thread` | `id` | `Change` |
| `create_todo` | `input: TodoInput` | `Change` |
| `update_todo` | `id, patch: TodoPatch` | `Change` |
| `delete_todo` | `id` | `Change` |
| `create_entry` | `input: EntryInput` | `Change` |
| `update_entry` | `id, patch: EntryPatch` | `Change` |
| `delete_entry` | `id` | `Change` |
| `reorder` | `kind: 'organization' \| 'project' \| 'thread' \| 'todo', ids: Id[]` | `Change` |
| `update_settings` | `patch: SettingsPatch` | `Change` |
| `backup_now` | — | `string`（备份文件绝对路径） |

`load_workspace` 返回的数组按 `position` 升序，`entries` 按 `createdAt` 升序。

### Change 的内容

`Change` 必须包含本次命令改动过的**每一行的完整最新值**（包括连带更新的行，例如被刷新 `lastActivityAt` 的策略线、自动生成的 `event` 条目），以及 `deleted` 中所有被删除的行（含级联删除）。前端只靠 `Change` 合并状态，不会重新加载。没有内容的键可以省略。

### Patch 语义

- 字段缺省表示不修改。
- `targetDate`、`due`、`threadId`、`health` 这类可空字段：显式传 `null` 表示清空。Rust 侧用 `Option<Option<T>>` 区分缺省与 `null`（如 `#[serde(default, deserialize_with = ...)]`）。
- 未知字段忽略。

## 校验

所有字符串先 `trim`。超出限制或非法值返回中文错误，不做静默截断。

| 字段 | 规则 |
| --- | --- |
| 组织 `name` | 必填，≤ 60 字符 |
| 组织 `code` | ≤ 6 字符，转大写；为空时取 `name` 的前两个字符（按 Unicode 字符计）并转大写 |
| 组织 `color` | `ORG_COLORS` 之一，默认按已有组织数轮换 |
| 组织 `note`、项目 `goal` | ≤ 2000 字符 |
| 项目 `name` | 必填，≤ 80 字符 |
| 项目 `orgId` | 必须存在 |
| `targetDate`、`due` | 合法的 `YYYY-MM-DD` 日历日期，或 `null` |
| 策略线 `title` | 必填，≤ 120 字符 |
| 策略线 `summary`、条目 `body` | ≤ 20000 字符；条目 `body` 必填（`update` 带健康度时也必须有正文） |
| `hill` | 0–100 的整数 |
| `waitingOn` | ≤ 80 字符 |
| `tags` | 每个 ≤ 24 字符，去掉空项，忽略大小写去重（保留首次出现的写法），最多 12 个 |
| `metrics` | 最多 12 项；`label` ≤ 24、`value` ≤ 40；丢弃 `label` 为空的项 |
| 待办 `text` | 必填，≤ 500 字符 |
| `staleDays` | 1–90 的整数，默认 7 |
| `wipLimit` | 0–50 的整数，默认 8（0 表示关闭提醒） |

字符计数按 Unicode 标量（`chars().count()`）。

## 副作用规则

### 时间与位置

- `id` 用 UUID v4。`createdAt` / `updatedAt` 由后端以当前毫秒时间写入；前端传入的时间戳一律忽略。
- 新建行追加到同一父级末尾：组织全局，项目按组织，策略线按项目，待办按策略线（`position = max + 1`，空时为 0）。
- `reorder` 的 `ids` 必须是同一父级下**全部**同类行的一个排列；否则报错。按顺序把 `position` 重写为 0..n-1，并在 `Change` 中返回这些行。

### 策略线活动时间

- `lastActivityAt` 初始等于 `createdAt`。
- 下列操作把所属策略线的 `lastActivityAt` 与 `updatedAt` 刷新为当前时间，并把该策略线放进 `Change`：对策略线本身的任何修改（仅 `reviewed: true` 时除外）、新建 / 修改 / 删除它的待办、新建 / 修改它的条目。
- `reviewed: true` 只更新 `reviewedAt`，不刷新 `lastActivityAt`。同一次 patch 里还有其他字段时，照常刷新。

### 状态字段联动

- `state` 变为 `waiting`：若原先不是 `waiting`，`waitingSince = now`。`waitingOn` 取本次 patch 的值或保留原值。
- `state` 离开 `waiting`：`waitingSince = null`，`waitingOn = ""`。
- `state` 变为 `closed`：`closedAt = now`；离开 `closed`：`closedAt = null`。
- 新建策略线时 `state` 为 `waiting` 同样设置 `waitingSince`，为 `closed` 同样设置 `closedAt`。
- 待办 `done` 变为 `true`：`doneAt = now`；变回 `false`：`doneAt = null`。

### 自动事件条目（`kind = "event"`，`body = ""`）

| 触发 | `event` |
| --- | --- |
| 新建策略线 | `{ field: "created", from: null, to: <stage> }` |
| 策略线 `stage` 改变 | `{ field: "stage", from, to }` |
| 策略线 `state` 改变 | `{ field: "state", from, to }` |
| 策略线移到其他项目 | `{ field: "project", from: <旧项目名>, to: <新项目名> }`，条目挂在新项目下 |
| 项目 `health` 经 `update_project` 改变 | `{ field: "health", from, to }`，`threadId = null` |
| 项目 `status` 改变 | `{ field: "status", from, to }`，`threadId = null` |

- 值没有真正改变时不生成事件。一次 patch 改了多个字段时，按上表顺序各生成一条。
- 策略线移到其他项目时，它的所有条目的 `projectId` 一并改为新项目，并在 `Change.entries` 中返回。
- `event` 条目不能用 `update_entry` 修改（报错），可以删除。

### 项目进展

- `create_entry` 的 `kind = "update"` 时 `threadId` 必须为 `null`。若带 `health` 且与项目当前健康度不同，同时更新项目 `health` 与 `updatedAt`，并把项目放进 `Change`；这种情况下**不再**额外生成 `health` 事件。
- 其他 `kind` 不接受 `health`（传了则报错）。`threadId` 非空时，该策略线必须属于 `projectId` 指定的项目。

### 删除

删除都是永久的，按层级级联：

- `delete_organization`：删除组织、其下所有项目、策略线、待办和条目。
- `delete_project`：删除项目、其下所有策略线、待办和条目（含项目级条目）。
- `delete_thread`：删除策略线及其待办和条目。
- `Change.deleted` 列出每一个被删除的行。前端负责二次确认。

### 设置

`settings` 存放在单独的键值表中。`update_settings` 返回 `Change { settings }`。

## 窗口与权限

与 Dropping 一致：无边框透明主窗口（`decorations: false`、`transparent: true`、`shadow: false`），窗口标识 `main`，默认 1360×880、最小 960×640、居中。前端自绘标题栏，需要的权限：

- `core:default`、`core:window:allow-minimize`、`core:window:allow-toggle-maximize`、`core:window:allow-close`、`core:window:allow-start-dragging`
- `tauri-plugin-opener`：`opener:allow-open-url`（仅 `http://*`、`https://*`）、`opener:allow-reveal-item-in-dir`

CSP 同 Dropping：`default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'self'`。

## 测试要求

`cargo test --locked --manifest-path src-tauri/Cargo.toml` 覆盖：迁移与重开、每条校验规则的拒绝路径、事件生成（含“未改变不生成”）、`waiting` / `closed` 联动、`lastActivityAt` 与 `reviewed`、移动项目时条目跟随、项目进展更新健康度、`reorder` 的正确与错误输入、级联删除返回的 `deleted` 完整、备份轮换。测试用临时目录，不触碰真实数据目录。
