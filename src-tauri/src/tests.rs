use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use anyhow::Result;
use chrono::NaiveDate;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::{backup, decode, models::*, store};

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
        store::transact(&mut self.conn, &self.path, |w, now| match command {
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
        1
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
    db.conn.pragma_update(None, "user_version", 2).unwrap();
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
    mutate(
        "update_settings",
        json!({"patch":{"staleDays":10,"wipLimit":0}}),
    );
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
