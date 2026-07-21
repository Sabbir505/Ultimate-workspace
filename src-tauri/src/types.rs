//! IPC types shared with the frontend.
//!
//! Every struct here serializes with camelCase field names — this is a hard
//! requirement of CONTRACT.md; the frontend is written against those exact
//! field names and any rename silently breaks IPC.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub path: String,
    pub name: String,
    pub is_git_repo: bool,
    pub created_at: i64,
    pub last_opened_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub project_id: String,
    pub harness: String,
    pub harness_session_id: Option<String>,
    pub title: Option<String>,
    pub worktree_path: Option<String>,
    pub created_at: i64,
    pub last_active_at: i64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    pub id: String,
    pub display_name: String,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusInfo {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub dirty: bool,
    pub ahead: i64,
    pub behind: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub slash_command: String,
    pub content: String,
    pub scope: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickAction {
    pub id: String,
    pub project_id: String,
    pub label: String,
    pub command: String,
    pub keybinding: Option<String>,
    pub run_on_worktree: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostEvent {
    pub id: i64,
    pub session_id: String,
    pub timestamp: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub estimated_cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCostRollup {
    pub project_id: String,
    pub total_cost_usd: f64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyCost {
    pub day: String, // 'YYYY-MM-DD' (SQLite date(timestamp,'unixepoch'))
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostRollups {
    pub per_project: Vec<ProjectCostRollup>,
    pub daily: Vec<DailyCost>,
}

// ---- Event payloads (backend -> frontend, CONTRACT.md "Events") ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigatedEvent {
    pub pane_id: String,
    pub tab_id: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserUrlDetectedEvent {
    /// The terminal pane that produced this URL.
    pub pane_id: String,
    /// URL detected in the CLI agent's output.
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputEvent {
    pub pane_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExitEvent {
    pub pane_id: String,
    pub code: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyStateEvent {
    pub pane_id: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHarnessIdEvent {
    pub session_id: String,
    pub harness_session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostUpdatedEvent {
    pub session_id: String,
}

// ---- Chat types (CONTRACT.md "Chat" section) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub id: String,
    pub title: Option<String>,
    pub provider: String,
    pub model: String,
    pub created_at: i64,
    pub last_active_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageRecord {
    pub id: i64,
    pub chat_session_id: String,
    pub role: String,
    pub content: String,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTokenPayload {
    pub chat_session_id: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDonePayload {
    pub chat_session_id: String,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatArtifactPayload {
    pub chat_session_id: String,
    pub path: String,
    pub filename: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatErrorPayload {
    pub chat_session_id: String,
    pub message: String,
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConfigPayload {
    pub provider: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    /// True when an API key is stored in the keychain for this provider.
    /// Lets the API Keys panel enable Save for model-only updates without
    /// re-entering the key. The key VALUE is never returned over IPC.
    pub has_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModel {
    pub id: String,
    pub object: String,
    pub created: i64,
    pub owned_by: String,
}
