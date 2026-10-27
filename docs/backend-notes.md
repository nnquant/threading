# Threading 后端实现说明

2026-10-26，版本 0.1.0。以 `src/types.ts` 与 `docs/backend-contract.md` 为准；未修改前端、共享类型、契约、根目录配置或依赖文件。

## 命令与存储

已注册契约中的全部 21 个异步命令，参数名和 JSON 字段名保持一致：

- `load_workspace`
- `create_organization`、`update_organization`、`delete_organization`
- `create_project`、`update_project`、`delete_project`
- `create_thread`、`update_thread`、`delete_thread`
- `create_todo`、`update_todo`、`delete_todo`
- `create_entry`、`update_entry`、`delete_entry`
- `reorder`、`update_settings`、`backup_now`
- `import_demo_data`、`clear_demo_data`

命令在 `spawn_blocking` 工作线程中持有连接互斥锁。每次变更在 SQLite IMMEDIATE 事务内读取快照、校验、应用业务规则、计算完整 Change、保存和提交；提交失败不会返回成功 Change。即使时间戳恰好相同，也显式返回被触及的策略线等行。工作区读取使用独立读事务，保证多个表来自同一个快照。

数据库为应用数据目录下的 `threading.db`，支持 `THREADING_DATA_DIR`。相对覆盖目录会解析为绝对路径；空环境变量视为未设置。启用 WAL、外键、5 秒忙等待；当前 `user_version = 3`，拒绝打开更高版本，避免旧程序误写新库。`schema.sql` 保留版本 1 定义，版本 2 在迁移事务中追加 `organizations.demo INTEGER NOT NULL DEFAULT 0`，版本 3 追加子策略线关联，详见下文。全新数据库依次执行三次迁移。条目使用可延迟检查的复合外键，保证移动后项目与策略线一致。

每日备份使用本地日期，跨重启检查同名文件，只保留最近 14 个合法日期的每日文件；手动备份不参与轮换。备份移除 `dataPath`，使用同目录唯一临时文件、同步落盘和重命名。每日失败写 stderr，加载继续，后续加载可重试。

## 契约边界的处理

命令、参数和返回结构遵循契约。对契约没有进一步展开的情况作如下补充：

- 项目移动组织、策略线移动项目时，追加到目标父级末尾；原父级位置不自动压紧，显式 `reorder` 才压紧。
- `reorder` 也属于修改：策略线排序刷新其活动时间，待办排序刷新所属策略线活动时间。空 `ids` 仅在该类实体完全为空时接受；否则无法从空列表确定父级，返回中文错误。
- 仅 `reviewed: true` 保持 `updatedAt` 和 `lastActivityAt` 不变，只写 `reviewedAt`。空策略线 patch、仅 `reviewed: false` 不修改记录；显式传入其他业务字段（`parentId` 除外，见下文），即使值相同，仍算一次编辑，但不会重复生成事件。
- 删除条目不刷新策略线活动时间，遵循契约列举的活动触发范围。编辑或删除历史项目进展只影响条目，不回退项目当前健康度。
- 非 `update` 条目只要显式带 `health` 就报错，包括 `health: null`；`update` 可省略或传 null，表示这条进展不调整健康度。
- 标签去空、去重后最多 12 项；指标丢弃空 label 后最多 12 项。空 label 的指标整体忽略。组织简称先 trim、生成默认值或大写，再检查 Unicode 标量长度，大小写扩展导致超过 6 字符也拒绝。
- 日期限定为公历 `0001-01-01` 至 `9999-12-31`，严格十位格式，接受首尾空白并 trim。
- 手动备份文件名严格采用契约的秒级格式；同一秒内连续调用会原子替换同名手动备份，以最后一次快照为准。不同秒的手动备份均保留。
- 如果每日备份同名路径是目录，按备份失败处理，不把它当作已成功备份。

## 工程和权限

edition 2021、库名 `threading_lib`、release strip/thin LTO/单 codegen unit 与参考项目保持一致。`Cargo.lock` 位于 `src-tauri/`。当前锁定 Tauri 2.12.5、opener 2.7.2（与已安装 npm opener 2.7.2 一致）、rusqlite 0.38.0 bundled。

