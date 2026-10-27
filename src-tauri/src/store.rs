use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::Duration,
};

use anyhow::{bail, ensure, Context, Result};
use chrono::NaiveDate;
use rusqlite::{
    types::{Value as SqlValue, ValueRef},
    Connection, TransactionBehavior,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::models::*;

const COLORS: &[&str] = &[
    "slate", "blue", "teal", "green", "amber", "orange", "red", "violet",
];
const STAGES: &[&str] = &["idea", "research", "backtest", "paper", "live", "retired"];
const STATES: &[&str] = &["active", "waiting", "paused", "closed"];
const PRIORITIES: &[&str] = &["urgent", "high", "normal", "low"];
const HEALTH: &[&str] = &["onTrack", "atRisk", "offTrack"];
const STATUSES: &[&str] = &["active", "paused", "done", "archived"];

pub fn open(data_dir: &Path) -> Result<Connection> {
    std::fs::create_dir_all(data_dir).context("无法创建数据目录")?;
    let mut conn = Connection::open(data_dir.join("threading.db")).context("无法打开数据库")?;
    conn.busy_timeout(Duration::from_secs(5))
        .context("无法设置数据库等待时间")?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .context("无法设置数据库日志与外键")?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("无法开始数据库迁移")?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
    ensure!(version <= 3, "数据库版本较新，请升级 Threading 后再打开。");
    if version == 0 {
        tx.execute_batch(include_str!("schema.sql"))
            .context("数据库迁移失败")?;
        tx.pragma_update(None, "user_version", 1)?;
    }
    if version < 2 {
        tx.execute_batch("ALTER TABLE organizations ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;")
            .context("示例数据标记迁移失败")?;
        tx.pragma_update(None, "user_version", 2)?;
    }
    if version < 3 {
        tx.execute_batch(
            "ALTER TABLE threads ADD COLUMN parent_id TEXT NULL REFERENCES threads(id);
             CREATE INDEX threads_siblings ON threads(projectId, parent_id, position);",
        )
        .context("子策略线迁移失败")?;
        tx.pragma_update(None, "user_version", 3)?;
    }
    tx.commit().context("无法提交数据库迁移")?;
    Ok(conn)
}

// Column names deliberately match the wire model. JSON collections remain TEXT columns.
fn rows<T: DeserializeOwned>(conn: &Connection, table: &str, order: &str) -> Result<Vec<T>> {
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table} ORDER BY {order}, rowid"))?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut cursor = stmt.query([])?;
    let mut result = Vec::new();
    while let Some(row) = cursor.next()? {
        let mut object = Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(v) if matches!(name.as_str(), "archived" | "done" | "demo") => {
                    Value::Bool(v != 0)
                }
                ValueRef::Integer(v) => Value::from(v),
                ValueRef::Text(v) => {
                    let s = std::str::from_utf8(v).context("数据库文本不是有效 UTF-8")?;
                    if matches!(name.as_str(), "tags" | "metrics" | "event") {
                        serde_json::from_str(s).context("数据库 JSON 字段损坏")?
                    } else {
                        Value::String(s.to_owned())
                    }
                }
                _ => bail!("数据库字段类型错误：{table}.{name}"),
            };
            let name = if table == "threads" && name == "parent_id" {
                "parentId"
            } else {
                name
            };
            object.insert(name.to_owned(), value);
        }
        result.push(serde_json::from_value(Value::Object(object)).context("数据库记录格式错误")?);
    }
    Ok(result)
}

pub fn load(conn: &Connection, data_path: &Path) -> Result<Workspace> {
    let setting = |key| -> Result<i64> {
        conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .context("无法读取应用设置")
    };
    Ok(Workspace {
        organizations: rows(conn, "organizations", "position")?,
        projects: rows(conn, "projects", "position")?,
        threads: rows(conn, "threads", "position")?,
        todos: rows(conn, "todos", "position")?,
        entries: rows(conn, "entries", "createdAt")?,
        settings: Settings {
            stale_days: setting("staleDays")?,
            wip_limit: setting("wipLimit")?,
        },
        data_path: crate::display_path(data_path),
    })
}

trait Record: Serialize + Clone + PartialEq {
    fn id(&self) -> &str;
}
macro_rules! records {
    ($($model:ty),*) => { $(impl Record for $model { fn id(&self) -> &str { &self.id } })* };
}
records!(Organization, Project, Thread, Todo, Entry);

fn difference<T: Record>(
    before: &[T],
    after: &[T],
    kind: &str,
    deleted: &mut Vec<Deleted>,
) -> Vec<T> {
    let old: HashMap<_, _> = before.iter().map(|r| (r.id(), r)).collect();
    let new_ids: HashSet<_> = after.iter().map(Record::id).collect();
    deleted.extend(
        before
            .iter()
            .filter(|r| !new_ids.contains(r.id()))
            .map(|r| Deleted {
                kind: kind.to_owned(),
                id: r.id().to_owned(),
            }),
    );
    after
        .iter()
        .filter(|r| old.get(r.id()).is_none_or(|old| *old != *r))
        .cloned()
        .collect()
}

fn merge<T: Record>(changed: &mut Vec<T>, forced: Vec<T>) {
    for row in forced {
        if !changed.iter().any(|r| r.id() == row.id()) {
            changed.push(row);
        }
    }
}

