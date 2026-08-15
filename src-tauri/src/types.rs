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
    pub provider: Option<String>,
    pub model_key: Option<String>,
    pub source: String,
    pub cache_creation_input_tokens: Option<i64>,
    pub cache_read_input_tokens: Option<i64>,
    pub reasoning_output_tokens: Option<i64>,
    pub reported_cost_usd: Option<f64>,
    pub pricing_estimated_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCostRollup {
    pub project_id: String,
    pub total_cost_usd: f64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DailyCost {
    pub day: String, // 'YYYY-MM-DD' (SQLite date(timestamp,'unixepoch'))
    pub cost_usd: f64,
    pub tokens_by_provider: std::collections::BTreeMap<String, i64>,
    /// Per-provider cost for the stacked area chart (cost mode).
    pub cost_by_provider: std::collections::BTreeMap<String, f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostRollups {
    pub totals: CostTotals,
    pub per_provider: Vec<ProviderCostRollup>,
    pub daily: Vec<DailyCost>,
    pub by_kind: CostByKind,
    pub per_model: Vec<ModelCostRollup>,
    pub cost_quality: CostQuality,
    pub per_project: Vec<ProjectCostRollup>,
    pub range_start: String,
    pub range_end: String,
    pub range_days: u32,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostTotals {
    pub raw_token_cost_usd: f64,
    pub provider_reported_usd: f64,
    pub estimated_usd: f64,
    pub unpriced_usd: f64,
    /// Internal accumulator used by get_cost_rollups_v2; not part of the
    /// public IPC contract (the real cache-savings figure is on CostQuality).
    #[serde(skip)]
    pub cache_savings_usd_via_helper: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCostRollup {
    pub provider: String,
    pub cost_usd: f64,
    pub tokens: i64,
    pub share_pct: f64,
}


#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostByKind {
    pub processed_tokens: i64,
    pub cached_input_tokens: i64,
    pub uncached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub sessions: i64,
    pub responses: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelCostRollup {
    pub model_key: String,
    pub display_name: String,
    pub cost_usd: f64,
    pub share_pct: f64,
    pub tokens: i64,
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostQuality {
    pub provider_reported_pct: f64,
    pub model_priced_pct: f64,
    pub unpriced_pct: f64,
    pub cache_savings_usd: f64,
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
    /// Schema version of the payload. 1 = legacy `{ sessionId }`; 2 = current
    /// (adds `totals`, `byKind`, `costQuality` blocks on the rollup endpoint).
    /// Old mobile clients ignore the version field; the value lets the mobile
    /// UI detect the new shape and degrade gracefully.
    pub version: u32,
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
    /// Per-session watch-mode pacing override. None = inherit global setting;
    /// otherwise `"on"` | `"off"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_mode: Option<String>,
    /// Per-session agent selection from the composer's agent-then-model
    /// selector. `None` = no agent picked yet (fresh chats — the model chip
    /// stays locked and Send is disabled until one is chosen). Values:
    /// `"builtin"` (direct cloud API chat), `"local"` (bundled GGUF via
    /// llama-server), or `"harness:<id>"` (a CLI agent, e.g.
    /// `"harness:claude_code"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Bound project id. `None` = project-less chat (the legacy default);
    /// otherwise a `projects.id`. Drives which project's harness bundle the
    /// chat spawns into, which skills catalog it sees, and where artifacts
    /// land. Bind/unbind is a Tauri command (`set_chat_session_project`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

/// One hit from `search_chat_messages` (command palette "Chats" section).
/// `message_id`/`snippet`/`role` are `None` for title-only matches — the
/// session title matched the query, not a specific message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSearchResult {
    pub chat_session_id: String,
    pub session_title: Option<String>,
    pub message_id: Option<i64>,
    /// Short plain-text excerpt around the match (no highlight markers).
    pub snippet: Option<String>,
    pub role: Option<String>,
    /// Message `created_at` for content hits; session `last_active_at` for
    /// title-only hits.
    pub created_at: i64,
    pub last_active_at: i64,
}

/// One file entry in a checkpoint's changed-files list. `status` is a git
/// name-status letter: A / M / D.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFile {
    pub path: String,
    pub status: String,
}

/// A per-turn git working-tree snapshot (see `refs/conduit/checkpoints/…`).
/// `message_id` is the assistant message the checkpoint follows; `None` for
/// turn-start baselines and pre-restore safety snapshots.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCheckpoint {
    pub id: i64,
    pub chat_session_id: String,
    pub message_id: Option<i64>,
    /// Hidden git ref backing this checkpoint (empty if ref creation failed).
    pub ref_name: String,
    /// Tree object sha — snapshot identity, used for changed-nothing dedup.
    pub tree_sha: String,
    /// Absolute path of the repo the snapshot was taken in.
    pub repo_path: String,
    /// Files changed vs the session's previous checkpoint (empty for the
    /// baseline and when the diff failed — the restore still works).
    pub files: Vec<CheckpointFile>,
    pub created_at: i64,
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
    /// Non-null only for turns folded into a `[compacted context]` summary row
    /// by the local-model context-compaction framework. Points at the summary
    /// row's `id`. The send path excludes superseded rows; the UI timeline
    /// still lists them behind the compaction marker.
    #[serde(default)]
    pub superseded_by: Option<i64>,
    #[serde(default)]
    pub cache_creation_input_tokens: Option<i64>,
    #[serde(default)]
    pub cache_read_input_tokens: Option<i64>,
    #[serde(default)]
    pub reasoning_output_tokens: Option<i64>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model_key: Option<String>,
    #[serde(default)]
    pub pricing_estimated_usd: Option<f64>,
    /// Wall-clock window of the turn that produced this row (assistant only),
    /// in Unix seconds. `started_at` is captured when streaming begins and
    /// `completed_at` when the reply is persisted; the UI shows "Worked for
    /// Xs" from the difference. Both are `None` for user/system rows, for
    /// legacy rows predating the columns, and when the start instant is
    /// unknown (e.g. a partial message persisted on abort).
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub completed_at: Option<i64>,
    /// Perf metrics persisted per assistant turn. `llm_time_ms`/`tool_time_ms`
    /// are cumulative generation/execution windows; `ttft_ms` is time-to-first-
    /// token; `tokens_per_second` is generation speed. All `None` for legacy
    /// rows and for turns that predated the instrumentation. Cache hit rate is
    /// derived from usage in `ChatDonePayload`, not persisted here (raw cache
    /// token counts already are).
    #[serde(default)]
    pub llm_time_ms: Option<i64>,
    #[serde(default)]
    pub tool_time_ms: Option<i64>,
    #[serde(default)]
    pub ttft_ms: Option<i64>,
    #[serde(default)]
    pub tokens_per_second: Option<f64>,
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

/// A pre-token status notice for a streaming turn — emitted before the first
/// token to tell the frontend *why* it is waiting (e.g. a local model is
/// cold-starting after an app restart, so the wait can be tens of seconds).
/// The frontend shows this as a subtle loading line in place of the generic
/// thinking dots until the first `chat:token` arrives.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStatusPayload {
    pub chat_session_id: String,
    /// Machine-readable reason tag: "local_model_loading" | "thinking".
    pub reason: String,
    /// Human-facing line shown next to the spinner.
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDonePayload {
    pub chat_session_id: String,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    /// Cumulative wall-clock the model spent actively generating text (ms).
    #[serde(default)]
    pub llm_time_ms: Option<i64>,
    /// Cumulative wall-clock spent executing tools (ms), excluding approval waits.
    #[serde(default)]
    pub tool_time_ms: Option<i64>,
    /// Time from turn start to the first emitted token (ms).
    #[serde(default)]
    pub ttft_ms: Option<i64>,
    /// Generation speed = output_tokens / llm_time_ms (tokens per second).
    #[serde(default)]
    pub tokens_per_second: Option<f64>,
    /// Prompt/KV-cache hit rate (0.0–1.0), computed from usage cache fields.
    #[serde(default)]
    pub cache_hit_rate: Option<f64>,
}

/// Per-session cumulative perf snapshot, emitted (throttled) while a turn is
/// streaming so the composer metrics row can update live. Not persisted
/// directly — the final values ride on `ChatDonePayload`/the DB row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPerfPayload {
    pub chat_session_id: String,
    /// Cumulative model-generation time so far (ms).
    pub llm_time_ms: i64,
    /// Cumulative tool-execution time so far (ms).
    pub tool_time_ms: i64,
    /// Time from turn start to the first emitted token (ms), if known yet.
    pub ttft_ms: Option<i64>,
    /// Running generation speed = output_tokens_generated / llm_time_ms.
    pub tokens_per_second: Option<f64>,
    /// Output tokens generated so far in this turn.
    pub output_tokens: i64,
    /// Wall-clock elapsed since turn start (ms).
    pub elapsed_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatArtifactPayload {
    pub chat_session_id: String,
    pub path: String,
    pub filename: String,
}

/// Per-session aggregate perf metrics, returned by the
/// `get_chat_session_metrics` IPC command for the composer metrics row. All
/// fields are cumulative across the session's assistant turns (sums / weighted
/// averages), `None` when no turns have recorded the metric yet.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionMetricsPayload {
    pub chat_session_id: String,
    /// Sum of per-turn LLM time (ms).
    pub llm_time_ms: Option<i64>,
    /// Sum of per-turn tool-execution time (ms).
    pub tool_time_ms: Option<i64>,
    /// Average TTFT across turns that recorded one (ms).
    pub ttft_avg_ms: Option<i64>,
    /// Weighted-average generation speed (tok/s), weighted by output tokens.
    pub tokens_per_second: Option<f64>,
    /// Session cache-hit rate (0.0–1.0), `None` when no cache data.
    pub cache_hit_rate: Option<f64>,
    /// Cumulative input tokens across all turns.
    pub input_tokens: i64,
    /// Cumulative output tokens across all turns.
    pub output_tokens: i64,
    /// Number of assistant turns that contributed to these aggregates.
    pub turn_count: i64,
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

/// Emitted while a background chat task (download_file / run_shell) makes
/// progress. The UI renders a live progress card; the model polls the same
/// state via `get_task_status` / `download_progress`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTaskProgressPayload {
    pub chat_session_id: String,
    pub task_id: String,
    /// "download" | "shell"
    pub kind: String,
    /// running | completed | failed | cancelled
    pub state: crate::chat::tasks::TaskState,
    /// Human-facing detail (error, destination, output tail).
    pub message: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub speed_bps: u64,
    pub dest_path: Option<String>,
}

/// Plan step progress — lighter than ChatTaskProgressPayload (no download/speed
/// fields). Emitted when backend tools execute or TodoWrite tool calls carry
/// structured task updates. The frontend fuzzy-matches `step_label` against
/// parsed PlanStep items.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepProgressPayload {
    pub chat_session_id: String,
    /// Human-readable step label — frontend fuzzy-matches against PlanStep.label
    pub step_label: String,
    /// "pending" | "in_progress" | "completed" | "failed"
    pub status: String,
    /// Optional detail (error message for failed, "tool executed" for completed)
    pub detail: Option<String>,
    /// Optional tool-call context (e.g. the file path from a Write tool)
    pub tool_call: Option<String>,
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
    /// `data:` URI present for image/pdf/docx/pptx kinds (raw file bytes).
    pub data_uri: Option<String>,
    /// Signal to frontend that data_uri contains raw bytes (not base64-encoded HTML).
    /// When true for docx, use mammoth.js client-side conversion.
    pub original_bytes: Option<bool>,
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
    #[serde(default)]
    pub n_ctx: u32,
    /// Effective `--n-gpu-layers` after the stepwise fallback ladder.
    /// 0 = CPU-only, >0 = partial or full GPU offload. UI surfaces this.
    #[serde(default)]
    pub n_gpu_layers: i32,
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveLocalModel {
    pub model_id: String,
    pub port: u16,
    #[serde(default)]
    pub n_ctx: u32,
    /// Effective `--n-gpu-layers` of the running sidecar.
    #[serde(default)]
    pub n_gpu_layers: i32,
    pub base_url: String,
}

/// Live context-window usage for a local-model session. Returned by
/// `count_context_tokens` so the composer can drive its circular meter off
/// the same tokenizer the model actually uses (llama-server's `/tokenize`),
/// not the stale `inputTokens` of the last persisted assistant turn.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsagePayload {
    /// Tokens the running sidecar counted for the assembled (system + active
    /// history) conversation. Null when no sidecar is running, the chat
    /// session can't be found, or the tokenizer errored.
    pub used_tokens: Option<u32>,
    /// The model context window the sidecar was started with (`-c`). The
    /// meter divides `used_tokens` by this to render the ring.
    pub max_tokens: u32,
}

/// Per-category context-window breakdown for the rich context-meter tooltip.
/// Returned by `count_context_breakdown` (called lazily on hover). Each field
/// is the token count of that component of what the model sees; the sum is NOT
/// necessarily equal to `total_tokens` (the tokenizer counts each chunk in
/// isolation and real request assembly interleaves them), so rows render each
/// against `max_tokens` independently.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBreakdownPayload {
    /// The combined system + active-history total (what `count_context_tokens`
    /// returns), for the slider/ring.
    pub total_tokens: u32,
    /// The model context window the sidecar was started with (`-c`).
    pub max_tokens: u32,
    /// Core system prompt + tool guidance text.
    pub system_prompt_tokens: u32,
    /// Active chat messages (history) after strip_think_blocks.
    pub messages_tokens: u32,
    /// Built-in tool specs JSON (openai_tool_specs).
    pub tool_specs_tokens: u32,
    /// Connector-originated (MCP) tool specs JSON.
    pub connector_tools_tokens: u32,
    /// Invoked-skills bodies concatenation.
    pub skills_tokens: u32,
    /// Compaction summary system row (the `[compacted context]` marker).
    pub metacontext_tokens: u32,
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

/// Emitted when a harness CLI (claude/kimi/opencode) spawns a subagent
/// (Task tool call). Sent once on spawn, then `subagent-tokens` events arrive
/// as the subagent streams its output, and finally `subagent-done` with the
/// complete result.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSpawnPayload {
    pub chat_session_id: String,
    /// Unique id for this subagent within the session.
    pub id: String,
    /// e.g. "explore", "edit", "analyze" — the role requested.
    pub role: String,
    /// The task description the user/model provided.
    pub task: String,
    /// The prompt the subagent was started with.
    pub prompt: String,
}

/// A single chunk of subagent output (token or line). Emitted repeatedly as
/// the subagent produces output, allowing the frontend to render live streaming
/// text that looks identical to the main chat token stream.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTokenPayload {
    pub chat_session_id: String,
    pub subagent_id: String,
    pub chunk: String,
}

/// Emitted when the subagent completes (or errors). Carries the final combined
/// output so the frontend can close the panel cleanly.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentDonePayload {
    pub chat_session_id: String,
    pub id: String,
    pub output: String,
    pub error: Option<String>,
}