主窗口为 `main`，1360×880，最小 960×640，居中、无边框、透明、无阴影。CSP 与契约完全一致。仅配置指定 core/窗口权限、限制为 HTTP/HTTPS 的 `opener:allow-open-url`，及 `opener:allow-reveal-item-in-dir`；没有授予打开任意本地文件的权限。

主窗口设置 `dragDropEnabled: false`：已核对锁定的 Tauri 2.12.5 / tauri-utils 2.10.2 配置定义，该字段默认开启；应用不需要接收系统拖入文件，关闭后可避免 Tauri 的 WebView2 拖放处理拦截看板换阶段和待办排序所需的 HTML5 拖放事件，并通过 Rust 测试使用 `tauri::Config` 解析 `tauri.conf.json` 断言该设置。

图标通过 `npx tauri icon public/threading.svg -o src-tauri/icons` 生成，仅保留 `32x32.png`、`128x128.png`、`128x128@2x.png`、`icon.ico`、`icon.icns`。配置包含 MIT、Productivity、中文描述和 NSIS 简体中文/英语。

Windows MSVC 下，Tauri 默认资源仅为桌面二进制附带 Common Controls v6 manifest，真实 IPC 单元测试引入的 `TaskDialogIndirect` 因此曾导致测试程序启动错误 `0xc0000139`。`build.rs` 改为通过链接器给所有本包目标嵌入同样的 Common Controls v6 依赖，同时关闭 Tauri 重复嵌入 manifest；图标及版本资源仍由 Tauri 生成。修复后标准测试命令可在当前 Windows 沙箱直接运行。

## 验证

在 `D:\project\threading` 使用 Rust 1.95.0 执行：

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo build --manifest-path src-tauri/Cargo.toml
```

四条全部通过；17 项 Rust 测试通过，0 失败、0 忽略；Clippy 无警告。桌面程序生成于 `D:\project\threading\src-tauri\target\debug\threading.exe`（开发构建，未打包 NSIS 安装程序）。

测试覆盖全部字段的拒绝路径和失败无部分写入、迁移重开、外键、日期 null/缺省、Unicode、默认值/位置、自动事件顺序和不重复、waiting/closed/done 时间联动、复查与活动时间、移动时条目跟随、进展更新健康度、排序、完整级联删除、数据库写入失败回滚、备份轮换和失败清理。另通过真实 Tauri mock IPC 依次调用全部 19 个命令，模拟前端只合并 Change，每步与数据库快照比对；验证备份失败仍能加载。

所有测试数据使用 `src-tauri/work/rust-test-<UUID>/`，继承目录权限，结束时关闭连接并清理，不访问真实用户数据目录。未运行前端构建或启动实际桌面窗口。

## Windows 对外路径修复（2026-10-26）

启动时 `canonicalize()` 产生的 Windows verbatim 路径原先直接进入 IPC 返回值。现在内部文件操作继续使用规范路径，对外统一转换：`\\?\C:\...` 显示为 `C:\...`，`\\?\UNC\server\share\...` 显示为 `\\server\share\...`；非 Windows 平台保持原样。

转换覆盖 `Workspace.dataPath`、`backup_now` 返回值、命令错误链、后台任务错误、启动错误和每日备份失败日志。没有新增依赖，`Cargo.toml`、`Cargo.lock` 和接口契约无需改动。

新增 Windows 回归测试覆盖盘符路径、UNC 路径、中文与空格、已是普通形式的路径以及嵌套错误链。现有 Tauri mock IPC 测试增加对两个路径返回值的断言：不以 `\\?\` 开头、是绝对路径、指向实际文件、规范化后与内部文件路径相同，并能读取相同内容。UNC 转换通过字符串用例验证，未连接真实网络共享。

本次在 Windows / Rust 1.95.0 下验证，避免占用正在运行的桌面程序产物，测试和 Clippy 使用独立 target 目录：

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target/codex
cargo clippy --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target/codex --all-targets -- -D warnings
```

三条命令退出码均为 0；18 项 Rust 测试通过，0 失败、0 忽略；Clippy 无警告。未结束任何进程，未操作真实用户数据库；本次未做运行中桌面窗口或 Explorer 的交互验证。

