//! Message types for mobile ↔ desktop relay communication (JSON over WebSocket).

use serde::{Deserialize, Serialize};

use crate::chat::providers::ChatMessage;

// ---------------------------------------------------------------------------
// Mobile → Desktop messages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum MobileMessage {
    /// First frame every WebSocket connection MUST send. The desktop compares
    /// `token` against the per-launch pairing token it generated when the
    /// relay started; mismatch closes the connection before any command is
    /// honored. The token is rotated on every app launch.
    Pair { token: String },
    /// Query the current state of all providers.
    ListAvailableProviders,
    /// Query active CLI sessions running on the desktop.
    ListSessions,
    /// Start a chat turn. The desktop creates a temporary session, streams
    /// tokens back, and cleans up afterwards. If `gguf_path` is provided and
    /// `provider_id` is "local_gguf", the desktop will warm up the sidecar
    /// before sending the first request.
    ChatTurn {
        provider_id: String,
        model: String,
        messages: Vec<ChatMessage>,
        system: Option<String>,
        effort: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        gguf_path: Option<String>,
    },
    /// Abort an in-progress stream.
    CancelChatTurn { chat_session_id: String },
    /// Send text input to a running CLI session's pty (e.g., a follow-up
    /// prompt or an answer to a clarifying question).
    SendToSession { session_id: String, text: String },
    /// Request the pty transcript for a session (the full scrollback).
    GetTranscript { session_id: String },
    /// Create a new CLI session under a project.
    CreateSession { project_id: String, harness: String },
    /// Spawn/resume a session on the desktop (activate it in a pane).
    /// The desktop handles pane-slot allocation (max 6, LRU eviction).
    SpawnSession { session_id: String },
    /// Query aggregate spend (today + rolling 7 days) for the Settings tab.
    GetCostSummary,
    /// Query detailed cost breakdown for the Settings cost dashboard:
    /// daily spend (last 14 days), per-project totals, and per-local-model
    /// token usage. Mirrors what the desktop CostDashboard shows.
    GetCostDetails,
    /// Warm up (spawn) a local GGUF sidecar on the desktop without sending a
    /// chat turn. Lets the phone start a stopped model the moment the user taps
    /// it in the model selector, instead of waiting for the first message.
    /// `gguf_path` is the absolute path returned in `ProviderInfo::gguf_path`;
    /// `model` is the display name to pass to the sidecar.
    StartLocalModel {
        model: String,
        gguf_path: String,
    },
    GetSessionMessages {
        session_id: String,
        before_id: Option<i64>,
        limit: u32,
    },
    SendChatMessage {
        session_id: String,
        text: String,
        attachments: Vec<ChatAttachment>,
    },
    CancelSessionStream { session_id: String },
    ResolveSessionApproval {
        session_id: String,
        pending_id: String,
        decision: String,
    },
    RenameSession {
        session_id: String,
        title: String,
    },
}

