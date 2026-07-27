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

/// Connection status for a connector, surfaced to the Settings → Connectors UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorStatus {
    pub connected: bool,
    /// True when the stored access token's `expires_at` has passed (the MCP
    /// client will attempt a transparent refresh on next use; if no refresh
    /// token exists — Notion — the user must reconnect).
    pub expired: bool,
    pub account_display: Option<String>,
    pub granted_scopes: Option<String>,
    pub expires_at: Option<i64>,
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
    /// Starred chats are pinned to the top of the sidebar list.
    #[serde(default)]
    pub starred: bool,
    /// Marked-unread chats show an unread dot in the sidebar.
    #[serde(default)]
    pub unread: bool,
    /// Per-session permission posture for filesystem tool calls
    /// (`read_only` | `manual` | `auto_edit` | `full_auto`). New sessions
    /// default to `manual`. See `chat::permission::PermissionMode`.
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    /// Per-session watch-mode pacing override. None = inherit global setting;
    /// otherwise `"on"` | `"off"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_mode: Option<String>,
}

/// The serde default for `ChatSession::permission_mode` — `manual`, the safe
/// posture every new chat starts in.
fn default_permission_mode() -> String {
    "manual".to_string()
}

/// A file attached to a chat message from the composer. Images are forwarded
/// to the model as vision input; documents (docx/pptx/xlsx) are extracted to
/// text server-side; plain-text files carry their decoded text directly.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachmentInput {
    pub name: String,
    /// "image" | "text" | "doc".
    pub kind: String,
    /// Decoded text for `kind == "text"`.
    #[serde(default)]
    pub text: Option<String>,
    /// Base64 bytes for `kind == "image"` or `kind == "doc"` (no data: prefix).
    #[serde(default)]
    pub data: Option<String>,
    /// MIME type for images, e.g. "image/png".
    #[serde(default)]
    pub media_type: Option<String>,
    /// File extension/format for docs, e.g. "docx", "pptx", "xlsx", "pdf".
    #[serde(default)]
    pub format: Option<String>,
}

/// A generated artifact (file/diagram) surfaced in the Artifacts sidebar.
/// Persisted so it survives restarts; auto-deleted after 30 days.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub id: String,
    pub chat_session_id: Option<String>,
    /// The assistant message this artifact was produced by, set once that turn
    /// completes. Lets the chat re-attach artifacts to their message bubble
    /// (inline diagrams / file chips) when a session is reopened.
    pub chat_message_id: Option<i64>,
    pub filename: String,
    pub path: String,
    /// Lowercase file extension: "docx" | "pptx" | "pdf" | "xlsx" | "html" | ...
    pub kind: String,
    pub created_at: i64,
    pub expires_at: i64,
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

/// One recorded fact/claim a research turn extracted from a single source page.
/// Accumulated in the `chat_source_notes` table during the Execute phase and
/// read back via `get_source_ledger` during Synthesis. `unavailable` carries
/// the `browser_read` `failureReason` ("paywalled" / "login_required" /
/// "extraction_failed" / "blocked") when the source could not be read, so the
/// final Sources section can surface "consulted, unavailable" gaps honestly
/// rather than implying coverage was complete.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceNote {
    pub id: i64,
    pub chat_session_id: String,
    pub url: String,
    pub title: String,
    /// One concrete fact extracted from the source (a sentence, not a paragraph).
    pub fact: String,
    /// A short verbatim quote supporting `fact`. Stored at extraction time so
    /// synthesis works from real excerpts, not paraphrases.
    pub excerpt: String,
    /// `None` when the source was usable; otherwise the failure reason string.
    pub unavailable: Option<String>,
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

/// Emitted when the `open_url` tool asks the UI to show a page in the
/// built-in browser pane.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOpenBrowserPayload {
    pub chat_session_id: String,
    pub url: String,
}

/// Emitted when a filesystem tool call needs per-action approval (the central
/// `check_permission` gate returned `NeedsApproval`). The UI renders an
/// approval card; the user's choice is sent back via `resolve_tool_action`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatApprovalRequestPayload {
    pub chat_session_id: String,
    /// The synthetic id of the pending approval — pass to `resolve_tool_action`.
    pub pending_id: String,
    /// Tool name (e.g. "write_file").
    pub tool: String,
    /// A short human-facing summary of the action (e.g. "write → C:/…/f.txt").
    pub summary: String,
    /// The verbatim JSON arguments the model produced, for display/audit.
    pub args: serde_json::Value,
}

/// Emitted when the user has resolved a pending approval card (so the UI can
/// dismiss the card). Carries the outcome — `approved` ran the tool, a denied
/// card returned a "user denied" tool result instead.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatApprovalResolvedPayload {
    pub chat_session_id: String,
    pub pending_id: String,
    pub approved: bool,
}

/// In-app preview of a generated artifact file (see `read_artifact_preview`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactPreview {
    pub path: String,
    pub filename: String,
    pub ext: String,
    /// text | markdown | csv | json | html | diagram | code | image | pdf | office | binary
    pub kind: String,
    /// Present for text-like kinds (text/markdown/csv/json/html/code/office/diagram).
    pub text: Option<String>,
    /// `data:` URI present for image/pdf kinds.
    pub data_uri: Option<String>,
    pub size: u64,
    pub truncated: bool,
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

// ---- Local models (GGUF scan / sidecar status) ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GgufModel {
    pub id: String,
    pub path: String,
    pub filename: String,
    pub size_bytes: u64,
    pub name: Option<String>,
    pub architecture: Option<String>,
    pub param_count_label: Option<String>,
    pub quantization: Option<String>,
    pub memory_class: String,
    pub source: String,
    /// Whether the model has a companion mmproj (vision projector) GGUF,
    /// making it capable of image (vision) input.
    pub has_vision: bool,
    /// Absolute path to the companion mmproj GGUF, if found.
    pub mmproj_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedModel {
    pub model_id: String,
    pub port: u16,
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveLocalModel {
    pub model_id: String,
    pub port: u16,
    pub base_url: String,
}

/// Saved workspace (pane layout snapshot). See db/workspaces.rs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub data: String, // JSON blob with full workspace state
    pub created_at: i64,
    pub updated_at: i64,
}