## 示例数据写入与清理（2026-10-26）

本次只修改 `src-tauri/src/models.rs`、`src-tauri/src/store.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/tests.rs` 和本文档。

迁移版本 **2** 为旧组织补 `demo = false`。普通创建显式设为 false；OrganizationPatch 不包含 demo，传入该未知字段会被忽略，不能改变归属。组织序列化、加载、Change、每日及手动备份均包含布尔 demo。

`import_demo_data` 的 IPC 参数为 `seed`，在阻塞工作线程解码 DemoSeed，沿用 IMMEDIATE 事务和快照差异保存。先检查重复导入、每类行数上限、全库跨类型 ID 冲突及 seed 内跨类型重复，再检查仅在 seed 内闭合的引用、字段、状态时间联动、全部时间戳。复用 text/code/choice/date/tags/metrics；如果校验结果需要 trim、大写、补默认简称、标签去空去重或丢弃指标才合法，直接拒绝，避免静默修正原始数据。ID 保留，不重新生成；必须非空且无首尾空白。事件检查 field、from/to 的枚举或项目名称，以及事件所属层级。

所有时间戳按原值保存；每个时间字段最多允许比命令当前时间超前 300000 毫秒（含边界），updatedAt 和 lastActivityAt 不早于 createdAt。日期字段仍可为将来的合法日历日期。组织按 seed 顺序从现有最大 position + 1 追加，忽略传入 demo 并写 true；其他 position 保留。成功 Change 包含全部导入行，不生成额外事件，不改变历史活动时间、项目健康度或设置。所有业务校验在修改快照之前完成；数据库保存失败则回滚整个事务。

`clear_demo_data` 在同一事务中逐个调用既有 organization 删除逻辑，由快照差异产生完整 deleted。示例组织中后来新增的记录也删除；已移到非示例项目的策略线、待办及随迁条目保留。没有示例组织时返回 `{}`，不会报“没有示例数据”。清理失败则回滚所有级联删除。

### 错误信息原文

import_demo_data 新增的业务错误如下（带花括号的为实际代码中的参数化模板）：

- `示例数据已经添加过了，先清理再重新添加。`
- `示例数据的 id 重复或与已有记录冲突。`
- `示例数据的 id 不能为空或包含首尾空白。`
- `示例数据的{label}不能超过 {limit} 行。`：组织 20、项目 100、策略线 500、待办 2000、条目 5000。
- `示例数据的{label}格式不规范，请先整理后再导入。`
- `示例项目必须引用本次导入的组织。`
- `示例策略线必须引用本次导入的项目。`
- `示例待办必须引用本次导入的策略线。`
- `示例条目必须引用本次导入的项目。`
- `示例条目的策略线必须属于本次导入的同一项目。`
- `示例策略线的 waiting 与 waitingSince 不一致。`
- `示例策略线的 closed 与 closedAt 不一致。`
- `示例待办的 done 与 doneAt 不一致。`
- `示例数据时间戳不能晚于当前时间 5 分钟以上。`
- `示例数据的 updatedAt 不能早于 createdAt。`
- `示例数据的 lastActivityAt 不能早于 createdAt。`
- `示例事件条目的正文必须为空且健康度必须为 null。`
- `示例事件条目缺少 event。`
- `示例事件内容无效。`
- `非事件示例条目的 event 必须为 null。`
- `组织位置超出可用范围，无法添加示例数据。`

复用的字段校验原文为 `{label}不能为空。`、`{label}不能超过 {max} 个字符。`、`{label}无效。`、`日期必须为有效的 YYYY-MM-DD。`、`日期不是有效的日历日期`、`日期年份必须在 0001–9999 之间。`、`标签不能超过 12 个。`、`指标不能超过 12 项。`、`山丘位置必须是 0–100 的整数。`、`项目进展条目不能属于策略线。`、`只有项目进展条目可以传入健康度。`。字段类型/必填字段错误沿用 `输入格式无效，请检查字段类型和必填项`，后接 serde 错误详情。

