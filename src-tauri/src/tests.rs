use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::NaiveDate;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::{backup, decode, images, models::*, store};

#[test]
fn main_window_preserves_html5_drag_and_drop() {
    let config: tauri::Config = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let main = config
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .expect("主窗口配置缺失");
    assert!(
        !main.drag_drop_enabled,
        "主窗口必须关闭 Tauri 文件拖放处理，以支持 Windows HTML5 拖放"
    );
}

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("work");
        fs::create_dir_all(&root).unwrap();
        let path = root.join(format!("rust-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let probe = path.join("write-probe");
        fs::write(&probe, b"ok").unwrap();
        fs::remove_file(probe).unwrap();
        Self(path.canonicalize().unwrap())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("work")
            .canonicalize()
            .unwrap();
        if let Ok(path) = self.0.canonicalize() {
            assert!(path.starts_with(&root) && path != root);
            fs::remove_dir_all(path).unwrap();
        }
    }
}

struct Database {
    conn: Connection,
    path: PathBuf,
    _scratch: Scratch,
}

impl Database {
    fn new() -> Self {
        let scratch = Scratch::new();
        Self {
            conn: store::open(&scratch.0).unwrap(),
            path: scratch.0.join("threading.db"),
            _scratch: scratch,
        }
    }

    fn load(&self) -> Workspace {
        store::load(&self.conn, &self.path).unwrap()
    }

    fn call(&mut self, command: &str, id: &str, input: Value) -> Result<Change> {
        self.call_at(command, id, input, chrono::Utc::now().timestamp_millis())
    }

    fn call_at(&mut self, command: &str, id: &str, input: Value, now: i64) -> Result<Change> {
        store::transact(&mut self.conn, &self.path, |w, _| match command {
            "create_organization" => store::create_organization(w, decode(input)?, now),
            "update_organization" => store::update_organization(w, id, decode(input)?, now),
            "create_project" => store::create_project(w, decode(input)?, now),
            "update_project" => store::update_project(w, id, decode(input)?, now),
            "create_thread" => store::create_thread(w, decode(input)?, now),
            "update_thread" => store::update_thread(w, id, decode(input)?, now),
            "create_todo" => store::create_todo(w, decode(input)?, now),
            "update_todo" => store::update_todo(w, id, decode(input)?, now),
            "create_entry" => store::create_entry(w, decode(input)?, now),
            "update_entry" => store::update_entry(w, id, decode(input)?, now),
            "update_settings" => store::update_settings(w, decode(input)?, now),
            "import_demo_data" => store::import_demo_data(w, decode(input)?, now),
            "clear_demo_data" => store::clear_demo_data(w, now),
            "reorder" => store::reorder(w, id, serde_json::from_value(input)?, now),
            "delete" => store::delete(w, input.as_str().unwrap(), id, now),
            _ => panic!("unknown test command: {command}"),
        })
    }

    fn seed(&mut self) -> (String, String, String) {
        let org = self
            .call("create_organization", "", json!({"name":"量化研究"}))
            .unwrap()
            .organizations[0]
            .id
            .clone();
        let project = self
            .call("create_project", "", json!({"orgId":org,"name":"隔夜策略"}))
            .unwrap()
            .projects[0]
            .id
            .clone();
        let thread = self
            .call(
                "create_thread",
                "",
                json!({"projectId":project,"title":"反转研究","nextAction":"准备数据"}),
            )
            .unwrap()
            .threads[0]
            .id
            .clone();
        (org, project, thread)
    }

    fn rejects(&mut self, command: &str, id: &str, input: Value) {
        let before = self.load();
        let error = self.call(command, id, input.clone()).unwrap_err();
        assert!(
            error
                .to_string()
                .chars()
                .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
            "{error:#}"
        );
        assert_eq!(
            before,
            self.load(),
            "failed command wrote partial data: {command} {input}"
        );
    }
}

