use serde::{Deserialize, Deserializer, Serialize};

// Nullable patches must distinguish an omitted field from an explicit null.
fn nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub id: String,
    pub name: String,
    pub code: String,
    pub color: String,
    pub note: String,
    pub archived: bool,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub goal: String,
    pub status: String,
    pub health: String,
    pub target_date: Option<String>,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Metric {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub summary: String,
    pub stage: String,
    pub state: String,
    pub priority: String,
    pub hill: i64,
    pub waiting_on: String,
    pub waiting_since: Option<i64>,
    pub tags: Vec<String>,
    pub metrics: Vec<Metric>,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_activity_at: i64,
    pub reviewed_at: Option<i64>,
    pub closed_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub thread_id: String,
    pub text: String,
    pub due: Option<String>,
    pub done: bool,
    pub done_at: Option<i64>,
    pub position: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntryEvent {
    pub field: String,
    pub from: Option<String>,
    pub to: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub project_id: String,
    pub thread_id: Option<String>,
    pub kind: String,
    pub body: String,
    pub health: Option<String>,
    pub event: Option<EntryEvent>,
    pub created_at: i64,
    pub edited_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub stale_days: i64,
    pub wip_limit: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub organizations: Vec<Organization>,
    pub projects: Vec<Project>,
    pub threads: Vec<Thread>,
    pub todos: Vec<Todo>,
    pub entries: Vec<Entry>,
    pub settings: Settings,
    pub data_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Deleted {
    pub kind: String,
    pub id: String,
}

#[derive(Default, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub organizations: Vec<Organization>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<Project>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub threads: Vec<Thread>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub todos: Vec<Todo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<Entry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<Settings>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deleted: Vec<Deleted>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationInput {
    pub name: String,
    pub code: Option<String>,
    pub color: Option<String>,
    pub note: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationPatch {
    pub name: Option<String>,
    pub code: Option<String>,
    pub color: Option<String>,
    pub note: Option<String>,
    pub archived: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    pub org_id: String,
    pub name: String,
    pub goal: Option<String>,
    pub status: Option<String>,
    pub health: Option<String>,
    pub target_date: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatch {
    pub org_id: Option<String>,
    pub name: Option<String>,
    pub goal: Option<String>,
    pub status: Option<String>,
    pub health: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub target_date: Option<Option<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInput {
    pub project_id: String,
    pub title: String,
    pub summary: Option<String>,
    pub stage: Option<String>,
    pub state: Option<String>,
    pub priority: Option<String>,
    pub tags: Option<Vec<String>>,
    pub next_action: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadPatch {
    pub project_id: Option<String>,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub stage: Option<String>,
    pub state: Option<String>,
    pub priority: Option<String>,
    pub hill: Option<i64>,
    pub waiting_on: Option<String>,
    pub tags: Option<Vec<String>>,
    pub metrics: Option<Vec<Metric>>,
    pub reviewed: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoInput {
    pub thread_id: String,
    pub text: String,
    pub due: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoPatch {
    pub text: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub due: Option<Option<String>>,
    pub done: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    pub project_id: String,
    pub thread_id: Option<String>,
    pub kind: String,
    pub body: String,
    #[serde(default, deserialize_with = "nullable")]
    pub health: Option<Option<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryPatch {
    pub body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub stale_days: Option<i64>,
    pub wip_limit: Option<i64>,
}