fn upsert<T: Record>(conn: &Connection, table: &str, records: &[T]) -> Result<()> {
    for record in records {
        let Value::Object(object) = serde_json::to_value(record)? else {
            unreachable!()
        };
        let columns: Vec<_> = object
            .keys()
            .map(|name| {
                if table == "threads" && name == "parentId" {
                    "parent_id".to_owned()
                } else {
                    name.clone()
                }
            })
            .collect();
        let values: Vec<SqlValue> = object
            .values()
            .map(|v| match v {
                Value::Null => SqlValue::Null,
                Value::Bool(v) => SqlValue::Integer(i64::from(*v)),
                Value::Number(v) => SqlValue::Integer(v.as_i64().expect("model integers")),
                Value::String(v) => SqlValue::Text(v.clone()),
                _ => SqlValue::Text(v.to_string()),
            })
            .collect();
        let placeholders = vec!["?"; columns.len()].join(",");
        let updates = columns
            .iter()
            .filter(|c| c.as_str() != "id")
            .map(|c| format!("{c}=excluded.{c}"))
            .collect::<Vec<_>>()
            .join(",");
        conn.execute(&format!("INSERT INTO {table} ({}) VALUES ({placeholders}) ON CONFLICT(id) DO UPDATE SET {updates}", columns.join(",")), rusqlite::params_from_iter(values))?;
    }
    Ok(())
}

pub fn transact(
    conn: &mut Connection,
    data_path: &Path,
    action: impl FnOnce(&mut Workspace, i64) -> Result<Change>,
) -> Result<Change> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .context("无法开始保存事务")?;
    let before = load(&tx, data_path).context("无法读取工作区")?;
    let mut after = before.clone();
    let forced = action(&mut after, chrono::Utc::now().timestamp_millis())?;
    let mut change = Change::default();
    change.organizations = difference(
        &before.organizations,
        &after.organizations,
        "organization",
        &mut change.deleted,
    );
    change.projects = difference(
        &before.projects,
        &after.projects,
        "project",
        &mut change.deleted,
    );
    change.threads = difference(
        &before.threads,
        &after.threads,
        "thread",
        &mut change.deleted,
    );
    change.todos = difference(&before.todos, &after.todos, "todo", &mut change.deleted);
    change.entries = difference(
        &before.entries,
        &after.entries,
        "entry",
        &mut change.deleted,
    );
    merge(&mut change.organizations, forced.organizations);
    merge(&mut change.projects, forced.projects);
    merge(&mut change.threads, forced.threads);
    merge(&mut change.todos, forced.todos);
    merge(&mut change.entries, forced.entries);
    if before.settings != after.settings || forced.settings.is_some() {
        change.settings = Some(after.settings);
    }
    // Position is sibling-local; it cannot determine foreign-key deletion order.
    let thread_order: HashMap<_, _> = parent_first(&before.threads)?
        .into_iter()
        .enumerate()
        .map(|(rank, i)| (before.threads[i].id.as_str(), rank))
        .collect();
    change.deleted.sort_by_key(|row| match row.kind.as_str() {
        "organization" => (0, 0),
        "project" => (1, 0),
        "thread" => (2, thread_order[row.id.as_str()]),
        "todo" => (3, 0),
        "entry" => (4, 0),
        _ => unreachable!(),
    });
    for deleted in change.deleted.iter().rev() {
        let table = match deleted.kind.as_str() {
            "organization" => "organizations",
            "project" => "projects",
            "thread" => "threads",
            "todo" => "todos",
            "entry" => "entries",
            _ => unreachable!(),
        };
        tx.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [&deleted.id])
            .context("删除记录失败")?;
    }
    upsert(&tx, "organizations", &change.organizations).context("保存组织失败")?;
    upsert(&tx, "projects", &change.projects).context("保存项目失败")?;
    let threads: Vec<_> = parent_first(&change.threads)?
        .into_iter()
        .map(|i| change.threads[i].clone())
        .collect();
    upsert(&tx, "threads", &threads).context("保存策略线失败")?;
    upsert(&tx, "todos", &change.todos).context("保存待办失败")?;
    upsert(&tx, "entries", &change.entries).context("保存条目失败")?;
    if let Some(settings) = &change.settings {
        for (key, value) in [
            ("staleDays", settings.stale_days),
            ("wipLimit", settings.wip_limit),
        ] {
            tx.execute(
                "UPDATE settings SET value = ?1 WHERE key = ?2",
                (value, key),
            )
            .context("保存设置失败")?;
        }
    }
    tx.commit().context("提交保存失败")?;
    Ok(change)
}

fn text(value: &str, label: &str, max: usize, required: bool) -> Result<String> {
    let value = value.trim();
    ensure!(!required || !value.is_empty(), "{label}不能为空。");
    ensure!(
        value.chars().count() <= max,
        "{label}不能超过 {max} 个字符。"
    );
    Ok(value.to_owned())
}

fn choice(value: &str, label: &str, allowed: &[&str]) -> Result<String> {
    let value = value.trim();
    ensure!(allowed.contains(&value), "{label}无效。");
    Ok(value.to_owned())
}

fn date(value: Option<String>) -> Result<Option<String>> {
    value
        .map(|value| {
            let value = value.trim();
            let bytes = value.as_bytes();
            ensure!(
                bytes.len() == 10
                    && bytes[4] == b'-'
                    && bytes[7] == b'-'
                    && bytes
                        .iter()
                        .enumerate()
                        .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit()),
                "日期必须为有效的 YYYY-MM-DD。"
            );
            NaiveDate::parse_from_str(value, "%Y-%m-%d").context("日期不是有效的日历日期")?;
            ensure!(
                !value.starts_with("0000"),
                "日期年份必须在 0001–9999 之间。"
            );
            Ok(value.to_owned())
        })
        .transpose()
}

fn code(value: &str, name: &str) -> Result<String> {
    let value = text(value, "组织简称", 6, false)?;
    let value = if value.is_empty() {
        name.chars().take(2).collect::<String>()
    } else {
        value
    };
    text(&value.to_uppercase(), "组织简称", 6, false)
}