#[test]
fn migration_reopen_settings_and_foreign_keys() {
    let mut db = Database::new();
    assert_eq!(
        db.conn
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        db.conn
            .pragma_query_value(None, "foreign_keys", |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        db.conn
            .pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    let empty = db.load();
    assert!(empty.organizations.is_empty() && empty.threads.is_empty());
    assert_eq!(
        empty.settings,
        Settings {
            stale_days: 7,
            wip_limit: 8
        }
    );
    assert!(Path::new(&empty.data_path).is_absolute());
    db.seed();
    db.call("update_settings", "", json!({"staleDays":90,"wipLimit":0}))
        .unwrap();
    let before = db.load();
    db.conn = store::open(db.path.parent().unwrap()).unwrap();
    assert_eq!(db.load(), before);
    assert!(db
        .conn
        .execute("UPDATE projects SET orgId = 'missing'", [])
        .is_err());
    assert!(db
        .conn
        .execute("UPDATE threads SET tags = 'invalid'", [])
        .is_err());
    db.conn.pragma_update(None, "user_version", 4).unwrap();
    assert!(store::open(db.path.parent().unwrap()).is_err());
    assert_eq!(db.load(), before);
}

#[test]
fn normalization_unicode_defaults_and_positions() {
    let mut db = Database::new();
    let a = db
        .call(
            "create_organization",
            "",
            json!({"name":"  🦀量化  ","code":" ","createdAt":1,"id":"client"}),
        )
        .unwrap()
        .organizations
        .remove(0);
    assert_eq!(
        (&*a.name, &*a.code, &*a.color, a.position),
        ("🦀量化", "🦀量", "slate", 0)
    );
    assert_eq!(uuid::Uuid::parse_str(&a.id).unwrap().get_version_num(), 4);
    assert_ne!(a.created_at, 1);
    for (i, color) in [
        "blue", "teal", "green", "amber", "orange", "red", "violet", "slate",
    ]
    .iter()
    .enumerate()
    {
        let row = db
            .call(
                "create_organization",
                "",
                json!({"name":"其它","code":" ab "}),
            )
            .unwrap()
            .organizations
            .remove(0);
        assert_eq!(row.code, "AB");
        assert_eq!(row.color, *color);
        assert_eq!(row.position, i as i64 + 1);
    }
    let p = db
        .call(
            "create_project",
            "",
            json!({"orgId":format!(" {} ", a.id),"name":"  项目  ","targetDate":" 2024-02-29 "}),
        )
        .unwrap()
        .projects
        .remove(0);
    let p2 = db
        .call("create_project", "", json!({"orgId":a.id,"name":"项目二"}))
        .unwrap()
        .projects
        .remove(0);
    assert_eq!(p.position, 0);
    assert_eq!(p2.position, 1);
    let thread = db.call("create_thread", "", json!({"projectId":p.id,"title":"线","tags":[" ALPHA ","alpha",""," 中文 ","中文"],"nextAction":"  待办  "})).unwrap();
    let t = &thread.threads[0];
    assert_eq!(t.tags, ["ALPHA", "中文"]);
    assert_eq!(t.last_activity_at, t.created_at);
    assert_eq!(
        (&*t.stage, &*t.state, &*t.priority, t.hill),
        ("idea", "active", "normal", 0)
    );
    assert_eq!(thread.todos[0].text, "待办");
    assert_eq!(thread.todos[0].position, 0);
    let c = db
        .call(
            "update_thread",
            &t.id,
            json!({"metrics":[{"label":" ","value":"ignored"},{"label":" IC ","value":" 0.03 "}]}),
        )
        .unwrap();
    assert_eq!(
        c.threads[0].metrics,
        vec![Metric {
            label: "IC".into(),
            value: "0.03".into()
        }]
    );
    let chinese = "中".repeat(60);
    assert!(db
        .call("update_organization", &a.id, json!({"name":chinese}))
        .is_ok());
}

#[test]
fn organization_and_project_validation_rejects_every_boundary() {
    let mut db = Database::new();
    let (org, project, _) = db.seed();
    for patch in [
        json!({"name":" "}),
        json!({"name":"中".repeat(61)}),
        json!({"code":"1234567"}),
        json!({"code":"ßßßß"}),
        json!({"color":"pink"}),
        json!({"note":"x".repeat(2001)}),
    ] {
        db.rejects("update_organization", &org, patch.clone());
        let mut input = json!({"name":"测试"});
        input
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        db.rejects("create_organization", "", input);
    }
    for patch in [
        json!({"name":" "}),
        json!({"name":"x".repeat(81)}),
        json!({"goal":"x".repeat(2001)}),
        json!({"status":"other"}),
        json!({"health":"other"}),
        json!({"orgId":"missing"}),
    ] {
        db.rejects("update_project", &project, patch.clone());
        let mut input = json!({"name":"项目","orgId":org});
        input
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        db.rejects("create_project", "", input);
    }
    for date in [
        "2025-02-29",
        "2024-02-30",
        "2024-13-01",
        "2024-00-01",
        "2024-01-00",
        "2024-1-01",
        "24-01-01",
        "2024-01-01T00:00:00Z",
        "0000-01-01",
        "",
        "abcdefghij",
    ] {
        db.rejects("update_project", &project, json!({"targetDate":date}));
        db.rejects(
            "create_project",
            "",
            json!({"orgId":org,"name":"项目","targetDate":date}),
        );
        let todo = db.load().todos[0].clone();
        db.rejects("update_todo", &todo.id, json!({"due":date}));
        db.rejects(
            "create_todo",
            "",
            json!({"threadId":todo.thread_id,"text":"待办","due":date}),
        );
    }
}

#[test]
fn thread_validation_rejects_fields_and_invalid_numbers() {
    let mut db = Database::new();
    let (_, project, thread) = db.seed();
    for patch in [
        json!({"title":" "}),
        json!({"title":"x".repeat(121)}),
        json!({"summary":"x".repeat(20001)}),
        json!({"stage":"other"}),
        json!({"state":"other"}),
        json!({"priority":"other"}),
        json!({"projectId":"missing"}),
        json!({"tags":["x".repeat(25)]}),
        json!({"tags":(0..13).map(|i| i.to_string()).collect::<Vec<_>>()}),
    ] {
        db.rejects("update_thread", &thread, patch.clone());
        let mut input = json!({"projectId":project,"title":"线"});
        input
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        db.rejects("create_thread", "", input);
    }
    for patch in [
        json!({"hill":-1}),
        json!({"hill":101}),
        json!({"hill":1.5}),
        json!({"hill":"50"}),
        json!({"waitingOn":"x".repeat(81)}),
        json!({"metrics":[{"label":"x".repeat(25),"value":"1"}]}),
        json!({"metrics":[{"label":"x","value":"x".repeat(41)}]}),
        json!({"metrics":(0..13).map(|i| json!({"label":i.to_string(),"value":"1"})).collect::<Vec<_>>()}),
    ] {
        db.rejects("update_thread", &thread, patch);
    }
    db.rejects(
        "create_thread",
        "",
        json!({"projectId":project,"title":"线","nextAction":"x".repeat(501)}),
    );
    for hill in [0, 100] {
        db.call("update_thread", &thread, json!({"hill":hill}))
            .unwrap();
    }
}

#[test]
fn todo_entry_settings_validation_and_missing_ids() {
    let mut db = Database::new();
    let (_, project, thread) = db.seed();
    let todo = db.load().todos[0].id.clone();
    for text in [" ".to_owned(), "x".repeat(501)] {
        db.rejects("create_todo", "", json!({"threadId":thread,"text":text}));
        db.rejects("update_todo", &todo, json!({"text":text}));
    }
    db.rejects(
        "create_todo",
        "",
        json!({"threadId":"missing","text":"待办"}),
    );
    let entry = db
        .call(
            "create_entry",
            "",
            json!({"projectId":project,"body":"记录","kind":"note"}),
        )
        .unwrap()
        .entries[0]
        .id
        .clone();
    for body in [" ".to_owned(), "x".repeat(20001)] {
        for kind in ["note", "decision", "result", "update"] {
            db.rejects(
                "create_entry",
                "",
                json!({"projectId":project,"kind":kind,"body":body}),
            );
        }
        db.rejects("update_entry", &entry, json!({"body":body}));
    }
    for input in [
        json!({"projectId":"missing","kind":"note","body":"记录"}),
        json!({"projectId":project,"threadId":"missing","kind":"note","body":"记录"}),
        json!({"projectId":project,"kind":"event","body":"事件"}),
        json!({"projectId":project,"kind":"unknown","body":"记录"}),
        json!({"projectId":project,"kind":"update","body":"进展","health":"bad"}),
        json!({"projectId":project,"kind":"update","body":" ","health":"atRisk"}),
        json!({"projectId":project,"threadId":thread,"kind":"update","body":"进展"}),
    ] {
        db.rejects("create_entry", "", input);
    }
    for kind in ["note", "decision", "result"] {
        for health in [json!("atRisk"), Value::Null] {
            db.rejects(
                "create_entry",
                "",
                json!({"projectId":project,"kind":kind,"body":"记录","health":health}),
            );
        }
    }
    for patch in [
        json!({"staleDays":0}),
        json!({"staleDays":91}),
        json!({"staleDays":1.5}),
        json!({"wipLimit":-1}),
        json!({"wipLimit":51}),
        json!({"wipLimit":1.5}),
        json!({"staleDays":8,"wipLimit":100}),
    ] {
        db.rejects("update_settings", "", patch);
    }
    for (command, patch) in [
        ("update_organization", json!({})),
        ("update_project", json!({})),
        ("update_thread", json!({})),
        ("update_todo", json!({})),
        ("update_entry", json!({"body":"text"})),
    ] {
        db.rejects(command, "missing", patch);
    }
    for kind in ["organization", "project", "thread", "todo", "entry"] {
        db.rejects("delete", "missing", json!(kind));
    }
    db.rejects("create_organization", "", json!({}));
    db.rejects("create_project", "", json!({"name":"缺少父级"}));
    db.rejects("update_thread", &thread, json!({"tags":"not an array"}));
    db.rejects("update_todo", &todo, json!({"done":1}));
}

#[test]
fn nullable_patches_preserve_omit_and_clear_null() {
    let mut db = Database::new();
    let (_, project, _) = db.seed();
    let todo = db.load().todos[0].id.clone();
    for (command, id, key) in [
        ("update_project", project, "targetDate"),
        ("update_todo", todo, "due"),
    ] {
        db.call(command, &id, json!({key:"2024-02-29"})).unwrap();
        db.call(command, &id, json!({"unknownField":"ignored"}))
            .unwrap();
        let value = serde_json::to_value(db.load()).unwrap();
        let collection = if key == "due" { "todos" } else { "projects" };
        assert_eq!(value[collection][0][key], "2024-02-29");
        db.call(command, &id, json!({key:null})).unwrap();
        assert!(serde_json::to_value(db.load()).unwrap()[collection][0][key].is_null());
    }
}

#[test]
fn state_transitions_and_review_use_exact_supplied_clock() {
    let mut db = Database::new();
    let (_, project, thread) = db.seed();
    let mut w = db.load();
    let old = w.threads[0].clone();
    store::update_thread(
        &mut w,
        &thread,
        decode(json!({"reviewed":true})).unwrap(),
        100,
    )
    .unwrap();
    assert_eq!(w.threads[0].reviewed_at, Some(100));
    assert_eq!(w.threads[0].last_activity_at, old.last_activity_at);
    assert_eq!(w.threads[0].updated_at, old.updated_at);
    store::update_thread(
        &mut w,
        &thread,
        decode(json!({"state":"waiting","waitingOn":"  数据  ","reviewed":true})).unwrap(),
        200,
    )
    .unwrap();
    assert_eq!(w.threads[0].waiting_since, Some(200));
    assert_eq!(w.threads[0].waiting_on, "数据");
    assert_eq!(w.threads[0].last_activity_at, 200);
    let events = w.entries.len();
    store::update_thread(
        &mut w,
        &thread,
        decode(json!({"state":"waiting"})).unwrap(),
        300,
    )
    .unwrap();
    assert_eq!(w.threads[0].waiting_since, Some(200));
    assert_eq!(w.entries.len(), events);
    store::update_thread(
        &mut w,
        &thread,
        decode(json!({"state":"closed","waitingOn":"应清空"})).unwrap(),
        400,
    )
    .unwrap();
    assert_eq!(w.threads[0].waiting_since, None);
    assert_eq!(w.threads[0].waiting_on, "");
    assert_eq!(w.threads[0].closed_at, Some(400));
    store::update_thread(
        &mut w,
        &thread,
        decode(json!({"state":"closed"})).unwrap(),
        500,
    )
    .unwrap();
    assert_eq!(w.threads[0].closed_at, Some(400));
    store::update_thread(
        &mut w,
        &thread,
        decode(json!({"state":"active"})).unwrap(),
        600,
    )
    .unwrap();
    assert_eq!(w.threads[0].closed_at, None);
    for state in ["waiting", "closed"] {
        store::create_thread(
            &mut w,
            decode(json!({"projectId":project,"title":state,"state":state})).unwrap(),
            700,
        )
        .unwrap();
        let row = w.threads.last().unwrap();
        assert_eq!(row.waiting_since, (state == "waiting").then_some(700));
        assert_eq!(row.closed_at, (state == "closed").then_some(700));
    }
    let before = w.clone();
    store::update_thread(
        &mut w,
        &thread,
        decode(json!({"reviewed":false})).unwrap(),
        800,
    )
    .unwrap();
    assert_eq!(w, before);
}

#[test]
fn events_have_order_no_duplicates_and_follow_moving_thread() {
    let mut db = Database::new();
    let (org, project, thread) = db.seed();
    let created = db.load().entries[0].clone();
    assert_eq!(
        created.event,
        Some(EntryEvent {
            field: "created".into(),
            from: None,
            to: Some("idea".into())
        })
    );
    assert_eq!(created.body, "");
    let note = db
        .call(
            "create_entry",
            "",
            json!({"projectId":project,"threadId":thread,"kind":"note","body":"笔记"}),
        )
        .unwrap()
        .entries[0]
        .clone();
    let destination = db
        .call("create_project", "", json!({"orgId":org,"name":"新项目"}))
        .unwrap()
        .projects[0]
        .id
        .clone();
    db.call(
        "create_thread",
        "",
        json!({"projectId":destination,"title":"已有线"}),
    )
    .unwrap();
    let change = db
        .call(
            "update_thread",
            &thread,
            json!({"projectId":destination,"stage":"research","state":"waiting"}),
        )
        .unwrap();
    assert_eq!(change.threads[0].position, 1);
    assert_eq!(change.entries.len(), 5);
    assert!(change.entries.iter().all(|e| e.project_id == destination));
    assert!(change.entries.iter().any(|e| e.id == note.id));
    let generated: Vec<_> = change
        .entries
        .iter()
        .filter_map(|e| e.event.as_ref())
        .filter(|e| e.field != "created")
        .collect();
    assert_eq!(
        generated
            .iter()
            .map(|e| e.field.as_str())
            .collect::<Vec<_>>(),
        ["stage", "state", "project"]
    );
    assert_eq!(generated[2].from.as_deref(), Some("隔夜策略"));
    assert_eq!(generated[2].to.as_deref(), Some("新项目"));
    let same = db
        .call(
            "update_thread",
            &thread,
            json!({"projectId":destination,"stage":"research","state":"waiting"}),
        )
        .unwrap();
    assert!(same.entries.is_empty());
    db.rejects(
        "create_entry",
        "",
        json!({"projectId":project,"threadId":thread,"kind":"note","body":"错项目"}),
    );
    db.rejects("update_entry", &created.id, json!({"body":"篡改事件"}));
    let deleted = db.call("delete", &created.id, json!("entry")).unwrap();
    assert_eq!(
        deleted.deleted,
        vec![Deleted {
            kind: "entry".into(),
            id: created.id
        }]
    );
    assert!(deleted.threads.is_empty());
    let c = db
        .call(
            "update_project",
            &destination,
            json!({"health":"offTrack","status":"paused"}),
        )
        .unwrap();
    assert_eq!(
        c.entries
            .iter()
            .map(|e| e.event.as_ref().unwrap().field.as_str())
            .collect::<Vec<_>>(),
        ["health", "status"]
    );
    assert!(c.entries.iter().all(|e| e.thread_id.is_none()));
    assert!(db
        .call(
            "update_project",
            &destination,
            json!({"health":"offTrack","status":"paused"})
        )
        .unwrap()
        .entries
        .is_empty());
    let entries = db.load().entries;
    assert!(entries
        .windows(2)
        .all(|r| r[0].created_at <= r[1].created_at));
}

#[test]
fn project_updates_health_once_and_edit_delete_do_not_revert_it() {
    let mut db = Database::new();
    let (_, project, _) = db.seed();
    let c = db
        .call(
            "create_entry",
            "",
            json!({"projectId":project,"kind":"update","body":"风险增加","health":"atRisk"}),
        )
        .unwrap();
    assert_eq!(c.projects.len(), 1);
    assert_eq!(c.projects[0].health, "atRisk");
    assert_eq!(c.entries.len(), 1);
    assert_eq!(c.entries[0].kind, "update");
    assert!(c.entries[0].event.is_none());
    let entry = c.entries[0].id.clone();
    let c = db
        .call(
            "create_entry",
            "",
            json!({"projectId":project,"kind":"update","body":"继续观察","health":"atRisk"}),
        )
        .unwrap();
    assert!(c.projects.is_empty());
    db.call("create_entry", "", json!({"projectId":project,"kind":"update","threadId":null,"body":"普通进展","health":null})).unwrap();
    let edit = db
        .call("update_entry", &entry, json!({"body":"修订正文"}))
        .unwrap();
    assert!(edit.projects.is_empty());
    assert!(edit.entries[0].edited_at.is_some());
    db.call("delete", &entry, json!("entry")).unwrap();
    assert_eq!(db.load().projects[0].health, "atRisk");
}

#[test]
fn todos_and_entries_touch_activity_including_same_millisecond() {
    let mut db = Database::new();
    let (_, project, thread) = db.seed();
    let mut w = db.load();
    let todo = w.todos[0].id.clone();
    for (done, time, done_at) in [
        (true, 10, Some(10)),
        (true, 20, Some(10)),
        (false, 30, None),
    ] {
        let c =
            store::update_todo(&mut w, &todo, decode(json!({"done":done})).unwrap(), time).unwrap();
        assert_eq!(w.todos[0].done_at, done_at);
        assert_eq!(c.threads[0].last_activity_at, time);
        assert_eq!(c.todos[0].updated_at, time);
    }
    let c = store::create_entry(
        &mut w,
        decode(json!({"projectId":project,"threadId":thread,"kind":"result","body":"结果"}))
            .unwrap(),
        40,
    )
    .unwrap();
    assert_eq!(c.threads[0].last_activity_at, 40);
    let entry = w.entries.last().unwrap().id.clone();
    let c =
        store::update_entry(&mut w, &entry, decode(json!({"body":"修订"})).unwrap(), 50).unwrap();
    assert_eq!(c.threads[0].updated_at, 50);
    store::delete(&mut w, "entry", &entry, 60).unwrap();
    assert_eq!(w.threads[0].last_activity_at, 50);
    let c = store::delete(&mut w, "todo", &todo, 70).unwrap();
    assert_eq!(c.threads[0].last_activity_at, 70);
    // Force exactly the stored timestamp: a no-diff clock must still return the touched thread.
    let time = db.load().threads[0].last_activity_at;
    let c = store::transact(&mut db.conn, &db.path, |w, _| {
        store::create_todo(w, decode(json!({"threadId":thread,"text":"同毫秒"}))?, time)
    })
    .unwrap();
    assert_eq!(c.threads.len(), 1);
    assert_eq!(c.todos.len(), 1);
    let c = db
        .call("update_todo", &todo, json!({"text":"更改"}))
        .unwrap();
    assert_eq!(c.threads.len(), 1);
    let c = db.call("delete", &todo, json!("todo")).unwrap();
    assert_eq!(c.threads.len(), 1);
}

#[test]
fn reorder_checks_full_parent_permutation_and_touches_activity() {
    let mut db = Database::new();
    for kind in ["organization", "project", "thread", "todo"] {
        assert!(db.call("reorder", kind, json!([])).is_ok());
    }
    let (org, project, thread) = db.seed();
    let org2 = db
        .call("create_organization", "", json!({"name":"另一组织"}))
        .unwrap()
        .organizations[0]
        .id
        .clone();
    let project2 = db
        .call("create_project", "", json!({"orgId":org,"name":"项目二"}))
        .unwrap()
        .projects[0]
        .id
        .clone();
    let other = db
        .call(
            "create_project",
            "",
            json!({"orgId":org2,"name":"别的父级"}),
        )
        .unwrap()
        .projects[0]
        .id
        .clone();
    let thread2 = db
        .call(
            "create_thread",
            "",
            json!({"projectId":project,"title":"线二"}),
        )
        .unwrap()
        .threads[0]
        .id
        .clone();
    let other_thread = db
        .call(
            "create_thread",
            "",
            json!({"projectId":project2,"title":"其它线"}),
        )
        .unwrap()
        .threads[0]
        .id
        .clone();
    let todo = db.load().todos[0].id.clone();
    let todo2 = db
        .call(
            "create_todo",
            "",
            json!({"threadId":thread,"text":"第二步"}),
        )
        .unwrap()
        .todos[0]
        .id
        .clone();
    let other_todo = db
        .call(
            "create_todo",
            "",
            json!({"threadId":other_thread,"text":"别的待办"}),
        )
        .unwrap()
        .todos[0]
        .id
        .clone();
    for (kind, first, second, foreign) in [
        ("organization", org, org2, None),
        ("project", project, project2, Some(other)),
        ("thread", thread, thread2, Some(other_thread)),
        ("todo", todo, todo2, Some(other_todo)),
    ] {
        for ids in [
            json!([]),
            json!([first]),
            json!([first, first]),
            json!([first, "missing"]),
        ] {
            db.rejects("reorder", kind, ids);
        }
        if let Some(foreign) = foreign {
            db.rejects("reorder", kind, json!([first, foreign]));
        }
        let c = db.call("reorder", kind, json!([second, first])).unwrap();
        let collection = format!("{kind}s");
        let value = serde_json::to_value(c).unwrap();
        let rows = value[&collection].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.iter().find(|r| r["id"] == second).unwrap()["position"],
            0
        );
        assert_eq!(
            rows.iter().find(|r| r["id"] == first).unwrap()["position"],
            1
        );
        if kind == "todo" {
            assert_eq!(value["threads"].as_array().unwrap().len(), 1);
        }
        let repeat = db.call("reorder", kind, json!([second, first])).unwrap();
        assert_eq!(
            serde_json::to_value(repeat).unwrap()[&collection]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    db.rejects("reorder", "entry", json!([]));
    let w = db.load();
    assert!(w
        .organizations
        .windows(2)
        .all(|a| a[0].position <= a[1].position));
    assert!(w
        .projects
        .windows(2)
        .all(|a| a[0].position <= a[1].position));
    assert!(w.threads.windows(2).all(|a| a[0].position <= a[1].position));
    assert!(w.todos.windows(2).all(|a| a[0].position <= a[1].position));
}

fn row_ids(w: &Workspace) -> HashSet<(String, String)> {
    let value = serde_json::to_value(w).unwrap();
    ["organization", "project", "thread", "todo", "entry"]
        .iter()
        .flat_map(|kind| {
            value[collection_name(kind)]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| ((*kind).to_owned(), r["id"].as_str().unwrap().to_owned()))
                .collect::<Vec<_>>()
        })
        .collect()
}

#[test]
fn cascade_reports_every_deleted_row_and_preserves_other_branch() {
    for kind in ["organization", "project", "thread"] {
        let mut db = Database::new();
        let (org, project, thread) = db.seed();
        db.call(
            "create_entry",
            "",
            json!({"projectId":project,"kind":"note","body":"项目记录"}),
        )
        .unwrap();
        db.call(
            "create_entry",
            "",
            json!({"projectId":project,"threadId":thread,"kind":"note","body":"线记录"}),
        )
        .unwrap();
        let (_, _, other_thread) = db.seed();
        let before = db.load();
        let id = match kind {
            "organization" => &org,
            "project" => &project,
            _ => &thread,
        };
        let change = db.call("delete", id, json!(kind)).unwrap();
        let after = db.load();
        let expected: HashSet<_> = row_ids(&before)
            .difference(&row_ids(&after))
            .cloned()
            .collect();
        let actual: HashSet<_> = change
            .deleted
            .iter()
            .map(|r| (r.kind.clone(), r.id.clone()))
            .collect();
        assert_eq!(actual, expected);
        assert_eq!(actual.len(), change.deleted.len());
        assert_eq!(
            actual.len(),
            match kind {
                "organization" => 7,
                "project" => 6,
                _ => 4,
            }
        );
        assert!(after.threads.iter().any(|r| r.id == other_thread));
        if kind == "thread" {
            assert!(after
                .entries
                .iter()
                .any(|e| e.project_id == project && e.thread_id.is_none()));
        }
        assert!(db
            .conn
            .prepare("PRAGMA foreign_key_check")
            .unwrap()
            .query([])
            .unwrap()
            .next()
            .unwrap()
            .is_none());
    }
}

#[test]
fn sql_failure_rolls_back_all_rows_and_does_not_return_change() {
    let mut db = Database::new();
    let (_, project, thread) = db.seed();
    let before = db.load();
    db.conn.execute_batch("CREATE TRIGGER reject_entry BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, '模拟磁盘写入失败'); END;").unwrap();
    db.rejects(
        "create_thread",
        "",
        json!({"projectId":project,"title":"写入失败","nextAction":"不能残留"}),
    );
    db.rejects(
        "update_thread",
        &thread,
        json!({"title":"不能保存","stage":"live"}),
    );
    assert_eq!(db.load(), before);
    db.conn.execute_batch("DROP TRIGGER reject_entry;").unwrap();
}

#[test]
fn project_move_appends_in_destination_organization() {
    let mut db = Database::new();
    let (_, project, _) = db.seed();
    let org = db
        .call("create_organization", "", json!({"name":"目标组织"}))
        .unwrap()
        .organizations[0]
        .id
        .clone();
    db.call("create_project", "", json!({"orgId":org,"name":"已有项目"}))
        .unwrap();
    let c = db
        .call("update_project", &project, json!({"orgId":org}))
        .unwrap();
    assert_eq!(c.projects[0].position, 1);
    assert!(c.entries.is_empty());
}

#[test]
fn backups_rotate_only_daily_files_and_keep_snapshot_shape() {
    let mut db = Database::new();
    db.seed();
    let w = db.load();
    let dir = db.path.parent().unwrap().join("backups");
    let manual = backup::now(&w, &db.path).unwrap();
    assert!(Path::new(&manual).is_absolute());
    assert!(Path::new(&manual).exists());
    fs::write(dir.join("threading-20260100.json"), "unrelated").unwrap();
    fs::write(dir.join("threading-20260101-extra.json"), "unrelated").unwrap();
    for day in 1..=20 {
        backup::daily(&w, &db.path, NaiveDate::from_ymd_opt(2026, 1, day).unwrap()).unwrap();
    }
    let daily: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.len() == 23 && n != "threading-20260100.json"
        })
        .collect();
    // Exact names are asserted as well, independent of the directory filter.
    for day in 1..=20 {
        assert_eq!(
            dir.join(format!("threading-202601{day:02}.json")).exists(),
            day >= 7
        );
    }
    assert_eq!(daily.len(), 14);
    assert!(Path::new(&manual).exists());
    assert!(dir.join("threading-20260100.json").exists());
    assert!(dir.join("threading-20260101-extra.json").exists());
    let path = dir.join("threading-20260120.json");
    let original = fs::read(&path).unwrap();
    let mut changed = w.clone();
    changed.settings.stale_days = 90;
    backup::daily(
        &changed,
        &db.path,
        NaiveDate::from_ymd_opt(2026, 1, 20).unwrap(),
    )
    .unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    let snapshot: Value = serde_json::from_slice(&original).unwrap();
    let mut expected = serde_json::to_value(&w).unwrap();
    expected.as_object_mut().unwrap().remove("dataPath");
    assert_eq!(snapshot, expected);
    assert!(!fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .any(|e| e.path().extension().is_some_and(|s| s == "tmp")));
    let first = backup::now(&w, &db.path).unwrap();
    let second = backup::now(&changed, &db.path).unwrap();
    assert!(Path::new(&first).exists());
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(second).unwrap()).unwrap()["settings"]
            ["staleDays"],
        90
    );
}

