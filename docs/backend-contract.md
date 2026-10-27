# Threading 后端契约

前端（`src/`）与 Rust 后端（`src-tauri/`）之间的唯一约定。类型以 [`src/types.ts`](../src/types.ts) 为准，后端用 serde `rename_all = "camelCase"` 一一对应；本文件规定命令、校验与副作用。前端只调用这里列出的命令，不直接接触数据库。

## 概念

- **组织 Organization**：客户、基金或团队。下设多个策略项目。
- **策略项目 Project**：属于一个组织，有健康度（`onTrack` / `atRisk` / `offTrack`）和状态（`active` / `paused` / `done` / `archived`）。
- **策略线 Thread**：项目里并行推进的一条线。`stage` 是所处研发阶段（构想 → 研究 → 回测 → 模拟 → 实盘 → 退役），`state` 是我当前对它的投入状态（进行中 / 等待 / 搁置 / 已结束），`hill` 是山丘图位置（0–100，<50 仍在摸索，>50 只剩执行）。策略线可以嵌套：`parentId` 指向它分出来的上级策略线，`null` 表示项目下的一级策略线，层级不限深度。
- **下一步 Todo**：策略线上的待办。位置最靠前、未完成的一条就是这条线的“下一步”。
- **记录 Entry**：时间线条目。`note` 笔记、`decision` 决策、`result` 结果、`update` 项目进展（可带健康度），`event` 是后端自动生成的变更记录。`threadId` 为 `null` 表示项目级条目。

## 存储

- SQLite（`rusqlite`，`bundled` 特性），文件为 `<app_data_dir>/threading.db`（Windows 上即 `%APPDATA%\com.threading.desktop\threading.db`）。设置了环境变量 `THREADING_DATA_DIR` 时改用该目录，供测试和开发使用。
- 打开时设置 `PRAGMA journal_mode = WAL`、`PRAGMA foreign_keys = ON`；用 `PRAGMA user_version` 做顺序迁移，从 1 开始。
- 迁移 3：`threads` 加 `parent_id TEXT NULL REFERENCES threads(id)`，并为 `(project_id, parent_id, position)` 建索引。已有策略线的 `parent_id` 为 `NULL`。
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
| `import_demo_data` | `seed: DemoSeed` | `Change` |
| `clear_demo_data` | — | `Change` |
| `save_image` | `data: string`（图片文件的 base64） | `ImageRef` |
| `read_image` | `id: string` | 图片原始字节（前端收到 `ArrayBuffer`） |

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
| 策略线 `parentId` | `null`，或一条存在的策略线：必须与这条线在同一个项目，且不能是它自己或它的子孙（不能成环）。错误分别为 `找不到上级策略线，可能已被删除。`、`上级策略线必须在同一个项目里。`、`不能把策略线放到它自己或它的子策略线下面。` |
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
- 新建行追加到同一父级末尾：组织全局，项目按组织，策略线按项目和上级策略线（`projectId` 与 `parentId` 都相同的是同级），待办按策略线（`position = max + 1`，空时为 0）。
- `reorder` 的 `ids` 必须是同一父级下**全部**同类行的一个排列；否则报错。策略线的同一父级指 `projectId` 和 `parentId` 都相同。按顺序把 `position` 重写为 0..n-1，并在 `Change` 中返回这些行。

### 策略线活动时间

- `lastActivityAt` 初始等于 `createdAt`。
- 下列操作把所属策略线的 `lastActivityAt` 与 `updatedAt` 刷新为当前时间，并把该策略线放进 `Change`：对策略线本身的任何修改（仅 `reviewed: true` 时除外）、新建 / 修改 / 删除它的待办、新建 / 修改它的条目。
- 推进子策略线也算推进上级：凡是刷新了某条策略线的 `lastActivityAt`，就把它（按操作完成后的位置）的每一级上级也刷新为同一时间并放进 `Change`。新建子策略线刷新它的上级链；删除策略线刷新被删子树之上的上级链。
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
| 策略线 `parentId` 改变 | `{ field: "parent", from: <旧上级标题或 null>, to: <新上级标题或 null> }` |
| 项目 `health` 经 `update_project` 改变 | `{ field: "health", from, to }`，`threadId = null` |
| 项目 `status` 改变 | `{ field: "status", from, to }`，`threadId = null` |

- 值没有真正改变时不生成事件。一次 patch 改了多个字段时，按上表顺序各生成一条。
- 策略线移到其他项目时，它的所有条目的 `projectId` 一并改为新项目，并在 `Change.entries` 中返回。子策略线一起移动，见下文。
- `event` 条目不能用 `update_entry` 修改（报错），可以删除。

### 子策略线