fn tags(values: Vec<String>) -> Result<Vec<String>> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for value in values {
        let value = text(&value, "标签", 24, false)?;
        if !value.is_empty() && seen.insert(value.to_lowercase()) {
            result.push(value);
        }
    }
    ensure!(result.len() <= 12, "标签不能超过 12 个。");
    Ok(result)
}

fn metrics(values: Vec<Metric>) -> Result<Vec<Metric>> {
    let mut result = Vec::new();
    for value in values {
        let label = text(&value.label, "指标名称", 24, false)?;
        if label.is_empty() {
            continue;
        }
        let value = text(&value.value, "指标值", 40, false)?;
        result.push(Metric { label, value });
    }
    ensure!(result.len() <= 12, "指标不能超过 12 项。");
    Ok(result)
}

fn index<T: Record>(rows: &[T], id: &str, label: &str) -> Result<usize> {
    rows.iter()
        .position(|r| r.id() == id.trim())
        .with_context(|| format!("找不到该{label}，可能已被删除。"))
}
fn next(positions: impl Iterator<Item = i64>) -> i64 {
    positions.max().map_or(0, |p| p + 1)
}
fn id() -> String {
    Uuid::new_v4().to_string()
}

// Iterative traversal keeps nesting independent of the Rust call-stack depth.
fn parent_first(threads: &[Thread]) -> Result<Vec<usize>> {
    let ids: HashMap<_, _> = threads
        .iter()
        .enumerate()
        .map(|(i, t)| (t.id.as_str(), i))
        .collect();
    let mut children = vec![Vec::new(); threads.len()];
    let mut order = Vec::new();
    for (i, thread) in threads.iter().enumerate() {
        if let Some(parent) = thread.parent_id.as_deref().and_then(|id| ids.get(id)) {
            children[*parent].push(i);
        } else {
            order.push(i);
        }
    }
    let mut cursor = 0;
    while cursor < order.len() {
        order.extend_from_slice(&children[order[cursor]]);
        cursor += 1;
    }
    ensure!(
        order.len() == threads.len(),
        "不能把策略线放到它自己或它的子策略线下面。"
    );
    Ok(order)
}

fn subtree(w: &Workspace, id: &str) -> HashSet<String> {
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    for row in &w.threads {
        if let Some(parent) = row.parent_id.as_deref() {
            children.entry(parent).or_default().push(&row.id);
        }
    }
    let mut pending = vec![id];
    let mut found = HashSet::new();
    while let Some(id) = pending.pop() {
        if found.insert(id.to_owned()) {
            if let Some(children) = children.get(id) {
                pending.extend(children);
            }
        }
    }
    found
}

fn validate_parent(
    threads: &[Thread],
    id: &str,
    project: &str,
    parent: Option<&str>,
) -> Result<()> {
    let by_id: HashMap<_, _> = threads.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut cursor = parent;
    let mut seen = HashSet::from([id]);
    while let Some(id) = cursor {
        let row = by_id.get(id).context("找不到上级策略线，可能已被删除。")?;
        ensure!(
            seen.insert(id),
            "不能把策略线放到它自己或它的子策略线下面。"
        );
        ensure!(row.project_id == project, "上级策略线必须在同一个项目里。");
        cursor = row.parent_id.as_deref();
    }
    Ok(())
}

fn touch(w: &mut Workspace, thread_id: &str, now: i64) -> Result<Change> {
    let mut change = Change::default();
    let mut cursor = Some(thread_id.to_owned());
    while let Some(id) = cursor {
        let row = index(&w.threads, &id, "策略线")?;
        let row = &mut w.threads[row];
        row.updated_at = now;
        row.last_activity_at = now;
        cursor = row.parent_id.clone();
        change.threads.push(row.clone());
    }
    Ok(change)
}
fn event(
    w: &mut Workspace,
    project_id: &str,
    thread_id: Option<&str>,
    field: &str,
    from: Option<&str>,
    to: Option<&str>,
    now: i64,
) {
    w.entries.push(Entry {
        id: id(),
        project_id: project_id.to_owned(),
        thread_id: thread_id.map(str::to_owned),
        kind: "event".into(),
        body: String::new(),
        health: None,
        event: Some(EntryEvent {
            field: field.into(),
            from: from.map(str::to_owned),
            to: to.map(str::to_owned),
        }),
        created_at: now,
        edited_at: None,
    });
}

pub fn create_organization(
    w: &mut Workspace,
    input: OrganizationInput,
    now: i64,
) -> Result<Change> {
    let name = text(&input.name, "组织名称", 60, true)?;
    w.organizations.push(Organization {
        id: id(),
        code: code(input.code.as_deref().unwrap_or(""), &name)?,
        name,
        color: choice(
            input
                .color
                .as_deref()
                .unwrap_or(COLORS[w.organizations.len() % COLORS.len()]),
            "组织颜色",
            COLORS,
        )?,
        note: text(input.note.as_deref().unwrap_or(""), "组织备注", 2000, false)?,
        archived: false,
        demo: false,
        position: next(w.organizations.iter().map(|r| r.position)),
        created_at: now,
        updated_at: now,
    });
    Ok(Change::default())
}

pub fn update_organization(
    w: &mut Workspace,
    id: &str,
    patch: OrganizationPatch,
    now: i64,
) -> Result<Change> {
    let row = index(&w.organizations, id, "组织")?;
    let row = &mut w.organizations[row];
    if let Some(v) = patch.name {
        row.name = text(&v, "组织名称", 60, true)?;
    }
    if let Some(v) = patch.code {
        row.code = code(&v, &row.name)?;
    }
    if let Some(v) = patch.color {
        row.color = choice(&v, "组织颜色", COLORS)?;
    }
    if let Some(v) = patch.note {
        row.note = text(&v, "组织备注", 2000, false)?;
    }
    if let Some(v) = patch.archived {
        row.archived = v;
    }
    row.updated_at = now;
    Ok(Change {
        organizations: vec![row.clone()],
        ..Change::default()
    })
}