#[test]
fn backup_failure_cleans_temporary_file_and_preserves_database() {
    let mut db = Database::new();
    db.seed();
    let w = db.load();
    let dir = db.path.parent().unwrap().join("backups");
    fs::create_dir(&dir).unwrap();
    let path = dir.join("threading-20260101.json");
    fs::create_dir(&path).unwrap();
    // A destination collision with a directory makes rename fail deterministically.
    let manual = dir.join("threading-20260101-120000.json");
    fs::create_dir(&manual).unwrap();
    assert!(backup::write_snapshot(&w, &manual).is_err());
    assert!(manual.is_dir());
    assert!(!fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .any(|e| e.path().extension().is_some_and(|s| s == "tmp")));
    assert_eq!(db.load(), w);
}

#[cfg(windows)]
#[test]
fn displayed_windows_paths_and_error_chains_use_ordinary_paths() {
    for (input, expected) in [
        (
            r"\\?\C:\研究 数据\threading.db",
            r"C:\研究 数据\threading.db",
        ),
        (
            r"\\?\UNC\server\share\研究 数据\threading.db",
            r"\\server\share\研究 数据\threading.db",
        ),
        (r"C:\研究 数据\threading.db", r"C:\研究 数据\threading.db"),
        (
            r"\\server\share\研究 数据\threading.db",
            r"\\server\share\研究 数据\threading.db",
        ),
    ] {
        let displayed = crate::display_path(Path::new(input));
        assert_eq!(displayed, expected);
        assert!(Path::new(&displayed).is_absolute());
        let error = anyhow::anyhow!("无法访问：{input}").context(format!("无法备份：{input}"));
        assert_eq!(
            crate::display_error(error),
            format!("无法备份：{expected}: 无法访问：{expected}")
        );
    }
}

