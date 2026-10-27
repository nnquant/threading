mod backup;
mod models;
mod store;

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result};
use models::*;
use rusqlite::Connection;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::{Manager, State};

struct AppState {
    connection: Arc<Mutex<Connection>>,
    data_path: PathBuf,
}

fn display_error(error: anyhow::Error) -> String {
    display_text(format!("{error:#}"))
}

// Keep canonical paths for filesystem operations; expose ordinary Windows paths to users.
fn display_text(text: String) -> String {
    #[cfg(windows)]
    {
        text.replace(r"\\?\UNC\", r"\\").replace(r"\\?\", "")
    }
    #[cfg(not(windows))]
    {
        text
    }
}

fn display_path(path: &std::path::Path) -> String {
    display_text(path.to_string_lossy().into_owned())
}

fn decode<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).context("输入格式无效，请检查字段类型和必填项")
}

async fn blocking<T: Send + 'static>(
    state: State<'_, AppState>,
    operation: impl FnOnce(&mut Connection, &std::path::Path) -> Result<T> + Send + 'static,
) -> Result<T, String> {
    let connection = Arc::clone(&state.connection);
    let data_path = state.data_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = connection
            .lock()
            .map_err(|_| anyhow::anyhow!("数据库锁已损坏，请重启应用。"))?;
        operation(&mut conn, &data_path)
    })
    .await
    .map_err(|e| display_text(format!("后台任务执行失败：{e}")))?
    .map_err(display_error)
}

fn snapshot(conn: &mut Connection, path: &std::path::Path) -> Result<Workspace> {
    let tx = conn.transaction().context("无法开始读取工作区")?;
    let workspace = store::load(&tx, path).context("无法加载工作区")?;
    tx.commit().context("无法完成工作区读取")?;
    Ok(workspace)
}

#[tauri::command]
async fn load_workspace(state: State<'_, AppState>) -> Result<Workspace, String> {
    blocking(state, |conn, path| {
        let workspace = snapshot(conn, path)?;
        if let Err(error) = backup::daily(&workspace, path, chrono::Local::now().date_naive()) {
            eprintln!("每日备份失败：{}", display_error(error));
        }
        Ok(workspace)
    })
    .await
}

// Decode on the blocking worker so malformed input also gets a Chinese error context.
macro_rules! create_command {
    ($name:ident, $input:ty) => {
        #[tauri::command]
        async fn $name(state: State<'_, AppState>, input: Value) -> Result<Change, String> {
            blocking(state, move |conn, path| {
                let input: $input = decode(input)?;
                store::transact(conn, path, |w, now| store::$name(w, input, now))
            })
            .await
        }
    };
}
macro_rules! update_command {
    ($name:ident, $patch:ty) => {
        #[tauri::command]
        async fn $name(
            state: State<'_, AppState>,
            id: String,
            patch: Value,
        ) -> Result<Change, String> {
            blocking(state, move |conn, path| {
                let patch: $patch = decode(patch)?;
                store::transact(conn, path, |w, now| store::$name(w, &id, patch, now))
            })
            .await
        }
    };
}
macro_rules! delete_command {
    ($name:ident, $kind:literal) => {
        #[tauri::command]
        async fn $name(state: State<'_, AppState>, id: String) -> Result<Change, String> {
            blocking(state, move |conn, path| {
                store::transact(conn, path, |w, now| store::delete(w, $kind, &id, now))
            })
            .await
        }
    };
}

create_command!(create_organization, OrganizationInput);
create_command!(create_project, ProjectInput);
create_command!(create_thread, ThreadInput);
create_command!(create_todo, TodoInput);
create_command!(create_entry, EntryInput);
update_command!(update_organization, OrganizationPatch);
update_command!(update_project, ProjectPatch);
update_command!(update_thread, ThreadPatch);
update_command!(update_todo, TodoPatch);
update_command!(update_entry, EntryPatch);
delete_command!(delete_organization, "organization");
delete_command!(delete_project, "project");
delete_command!(delete_thread, "thread");
delete_command!(delete_todo, "todo");
delete_command!(delete_entry, "entry");

#[tauri::command]
async fn reorder(
    state: State<'_, AppState>,
    kind: String,
    ids: Vec<String>,
) -> Result<Change, String> {
    blocking(state, move |conn, path| {
        store::transact(conn, path, |w, now| store::reorder(w, &kind, ids, now))
    })
    .await
}

#[tauri::command]
async fn update_settings(state: State<'_, AppState>, patch: Value) -> Result<Change, String> {
    blocking(state, move |conn, path| {
        let patch = decode(patch)?;
        store::transact(conn, path, |w, now| store::update_settings(w, patch, now))
    })
    .await
}

#[tauri::command]
async fn import_demo_data(state: State<'_, AppState>, seed: Value) -> Result<Change, String> {
    blocking(state, move |conn, path| {
        let seed: DemoSeed = decode(seed)?;
        store::transact(conn, path, |w, now| store::import_demo_data(w, seed, now))
    })
    .await
}

#[tauri::command]
async fn clear_demo_data(state: State<'_, AppState>) -> Result<Change, String> {
    blocking(state, |conn, path| {
        store::transact(conn, path, store::clear_demo_data)
    })
    .await
}

#[tauri::command]
async fn backup_now(state: State<'_, AppState>) -> Result<String, String> {
    blocking(state, |conn, path| {
        backup::now(&snapshot(conn, path)?, path)
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            (|| -> Result<()> {
                let dir = match std::env::var_os("THREADING_DATA_DIR") {
                    Some(value) if !value.is_empty() => PathBuf::from(value),
                    _ => app.path().app_data_dir()?,
                };
                let connection = store::open(&dir)?;
                let data_path = dir
                    .canonicalize()
                    .context("无法解析数据目录绝对路径")?
                    .join("threading.db");
                app.manage(AppState {
                    connection: Arc::new(Mutex::new(connection)),
                    data_path,
                });
                Ok(())
            })()
            .map_err(|error| display_error(error).into())
        })
        .invoke_handler(command_handler())
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| panic!("Threading 启动失败：{}", display_error(error.into())));
}

fn command_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        load_workspace,
        create_organization,
        update_organization,
        delete_organization,
        create_project,
        update_project,
        delete_project,
        create_thread,
        update_thread,
        delete_thread,
        create_todo,
        update_todo,
        delete_todo,
        create_entry,
        update_entry,
        delete_entry,
        reorder,
        update_settings,
        backup_now,
        import_demo_data,
        clear_demo_data,
    ]
}

#[cfg(test)]
mod tests;