pub fn create_project(w: &mut Workspace, input: ProjectInput, now: i64) -> Result<Change> {
    let org_id = input.org_id.trim().to_owned();
    index(&w.organizations, &org_id, "组织")?;
    w.projects.push(Project {
        id: id(),
        position: next(
            w.projects
                .iter()
                .filter(|p| p.org_id == org_id)
                .map(|p| p.position),
        ),
        org_id,
        name: text(&input.name, "项目名称", 80, true)?,
        goal: text(input.goal.as_deref().unwrap_or(""), "项目目标", 2000, false)?,
        status: choice(
            input.status.as_deref().unwrap_or("active"),
            "项目状态",
            STATUSES,
        )?,
        health: choice(
            input.health.as_deref().unwrap_or("onTrack"),
            "项目健康度",
            HEALTH,
        )?,
        target_date: date(input.target_date)?,
        created_at: now,
        updated_at: now,
    });
    Ok(Change::default())
}

pub fn update_project(
    w: &mut Workspace,
    id: &str,
    patch: ProjectPatch,
    now: i64,
) -> Result<Change> {
    let i = index(&w.projects, id, "项目")?;
    let old = w.projects[i].clone();
    let mut row = old.clone();
    if let Some(v) = patch.org_id {
        let v = v.trim().to_owned();
        index(&w.organizations, &v, "组织")?;
        if v != row.org_id {
            row.position = next(
                w.projects
                    .iter()
                    .filter(|p| p.org_id == v)
                    .map(|p| p.position),
            );
            row.org_id = v;
        }
    }
    if let Some(v) = patch.name {
        row.name = text(&v, "项目名称", 80, true)?;
    }
    if let Some(v) = patch.goal {
        row.goal = text(&v, "项目目标", 2000, false)?;
    }
    if let Some(v) = patch.status {
        row.status = choice(&v, "项目状态", STATUSES)?;
    }
    if let Some(v) = patch.health {
        row.health = choice(&v, "项目健康度", HEALTH)?;
    }
    if let Some(v) = patch.target_date {
        row.target_date = date(v)?;
    }
    row.updated_at = now;
    if row.health != old.health {
        event(
            w,
            &row.id,
            None,
            "health",
            Some(&old.health),
            Some(&row.health),
            now,
        );
    }
    if row.status != old.status {
        event(
            w,
            &row.id,
            None,
            "status",
            Some(&old.status),
            Some(&row.status),
            now,
        );
    }
    w.projects[i] = row.clone();
    Ok(Change {
        projects: vec![row],
        ..Change::default()
    })
}

pub fn create_thread(w: &mut Workspace, input: ThreadInput, now: i64) -> Result<Change> {
    let project_id = input.project_id.trim().to_owned();
    index(&w.projects, &project_id, "项目")?;
    let parent_id = input.parent_id.map(|id| id.trim().to_owned());
    validate_parent(&w.threads, "", &project_id, parent_id.as_deref())?;
    let state = choice(
        input.state.as_deref().unwrap_or("active"),
        "策略线状态",
        STATES,
    )?;
    let row = Thread {
        id: id(),
        position: next(
            w.threads
                .iter()
                .filter(|t| t.project_id == project_id && t.parent_id == parent_id)
                .map(|t| t.position),
        ),
        project_id,
        parent_id,
        title: text(&input.title, "策略线标题", 120, true)?,
        summary: text(
            input.summary.as_deref().unwrap_or(""),
            "策略线摘要",
            20000,
            false,
        )?,
        stage: choice(input.stage.as_deref().unwrap_or("idea"), "研发阶段", STAGES)?,
        waiting_since: (state == "waiting").then_some(now),
        closed_at: (state == "closed").then_some(now),
        state,
        priority: choice(
            input.priority.as_deref().unwrap_or("normal"),
            "优先级",
            PRIORITIES,
        )?,
        hill: 0,
        waiting_on: String::new(),
        tags: tags(input.tags.unwrap_or_default())?,
        metrics: Vec::new(),
        created_at: now,
        updated_at: now,
        last_activity_at: now,
        reviewed_at: None,
    };
    let next_action = text(
        input.next_action.as_deref().unwrap_or(""),
        "下一步",
        500,
        false,
    )?;
    event(
        w,
        &row.project_id,
        Some(&row.id),
        "created",
        None,
        Some(&row.stage),
        now,
    );
    let thread_id = row.id.clone();
    w.threads.push(row);
    if !next_action.is_empty() {
        create_todo(
            w,
            TodoInput {
                thread_id: thread_id.clone(),
                text: next_action,
                due: None,
            },
            now,
        )?;
    }
    touch(w, &thread_id, now)
}