clear_demo_data 没有新增业务错误。两个命令沿用公共数据库错误上下文：`无法开始保存事务`、`无法读取工作区`、`提交保存失败`；导入写入失败为 `保存组织失败` / `保存项目失败` / `保存策略线失败` / `保存待办失败` / `保存条目失败`，清理删除失败为 `删除记录失败`。这些错误后接实际底层原因，并统一经过现有路径显示转换；例如测试触发的清理失败包含 `删除记录失败: 模拟删除失败`。

### 本次验证

新增 8 项测试，覆盖从真实版本 1 schema 建库迁移、历史数据逐字段读回、备份 demo、禁止 patch 改归属、重复导入、各类型/跨类型 ID 冲突、外部与缺失引用、错误项目引用、字段拒绝路径、六类事件、waiting/closed/done 双向不一致、全部时间戳及精确 5 分钟边界、五类行数上限及等于上限、导入和清理 SQL 失败整体回滚、完整 deleted、保留真实和移出内容。既有真实 Tauri mock IPC 测试新增两个命令的成功、重复导入、空清理和格式错误调用，并逐次合并 Change 与数据库比对。

验收命令使用独立 target 目录，所有测试数据库仍在 `src-tauri/work/rust-test-<UUID>/`，不接触真实用户数据：

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --locked --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target/codex
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --target-dir src-tauri/target/codex -- -D warnings
```

三条验收命令退出码均为 0：27 项 Rust 测试通过（0 失败、0 忽略），Clippy 无警告。另按 `tests/bridge.test.ts` 的提取方式只读核对，前端 bridge 与 `generate_handler!` 的 21 个命令完全一致；未运行前端测试套件。未结束任何进程。

## 子策略线（2026-10-27）

迁移 3 增加 `threads.parent_id TEXT NULL REFERENCES threads(id)`，旧行保持 NULL；JSON 读写映射为 `parentId`，patch 使用 `Option<Option<String>>` 区分缺省和显式 null。契约写作 `(project_id, parent_id, position)`，但 v1/v2 的实际列名为 `projectId`，因此保留旧列名，建立等价索引 `threads_siblings(projectId, parent_id, position)`，不重建旧表。测试从旧 schema 真正创建 v2 文件、写入全部类型的历史记录及非默认设置，再迁移并重开验证。

沿用一个 IMMEDIATE 事务内的快照操作：子树查询在内存快照上建立父子邻接表，迭代遍历全部后代；上级校验沿祖先链检查存在、同项目和环，不限制层数、不递归调用。新建及改上级按 `(projectId, parentId)` 的最大 position + 1 追加，排序要求该组完整排列。跨项目移动保留后代的 parentId/position/lastActivityAt，更新整棵子树的项目和 updatedAt，迁移全部所属条目，并分别生成 project 事件。

所有活动刷新统一经过 `touch`，按操作完成后的上级链同步 updatedAt/lastActivityAt；删除子树后从其原上级开始刷新。旧上级在重挂或移项目时不刷新。显式返回触及的整条链，即使同一毫秒数值未变，Change 也完整。仅 reviewed 不传播；关闭或搁置上级不修改子孙。相同 parentId 的 patch 按“只在真正改变时生效”视为无操作；其他显式字段沿用原有编辑语义。parent 事件保存旧/新上级标题或 null，允许历史同名上级；导入时拒绝两端均 null、空白或超长标题及项目级 parent 事件。

持久化时对变更策略线做拓扑排序，上级先写入，支持 seed 中子级排在上级之前；删除先删条目、待办，再按原树拓扑逆序删子策略线，最后删项目和组织。delete_thread、delete_project、delete_organization、clear_demo_data 均返回完整 deleted，外键始终开启；任何校验或 SQL 失败回滚整个命令。

新增 13 项测试，总计 40 项，覆盖 500 层逆序导入、祖先传播、同毫秒 Change、迁移 3、拒绝路径、事件顺序、同级排序、整树移项目与删除、真实 Tauri mock IPC 合并、数据库写入/删除失败回滚。验收使用隔离构建目录，测试数据仍只在 `src-tauri/work/rust-test-<UUID>/`：

```powershell
$env:CARGO_TARGET_DIR = 'src-tauri/target/codex'
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

上述两条验收命令均退出 0：40 项测试通过，0 失败、0 忽略，Clippy 无警告；cargo fmt --check 与范围内 git diff --check 也通过。
