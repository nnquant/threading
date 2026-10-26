use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{ensure, Context, Result};
use chrono::{Local, NaiveDate};
use uuid::Uuid;

use crate::models::Workspace;

fn directory(data_path: &Path) -> Result<PathBuf> {
    let dir = data_path
        .parent()
        .context("数据库路径缺少父目录")?
        .join("backups");
    fs::create_dir_all(&dir).context("无法创建备份目录")?;
    Ok(dir)
}

pub(crate) fn write_snapshot(workspace: &Workspace, path: &Path) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut snapshot = serde_json::to_value(workspace).context("无法序列化备份")?;
        snapshot
            .as_object_mut()
            .context("备份格式错误")?
            .remove("dataPath");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .context("无法创建临时备份")?;
        file.write_all(&serde_json::to_vec_pretty(&snapshot)?)
            .context("无法写入备份")?;
        file.sync_all().context("无法同步备份文件")?;
        drop(file);
        fs::rename(&temporary, path).context("无法完成备份文件重命名")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn rotate(dir: &Path) -> Result<()> {
    let mut daily = Vec::new();
    for entry in fs::read_dir(dir).context("无法读取备份目录")? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(date) = name
            .strip_prefix("threading-")
            .and_then(|s| s.strip_suffix(".json"))
        {
            if date.len() == 8
                && date.bytes().all(|c| c.is_ascii_digit())
                && NaiveDate::parse_from_str(date, "%Y%m%d").is_ok()
                && entry.file_type()?.is_file()
            {
                daily.push(entry.path());
            }
        }
    }
    daily.sort();
    let count = daily.len().saturating_sub(14);
    for path in daily.into_iter().take(count) {
        fs::remove_file(path).context("无法清理旧每日备份")?;
    }
    Ok(())
}

pub fn daily(workspace: &Workspace, data_path: &Path, day: NaiveDate) -> Result<()> {
    let dir = directory(data_path)?;
    let path = dir.join(format!("threading-{}.json", day.format("%Y%m%d")));
    if !path.try_exists().context("无法检查每日备份")? {
        write_snapshot(workspace, &path)?;
    }
    ensure!(path.is_file(), "每日备份路径不是文件。");
    rotate(&dir)
}

pub fn now(workspace: &Workspace, data_path: &Path) -> Result<String> {
    let dir = directory(data_path)?;
    let path = dir.join(format!(
        "threading-{}.json",
        Local::now().format("%Y%m%d-%H%M%S")
    ));
    write_snapshot(workspace, &path)?;
    Ok(crate::display_path(&path))
}