pub fn update_thread(w: &mut Workspace, id: &str, patch: ThreadPatch, now: i64) -> Result<Change> {
    let i = index(&w.threads, id, "策略线")?;
    let old = w.threads[i].clone();
    let mut row = old.clone();
    let activity = patch.project_id.is_some()
        || patch.title.is_some()
        || patch.summary.is_some()
        || patch.stage.is_some()
        || patch.state.is_some()
        || patch.priority.is_some()
        || patch.hill.is_some()
        || patch.waiting_on.is_some()
        || patch.tags.is_some()
        || patch.metrics.is_some();
    if let Some(v) = patch.project_id {
        let v = v.trim().to_owned();
        index(&w.projects, &v, "项目")?;
        row.project_id = v;
    }
    if let Some(parent) = patch.parent_id {
        row.parent_id = parent.map(|id| id.trim().to_owned());
    } else if row.project_id != old.project_id {
        row.parent_id = None;
    }
    validate_parent(
        &w.threads,
        &row.id,
        &row.project_id,
        row.parent_id.as_deref(),
    )?;
    let activity = activity || row.parent_id != old.parent_id;
    if row.project_id != old.project_id || row.parent_id != old.parent_id {
        row.position = next(
            w.threads
                .iter()
                .filter(|t| t.project_id == row.project_id && t.parent_id == row.parent_id)
                .map(|t| t.position),
        );
    }
    if let Some(v) = patch.title {
        row.title = text(&v, "策略线标题", 120, true)?;
    }
    if let Some(v) = patch.summary {
        row.summary = text(&v, "策略线摘要", 20000, false)?;
    }
    if let Some(v) = patch.stage {
        row.stage = choice(&v, "研发阶段", STAGES)?;
    }
    if let Some(v) = patch.state {
        row.state = choice(&v, "策略线状态", STATES)?;
    }
    if let Some(v) = patch.priority {
        row.priority = choice(&v, "优先级", PRIORITIES)?;
    }
    if let Some(v) = patch.hill {
        ensure!((0..=100).contains(&v), "山丘位置必须是 0–100 的整数。");
        row.hill = v;
    }
    if let Some(v) = patch.waiting_on {
        row.waiting_on = text(&v, "等待事项", 80, false)?;
    }
    if let Some(v) = patch.tags {
        row.tags = tags(v)?;
    }
    if let Some(v) = patch.metrics {
        row.metrics = metrics(v)?;
    }
    if row.state != old.state {
        row.waiting_since = if row.state == "waiting" {
            Some(now)
        } else {
            None
        };
        if old.state == "waiting" {
            row.waiting_on.clear();
        }
        row.closed_at = if row.state == "closed" {
            Some(now)
        } else {
            None
        };
    }
    if patch.reviewed == Some(true) {
        row.reviewed_at = Some(now);
    }
    let moved = if row.project_id != old.project_id {
        subtree(w, &row.id)
    } else {
        HashSet::new()
    };
    if !moved.is_empty() {
        for entry in &mut w.entries {
            if entry
                .thread_id
                .as_ref()
                .is_some_and(|id| moved.contains(id))
            {
                entry.project_id.clone_from(&row.project_id);
            }
        }
    }
    if row.stage != old.stage {
        event(
            w,
            &row.project_id,
            Some(&row.id),
            "stage",
            Some(&old.stage),
            Some(&row.stage),
            now,
        );
    }
    if row.state != old.state {
        event(
            w,
            &row.project_id,
            Some(&row.id),
            "state",
            Some(&old.state),
            Some(&row.state),
            now,
        );
    }
    if row.project_id != old.project_id {
        let from = w.projects[index(&w.projects, &old.project_id, "项目")?]
            .name
            .clone();
        let to = w.projects[index(&w.projects, &row.project_id, "项目")?]
            .name
            .clone();
        event(
            w,
            &row.project_id,
            Some(&row.id),
            "project",
            Some(&from),
            Some(&to),
            now,
        );
        let descendants: Vec<_> = w
            .threads
            .iter_mut()
            .filter(|t| t.id != row.id && moved.contains(&t.id))
            .map(|t| {
                t.project_id.clone_from(&row.project_id);
                t.updated_at = now;
                t.id.clone()
            })
            .collect();
        for id in descendants {
            event(
                w,
                &row.project_id,
                Some(&id),
                "project",
                Some(&from),
                Some(&to),
                now,
            );
        }
    }
    if row.parent_id != old.parent_id {
        let title = |id: &Option<String>| -> Option<String> {
            id.as_ref()
                .and_then(|id| w.threads.iter().find(|t| &t.id == id))
                .map(|t| t.title.clone())
        };
        let from = title(&old.parent_id);
        let to = title(&row.parent_id);
        event(
            w,
            &row.project_id,
            Some(&row.id),
            "parent",
            from.as_deref(),
            to.as_deref(),
            now,
        );
    }
    w.threads[i] = row.clone();
    if activity {
        return touch(w, &row.id, now);
    }
    Ok(Change {
        threads: if patch.reviewed == Some(true) {
            vec![row]
        } else {
            Vec::new()
        },
        ..Change::default()
    })
}

pub fn create_todo(w: &mut Workspace, input: TodoInput, now: i64) -> Result<Change> {
    let thread_id = input.thread_id.trim().to_owned();
    index(&w.threads, &thread_id, "策略线")?;
    let row = Todo {
        id: id(),
        position: next(
            w.todos
                .iter()
                .filter(|t| t.thread_id == thread_id)
                .map(|t| t.position),
        ),
        thread_id: thread_id.clone(),
        text: text(&input.text, "待办内容", 500, true)?,
        due: date(input.due)?,
        done: false,
        done_at: None,
        created_at: now,
        updated_at: now,
    };
    w.todos.push(row);
    touch(w, &thread_id, now)
}

pub fn update_todo(w: &mut Workspace, id: &str, patch: TodoPatch, now: i64) -> Result<Change> {
    let i = index(&w.todos, id, "待办")?;
    let row = &mut w.todos[i];
    if let Some(v) = patch.text {
        row.text = text(&v, "待办内容", 500, true)?;
    }
    if let Some(v) = patch.due {
        row.due = date(v)?;
    }
    if let Some(v) = patch.done {
        if row.done != v {
            row.done = v;
            row.done_at = v.then_some(now);
        }
    }
    row.updated_at = now;
    let thread_id = row.thread_id.clone();
    let todo = row.clone();
    let mut change = touch(w, &thread_id, now)?;
    change.todos.push(todo);
    Ok(change)
}