- `create_thread` 带 `parentId` 时建的是子策略线：上级必须存在且 `projectId` 与上级相同，否则按“校验”中的错误返回。新建只生成 `created` 事件，不生成 `parent` 事件。
- `update_thread` 的 `parentId`（`Option<Option<Id>>`，显式 `null` 表示改为一级策略线）只在真正改变时生效：校验上级后，把这条线追加到新同级的末尾（重算 `position`），生成 `parent` 事件。这条线的子孙跟着它，`parentId` 不变。
- `update_thread` 带不同的 `projectId` 时，这条线**连同全部子孙**移到新项目：
  - 这条线的新上级是本次 patch 的 `parentId`（必须在新项目里），没给则为 `null`；上级因此改变时照常生成 `parent` 事件。它追加到新同级末尾；子孙保持原有的 `parentId` 和 `position`。
  - 子树里的每条线都改 `projectId`、刷新 `updatedAt`（子孙的 `lastActivityAt` 不变），各自生成一条 `project` 事件；它们的全部条目改挂到新项目。所有这些行都放进 `Change`。
- 关闭、搁置上级不影响子策略线的状态和阶段，两者互相独立。

### 项目进展

- `create_entry` 的 `kind = "update"` 时 `threadId` 必须为 `null`。若带 `health` 且与项目当前健康度不同，同时更新项目 `health` 与 `updatedAt`，并把项目放进 `Change`；这种情况下**不再**额外生成 `health` 事件。
- 其他 `kind` 不接受 `health`（传了则报错）。`threadId` 非空时，该策略线必须属于 `projectId` 指定的项目。

### 删除

删除都是永久的，按层级级联：

- `delete_organization`：删除组织、其下所有项目、策略线、待办和条目。
- `delete_project`：删除项目、其下所有策略线、待办和条目（含项目级条目）。
- `delete_thread`：删除策略线及其全部子孙策略线，以及这些线的待办和条目。
- `Change.deleted` 列出每一个被删除的行。前端负责二次确认。

### 设置

`settings` 存放在单独的键值表中。`update_settings` 返回 `Change { settings }`。

### 示例数据

用户可以把一套示例数据（几个组织、项目、策略线，带几个月的历史）加进真实数据库试用，之后一键清理。示例数据由前端生成（与浏览器预览的示例数据同源，见 `src/demo.ts`），后端负责原样写入和整体删除。

- 组织新增 `demo` 布尔字段，新增一次迁移：`organizations` 加 `demo INTEGER NOT NULL DEFAULT 0`。已有组织和 `create_organization` 建的组织为 `false`；`update_organization` 不能修改它。示例数据的归属以组织为准：示例组织下的一切都算示例数据。
- `import_demo_data(seed)` 在一个事务内写入 `seed` 中的全部行，**保留前端给出的 `id` 和所有时间戳**（这是“前端传入的时间戳一律忽略”的唯一例外）：
  - 已存在任何示例组织时报错：`示例数据已经添加过了，先清理再重新添加。`
  - 任一 `id` 与数据库中已有行冲突，或在 `seed` 内部重复时报错。
  - 引用必须闭合在 `seed` 内：项目的 `orgId` 指向 `seed` 中的组织；策略线的 `projectId` 指向 `seed` 中的项目，`parentId` 为 `null` 或指向 `seed` 中同一项目的策略线且不成环（写入顺序要保证上级先于子策略线，或等价地满足外键）；待办的 `threadId` 指向 `seed` 中的策略线；条目的 `projectId` 指向 `seed` 中的项目，`threadId` 为 `null` 或指向 `seed` 中属于同一项目的策略线。
  - 每个字段按上文“校验”中对应新建命令的规则检查（枚举值、长度、日期、`hill`、标签、指标等），不合法时报错而不是修正。另外检查：`state` 为 `waiting` 当且仅当 `waitingSince` 非空，为 `closed` 当且仅当 `closedAt` 非空；`done` 当且仅当 `doneAt` 非空；`event` 条目的 `body` 为空、`event` 合法、`health` 为 `null`；其他条目 `event` 为 `null`、`body` 非空，只有 `threadId` 为 `null` 的 `update` 条目可以带 `health`；时间戳不晚于当前时间 5 分钟以上，`updatedAt` 和 `lastActivityAt` 不早于 `createdAt`。
  - 每类行数设合理上限（组织 20、项目 100、策略线 500、待办 2000、条目 5000），超出报错。
  - 所有组织以 `demo = true` 写入（忽略传入值），`position` 按 `seed` 中的顺序接在现有组织之后；其他行的 `position` 原样保存。
  - 不产生任何副作用：不生成事件条目，不刷新 `lastActivityAt`，不改设置。
  - 返回 `Change`，包含写入的每一行（组织按最终的 `demo` 和 `position`）。