fn assert_public_file_path(displayed: &str, actual: &Path) {
    #[cfg(windows)]
    assert!(!displayed.starts_with(r"\\?\"), "{displayed}");
    let displayed = Path::new(displayed);
    assert!(displayed.is_absolute());
    assert!(displayed.is_file());
    assert_eq!(
        displayed.canonicalize().unwrap(),
        actual.canonicalize().unwrap()
    );
    assert_eq!(fs::read(displayed).unwrap(), fs::read(actual).unwrap());
}

#[test]
fn ipc_commands_accept_contract_payloads_and_merge_without_reload() {
    let scratch = Scratch::new();
    let connection = Arc::new(Mutex::new(store::open(&scratch.0).unwrap()));
    let path = scratch.0.join("threading.db");
    let app = tauri::test::mock_builder()
        .manage(crate::AppState {
            connection: Arc::clone(&connection),
            data_path: path.clone(),
        })
        .invoke_handler(crate::command_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let invoke = |cmd: &str, body: Value| {
        tauri::test::get_ipc_response(
            &window,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
        .map(|response| response.deserialize::<Value>().unwrap())
    };
    let mut client = invoke("load_workspace", json!({})).unwrap();
    assert_public_file_path(client["dataPath"].as_str().unwrap(), &path);
    let mut mutate = |cmd: &str, body: Value| {
        let change = invoke(cmd, body).unwrap();
        merge_client(&mut client, &change);
        let actual =
            serde_json::to_value(store::load(&connection.lock().unwrap(), &path).unwrap()).unwrap();
        assert_workspace_rows_equal(&client, &actual);
        change
    };
    let org = mutate("create_organization", json!({"input":{"name":"组织"}}))["organizations"][0]
        ["id"]
        .clone();
    mutate(
        "update_organization",
        json!({"id":org,"patch":{"code":"hq","note":"测试"}}),
    );
    let project = mutate(
        "create_project",
        json!({"input":{"orgId":org,"name":"项目"}}),
    )["projects"][0]["id"]
        .clone();
    mutate(
        "update_project",
        json!({"id":project,"patch":{"health":"atRisk","targetDate":"2026-11-01"}}),
    );
    let thread = mutate(
        "create_thread",
        json!({"input":{"projectId":project,"title":"线","nextAction":"首步"}}),
    )["threads"][0]["id"]
        .clone();
    mutate(
        "update_thread",
        json!({"id":thread,"patch":{"stage":"paper","reviewed":true}}),
    );
    let todo = mutate(
        "create_todo",
        json!({"input":{"threadId":thread,"text":"待办","due":"2026-11-01"}}),
    )["todos"][0]["id"]
        .clone();
    mutate(
        "update_todo",
        json!({"id":todo,"patch":{"due":null,"done":true}}),
    );
    let entry = mutate(
        "create_entry",
        json!({"input":{"projectId":project,"threadId":thread,"kind":"decision","body":"结论"}}),
    )["entries"][0]["id"]
        .clone();
    mutate(
        "update_entry",
        json!({"id":entry,"patch":{"body":"修改结论"}}),
    );
    mutate("reorder", json!({"kind":"thread","ids":[thread]}));
    let child = mutate(
        "create_thread",
        json!({"input":{"projectId":project,"parentId":thread,"title":"子线"}}),
    )["entries"][0]["threadId"]
        .clone();
    mutate(
        "create_thread",
        json!({"input":{"projectId":project,"parentId":child,"title":"孙线"}}),
    );
    mutate(
        "update_thread",
        json!({"id":child,"patch":{"parentId":null}}),
    );
    mutate(
        "update_thread",
        json!({"id":child,"patch":{"parentId":thread}}),
    );
    mutate("delete_thread", json!({"id":child}));
    mutate(
        "update_settings",
        json!({"patch":{"staleDays":10,"wipLimit":0}}),
    );
    let imported = mutate("import_demo_data", json!({"seed":demo_seed()}));
    assert_eq!(imported["organizations"][0]["demo"], true);
    assert_eq!(imported["threads"][0], demo_seed()["threads"][0]);
    let error = invoke("import_demo_data", json!({"seed":demo_seed()})).unwrap_err();
    assert_eq!(error, json!("示例数据已经添加过了，先清理再重新添加。"));
    mutate("clear_demo_data", json!({}));
    assert_eq!(mutate("clear_demo_data", json!({})), json!({}));
    let error = invoke("import_demo_data", json!({"seed":{"organizations":[]}})).unwrap_err();
    assert!(error.to_string().contains("输入格式无效"));
    let backup = invoke("backup_now", json!({})).unwrap();
    let backup_path = backup.as_str().unwrap();
    let actual_backup = scratch
        .0
        .join("backups")
        .join(Path::new(backup_path).file_name().unwrap());
    assert_public_file_path(backup_path, &actual_backup);
    for (command, id) in [
        ("delete_entry", entry),
        ("delete_todo", todo),
        ("delete_thread", thread),
        ("delete_project", project),
        ("delete_organization", org),
    ] {
        mutate(command, json!({"id":id}));
    }
    let error = invoke("update_settings", json!({"patch":{"staleDays":1.5}})).unwrap_err();
    assert!(error.to_string().contains("输入格式无效"));
    // load succeeds even when the backup directory cannot be created.
    let backups = scratch.0.join("backups");
    let resolved = backups.canonicalize().unwrap();
    assert!(resolved.starts_with(&scratch.0) && resolved != scratch.0);
    fs::remove_dir_all(&resolved).unwrap();
    fs::write(&backups, "blocked").unwrap();
    assert!(invoke("load_workspace", json!({})).is_ok());
    // MockRuntime retains AppHandle clones; close the on-disk connection explicitly.
    let disk = std::mem::replace(
        &mut *connection.lock().unwrap(),
        Connection::open_in_memory().unwrap(),
    );
    disk.close().unwrap();
    drop(window);
    drop(app);
    drop(connection);
}

fn demo_seed() -> Value {
    json!({
        "organizations":[{"id":"demo-org","name":"示例组织","code":"DEMO","color":"teal","note":"历史研究","archived":false,"demo":false,"position":99,"createdAt":1000,"updatedAt":2000}],
        "projects":[{"id":"demo-project","orgId":"demo-org","name":"示例项目","goal":"验证","status":"active","health":"onTrack","targetDate":"2026-12-31","position":7,"createdAt":2000,"updatedAt":3000}],
        "threads":[{"id":"demo-thread","projectId":"demo-project","parentId":null,"title":"示例策略线","summary":"历史摘要","stage":"research","state":"waiting","priority":"high","hill":42,"waitingOn":"等数据","waitingSince":4000,"tags":["研究","Alpha"],"metrics":[{"label":"IC","value":"0.05"}],"position":9,"createdAt":3000,"updatedAt":6000,"lastActivityAt":5000,"reviewedAt":7000,"closedAt":null}],
        "todos":[{"id":"demo-todo","threadId":"demo-thread","text":"历史待办","due":"2024-02-29","done":true,"doneAt":6000,"position":11,"createdAt":4000,"updatedAt":6000}],
        "entries":[
            {"id":"demo-created","projectId":"demo-project","threadId":"demo-thread","kind":"event","body":"","health":null,"event":{"field":"created","from":null,"to":"idea"},"createdAt":3000,"editedAt":null},
            {"id":"demo-note","projectId":"demo-project","threadId":"demo-thread","kind":"note","body":"历史笔记","health":null,"event":null,"createdAt":4000,"editedAt":5000},
            {"id":"demo-update","projectId":"demo-project","threadId":null,"kind":"update","body":"历史进展","health":"atRisk","event":null,"createdAt":5000,"editedAt":null}
        ]
    })
}

#[test]
fn migration_from_v1_preserves_rows_and_defaults_demo_false() {
    let scratch = Scratch::new();
    let path = scratch.0.join("threading.db");
    let old = Connection::open(&path).unwrap();
    old.execute_batch(include_str!("schema.sql")).unwrap();
    old.execute(
        "INSERT INTO organizations VALUES ('old-org','旧组织','OLD','blue','备注',1,8,100,200)",
        [],
    )
    .unwrap();
    old.execute("INSERT INTO projects VALUES ('old-project','old-org','旧项目','目标','active','onTrack',NULL,4,120,220)", []).unwrap();
    old.pragma_update(None, "user_version", 1).unwrap();
    old.close().unwrap();
    let conn = store::open(&scratch.0).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    let before = store::load(&conn, &path).unwrap();
    assert_eq!(
        serde_json::to_value(&before.organizations[0]).unwrap(),
        json!({"id":"old-org","name":"旧组织","code":"OLD","color":"blue","note":"备注","archived":true,"demo":false,"position":8,"createdAt":100,"updatedAt":200})
    );
    assert_eq!(before.projects[0].id, "old-project");
    conn.close().unwrap();
    let conn = store::open(&scratch.0).unwrap();
    assert_eq!(before, store::load(&conn, &path).unwrap());
}

#[test]
fn demo_import_preserves_all_rows_and_backup_without_side_effects() {
    let mut db = Database::new();
    let (org, _, _) = db.seed();
    db.conn
        .execute("UPDATE organizations SET position = 12", [])
        .unwrap();
    db.call("update_organization", &org, json!({"demo":true}))
        .unwrap();
    let before = db.load();
    assert!(!before.organizations[0].demo);
    let mut seed = demo_seed();
    let mut second = seed["organizations"][0].clone();
    second["id"] = json!("demo-org-2");
    second["demo"] = json!(true);
    seed["organizations"].as_array_mut().unwrap().push(second);
    let mut closed = seed["threads"][0].clone();
    closed["id"] = json!("demo-closed");
    closed["state"] = json!("closed");
    closed["waitingSince"] = Value::Null;
    closed["waitingOn"] = json!("");
    closed["closedAt"] = json!(5500);
    seed["threads"].as_array_mut().unwrap().push(closed);
    let change = db.call("import_demo_data", "", seed.clone()).unwrap();
    let mut expected = seed;
    for (i, row) in expected["organizations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        row["demo"] = json!(true);
        row["position"] = json!(13 + i);
    }
    assert_eq!(serde_json::to_value(change).unwrap(), expected);
    let after = db.load();
    assert_eq!(after.settings, before.settings);
    assert_eq!(after.organizations[0], before.organizations[0]);
    assert_eq!(
        after.threads.iter().find(|r| r.id == before.threads[0].id),
        Some(&before.threads[0])
    );
    assert_eq!(after.entries.len(), before.entries.len() + 3);
    assert_eq!(
        after
            .projects
            .iter()
            .find(|r| r.id == "demo-project")
            .unwrap()
            .health,
        "onTrack"
    );
    db.conn = store::open(db.path.parent().unwrap()).unwrap();
    assert_eq!(db.load(), after);
    let path = backup::now(&after, &db.path).unwrap();
    let saved: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert_eq!(
        saved["organizations"],
        serde_json::to_value(&after.organizations).unwrap()
    );
    db.call("update_organization", "demo-org", json!({"demo":false}))
        .unwrap();
    assert!(
        db.load()
            .organizations
            .iter()
            .find(|r| r.id == "demo-org")
            .unwrap()
            .demo
    );
    let error = db.call("import_demo_data", "", demo_seed()).unwrap_err();
    assert_eq!(
        error.to_string(),
        "示例数据已经添加过了，先清理再重新添加。"
    );
    db.rejects("import_demo_data", "", demo_seed());
}

#[test]
fn demo_import_rejects_id_collisions_and_open_references_atomically() {
    let mut db = Database::new();
    let (org, project, thread) = db.seed();
    let existing = row_ids(&db.load());
    let collections = ["organizations", "projects", "threads", "todos", "entries"];
    for collection in collections {
        for (_, id) in &existing {
            let mut seed = demo_seed();
            seed[collection][0]["id"] = json!(id);
            let error = db.call("import_demo_data", "", seed.clone()).unwrap_err();
            assert_eq!(error.to_string(), "示例数据的 id 重复或与已有记录冲突。");
            db.rejects("import_demo_data", "", seed);
        }
        let mut seed = demo_seed();
        let duplicate = seed[collection][0].clone();
        seed[collection].as_array_mut().unwrap().push(duplicate);
        db.rejects("import_demo_data", "", seed);
        for id in ["", " bad "] {
            let mut seed = demo_seed();
            seed[collection][0]["id"] = json!(id);
            db.rejects("import_demo_data", "", seed);
        }
    }
    let mut seed = demo_seed();
    seed["entries"][0]["id"] = seed["todos"][0]["id"].clone();
    db.rejects("import_demo_data", "", seed);
    for (collection, field, real_id) in [
        ("projects", "orgId", org),
        ("threads", "projectId", project.clone()),
        ("todos", "threadId", thread.clone()),
        ("entries", "projectId", project),
        ("entries", "threadId", thread),
    ] {
        for id in [real_id.as_str(), "missing"] {
            let mut seed = demo_seed();
            seed[collection][0][field] = json!(id);
            db.rejects("import_demo_data", "", seed);
        }
    }
    let mut seed = demo_seed();
    let mut other = seed["projects"][0].clone();
    other["id"] = json!("other-project");
    seed["projects"].as_array_mut().unwrap().push(other);
    seed["entries"][0]["projectId"] = json!("other-project");
    db.rejects("import_demo_data", "", seed);
}

#[test]
fn demo_import_rejects_invalid_fields_without_normalizing() {
    let mut db = Database::new();
    db.seed();
    for (collection, field, value) in [
        ("organizations", "name", json!(" ")),
        ("organizations", "name", json!("中".repeat(61))),
        ("organizations", "name", json!(" trim ")),
        ("organizations", "code", json!("1234567")),
        ("organizations", "code", json!("abc")),
        ("organizations", "code", json!("")),
        ("organizations", "color", json!("pink")),
        ("organizations", "note", json!("中".repeat(2001))),
        ("projects", "name", json!("")),
        ("projects", "name", json!("中".repeat(81))),
        ("projects", "goal", json!("中".repeat(2001))),
        ("projects", "status", json!("invalid")),
        ("projects", "health", json!("invalid")),
        ("projects", "targetDate", json!("2025-02-29")),
        ("projects", "targetDate", json!("2026-1-01")),
        ("projects", "targetDate", json!("0000-01-01")),
        ("threads", "title", json!("")),
        ("threads", "title", json!("中".repeat(121))),
        ("threads", "summary", json!("中".repeat(20001))),
        ("threads", "stage", json!("invalid")),
        ("threads", "state", json!("invalid")),
        ("threads", "priority", json!("invalid")),
        ("threads", "hill", json!(-1)),
        ("threads", "hill", json!(101)),
        ("threads", "hill", json!(1.5)),
        ("threads", "waitingOn", json!("中".repeat(81))),
        ("threads", "tags", json!(["中".repeat(25)])),
        ("threads", "tags", json!([""])),
        ("threads", "tags", json!(["Alpha", "alpha"])),
        (
            "threads",
            "tags",
            json!((0..13).map(|i| i.to_string()).collect::<Vec<_>>()),
        ),
        ("threads", "metrics", json!([{"label":"","value":"1"}])),
        (
            "threads",
            "metrics",
            json!([{"label":"中".repeat(25),"value":"1"}]),
        ),
        (
            "threads",
            "metrics",
            json!([{"label":"IC","value":"中".repeat(41)}]),
        ),
        (
            "threads",
            "metrics",
            json!(vec![json!({"label":"IC","value":"1"}); 13]),
        ),
        ("todos", "text", json!("")),
        ("todos", "text", json!("中".repeat(501))),
        ("todos", "due", json!("2026-02-30")),
        ("entries", "kind", json!("invalid")),
    ] {
        let mut seed = demo_seed();
        seed[collection][0][field] = value;
        db.rejects("import_demo_data", "", seed);
    }
    for (entry, patch) in [
        (0, json!({"body":"非空"})),
        (0, json!({"health":"onTrack"})),
        (0, json!({"event":null})),
        (
            0,
            json!({"event":{"field":"unknown","from":null,"to":"idea"}}),
        ),
        (
            0,
            json!({"event":{"field":"created","from":"idea","to":"research"}}),
        ),
        (
            0,
            json!({"event":{"field":"stage","from":"invalid","to":"live"}}),
        ),
        (
            0,
            json!({"event":{"field":"state","from":"active","to":null}}),
        ),
        (
            0,
            json!({"event":{"field":"project","from":"","to":"项目"}}),
        ),
        (
            0,
            json!({"event":{"field":"health","from":"onTrack","to":"atRisk"}}),
        ),
        (0, json!({"threadId":null})),
        (1, json!({"body":""})),
        (1, json!({"body":"中".repeat(20001)})),
        (
            1,
            json!({"event":{"field":"created","from":null,"to":"idea"}}),
        ),
        (1, json!({"health":"onTrack"})),
        (1, json!({"kind":"update"})),
        (2, json!({"health":"invalid"})),
        (2, json!({"body":""})),
    ] {
        let mut seed = demo_seed();
        for (field, value) in patch.as_object().unwrap() {
            seed["entries"][entry][field] = value.clone();
        }
        db.rejects("import_demo_data", "", seed);
    }
}

#[test]
fn demo_import_preserves_valid_event_variants_and_rejects_bad_payloads() {
    let mut db = Database::new();
    for (field, from, to, thread_id) in [
        ("created", None, "idea", Some("demo-thread")),
        ("stage", Some("idea"), "research", Some("demo-thread")),
        ("state", Some("active"), "waiting", Some("demo-thread")),
        ("project", Some("原项目"), "新项目", Some("demo-thread")),
        ("health", Some("onTrack"), "atRisk", None),
        ("status", Some("active"), "done", None),
    ] {
        let mut seed = demo_seed();
        seed["entries"][0]["threadId"] = json!(thread_id);
        seed["entries"][0]["event"] = json!({"field":field,"from":from,"to":to});
        let change = db.call("import_demo_data", "", seed.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(&change.entries[0]).unwrap(),
            seed["entries"][0]
        );
        db.call("clear_demo_data", "", json!({})).unwrap();
        for invalid_to in [Value::Null, json!(""), json!(" bad ")] {
            let mut bad = seed.clone();
            bad["entries"][0]["event"]["to"] = invalid_to;
            db.rejects("import_demo_data", "", bad);
        }
    }
    let mut seed = demo_seed();
    seed["threads"][0]["state"] = json!("active");
    seed["threads"][0]["waitingSince"] = Value::Null;
    seed["threads"][0]["waitingOn"] = json!("");
    seed["todos"][0]["done"] = json!(false);
    seed["todos"][0]["doneAt"] = Value::Null;
    db.call("import_demo_data", "", seed).unwrap();
}

#[test]
fn demo_import_checks_state_times_and_every_timestamp() {
    let mut db = Database::new();
    for (collection, patch) in [
        ("threads", json!({"waitingSince":null})),
        ("threads", json!({"state":"active"})),
        ("threads", json!({"state":"closed","waitingSince":null})),
        ("threads", json!({"closedAt":5000})),
        ("todos", json!({"doneAt":null})),
        ("todos", json!({"done":false})),
        ("organizations", json!({"updatedAt":0})),
        ("projects", json!({"updatedAt":0})),
        ("threads", json!({"updatedAt":0})),
        ("threads", json!({"lastActivityAt":0})),
        ("todos", json!({"updatedAt":0})),
    ] {
        let mut seed = demo_seed();
        for (field, value) in patch.as_object().unwrap() {
            seed[collection][0][field] = value.clone();
        }
        db.rejects("import_demo_data", "", seed);
    }
    for (collection, fields) in [
        ("organizations", vec!["createdAt", "updatedAt"]),
        ("projects", vec!["createdAt", "updatedAt"]),
        (
            "threads",
            vec![
                "createdAt",
                "updatedAt",
                "lastActivityAt",
                "waitingSince",
                "reviewedAt",
                "closedAt",
            ],
        ),
        ("todos", vec!["createdAt", "updatedAt", "doneAt"]),
        ("entries", vec!["createdAt", "editedAt"]),
    ] {
        for field in fields {
            let mut seed = demo_seed();
            if field == "closedAt" {
                seed["threads"][0]["state"] = json!("closed");
                seed["threads"][0]["waitingSince"] = Value::Null;
            }
            seed[collection][0][field] = json!(chrono::Utc::now().timestamp_millis() + 600_000);
            let error = db.call("import_demo_data", "", seed.clone()).unwrap_err();
            assert_eq!(
                error.to_string(),
                "示例数据时间戳不能晚于当前时间 5 分钟以上。"
            );
            db.rejects("import_demo_data", "", seed);
        }
    }
    // The five-minute boundary uses a fixed clock to avoid a timing-dependent assertion.
    for (delta, valid) in [(300_000, true), (300_001, false)] {
        let mut seed = demo_seed();
        seed["entries"][1]["editedAt"] = json!(10_000 + delta);
        let result = store::transact(&mut db.conn, &db.path, |w, _| {
            store::import_demo_data(w, decode(seed)?, 10_000)
        });
        assert_eq!(result.is_ok(), valid);
        db.call("clear_demo_data", "", json!({})).unwrap();
    }
}

#[test]
fn demo_import_enforces_each_row_limit_and_rolls_back_sql_failures() {
    let mut db = Database::new();
    for (collection, limit, label) in [
        ("organizations", 20, "组织"),
        ("projects", 100, "项目"),
        ("threads", 500, "策略线"),
        ("todos", 2000, "待办"),
        ("entries", 5000, "条目"),
    ] {
        let mut seed = demo_seed();
        let row = seed[collection][0].clone();
        seed[collection] = json!((0..=limit)
            .map(|i| {
                let mut row = row.clone();
                if i > 0 {
                    row["id"] = json!(format!("extra-{i}"));
                }
                row
            })
            .collect::<Vec<_>>());
        let error = db.call("import_demo_data", "", seed.clone()).unwrap_err();
        assert_eq!(
            error.to_string(),
            format!("示例数据的{label}不能超过 {limit} 行。")
        );
        db.rejects("import_demo_data", "", seed.clone());
        seed[collection].as_array_mut().unwrap().pop();
        db.call("import_demo_data", "", seed).unwrap();
        db.call("clear_demo_data", "", json!({})).unwrap();
    }
    db.conn.execute_batch("CREATE TRIGGER reject_demo_entry BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, '模拟写入失败'); END;").unwrap();
    db.rejects("import_demo_data", "", demo_seed());
    db.conn
        .execute_batch("DROP TRIGGER reject_demo_entry;")
        .unwrap();
    db.call("import_demo_data", "", demo_seed()).unwrap();
    db.conn.execute_batch("CREATE TRIGGER reject_demo_delete BEFORE DELETE ON organizations BEGIN SELECT RAISE(ABORT, '模拟删除失败'); END;").unwrap();
    db.rejects("clear_demo_data", "", json!({}));
}

#[test]
fn clear_demo_deletes_complete_subtrees_but_keeps_real_and_moved_work() {
    let mut db = Database::new();
    let (_, real_project, _) = db.seed();
    let real = db.load();
    assert_eq!(
        serde_json::to_value(db.call("clear_demo_data", "", json!({})).unwrap()).unwrap(),
        json!({})
    );
    db.call("import_demo_data", "", demo_seed()).unwrap();
    db.call(
        "update_thread",
        "demo-thread",
        json!({"projectId":real_project}),
    )
    .unwrap();
    db.call(
        "create_thread",
        "",
        json!({"projectId":"demo-project","title":"后来新增","nextAction":"新增待办"}),
    )
    .unwrap();
    db.call(
        "create_entry",
        "",
        json!({"projectId":"demo-project","kind":"note","body":"后来新增项目记录"}),
    )
    .unwrap();
    let before = db.load();
    let preserved_thread = before
        .threads
        .iter()
        .find(|r| r.id == "demo-thread")
        .unwrap();
    let change = db.call("clear_demo_data", "", json!({})).unwrap();
    let after = db.load();
    assert_eq!(after.organizations, real.organizations);
    assert_eq!(after.projects, real.projects);
    assert_eq!(after.settings, real.settings);
    for row in &real.threads {
        assert!(after.threads.contains(row));
    }
    for row in &real.todos {
        assert!(after.todos.contains(row));
    }
    for row in &real.entries {
        assert!(after.entries.contains(row));
    }
    assert!(after.threads.contains(preserved_thread));
    assert!(after.todos.iter().any(|r| r.id == "demo-todo"));
    assert!(after
        .entries
        .iter()
        .any(|r| r.id == "demo-note" && r.project_id == real_project));
    let actual: HashSet<_> = change
        .deleted
        .iter()
        .map(|r| (r.kind.clone(), r.id.clone()))
        .collect();
    let expected: HashSet<_> = row_ids(&before)
        .difference(&row_ids(&after))
        .cloned()
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(actual.len(), 7);
    assert_eq!(actual.len(), change.deleted.len());
    let mut only_deleted = serde_json::to_value(change).unwrap();
    only_deleted.as_object_mut().unwrap().remove("deleted");
    assert_eq!(only_deleted, json!({}));
    assert_eq!(
        serde_json::to_value(db.call("clear_demo_data", "", json!({})).unwrap()).unwrap(),
        json!({})
    );
    assert_eq!(db.load(), after);
    // Moved IDs remain protected against another import after clearing.
    db.rejects("import_demo_data", "", demo_seed());
}

#[test]
fn migration_from_real_v2_schema_preserves_all_rows_and_adds_parent_index() {
    let scratch = Scratch::new();
    let path = scratch.0.join("threading.db");
    let old = Connection::open(&path).unwrap();
    old.execute_batch(include_str!("schema.sql")).unwrap();
    old.execute_batch("ALTER TABLE organizations ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;")
        .unwrap();
    let mut seed = demo_seed();
    seed["organizations"][0]["demo"] = json!(true);
    for table in ["organizations", "projects", "threads", "todos", "entries"] {
        for value in seed[table].as_array().unwrap() {
            let mut fields = value.as_object().unwrap().clone();
            fields.remove("parentId");
            let names = fields.keys().cloned().collect::<Vec<_>>().join(",");
            let values: Vec<rusqlite::types::Value> = fields
                .values()
                .map(|v| match v {
                    Value::Null => rusqlite::types::Value::Null,
                    Value::Bool(v) => i64::from(*v).into(),
                    Value::Number(v) => v.as_i64().unwrap().into(),
                    Value::String(v) => v.clone().into(),
                    _ => v.to_string().into(),
                })
                .collect();
            old.execute(
                &format!(
                    "INSERT INTO {table} ({names}) VALUES ({})",
                    vec!["?"; values.len()].join(",")
                ),
                rusqlite::params_from_iter(values),
            )
            .unwrap();
        }
    }
    old.pragma_update(None, "user_version", 2).unwrap();
    old.execute("UPDATE settings SET value = 14 WHERE key = 'staleDays'", [])
        .unwrap();
    assert!(old.prepare("SELECT parent_id FROM threads").is_err());
    old.close().unwrap();
    let mut conn = store::open(&scratch.0).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    let before = store::load(&conn, &path).unwrap();
    assert_eq!(before.settings.stale_days, 14);
    let serialized = serde_json::to_value(&before).unwrap();
    for table in ["organizations", "projects", "threads", "todos", "entries"] {
        assert_eq!(serialized[table], seed[table]);
    }
    let columns: Vec<String> = conn
        .prepare("PRAGMA index_info(threads_siblings)")
        .unwrap()
        .query_map([], |r| r.get(2))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(columns, ["projectId", "parent_id", "position"]);
    assert!(conn
        .execute("UPDATE threads SET parent_id = 'missing'", [])
        .is_err());
    store::transact(&mut conn, &path, |w, now| {
        store::create_thread(
            w,
            decode(json!({
                "projectId":"demo-project", "parentId":"demo-thread", "title":"迁移后的子线"
            }))?,
            now,
        )
    })
    .unwrap();
    let expected = store::load(&conn, &path).unwrap();
    conn.close().unwrap();
    let conn = store::open(&scratch.0).unwrap();
    assert_eq!(expected, store::load(&conn, &path).unwrap());
    assert_eq!(
        conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
}

fn add_line(db: &mut Database, project: &str, parent: Option<&str>, title: &str) -> String {
    db.call(
        "create_thread",
        "",
        json!({"projectId":project,"parentId":parent,"title":title}),
    )
    .unwrap()
    .entries[0]
        .thread_id
        .clone()
        .unwrap()
}

fn thread_row(db: &Database, id: &str) -> Thread {
    db.load().threads.into_iter().find(|t| t.id == id).unwrap()
}

fn assert_thread_change(change: &Change, ids: &[&str], now: i64) {
    assert_eq!(
        change
            .threads
            .iter()
            .map(|t| t.id.as_str())
            .collect::<HashSet<_>>(),
        ids.iter().copied().collect()
    );
    assert_eq!(change.threads.len(), ids.len());
    for thread in &change.threads {
        assert_eq!((thread.updated_at, thread.last_activity_at), (now, now));
    }
}

#[test]
fn nested_create_and_parent_validation_are_atomic() {
    let mut db = Database::new();
    let (org, project, root) = db.seed();
    let other_project = db
        .call(
            "create_project",
            "",
            json!({"orgId":org,"name":"另一个项目"}),
        )
        .unwrap()
        .projects[0]
        .id
        .clone();
    let other = add_line(&mut db, &other_project, None, "另一个项目的线");
    let now = chrono::Utc::now().timestamp_millis() + 1000;
    let change = db.call_at("create_thread", "", json!({"projectId":project,"parentId":format!(" {root} "),"title":"子线","nextAction":"下一步"}), now).unwrap();
    let child = change.entries[0].thread_id.clone().unwrap();
    assert_thread_change(&change, &[&root, &child], now);
    assert_eq!(change.entries.len(), 1);
    assert_eq!(change.entries[0].event.as_ref().unwrap().field, "created");
    let child_row = thread_row(&db, &child);
    assert_eq!(child_row.parent_id.as_deref(), Some(root.as_str()));
    assert_eq!((child_row.position, child_row.created_at), (0, now));
    assert_eq!(change.todos.len(), 1);
    let grandchild = add_line(&mut db, &project, Some(&child), "孙线");
    for (command, id, parent, error) in [
        (
            "create_thread",
            "",
            "missing",
            "找不到上级策略线，可能已被删除。",
        ),
        (
            "create_thread",
            "",
            other.as_str(),
            "上级策略线必须在同一个项目里。",
        ),
        (
            "update_thread",
            child.as_str(),
            "missing",
            "找不到上级策略线，可能已被删除。",
        ),
        (
            "update_thread",
            child.as_str(),
            other.as_str(),
            "上级策略线必须在同一个项目里。",
        ),
        (
            "update_thread",
            child.as_str(),
            child.as_str(),
            "不能把策略线放到它自己或它的子策略线下面。",
        ),
        (
            "update_thread",
            root.as_str(),
            grandchild.as_str(),
            "不能把策略线放到它自己或它的子策略线下面。",
        ),
    ] {
        let before = db.load();
        let error_actual = db
            .call(
                command,
                id,
                json!({"projectId":project,"parentId":parent,"title":"校验"}),
            )
            .unwrap_err();
        assert_eq!(error_actual.to_string(), error);
        assert_eq!(before, db.load());
    }
}

#[test]
fn reparent_uses_nullable_patch_sibling_positions_and_title_events() {
    let mut db = Database::new();
    let (_, project, root) = db.seed();
    let target = add_line(&mut db, &project, None, "新上级");
    let child = add_line(&mut db, &project, Some(&root), "子线");
    let grandchild = add_line(&mut db, &project, Some(&child), "孙线");
    let sibling = add_line(&mut db, &project, Some(&target), "目标同级");
    db.conn
        .execute("UPDATE threads SET position = 8 WHERE id = ?1", [&sibling])
        .unwrap();
    let before_root = thread_row(&db, &root);
    let before_grandchild = thread_row(&db, &grandchild);
    let now = chrono::Utc::now().timestamp_millis() + 1000;
    let change = db
        .call_at("update_thread", &child, json!({"parentId":target}), now)
        .unwrap();
    assert_thread_change(&change, &[&child, &target], now);
    assert_eq!(thread_row(&db, &child).position, 9);
    assert_eq!(thread_row(&db, &root), before_root);
    assert_eq!(thread_row(&db, &grandchild), before_grandchild);
    assert_eq!(
        serde_json::to_value(&change.entries[0].event).unwrap(),
        json!({"field":"parent","from":"反转研究","to":"新上级"})
    );
    let before = db.load();
    let change = db
        .call("update_thread", &child, json!({"parentId":target}))
        .unwrap();
    assert!(change.entries.is_empty());
    assert!(change.threads.is_empty());
    assert_eq!(db.load(), before);
    assert_eq!(thread_row(&db, &child).position, 9);
    db.call(
        "update_thread",
        &child,
        json!({"summary":"未提供 parentId"}),
    )
    .unwrap();
    assert_eq!(
        thread_row(&db, &child).parent_id.as_deref(),
        Some(target.as_str())
    );
    let change = db
        .call("update_thread", &child, json!({"parentId":null}))
        .unwrap();
    assert_eq!(thread_row(&db, &child).parent_id, None);
    assert_eq!(thread_row(&db, &child).position, 2);
    assert_eq!(
        serde_json::to_value(&change.entries[0].event).unwrap(),
        json!({"field":"parent","from":"新上级","to":null})
    );
    let change = db
        .call("update_thread", &child, json!({"parentId":root}))
        .unwrap();
    assert_eq!(
        serde_json::to_value(&change.entries[0].event).unwrap(),
        json!({"field":"parent","from":null,"to":"反转研究"})
    );
    let row = thread_row(&db, &grandchild);
    assert_eq!(row.parent_id.as_deref(), Some(child.as_str()));
}

#[test]
fn nested_reorder_requires_all_and_only_one_sibling_group() {
    let mut db = Database::new();
    let (org, project, root) = db.seed();
    let other = add_line(&mut db, &project, None, "另一根线");
    let a = add_line(&mut db, &project, Some(&root), "子线 A");
    let b = add_line(&mut db, &project, Some(&root), "子线 B");
    let c = add_line(&mut db, &project, Some(&other), "子线 C");
    assert_eq!(
        (
            thread_row(&db, &a).position,
            thread_row(&db, &b).position,
            thread_row(&db, &c).position
        ),
        (0, 1, 0)
    );
    let project2 = db
        .call("create_project", "", json!({"orgId":org,"name":"项目二"}))
        .unwrap()
        .projects[0]
        .id
        .clone();
    let root2 = add_line(&mut db, &project2, None, "项目二根线");
    for ids in [
        json!([]),
        json!([a]),
        json!([a, a]),
        json!([a, b, c]),
        json!([root, other, root2]),
        json!([a, b, "missing"]),
    ] {
        db.rejects("reorder", "thread", ids);
    }
    let now = chrono::Utc::now().timestamp_millis() + 1000;
    let change = db.call_at("reorder", "thread", json!([b, a]), now).unwrap();
    assert_thread_change(&change, &[&a, &b, &root], now);
    assert_eq!(
        (thread_row(&db, &a).position, thread_row(&db, &b).position),
        (1, 0)
    );
    let change = db.call_at("reorder", "thread", json!([b, a]), now).unwrap();
    assert_thread_change(&change, &[&a, &b, &root], now);
    db.call("reorder", "thread", json!([other, root])).unwrap();
    assert_eq!(
        (
            thread_row(&db, &other).position,
            thread_row(&db, &root).position
        ),
        (0, 1)
    );
}

#[test]
fn nested_activity_propagates_for_every_trigger_and_same_millisecond() {
    let mut db = Database::new();
    let (_, project, root) = db.seed();
    let child = add_line(&mut db, &project, Some(&root), "子线");
    let grandchild = add_line(&mut db, &project, Some(&child), "孙线");
    let unrelated = add_line(&mut db, &project, Some(&root), "旁支");
    let unrelated_before = thread_row(&db, &unrelated);
    let now = chrono::Utc::now().timestamp_millis() + 1000;
    let created = db
        .call_at(
            "create_thread",
            "",
            json!({"projectId":project,"parentId":grandchild,"title":"第四层"}),
            now,
        )
        .unwrap();
    let leaf = created.entries[0].thread_id.clone().unwrap();
    let chain = [&*root, &*child, &*grandchild, &*leaf];
    assert_thread_change(&created, &chain, now);
    let created = db
        .call_at(
            "create_thread",
            "",
            json!({"projectId":project,"parentId":grandchild,"title":"同毫秒创建"}),
            now,
        )
        .unwrap();
    let temporary = created.entries[0].thread_id.clone().unwrap();
    assert_thread_change(&created, &[&root, &child, &grandchild, &temporary], now);
    let deleted = db
        .call_at("delete", &temporary, json!("thread"), now)
        .unwrap();
    assert_thread_change(&deleted, &[&root, &child, &grandchild], now);
    let todo_change = db
        .call_at(
            "create_todo",
            "",
            json!({"threadId":leaf,"text":"待办"}),
            now,
        )
        .unwrap();
    assert_thread_change(&todo_change, &chain, now);
    let todo = todo_change.todos[0].id.clone();
    let entry_change = db
        .call_at(
            "create_entry",
            "",
            json!({"projectId":project,"threadId":leaf,"kind":"note","body":"笔记"}),
            now,
        )
        .unwrap();
    assert_thread_change(&entry_change, &chain, now);
    let entry = entry_change.entries[0].id.clone();
    for (command, id, input) in [
        ("update_thread", leaf.as_str(), json!({"hill":50})),
        ("update_todo", todo.as_str(), json!({"done":true})),
        ("update_entry", entry.as_str(), json!({"body":"编辑"})),
        ("reorder", "thread", json!([leaf])),
        ("reorder", "todo", json!([todo])),
        ("delete", todo.as_str(), json!("todo")),
    ] {
        let change = db.call_at(command, id, input, now).unwrap();
        assert_thread_change(&change, &chain, now);
    }
    let before = db.load().threads;
    let change = db
        .call_at("update_thread", &leaf, json!({"reviewed":true}), now + 1)
        .unwrap();
    assert_eq!(change.threads.len(), 1);
    assert_eq!(change.threads[0].reviewed_at, Some(now + 1));
    for row in db.load().threads {
        let old = before.iter().find(|t| t.id == row.id).unwrap();
        assert_eq!(
            (row.updated_at, row.last_activity_at),
            (old.updated_at, old.last_activity_at)
        );
    }
    let change = db
        .call_at(
            "update_thread",
            &leaf,
            json!({"reviewed":true,"summary":"复查并修改"}),
            now + 2,
        )
        .unwrap();
    assert_thread_change(&change, &chain, now + 2);
    let change = db
        .call_at("delete", &entry, json!("entry"), now + 3)
        .unwrap();
    assert!(change.threads.is_empty());
    assert_eq!(thread_row(&db, &unrelated), unrelated_before);
}

#[test]
fn closing_or_pausing_parent_leaves_descendants_unchanged() {
    let mut db = Database::new();
    let (_, project, root) = db.seed();
    let child = add_line(&mut db, &project, Some(&root), "子线");
    let leaf = add_line(&mut db, &project, Some(&child), "孙线");
    let child_before = thread_row(&db, &child);
    let leaf_before = thread_row(&db, &leaf);
    for state in ["closed", "paused"] {
        let change = db
            .call(
                "update_thread",
                &root,
                json!({"state":state,"stage":"retired"}),
            )
            .unwrap();
        assert_eq!(change.threads.len(), 1);
        assert_eq!(thread_row(&db, &child), child_before);
        assert_eq!(thread_row(&db, &leaf), leaf_before);
    }
}

#[test]
fn project_move_transfers_subtree_entries_and_only_touches_final_ancestors() {
    for explicit_parent in [false, true] {
        let mut db = Database::new();
        let (org, project, old_ancestor) = db.seed();
        let root = add_line(&mut db, &project, Some(&old_ancestor), "被移动根线");
        let child = add_line(&mut db, &project, Some(&root), "子线");
        let leaf = add_line(&mut db, &project, Some(&child), "孙线");
        let sibling = add_line(&mut db, &project, Some(&root), "并行子线");
        let moved_ids = [&*root, &*child, &*leaf, &*sibling];
        for id in moved_ids {
            db.call("create_todo", "", json!({"threadId":id,"text":"保留待办"}))
                .unwrap();
            db.call(
                "create_entry",
                "",
                json!({"projectId":project,"threadId":id,"kind":"note","body":"随迁笔记"}),
            )
            .unwrap();
        }
        let target_project = db
            .call("create_project", "", json!({"orgId":org,"name":"目标项目"}))
            .unwrap()
            .projects[0]
            .id
            .clone();
        let target_root = add_line(&mut db, &target_project, None, "目标根线");
        let target = add_line(&mut db, &target_project, Some(&target_root), "目标上级");
        add_line(&mut db, &target_project, Some(&target), "目标已有子线");
        db.rejects(
            "update_thread",
            &root,
            json!({"projectId":target_project,"parentId":old_ancestor}),
        );
        let before = db.load();
        let mut patch = json!({"projectId":target_project,"stage":"paper","state":"waiting"});
        if explicit_parent {
            patch["parentId"] = json!(target);
        }
        let now = chrono::Utc::now().timestamp_millis() + 1000;
        let change = db.call_at("update_thread", &root, patch, now).unwrap();
        let after = db.load();
        let mut expected_ids: HashSet<_> = moved_ids.into_iter().collect();
        if explicit_parent {
            expected_ids.extend([target.as_str(), target_root.as_str()]);
        }
        assert_eq!(
            change
                .threads
                .iter()
                .map(|t| t.id.as_str())
                .collect::<HashSet<_>>(),
            expected_ids
        );
        assert_eq!(
            thread_row(&db, &root).parent_id,
            explicit_parent.then(|| target.clone())
        );
        assert_eq!(thread_row(&db, &root).position, 1);
        for row in &after.threads {
            let old = before.threads.iter().find(|t| t.id == row.id).unwrap();
            if moved_ids.contains(&row.id.as_str()) {
                assert_eq!(row.project_id, target_project);
                assert_eq!(row.updated_at, now);
                if row.id == root {
                    assert_eq!(row.last_activity_at, now);
                } else {
                    assert_eq!(
                        (
                            &row.parent_id,
                            row.position,
                            row.last_activity_at,
                            &row.stage,
                            &row.state
                        ),
                        (
                            &old.parent_id,
                            old.position,
                            old.last_activity_at,
                            &old.stage,
                            &old.state
                        )
                    );
                }
            } else if explicit_parent
                && [target.as_str(), target_root.as_str()].contains(&row.id.as_str())
            {
                assert_eq!((row.updated_at, row.last_activity_at), (now, now));
            } else {
                assert_eq!(row, old);
            }
        }
        assert_eq!(after.todos, before.todos);
        for old in &before.entries {
            let row = after.entries.iter().find(|e| e.id == old.id).unwrap();
            if old
                .thread_id
                .as_deref()
                .is_some_and(|id| moved_ids.contains(&id))
            {
                assert_eq!(row.project_id, target_project);
                assert!(change.entries.contains(row));
                let mut expected = old.clone();
                expected.project_id.clone_from(&target_project);
                assert_eq!(row, &expected);
            } else {
                assert_eq!(row, old);
            }
        }
        let new_events: Vec<_> = change
            .entries
            .iter()
            .filter(|e| !before.entries.iter().any(|old| old.id == e.id))
            .collect();
        let root_events: Vec<_> = new_events
            .iter()
            .filter(|e| e.thread_id.as_deref() == Some(&root))
            .map(|e| e.event.as_ref().unwrap().field.as_str())
            .collect();
        assert_eq!(root_events, ["stage", "state", "project", "parent"]);
        for id in [&child, &leaf, &sibling] {
            let events: Vec<_> = new_events
                .iter()
                .filter(|e| e.thread_id.as_ref() == Some(id))
                .collect();
            assert_eq!(events.len(), 1);
            assert_eq!(
                serde_json::to_value(&events[0].event).unwrap(),
                json!({"field":"project","from":"隔夜策略","to":"目标项目"})
            );
        }
        let parent_event = new_events
            .iter()
            .find(|e| e.event.as_ref().unwrap().field == "parent")
            .unwrap();
        assert_eq!(
            serde_json::to_value(&parent_event.event).unwrap(),
            json!({"field":"parent","from":"反转研究","to":explicit_parent.then_some("目标上级")})
        );
        assert!(new_events.iter().all(|e| e.project_id == target_project));
        let mut client = serde_json::to_value(&before).unwrap();
        merge_client(&mut client, &serde_json::to_value(&change).unwrap());
        assert_workspace_rows_equal(&client, &serde_json::to_value(&after).unwrap());
        db.conn = store::open(db.path.parent().unwrap()).unwrap();
        assert_eq!(db.load(), after);
    }
}

#[test]
fn nested_delete_reports_subtree_and_refreshes_only_surviving_ancestor_chain() {
    let mut db = Database::new();
    let (_, project, root) = db.seed();
    let parent = add_line(&mut db, &project, Some(&root), "父线");
    let child = add_line(&mut db, &project, Some(&parent), "被删子线");
    let leaf = add_line(&mut db, &project, Some(&child), "被删孙线");
    let sibling = add_line(&mut db, &project, Some(&parent), "保留旁支");
    for id in [&child, &leaf] {
        db.call("create_todo", "", json!({"threadId":id,"text":"待办"}))
            .unwrap();
        db.call(
            "create_entry",
            "",
            json!({"projectId":project,"threadId":id,"kind":"note","body":"笔记"}),
        )
        .unwrap();
    }
    // Force the load order to disagree with the ancestry order.
    db.conn
        .execute("UPDATE threads SET position = 100 WHERE id = ?1", [&child])
        .unwrap();
    let before = db.load();
    let sibling_before = thread_row(&db, &sibling);
    let now = chrono::Utc::now().timestamp_millis() + 1000;
    let change = db.call_at("delete", &child, json!("thread"), now).unwrap();
    assert_thread_change(&change, &[&root, &parent], now);
    let mut expected: HashSet<_> = [child.clone(), leaf.clone()]
        .into_iter()
        .map(|id| ("thread".to_owned(), id))
        .collect();
    expected.extend(
        before
            .todos
            .iter()
            .filter(|t| [&child, &leaf].contains(&&t.thread_id))
            .map(|t| ("todo".to_owned(), t.id.clone())),
    );
    expected.extend(
        before
            .entries
            .iter()
            .filter(|e| {
                e.thread_id
                    .as_ref()
                    .is_some_and(|id| [&child, &leaf].contains(&id))
            })
            .map(|e| ("entry".to_owned(), e.id.clone())),
    );
    assert_eq!(
        change
            .deleted
            .iter()
            .map(|d| (d.kind.clone(), d.id.clone()))
            .collect::<HashSet<_>>(),
        expected
    );
    assert_eq!(change.deleted.len(), 8);
    assert_eq!(thread_row(&db, &sibling), sibling_before);
    let mut client = serde_json::to_value(&before).unwrap();
    merge_client(&mut client, &serde_json::to_value(&change).unwrap());
    assert_workspace_rows_equal(&client, &serde_json::to_value(db.load()).unwrap());
    let change = db.call("delete", &root, json!("thread")).unwrap();
    assert!(change.threads.is_empty());
    assert!(db.load().threads.is_empty());
}

fn nested_demo_seed(depth: usize) -> Value {
    let mut seed = demo_seed();
    let mut threads = vec![seed["threads"][0].clone()];
    for i in 1..depth {
        let mut row = threads[0].clone();
        row["id"] = json!(format!("demo-thread-{i}"));
        row["parentId"] = threads[i - 1]["id"].clone();
        row["position"] = json!(i % 3);
        threads.push(row);
    }
    threads.reverse();
    seed["threads"] = json!(threads);
    seed
}

#[test]
fn nested_demo_import_preserves_reversed_history_and_supports_deep_trees() {
    let mut db = Database::new();
    let seed = nested_demo_seed(500);
    let before = db.load();
    let change = db.call("import_demo_data", "", seed.clone()).unwrap();
    assert_eq!(
        serde_json::to_value(&change.threads).unwrap(),
        seed["threads"]
    );
    assert_eq!(serde_json::to_value(&change.todos).unwrap(), seed["todos"]);
    assert_eq!(
        serde_json::to_value(&change.entries).unwrap(),
        seed["entries"]
    );
    assert!(change.settings.is_none());
    assert_eq!(db.load().settings, before.settings);
    let mut client = serde_json::to_value(&before).unwrap();
    merge_client(&mut client, &serde_json::to_value(&change).unwrap());
    assert_workspace_rows_equal(&client, &serde_json::to_value(db.load()).unwrap());
    db.conn = store::open(db.path.parent().unwrap()).unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    let change = db
        .call_at("update_thread", "demo-thread-499", json!({"hill":55}), now)
        .unwrap();
    assert_eq!(change.threads.len(), 500);
    assert!(change
        .threads
        .iter()
        .all(|t| t.last_activity_at == now && t.updated_at == now));
    let before = db.load();
    let change = db.call("clear_demo_data", "", json!({})).unwrap();
    assert_eq!(
        change
            .deleted
            .iter()
            .map(|d| (d.kind.clone(), d.id.clone()))
            .collect::<HashSet<_>>(),
        row_ids(&before)
    );
    assert!(row_ids(&db.load()).is_empty());
}

#[test]
fn nested_demo_rejects_external_cross_project_self_and_cycle_references() {
    let mut db = Database::new();
    let (_, _, external) = db.seed();
    for (parent, error) in [
        ("missing", "找不到上级策略线，可能已被删除。"),
        (external.as_str(), "找不到上级策略线，可能已被删除。"),
        ("demo-thread", "不能把策略线放到它自己或它的子策略线下面。"),
        (
            "demo-thread-2",
            "不能把策略线放到它自己或它的子策略线下面。",
        ),
    ] {
        let mut seed = nested_demo_seed(3);
        seed["threads"][2]["parentId"] = json!(parent);
        let before = db.load();
        let actual = db.call("import_demo_data", "", seed).unwrap_err();
        assert_eq!(actual.to_string(), error);
        assert_eq!(db.load(), before);
    }
    let mut seed = nested_demo_seed(3);
    let mut project2 = seed["projects"][0].clone();
    project2["id"] = json!("project-2");
    seed["projects"].as_array_mut().unwrap().push(project2);
    seed["threads"][0]["projectId"] = json!("project-2");
    let before = db.load();
    let actual = db.call("import_demo_data", "", seed).unwrap_err();
    assert_eq!(actual.to_string(), "上级策略线必须在同一个项目里。");
    assert_eq!(db.load(), before);
}

#[test]
fn demo_parent_events_accept_nullable_titles_and_reject_invalid_payloads() {
    let mut db = Database::new();
    for (from, to) in [
        (None, Some("上级")),
        (Some("原上级"), None),
        (Some("同名上级"), Some("同名上级")),
        (Some("旧上级"), Some("新上级")),
    ] {
        let mut seed = nested_demo_seed(3);
        seed["entries"][0]["event"] = json!({"field":"parent","from":from,"to":to});
        let change = db.call("import_demo_data", "", seed.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(&change.entries[0]).unwrap(),
            seed["entries"][0]
        );
        db.call("clear_demo_data", "", json!({})).unwrap();
    }
    for patch in [
        json!({"event":{"field":"parent","from":null,"to":null}}),
        json!({"event":{"field":"parent","from":"", "to":"新上级"}}),
        json!({"event":{"field":"parent","from":null,"to":" x "}}),
        json!({"event":{"field":"parent","from":null,"to":"界".repeat(121)}}),
        json!({"event":{"field":"parent","from":"界".repeat(121),"to":null}}),
        json!({"threadId":null,"event":{"field":"parent","from":null,"to":"新上级"}}),
    ] {
        let mut seed = nested_demo_seed(3);
        for (key, value) in patch.as_object().unwrap() {
            seed["entries"][0][key] = value.clone();
        }
        db.rejects("import_demo_data", "", seed);
    }
}

#[test]
fn nested_project_organization_and_demo_deletes_preserve_moved_subtrees() {
    for kind in ["project", "organization", "demo"] {
        let mut db = Database::new();
        let (_, real_project, _) = db.seed();
        db.call("import_demo_data", "", nested_demo_seed(4))
            .unwrap();
        for id in ["demo-thread-1", "demo-thread-2", "demo-thread-3"] {
            db.call("create_todo", "", json!({"threadId":id,"text":"子线待办"}))
                .unwrap();
            db.call(
                "create_entry",
                "",
                json!({"projectId":"demo-project","threadId":id,"kind":"note","body":"子线笔记"}),
            )
            .unwrap();
        }
        let escaped = add_line(&mut db, "demo-project", Some("demo-thread"), "移出根线");
        let escaped_child = add_line(&mut db, "demo-project", Some(&escaped), "移出子线");
        db.call("update_thread", &escaped, json!({"projectId":real_project}))
            .unwrap();
        let before = db.load();
        let change = match kind {
            "project" => db.call("delete", "demo-project", json!("project")),
            "organization" => db.call("delete", "demo-org", json!("organization")),
            _ => db.call("clear_demo_data", "", json!({})),
        }
        .unwrap();
        let after = db.load();
        assert!(after.threads.iter().all(|t| t.project_id == real_project));
        assert!(after.threads.iter().any(|t| t.id == escaped));
        assert_eq!(
            thread_row(&db, &escaped_child).parent_id.as_deref(),
            Some(escaped.as_str())
        );
        assert_eq!(
            change
                .deleted
                .iter()
                .map(|d| (d.kind.clone(), d.id.clone()))
                .collect::<HashSet<_>>(),
            row_ids(&before)
                .difference(&row_ids(&after))
                .cloned()
                .collect()
        );
        assert!(change.threads.is_empty());
        for thread in &after.threads {
            assert_eq!(
                thread,
                before.threads.iter().find(|t| t.id == thread.id).unwrap()
            );
        }
        let mut client = serde_json::to_value(before).unwrap();
        merge_client(&mut client, &serde_json::to_value(change).unwrap());
        assert_workspace_rows_equal(&client, &serde_json::to_value(after).unwrap());
    }
}

#[test]
fn nested_mutations_roll_back_all_rows_on_sql_failure() {
    let mut db = Database::new();
    let (org, project, root) = db.seed();
    let child = add_line(&mut db, &project, Some(&root), "子线");
    let leaf = add_line(&mut db, &project, Some(&child), "孙线");
    let other = db
        .call("create_project", "", json!({"orgId":org,"name":"目标"}))
        .unwrap()
        .projects[0]
        .id
        .clone();
    db.conn.execute_batch("CREATE TRIGGER fail_event BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, '模拟事件失败'); END;").unwrap();
    db.rejects("update_thread", &child, json!({"projectId":other}));
    db.rejects("update_thread", &child, json!({"parentId":null}));
    db.rejects(
        "create_thread",
        "",
        json!({"projectId":project,"parentId":child,"title":"失败子线"}),
    );
    db.conn.execute_batch("DROP TRIGGER fail_event;").unwrap();
    db.conn.execute(&format!("CREATE TRIGGER fail_delete BEFORE DELETE ON threads WHEN OLD.id = '{leaf}' BEGIN SELECT RAISE(ABORT, '模拟删除失败'); END;"), []).unwrap();
    db.rejects("delete", &child, json!("thread"));
    db.rejects("delete", &project, json!("project"));
    db.rejects("delete", &org, json!("organization"));
    db.conn.execute_batch("DROP TRIGGER fail_delete;").unwrap();
    db.conn.execute_batch("CREATE TRIGGER fail_import BEFORE INSERT ON threads WHEN NEW.parent_id IS NOT NULL BEGIN SELECT RAISE(ABORT, '模拟子线写入失败'); END;").unwrap();
    db.rejects("import_demo_data", "", nested_demo_seed(3));
    db.conn.execute_batch("DROP TRIGGER fail_import;").unwrap();
    db.call("import_demo_data", "", nested_demo_seed(3))
        .unwrap();
    db.conn.execute_batch("CREATE TRIGGER fail_clear BEFORE DELETE ON threads WHEN OLD.id = 'demo-thread' BEGIN SELECT RAISE(ABORT, '模拟清理失败'); END;").unwrap();
    db.rejects("clear_demo_data", "", json!({}));
}

fn merge_client(client: &mut Value, change: &Value) {
    for collection in ["organizations", "projects", "threads", "todos", "entries"] {
        if let Some(rows) = change[collection].as_array() {
            let current = client[collection].as_array_mut().unwrap();
            for row in rows {
                if let Some(index) = current.iter().position(|r| r["id"] == row["id"]) {
                    current[index] = row.clone();
                } else {
                    current.push(row.clone());
                }
            }
        }
    }
    if let Some(deleted) = change["deleted"].as_array() {
        for row in deleted {
            let collection = collection_name(row["kind"].as_str().unwrap());
            client[collection]
                .as_array_mut()
                .unwrap()
                .retain(|r| r["id"] != row["id"]);
        }
    }
    if change.get("settings").is_some() {
        client["settings"] = change["settings"].clone();
    }
}

fn assert_workspace_rows_equal(left: &Value, right: &Value) {
    let normalize = |value: &Value| {
        let mut value = value.clone();
        for collection in ["organizations", "projects", "threads", "todos", "entries"] {
            value[collection]
                .as_array_mut()
                .unwrap()
                .sort_by_key(|v| v["id"].as_str().unwrap().to_owned());
        }
        value
    };
    assert_eq!(normalize(left), normalize(right));
}

fn collection_name(kind: &str) -> String {
    if kind == "entry" {
        "entries".into()
    } else {
        format!("{kind}s")
    }
}

fn image_samples() -> Vec<(&'static [u8], &'static str, &'static str)> {
    vec![
        (b"\x89PNG\r\n\x1a\n\0\xff.jpg", "png", "image/png"),
        (b"\xff\xd8\xff\0.png", "jpg", "image/jpeg"),
        (b"GIF87a\0\xff.webp", "gif", "image/gif"),
        (b"GIF89a\0\xff.jpg", "gif", "image/gif"),
        (b"RIFF\x08\0\0\0WEBP\0\xff.gif", "webp", "image/webp"),
    ]
}

#[test]
fn images_save_headers_and_read_exact_bytes_without_database() {
    let scratch = Scratch::new();
    let path = scratch.0.join("threading.db");
    let mut names = HashSet::new();
    for (bytes, ext, mime) in image_samples() {
        let reference = images::save(&path, &STANDARD.encode(bytes)).unwrap();
        let (uuid, actual_ext) = reference.id.split_once('.').unwrap();
        let parsed = uuid::Uuid::parse_str(uuid).unwrap();
        assert_eq!(parsed.get_version_num(), 4);
        assert_eq!(parsed.hyphenated().to_string(), uuid);
        assert_eq!(actual_ext, ext);
        assert_eq!(reference.mime, mime);
        assert_eq!(reference.size, bytes.len());
        assert_eq!(images::read(&path, &reference.id).unwrap(), bytes);
        assert_eq!(
            fs::read(scratch.0.join("images").join(&reference.id)).unwrap(),
            bytes
        );
        assert!(names.insert(reference.id));
        // Repeated saves create new immutable files, including with omitted padding.
        let repeated = images::save(&path, STANDARD.encode(bytes).trim_end_matches('=')).unwrap();
        assert!(names.insert(repeated.id));
    }
    let actual: HashSet<_> = fs::read_dir(scratch.0.join("images"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(actual, names);
    assert!(!path.exists());
}

#[test]
fn images_reject_bad_base64_empty_and_unsupported_headers() {
    let scratch = Scratch::new();
    let path = scratch.0.join("threading.db");
    for data in [
        "!",
        "a",
        "Zg===",
        "Zh==",
        "=Zg=",
        "_9j_",
        "data:image/png;base64,iVBORw==",
        "R0lGODdh\n",
        " R0lGODdh",
        "R0lGODdh ",
    ] {
        assert_eq!(
            images::save(&path, data).unwrap_err(),
            "图片数据无法读取。",
            "{data:?}"
        );
    }
    assert_eq!(images::save(&path, "").unwrap_err(), "图片是空的。");
    for bytes in [
        b"ordinary.png".as_slice(),
        b"\x89PNG\r\n\x1a",
        b"\xff\xd8",
        b"GIF88a",
        b"RIFF\0\0\0\0WEB",
        b"RIFF\0\0\0\0WAVE",
        b"xxxx\0\0\0\0WEBP",
        b"<svg></svg>",
    ] {
        assert_eq!(
            images::save(&path, &STANDARD.encode(bytes)).unwrap_err(),
            "只支持 PNG、JPEG、GIF 和 WebP 图片。"
        );
    }
    assert!(!scratch.0.join("images").exists());
}

#[test]
fn images_enforce_exact_ten_mb_decoded_boundary() {
    let scratch = Scratch::new();
    let path = scratch.0.join("threading.db");
    let mut bytes = vec![0; 10 * 1024 * 1024 - 1];
    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    for _ in 0..2 {
        let reference = images::save(&path, &STANDARD.encode(&bytes)).unwrap();
        assert_eq!(reference.size, bytes.len());
        assert_eq!(images::read(&path, &reference.id).unwrap(), bytes);
        bytes.push(0);
    }
    assert_eq!(
        images::save(&path, &STANDARD.encode(bytes)).unwrap_err(),
        "图片不能超过 10 MB。"
    );
    assert_eq!(fs::read_dir(scratch.0.join("images")).unwrap().count(), 2);
}

#[test]
fn images_reject_noncanonical_ids_before_filesystem_access() {
    let scratch = Scratch::new();
    let path = scratch.0.join("threading.db");
    let reference = images::save(&path, &STANDARD.encode(b"GIF89a")).unwrap();
    let id = &reference.id;
    let invalid = vec![
        String::new(),
        "..".into(),
        format!("../{id}"),
        format!("..\\{id}"),
        format!("images/{id}"),
        format!("images\\{id}"),
        format!("/{id}"),
        format!("C:{id}"),
        format!("C:\\{id}"),
        format!("\\\\server\\share\\{id}"),
        id.to_uppercase(),
        id.replace(".gif", ".GIF"),
        format!(" {id}"),
        format!("{id} "),
        format!("{id}\n"),
        format!("{id}\r\n"),
        format!("{id}\0"),
        format!("{id}.png"),
        id.replace('-', ""),
        id.replace('-', "_"),
        id.replace(".gif", ".jpeg"),
        id.replace(".gif", ".svg"),
        format!("g{}", &id[1..]),
        format!("é{}", &id[1..]),
        format!("%2e%2e%2f{id}"),
        format!("{id}:stream"),
        format!("{id}."),
    ];
    for invalid_id in invalid {
        assert_eq!(
            images::read(&path, &invalid_id).unwrap_err(),
            "图片地址无效。",
            "{invalid_id:?}"
        );
    }
    // Read validation follows the regex, not a stricter UUID version/variant parser.
    let zero_id = "00000000-0000-0000-0000-000000000000.png";
    assert_eq!(
        images::read(&path, zero_id).unwrap_err(),
        "找不到这张图片，可能已被删除。"
    );
    fs::write(scratch.0.join("images").join(zero_id), b"existing").unwrap();
    assert_eq!(images::read(&path, zero_id).unwrap(), b"existing");
    fs::remove_file(scratch.0.join("images").join(id)).unwrap();
    assert_eq!(
        images::read(&path, id).unwrap_err(),
        "找不到这张图片，可能已被删除。"
    );
}

#[test]
fn images_io_failures_clean_temporary_files() {
    let scratch = Scratch::new();
    let path = scratch.0.join("threading.db");
    let dir = scratch.0.join("images");
    fs::write(&dir, b"blocked").unwrap();
    assert_eq!(
        images::save(&path, &STANDARD.encode(b"GIF89a")).unwrap_err(),
        "无法保存图片。"
    );
    assert_eq!(fs::read(&dir).unwrap(), b"blocked");
    fs::remove_file(&dir).unwrap();
    fs::create_dir(&dir).unwrap();
    let id = "00000000-0000-0000-0000-000000000000.png";
    let destination = dir.join(id);
    fs::create_dir(&destination).unwrap();
    // A directory at the destination forces failure after the temporary file is synced.
    assert!(images::write_image(&destination, b"GIF89a").is_err());
    assert!(destination.is_dir());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    assert_eq!(images::read(&path, id).unwrap_err(), "图片数据无法读取。");
}

#[test]
fn images_survive_record_deletions_and_demo_cleanup() {
    let mut db = Database::new();
    let (org, project, thread) = db.seed();
    let before = db.load();
    let bytes = b"GIF89a\0\xff";
    let reference = images::save(&db.path, &STANDARD.encode(bytes)).unwrap();
    assert_eq!(db.load(), before);
    let entry = db
        .call(
            "create_entry",
            "",
            json!({
                "projectId": project, "threadId": thread, "kind": "note",
                "body": format!("![说明](attachment:{})", reference.id),
            }),
        )
        .unwrap()
        .entries[0]
        .id
        .clone();
    db.call("delete", &entry, json!("entry")).unwrap();
    db.call("delete", &thread, json!("thread")).unwrap();
    db.call("delete", &org, json!("organization")).unwrap();
    db.call("import_demo_data", "", demo_seed()).unwrap();
    db.call("clear_demo_data", "", json!({})).unwrap();
    assert_eq!(images::read(&db.path, &reference.id).unwrap(), bytes);
}

#[test]
fn image_ipc_returns_raw_bytes_without_acquiring_database_lock() {
    let scratch = Scratch::new();
    let path = scratch.0.join("threading.db");
    let connection = Arc::new(Mutex::new(Connection::open_in_memory().unwrap()));
    let app = tauri::test::mock_builder()
        .manage(crate::AppState {
            connection: Arc::clone(&connection),
            data_path: path.clone(),
        })
        .invoke_handler(crate::command_handler())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let invoke = |cmd: &str, body: Value| {
        tauri::test::get_ipc_response(
            &window,
            tauri::webview::InvokeRequest {
                cmd: cmd.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "http://tauri.localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
        )
    };
    let _guard = connection.lock().unwrap();
    for (bytes, ext, mime) in image_samples() {
        let reference: ImageRef = invoke("save_image", json!({"data": STANDARD.encode(bytes)}))
            .unwrap()
            .deserialize()
            .unwrap();
        assert!(reference.id.ends_with(&format!(".{ext}")));
        assert_eq!(reference.mime, mime);
        assert_eq!(reference.size, bytes.len());
        match invoke("read_image", json!({"id": reference.id})).unwrap() {
            tauri::ipc::InvokeResponseBody::Raw(actual) => assert_eq!(actual, bytes),
            tauri::ipc::InvokeResponseBody::Json(_) => panic!("read_image 必须返回原始字节"),
        }
    }
    for (data, expected) in [
        ("!", "图片数据无法读取。"),
        ("", "图片是空的。"),
        ("aGVsbG8=", "只支持 PNG、JPEG、GIF 和 WebP 图片。"),
    ] {
        assert_eq!(
            invoke("save_image", json!({"data":data})).unwrap_err(),
            json!(expected)
        );
    }
    assert_eq!(
        invoke(
            "save_image",
            json!({"data":STANDARD.encode(vec![0; 10 * 1024 * 1024 + 1])})
        )
        .unwrap_err(),
        json!("图片不能超过 10 MB。")
    );
    assert_eq!(
        invoke("read_image", json!({"id":"../threading.db"})).unwrap_err(),
        json!("图片地址无效。")
    );
    assert_eq!(
        invoke(
            "read_image",
            json!({"id":"00000000-0000-0000-0000-000000000000.png"})
        )
        .unwrap_err(),
        json!("找不到这张图片，可能已被删除。")
    );
    assert_eq!(fs::read_dir(scratch.0.join("images")).unwrap().count(), 5);
    assert!(!path.exists());
}

#[test]
fn image_csp_matches_contract() {
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    assert_eq!(config["app"]["security"]["csp"], "default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' asset: http://asset.localhost data: blob: https:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'self'");
}