pub fn create_entry(w: &mut Workspace, input: EntryInput, now: i64) -> Result<Change> {
    let project_id = input.project_id.trim().to_owned();
    let project_index = index(&w.projects, &project_id, "项目")?;
    let thread_id = input.thread_id.map(|s| s.trim().to_owned());
    let kind = choice(
        &input.kind,
        "条目类型",
        &["note", "decision", "result", "update"],
    )?;
    let body = text(&input.body, "条目正文", 20000, true)?;
    ensure!(
        kind == "update" || input.health.is_none(),
        "只有项目进展条目可以传入健康度。"
    );
    ensure!(
        kind != "update" || thread_id.is_none(),
        "项目进展条目不能属于策略线。"
    );
    if let Some(thread_id) = &thread_id {
        let i = index(&w.threads, thread_id, "策略线")?;
        ensure!(
            w.threads[i].project_id == project_id,
            "策略线不属于指定项目。"
        );
    }
    let health = input
        .health
        .flatten()
        .map(|v| choice(&v, "项目健康度", HEALTH))
        .transpose()?;
    if let Some(health) = &health {
        let project = &mut w.projects[project_index];
        if &project.health != health {
            project.health.clone_from(health);
            project.updated_at = now;
        }
    }
    let change = if let Some(thread_id) = &thread_id {
        touch(w, thread_id, now)?
    } else {
        Change::default()
    };
    w.entries.push(Entry {
        id: id(),
        project_id,
        thread_id,
        kind,
        body,
        health,
        event: None,
        created_at: now,
        edited_at: None,
    });
    Ok(change)
}

pub fn update_entry(w: &mut Workspace, id: &str, patch: EntryPatch, now: i64) -> Result<Change> {
    let i = index(&w.entries, id, "条目")?;
    let row = &mut w.entries[i];
    ensure!(row.kind != "event", "自动事件条目不能修改。");
    row.body = text(&patch.body, "条目正文", 20000, true)?;
    row.edited_at = Some(now);
    let thread_id = row.thread_id.clone();
    let entry = row.clone();
    let mut change = if let Some(thread_id) = thread_id {
        touch(w, &thread_id, now)?
    } else {
        Change::default()
    };
    change.entries.push(entry);
    Ok(change)
}

pub fn delete(w: &mut Workspace, kind: &str, id: &str, now: i64) -> Result<Change> {
    let id = id.trim();
    let mut change = Change::default();
    match kind {
        "organization" => {
            let i = index(&w.organizations, id, "组织")?;
            w.organizations.remove(i);
        }
        "project" => {
            let i = index(&w.projects, id, "项目")?;
            w.projects.remove(i);
        }
        "thread" => {
            let i = index(&w.threads, id, "策略线")?;
            let parent = w.threads[i].parent_id.clone();
            let removed = subtree(w, id);
            w.threads.retain(|r| !removed.contains(&r.id));
            if let Some(parent) = parent {
                change = touch(w, &parent, now)?;
            }
        }
        "todo" => {
            let i = index(&w.todos, id, "待办")?;
            let row = w.todos.remove(i);
            change = touch(w, &row.thread_id, now)?;
        }
        "entry" => {
            let i = index(&w.entries, id, "条目")?;
            w.entries.remove(i);
        }
        _ => bail!("删除类型无效。"),
    }
    let organizations: HashSet<_> = w.organizations.iter().map(|r| r.id.as_str()).collect();
    w.projects
        .retain(|r| organizations.contains(r.org_id.as_str()));
    let projects: HashSet<_> = w.projects.iter().map(|r| r.id.as_str()).collect();
    w.threads
        .retain(|r| projects.contains(r.project_id.as_str()));
    let threads: HashSet<_> = w.threads.iter().map(|r| r.id.as_str()).collect();
    w.todos.retain(|r| threads.contains(r.thread_id.as_str()));
    w.entries.retain(|r| {
        projects.contains(r.project_id.as_str())
            && r.thread_id.as_deref().is_none_or(|id| threads.contains(id))
    });
    Ok(change)
}

// Imports validate with the normal field rules, but must never normalize supplied history.
fn unchanged<T: PartialEq>(original: &T, validated: T, label: &str) -> Result<()> {
    ensure!(
        original == &validated,
        "示例数据的{label}格式不规范，请先整理后再导入。"
    );
    Ok(())
}

fn demo_time(value: i64, now: i64) -> Result<()> {
    ensure!(
        value <= now.saturating_add(300_000),
        "示例数据时间戳不能晚于当前时间 5 分钟以上。"
    );
    Ok(())
}

fn demo_times(created: i64, updated: i64, now: i64) -> Result<()> {
    demo_time(created, now)?;
    demo_time(updated, now)?;
    ensure!(
        updated >= created,
        "示例数据的 updatedAt 不能早于 createdAt。"
    );
    Ok(())
}

fn demo_event(row: &Entry) -> Result<()> {
    ensure!(
        row.body.is_empty() && row.health.is_none(),
        "示例事件条目的正文必须为空且健康度必须为 null。"
    );
    let event = row.event.as_ref().context("示例事件条目缺少 event。")?;
    let valid = match event.field.as_str() {
        "created" => {
            row.thread_id.is_some()
                && event.from.is_none()
                && event.to.as_deref().is_some_and(|v| STAGES.contains(&v))
        }
        "stage" | "state" => {
            let allowed = if event.field == "stage" {
                STAGES
            } else {
                STATES
            };
            row.thread_id.is_some()
                && event.from.as_deref().is_some_and(|v| allowed.contains(&v))
                && event.to.as_deref().is_some_and(|v| allowed.contains(&v))
        }
        "project" => {
            row.thread_id.is_some()
                && event
                    .from
                    .as_deref()
                    .zip(event.to.as_deref())
                    .is_some_and(|(from, to)| {
                        [from, to]
                            .iter()
                            .all(|v| !v.is_empty() && *v == v.trim() && v.chars().count() <= 80)
                    })
        }
        "parent" => {
            row.thread_id.is_some()
                && (event.from.is_some() || event.to.is_some())
                && [event.from.as_deref(), event.to.as_deref()]
                    .into_iter()
                    .flatten()
                    .all(|v| !v.is_empty() && v == v.trim() && v.chars().count() <= 120)
        }
        "health" | "status" => {
            let allowed = if event.field == "health" {
                HEALTH
            } else {
                STATUSES
            };
            row.thread_id.is_none()
                && event.from.as_deref().is_some_and(|v| allowed.contains(&v))
                && event.to.as_deref().is_some_and(|v| allowed.contains(&v))
        }
        _ => false,
    };
    ensure!(valid, "示例事件内容无效。");
    Ok(())
}