- `clear_demo_data()` 删除所有示例组织，级联方式与 `delete_organization` 相同，`Change.deleted` 列出每一个被删除的行。用户在示例组织里新建的内容一并删除（前端会提前说明）；从示例项目移到非示例项目的策略线保留。没有示例数据时返回空 `Change`。

## 图片

记录、策略线说明这类 Markdown 正文里可以插入图片（前端的编辑器支持粘贴、拖入和选择文件）。图片不进数据库，以文件形式保存在数据库旁边，正文里只写引用。

- 位置：`<data_dir>/images/<id>`，`<data_dir>` 是数据库文件所在目录（受 `THREADING_DATA_DIR` 影响）。目录不存在时创建。
- `id` 就是文件名：`<uuid v4 小写>.<ext>`，例如 `3f2a9c1e-8b7d-4e6f-a1b2-c3d4e5f60789.png`。正文里写作 `![说明](attachment:<id>)`。
- 图片保存后不再修改。删除记录、策略线或清理示例数据都**不删除**图片文件（正文可能被复制到别处，JSON 备份也引用它们）；暂不做自动清理。两个命令都不读写数据库，不返回 `Change`，也不影响 `load_workspace`。

`save_image(data)`：

- `data` 是图片文件内容的标准 base64（RFC 4648 字母表，允许 `=` 填充，不带 `data:` 前缀，不含换行）。
- 解码失败：`图片数据无法读取。`；解码后为 0 字节：`图片是空的。`；超过 10 MB（10 × 1024 × 1024 字节）：`图片不能超过 10 MB。`
- 按文件头识别格式，不信任任何扩展名或 MIME：PNG（`89 50 4E 47 0D 0A 1A 0A`）→ `png` / `image/png`；JPEG（`FF D8 FF`）→ `jpg` / `image/jpeg`；GIF（`GIF87a` 或 `GIF89a`）→ `gif` / `image/gif`；WebP（`RIFF` + 4 字节 + `WEBP`）→ `webp` / `image/webp`。其他一律：`只支持 PNG、JPEG、GIF 和 WebP 图片。`
- 先写同目录下的临时文件，`sync` 后重命名为最终文件名；失败时删除临时文件并返回 `无法保存图片。`
- 返回 `ImageRef { id, mime, size }`，`size` 为字节数。

`read_image(id)`：

- `id` 必须完整匹配 `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$`，否则 `图片地址无效。`（拒绝 `..`、斜杠、反斜杠、盘符、大写等任何变体，防止读到图片目录以外的文件）。
- 文件不存在：`找不到这张图片，可能已被删除。`
- 成功时用 `tauri::ipc::Response` 返回原始字节，不做 base64 或 JSON 包装。

## 窗口与权限

与 Dropping 一致：无边框透明主窗口（`decorations: false`、`transparent: true`、`shadow: false`），窗口标识 `main`，默认 1360×880、最小 960×640、居中。前端自绘标题栏，需要的权限：

- `core:default`、`core:window:allow-minimize`、`core:window:allow-toggle-maximize`、`core:window:allow-close`、`core:window:allow-start-dragging`
- `tauri-plugin-opener`：`opener:allow-open-url`（仅 `http://*`、`https://*`）、`opener:allow-reveal-item-in-dir`

CSP 在 Dropping 的基础上为图片放开 `blob:`（前端把 `read_image` 读到的字节转成 blob URL 显示）和 `https:`（正文里引用的网络图片）：`default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost data: blob: https:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'self'`。

## 测试要求

`cargo test --locked --manifest-path src-tauri/Cargo.toml` 覆盖：迁移与重开、每条校验规则的拒绝路径、事件生成（含“未改变不生成”）、`waiting` / `closed` 联动、`lastActivityAt` 与 `reviewed`、移动项目时条目跟随、项目进展更新健康度、`reorder` 的正确与错误输入、级联删除返回的 `deleted` 完整、备份轮换、示例数据的写入（保留 id 与时间戳、`demo` 与位置）与各条拒绝路径、清理只删除示例组织及其下内容；迁移 3 保留旧数据；子策略线的新建与上级校验（不存在、跨项目、自身、成环）、改上级与 `parent` 事件、同级内的 `position` 与 `reorder`、移项目时整棵子树连同条目跟随、删除时子孙全部级联且 `deleted` 完整、推进子策略线刷新整条上级链、示例数据中的 `parentId` 引用与成环拒绝；图片的四种格式各自保存并原样读回（文件名、扩展名、`mime`、`size`）、格式靠文件头识别（扩展名对不上的数据也按内容判定）、各条拒绝路径（base64 非法、空、超过 10 MB 的边界、不支持的格式、`id` 的路径穿越与大小写等变体、文件不存在）、保存后图片目录里不残留临时文件，以及经由真实 IPC 调用两个命令（`read_image` 返回原始字节）。测试用临时目录，不触碰真实数据目录。
