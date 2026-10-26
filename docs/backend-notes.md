# Threading 后端实现说明

2026-10-26，版本 0.1.0。以 `src/types.ts` 与 `docs/backend-contract.md` 为准；未修改前端、共享类型、契约、根目录配置或依赖文件。

## 命令与存储

已注册契约中的全部 19 个异步命令，参数名和 JSON 字段名保持一致：

- `load_workspace`
- `create_organization`、`update_organization`、`delete_organization`
- `create_project`、`update_project`、`delete_project`
- `create_thread`、`update_thread`、`delete_thread`
- `create_todo`、`update_todo`、`delete_todo`
- `create_entry`、`update_entry`、`delete_entry`
- `reorder`、`update_settings`、`backup_now`

命令在 `spawn_blocking` 工作线程中持有连接互斥锁。每次变更在 SQLite IMMEDIATE 事务内读取快照、校验、应用业务规则、计算完整 Change、保存和提交；提交失败不会返回成功 Change。即使时间戳恰好相同，也显式返回被触及的策略线等行。工作区读取使用独立读事务，保证多个表来自同一个快照。

数据库为应用数据目录下的 `threading.db`，支持 `THREADING_DATA_DIR`。相对覆盖目录会解析为绝对路径；空环境变量视为未设置。启用 WAL、外键、5 秒忙等待；`user_version = 1`，拒绝打开更高版本，避免旧程序误写新库。`schema.sql` 定义独立实体表、JSON 文本列、设置键值表及父级索引；条目使用可延迟检查的复合外键，保证移动后项目与策略线一致。

每日备份使用本地日期，跨重启检查同名文件，只保留最近 14 个合法日期的每日文件；手动备份不参与轮换。备份移除 `dataPath`，使用同目录唯一临时文件、同步落盘和重命名。每日失败写 stderr，加载继续，后续加载可重试。

## 契约边界的处理

没有改变命令、参数或返回结构。对契约没有进一步展开的情况作如下补充：

- 项目移动组织、策略线移动项目时，追加到目标父级末尾；原父级位置不自动压紧，显式 `reorder` 才压紧。
- `reorder` 也属于修改：策略线排序刷新其活动时间，待办排序刷新所属策略线活动时间。空 `ids` 仅在该类实体完全为空时接受；否则无法从空列表确定父级，返回中文错误。
- 仅 `reviewed: true` 保持 `updatedAt` 和 `lastActivityAt` 不变，只写 `reviewedAt`。空策略线 patch、仅 `reviewed: false` 不修改记录；显式传入其他业务字段，即使值相同，仍算一次编辑，但不会重复生成事件。
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