pub fn import_demo_data(w: &mut Workspace, mut seed: DemoSeed, now: i64) -> Result<Change> {
    ensure!(
        !w.organizations.iter().any(|r| r.demo),
        "示例数据已经添加过了，先清理再重新添加。"
    );
    for (count, limit, label) in [
        (seed.organizations.len(), 20, "组织"),
        (seed.projects.len(), 100, "项目"),
        (seed.threads.len(), 500, "策略线"),
        (seed.todos.len(), 2000, "待办"),
        (seed.entries.len(), 5000, "条目"),
    ] {
        ensure!(count <= limit, "示例数据的{label}不能超过 {limit} 行。");
    }
    let mut ids: HashSet<&str> = w
        .organizations
        .iter()
        .map(Record::id)
        .chain(w.projects.iter().map(Record::id))
        .chain(w.threads.iter().map(Record::id))
        .chain(w.todos.iter().map(Record::id))
        .chain(w.entries.iter().map(Record::id))
        .collect();
    for id in seed
        .organizations
        .iter()
        .map(Record::id)
        .chain(seed.projects.iter().map(Record::id))
        .chain(seed.threads.iter().map(Record::id))
        .chain(seed.todos.iter().map(Record::id))
        .chain(seed.entries.iter().map(Record::id))
    {
        ensure!(
            !id.is_empty() && id == id.trim(),
            "示例数据的 id 不能为空或包含首尾空白。"
        );
        ensure!(ids.insert(id), "示例数据的 id 重复或与已有记录冲突。");
    }
    let organizations: HashSet<_> = seed.organizations.iter().map(|r| &r.id).collect();
    let projects: HashSet<_> = seed.projects.iter().map(|r| &r.id).collect();
    let threads: HashMap<_, _> = seed
        .threads
        .iter()
        .map(|r| (&r.id, &r.project_id))
        .collect();
    for row in &seed.organizations {
        unchanged(
            &row.name,
            text(&row.name, "组织名称", 60, true)?,
            "组织名称",
        )?;
        unchanged(&row.code, code(&row.code, &row.name)?, "组织简称")?;
        unchanged(
            &row.color,
            choice(&row.color, "组织颜色", COLORS)?,
            "组织颜色",
        )?;
        unchanged(
            &row.note,
            text(&row.note, "组织备注", 2000, false)?,
            "组织备注",
        )?;
        demo_times(row.created_at, row.updated_at, now)?;
    }
    for row in &seed.projects {
        ensure!(
            organizations.contains(&row.org_id),
            "示例项目必须引用本次导入的组织。"
        );
        unchanged(
            &row.name,
            text(&row.name, "项目名称", 80, true)?,
            "项目名称",
        )?;
        unchanged(
            &row.goal,
            text(&row.goal, "项目目标", 2000, false)?,
            "项目目标",
        )?;
        unchanged(
            &row.status,
            choice(&row.status, "项目状态", STATUSES)?,
            "项目状态",
        )?;
        unchanged(
            &row.health,
            choice(&row.health, "项目健康度", HEALTH)?,
            "项目健康度",
        )?;
        unchanged(&row.target_date, date(row.target_date.clone())?, "目标日期")?;
        demo_times(row.created_at, row.updated_at, now)?;
    }
    for row in &seed.threads {
        ensure!(
            projects.contains(&row.project_id),
            "示例策略线必须引用本次导入的项目。"
        );
        validate_parent(
            &seed.threads,
            &row.id,
            &row.project_id,
            row.parent_id.as_deref(),
        )?;
        unchanged(
            &row.title,
            text(&row.title, "策略线标题", 120, true)?,
            "策略线标题",
        )?;
        unchanged(
            &row.summary,
            text(&row.summary, "策略线摘要", 20000, false)?,
            "策略线摘要",
        )?;
        unchanged(
            &row.stage,
            choice(&row.stage, "研发阶段", STAGES)?,
            "研发阶段",
        )?;
        unchanged(
            &row.state,
            choice(&row.state, "策略线状态", STATES)?,
            "策略线状态",
        )?;
        unchanged(
            &row.priority,
            choice(&row.priority, "优先级", PRIORITIES)?,
            "优先级",
        )?;
        ensure!(
            (0..=100).contains(&row.hill),
            "山丘位置必须是 0–100 的整数。"
        );
        unchanged(
            &row.waiting_on,
            text(&row.waiting_on, "等待事项", 80, false)?,
            "等待事项",
        )?;
        unchanged(&row.tags, tags(row.tags.clone())?, "标签")?;
        unchanged(&row.metrics, metrics(row.metrics.clone())?, "指标")?;
        ensure!(
            (row.state == "waiting") == row.waiting_since.is_some(),
            "示例策略线的 waiting 与 waitingSince 不一致。"
        );
        ensure!(
            (row.state == "closed") == row.closed_at.is_some(),
            "示例策略线的 closed 与 closedAt 不一致。"
        );
        demo_times(row.created_at, row.updated_at, now)?;
        ensure!(
            row.last_activity_at >= row.created_at,
            "示例数据的 lastActivityAt 不能早于 createdAt。"
        );
        for time in [
            Some(row.last_activity_at),
            row.waiting_since,
            row.reviewed_at,
            row.closed_at,
        ]
        .into_iter()
        .flatten()
        {
            demo_time(time, now)?;
        }
    }
    for row in &seed.todos {
        ensure!(
            threads.contains_key(&row.thread_id),
            "示例待办必须引用本次导入的策略线。"
        );
        unchanged(
            &row.text,
            text(&row.text, "待办内容", 500, true)?,
            "待办内容",
        )?;
        unchanged(&row.due, date(row.due.clone())?, "待办日期")?;
        ensure!(
            row.done == row.done_at.is_some(),
            "示例待办的 done 与 doneAt 不一致。"
        );
        demo_times(row.created_at, row.updated_at, now)?;
        if let Some(time) = row.done_at {
            demo_time(time, now)?;
        }
    }
    for row in &seed.entries {
        ensure!(
            projects.contains(&row.project_id),
            "示例条目必须引用本次导入的项目。"
        );
        if let Some(id) = &row.thread_id {
            ensure!(
                threads.get(id) == Some(&&row.project_id),
                "示例条目的策略线必须属于本次导入的同一项目。"
            );
        }
        unchanged(
            &row.kind,
            choice(
                &row.kind,
                "条目类型",
                &["note", "decision", "result", "update", "event"],
            )?,
            "条目类型",
        )?;
        if row.kind == "event" {
            demo_event(row)?;
        } else {
            ensure!(row.event.is_none(), "非事件示例条目的 event 必须为 null。");
            unchanged(
                &row.body,
                text(&row.body, "条目正文", 20000, true)?,
                "条目正文",
            )?;
            ensure!(
                row.kind != "update" || row.thread_id.is_none(),
                "项目进展条目不能属于策略线。"
            );
            ensure!(
                row.health.is_none() || row.kind == "update",
                "只有项目进展条目可以传入健康度。"
            );
            if let Some(health) = &row.health {
                unchanged(health, choice(health, "项目健康度", HEALTH)?, "项目健康度")?;
            }
        }
        demo_time(row.created_at, now)?;
        if let Some(time) = row.edited_at {
            demo_time(time, now)?;
        }
    }
    if !seed.organizations.is_empty() {
        let last = w
            .organizations
            .iter()
            .map(|r| r.position)
            .max()
            .unwrap_or(-1);
        ensure!(
            last.checked_add(seed.organizations.len() as i64).is_some(),
            "组织位置超出可用范围，无法添加示例数据。"
        );
        for (offset, row) in seed.organizations.iter_mut().enumerate() {
            row.demo = true;
            row.position = last + 1 + offset as i64;
        }
    }
    w.organizations.extend(seed.organizations);
    w.projects.extend(seed.projects);
    w.threads.extend(seed.threads);
    w.todos.extend(seed.todos);
    w.entries.extend(seed.entries);
    Ok(Change::default())
}