// ---------------------------------------------------------------------------
// Desktop → Mobile messages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DesktopMessage {
    /// Provider list response.
    AvailableProviders { providers: Vec<ProviderInfo> },
    /// Active CLI session list response.
    SessionList { sessions: Vec<SessionInfo> },
    /// One streamed token.
    ChatToken {
        chat_session_id: String,
        token: String,
    },
    /// Stream completed with usage info.
    ChatDone {
        chat_session_id: String,
        usage: Option<ChatUsage>,
    },
    /// Stream failed.
    ChatError {
        chat_session_id: String,
        error: String,
    },
    /// Connection handshake / heartbeat.
    DesktopStatus { connected: bool },
    /// Response to GetTranscript — the rendered terminal screen (SGR-styled
    /// rows) plus the terminal size, so the phone can fit the font to the
    /// terminal's column count instead of sideways-scrolling a desktop-width
    /// layout.
    Transcript { session_id: String, text: String, cols: u16, rows: u16 },
    /// A new session was successfully created.
    SessionCreated { session: SessionInfo },
    /// Aggregate spend response (today + rolling 7 days).
    /// `version: 2` = read-time priced (same source as the desktop rollup).
    CostSummary { today: f64, week: f64, version: u32 },
    /// Detailed cost breakdown response — same shape the desktop
    /// CostDashboard renders: daily spend, per-project totals, and per
    /// local-model token usage. All figures are best-effort estimates.
    CostDetails {
        daily: Vec<DailyCostEntry>,
        per_project: Vec<ProjectCostEntry>,
        local_models: Vec<LocalModelUsageEntry>,
    },
    /// Ack for `StartLocalModel`: the sidecar is up and serving at `base_url`,
    /// so the phone can clear its "Loading local model…" banner.
    LocalModelReady {
        model: String,
        base_url: String,
    },
    /// Ack for `StartLocalModel`: the sidecar failed to start.
    LocalModelError {
        model: String,
        error: String,
    },
    SessionMessages {
        session_id: String,
        messages: Vec<SessionMessageRecord>,
        has_more: bool,
    },
    SessionChatToken {
        session_id: String,
        token: String,
    },
    SessionChatDone {
        session_id: String,
        usage: Option<MobileChatUsage>,
    },
    SessionChatError {
        session_id: String,
        error: String,
    },
    SessionChatStatus {
        session_id: String,
        reason: String,
        message: String,
    },
    SessionApprovalRequest {
        session_id: String,
        pending_id: String,
        tool: String,
        summary: String,
        args: serde_json::Value,
    },
    SessionArtifact {
        session_id: String,
        message_id: Option<i64>,
        artifact: ChatArtifactPayload,
    },
}

// ---------------------------------------------------------------------------
// Cost-detail entries (mirrors the desktop CostDashboard aggregates)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyCostEntry {
    /// 'YYYY-MM-DD' (SQLite date(timestamp,'unixepoch')).
    pub day: String,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectCostEntry {
    pub project_id: String,
    pub project_name: String,
    pub total_cost_usd: f64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalModelUsageEntry {
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub message_count: i64,
    /// 'YYYY-MM-DD' of the most recent assistant message that carried usage.
    pub last_used: String,
}

// ---------------------------------------------------------------------------
// Shared structs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    pub display_name: String,
    pub models: Vec<String>,
    pub is_local: bool,
    /// For local models: whether the sidecar is currently running.
    pub is_running: bool,
    /// For local GGUF models that are available but not running: the absolute
    /// file path so the mobile app can trigger on-demand warm-up (option b).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gguf_path: Option<String>,
}

/// A local GGUF model that is available on disk but may not have a running
/// sidecar. The mobile app can request on-demand warm-up before starting a
/// chat turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvailableLocalModel {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub is_running: bool,
}

/// A running CLI agent session on the desktop.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    pub title: String,
    pub harness: String,
    /// "working" | "waiting" | "diff_ready" | "idle" — reflects whether a
    /// live pty exists for this session.
    pub status: String,
    pub last_active_at: i64,
    /// Whether this session currently has a live pane/pty on the desktop.
    pub is_live: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
}

// ---------------------------------------------------------------------------
// Session-scoped chat (Task 2)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatAttachment {
    pub name: String,
    pub kind: String, // "text" | "image" | "doc"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>, // base64, no data: prefix
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMessageRecord {
    pub id: i64,
    pub role: String, // "user" | "assistant" | "system"
    pub content: String,
    pub created_at: i64,
    #[serde(default)]
    pub input_tokens: Option<i64>,
    #[serde(default)]
    pub output_tokens: Option<i64>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
    #[serde(default)]
    pub artifact_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MobileChatUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    #[serde(default)]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatArtifactPayload {
    pub path: String,
    pub filename: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline: Option<ChatArtifactInline>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatArtifactInline {
    pub kind: String, // "jsx" | "tsx"
    pub code: String,
}