pub fn clear_demo_data(w: &mut Workspace, now: i64) -> Result<Change> {
    let ids: Vec<_> = w
        .organizations
        .iter()
        .filter(|r| r.demo)
        .map(|r| r.id.clone())
        .collect();
    for id in ids {
        delete(w, "organization", &id, now)?;
    }
    Ok(Change::default())
}

pub fn reorder(w: &mut Workspace, kind: &str, ids: Vec<String>, now: i64) -> Result<Change> {
    let ids: Vec<_> = ids.iter().map(|s| s.trim().to_owned()).collect();
    let unique: HashSet<_> = ids.iter().collect();
    ensure!(unique.len() == ids.len(), "排序列表不能包含重复记录。");
    let mut change = Change::default();
    macro_rules! order {
        ($rows:ident, $label:expr, $parent:expr) => {{
            if ids.is_empty() {
                ensure!(
                    w.$rows.is_empty(),
                    "排序列表必须包含同一父级的全部记录，不能为空。"
                );
                return Ok(change);
            }
            let first = index(&w.$rows, &ids[0], $label)?;
            let parent = ($parent)(&w.$rows[first]);
            let expected: HashSet<_> = w
                .$rows
                .iter()
                .filter(|r| ($parent)(r) == parent)
                .map(|r| &r.id)
                .collect();
            ensure!(
                expected == unique,
                "排序列表必须是同一父级下全部记录的排列。"
            );
            for (position, id) in ids.iter().enumerate() {
                let i = index(&w.$rows, id, $label)?;
                let row = &mut w.$rows[i];
                row.position = position as i64;
                row.updated_at = now;
                change.$rows.push(row.clone());
            }
        }};
    }
    match kind.trim() {
        "organization" => order!(organizations, "组织", |_: &Organization| String::new()),
        "project" => order!(projects, "项目", |r: &Project| r.org_id.clone()),
        "thread" => {
            order!(threads, "策略线", |r: &Thread| (
                r.project_id.clone(),
                r.parent_id.clone()
            ));
            change.threads.clear();
            for id in &ids {
                merge(&mut change.threads, touch(w, id, now)?.threads);
            }
        }
        "todo" => {
            order!(todos, "待办", |r: &Todo| r.thread_id.clone());
            change.threads = touch(w, &change.todos[0].thread_id, now)?.threads;
        }
        _ => bail!("排序类型无效。"),
    }
    Ok(change)
}

pub fn update_settings(w: &mut Workspace, patch: SettingsPatch, _now: i64) -> Result<Change> {
    if let Some(v) = patch.stale_days {
        ensure!((1..=90).contains(&v), "停滞天数必须是 1–90 的整数。");
        w.settings.stale_days = v;
    }
    if let Some(v) = patch.wip_limit {
        ensure!((0..=50).contains(&v), "进行中上限必须是 0–50 的整数。");
        w.settings.wip_limit = v;
    }
    Ok(Change {
        settings: Some(w.settings.clone()),
        ..Change::default()
    })
}
