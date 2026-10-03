//! Message types for mobile ↔ desktop relay communication (JSON over WebSocket).

use serde::{Deserialize, Serialize};

use crate::chat::providers::ChatMessage;

// ---------------------------------------------------------------------------
// Mobile → Desktop messages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum MobileMessage {
    /// First frame every WebSocket connection MUST send. Two pairing modes:
    ///
    /// - **E2E (§3.2.11):** send only `proof` = lowercase-hex
    ///   `HMAC-SHA256(key = token, data = "E2E")`. The desktop verifies the
    ///   proof against its per-launch token, both sides derive a session key
    ///   from the token via HKDF, and every subsequent frame is
    ///   XChaCha20-Poly1305 encrypted Binary. The raw token never rides the
    ///   wire, so a passive observer can neither derive the key nor
    ///   impersonate the phone.
    /// - **Legacy:** send the raw `token`. Verified against the per-launch
    ///   pairing token; the connection then runs in plaintext. Pre-E2E
    ///   clients only.
    ///
    /// Sending neither (or both) is rejected. The token is rotated on every
    /// app launch.
    Pair {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        proof: Option<String>,
        /// Challenge-capable client marker (anti-replay, 2026-10-01): the
        /// client understands `PairChallenge` and its `proof` is
        /// `HMAC(token, "E2E-NONCE-V1" || this connection's nonce)`. When
        /// true the desktop requires the nonce-bound proof and will NOT fall
        /// back to the legacy static proof — so replaying a captured static
        /// proof at a v2 client's identity fails. Old builds omit the field
        /// (serde default) and keep the legacy path.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        v2: Option<bool>,
        /// Salt-binding client marker (audit C9, 2026-10-03): the client binds
        /// the public `PairOk` salt to this connection's challenge
        /// (`SHA256(challenge || salt)`) before deriving its session key and
        /// refuses a replayed challenge, so a relay MITM replaying a recorded
        /// `PairOk` salt cannot re-derive a previous connection's key (whose
        /// counter nonces restart at 0 → keystream + one-time-key reuse). The
        /// desktop derives the SAME bound salt when this flag is set; pre-v3
        /// clients keep the raw-salt derivation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        v3: Option<bool>,
    },
    /// Query the current state of all providers.
    ListAvailableProviders,
    /// Star/unstar a chat (desktop sidebar pin parity). The phone's list
    /// picks the new state up on the next poll.
    SetSessionStarred { session_id: String, starred: bool },
    /// The artifact library: every chat's latest artifact, newest first
    /// (desktop Sidebar → ArtifactLibrary parity).
    ListArtifacts,
    /// Cost-dashboard rollups for N days (desktop Settings → Cost parity).
    GetCostRollups {
        #[serde(default)]
        days: Option<u32>,
    },
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
    /// Create a new CLI session under a project. `provider`/`model` are the
    /// phone-picked model for the new chat (omitted → "auto" routing, the
    /// desktop's fresh-chat default).
    CreateSession {
        project_id: String,
        harness: String,
        #[serde(default)]
        provider: Option<String>,
        #[serde(default)]
        model: Option<String>,
        /// Reasoning effort for the new chat ("" / absent = provider default) —
        /// the phone's picker slider, same wire values the desktop stores.
        #[serde(default)]
        effort: Option<String>,
        /// Connectors attached from the composer's @-menu before the chat
        /// existed; applied to the new chat row like the desktop's.
        #[serde(default)]
        connectors: Option<Vec<String>>,
    },
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
        /// "Always allow" — persist an approval rule so this tool stops
        /// prompting. Only meaningful for the filesystem mutators the desktop
        /// rules engine governs (write_file / edit_file / delete_file /
        /// move_file / copy_file); ignored for everything else.
        #[serde(default)]
        always_allow: bool,
    },
    RenameSession {
        session_id: String,
        title: String,
    },
    /// Switch the chat session's provider + model from the phone's model
    /// sheet. Applies to the session row, so the NEXT turn uses it (an
    /// in-flight stream keeps its model).
    SetSessionModel {
        session_id: String,
        provider_id: String,
        model: String,
        /// Some("") clears back to the provider default; None leaves the
        /// session's effort untouched (model-only switches from older phones).
        #[serde(default)]
        effort: Option<String>,
    },
    /// Delete a chat session and its messages from the desktop.
    DeleteChatSession {
        session_id: String,
    },
    /// Read the chat session's provider/model/title (header + model sheet).
    GetSessionMeta {
        session_id: String,
    },
    /// Register (or replace) the phone's push token so the desktop can notify
    /// about approvals / completions while no WebSocket is connected.
    RegisterPushToken {
        token: String,
        /// "ios" | "android" | "web" — diagnostics only today.
        platform: String,
    },
    /// List the artifacts attached to this session's messages.
    ListSessionArtifacts {
        session_id: String,
    },
    /// Lightweight artifact preview for the library GRID (desktop
    /// ArtifactLibrary parity): a text snippet for text-like kinds, a data
    /// URI for images, nothing for binaries. Same containment gate as
    /// `ReadArtifact` — the relay applies it before calling the core.
    ReadArtifactPreview {
        path: String,
    },
    /// Read one artifact's bytes for on-device preview. The path is
    /// containment-checked against the desktop's artifacts directory — the
    /// relay must never become an arbitrary-file-read primitive.
    ReadArtifact {
        session_id: String,
        path: String,
    },
    /// The skills the chat `/` menu offers (installed + builtin).
    ListChatSkills,
    /// Automations (desktop Automations view parity).
    ListAutomations,
    /// ACP agents (desktop picker "Agents · ACP" rail parity).
    ListAcpAgents,
    /// Memory (desktop Settings → Memory parity): browse, edit, forget, purge.
    ListMemoryRecords {
        #[serde(default)]
        include_inactive: Option<bool>,
    },
    UpdateMemoryRecord {
        memory_id: String,
        content: String,
        #[serde(default)]
        importance: Option<i64>,
    },
    DeleteMemoryRecord {
        memory_id: String,
    },
    PurgeMemories,
    /// Installed skills / loops library (desktop SkillsLibrary parity).
    ListInstalledSkills {
        /// "skill" | "loop"
        kind: String,
    },
    ReadInstalledSkill {
        slug: String,
        kind: String,
    },
    SaveInstalledSkill {
        slug: String,
        kind: String,
        content: String,
    },
    CreateInstalledSkill {
        name: String,
        kind: String,
        content: String,
    },
    DeleteInstalledSkill {
        slug: String,
        kind: String,
    },
    MakeInstalledSkillsGlobal {
        kind: String,
    },
    /// Git tools (desktop GitToolsSidebar parity), scoped to a REGISTERED
    /// project (the phone can't hand the backend an arbitrary path).
    GitStatus {
        project_id: String,
    },
    GitDiff {
        project_id: String,
        #[serde(default)]
        path: Option<String>,
    },
    GitCommit {
        project_id: String,
        message: String,
    },
    GitPush {
        project_id: String,
    },
    GitBranches {
        project_id: String,
    },
    GitLog {
        project_id: String,
        #[serde(default)]
        limit: Option<usize>,
    },
    /// Per-project spend caps (desktop Cost → Budgets parity).
    ListBudgets,
    SetBudget {
        project_id: String,
        monthly_usd: f64,
        #[serde(default)]
        threshold_pct: Option<f64>,
    },
    RemoveBudget {
        project_id: String,
    },
    ListHiddenCostProjects,
    HideCostProject {
        project_id: String,
    },
    UnhideCostProject {
        project_id: String,
    },
    /// Projects (desktop sidebar projects parity): list, add by path,
    /// rename, remove. The phone has no native folder picker, so `path` is
    /// typed/pasted (the same absolute path the desktop stores).
    ListProjects,
    AddProject {
        path: String,
        #[serde(default)]
        name: Option<String>,
    },
    RenameProject {
        project_id: String,
        name: String,
    },
    RemoveProject {
        project_id: String,
    },
    /// Connectors + their connection state (composer @-menu parity).
    ListConnectors,
    /// Replace the connectors attached to a chat session (the @-menu's
    /// toggle) — same per-session set the desktop composer edits.
    SetSessionConnectors {
        session_id: String,
        connector_ids: Vec<String>,
    },
    /// The connectors currently attached to a chat session.
    GetSessionConnectors {
        session_id: String,
    },
    CreateAutomation {
        /// `AutomationInput` shape (name/prompt/harness/model/cwd/schedule/…).
        input: serde_json::Value,
    },
    UpdateAutomation {
        automation_id: String,
        input: serde_json::Value,
    },
    DeleteAutomation {
        automation_id: String,
    },
    SetAutomationEnabled {
        automation_id: String,
        enabled: bool,
    },
    RunAutomationNow {
        automation_id: String,
    },
    StopAutomationRun {
        automation_id: String,
    },
    ListAutomationRuns {
        automation_id: String,
        #[serde(default)]
        limit: Option<i64>,
    },
    /// List one harness's own model catalog (the phone fetches a pane the
    /// AvailableProviders cache didn't pre-warm, like the desktop picker does
    /// on pane open).
    ListHarnessModels {
        harness_id: String,
    },
    /// Delete one persisted message (desktop MessageBubble parity).
    DeleteChatMessage {
        session_id: String,
        message_id: i64,
    },
    /// Edit a user message: retire the branch from that message and re-send
    /// the edited text as a fresh turn (desktop edit-to-fork).
    EditUserMessage {
        session_id: String,
        message_id: i64,
        text: String,
    },
    /// Re-run the session's latest user turn (desktop Regenerate).
    RegenerateMessage {
        session_id: String,
    },
    /// Turn checkpoints (desktop TurnChangesRow Undo parity).
    ListChatCheckpoints {
        session_id: String,
    },
    RestoreChatCheckpoint {
        session_id: String,
        checkpoint_id: i64,
        /// Also roll the conversation back to the checkpoint (desktop asks).
        #[serde(default)]
        rollback_messages: Option<bool>,
    },
    /// Full-text search across the desktop's chat history (phone search).
    SearchChatMessages {
        query: String,
        #[serde(default)]
        limit: Option<u32>,
    },
    /// Permission posture: plan | read_only | manual | auto_edit | full_auto.
    SetSessionPermissionMode {
        session_id: String,
        mode: String,
    },
    /// `/compact` — summarize older turns now.
    CompactSession {
        session_id: String,
    },
    /// Transcribe a voice note through the desktop's whisper sidecar (the
    /// same `transcribe_audio` core the desktop push-to-talk uses).
    TranscribeAudio {
        /// base64 (no data: prefix) WAV/MP3 bytes.
        data_base64: String,
        media_type: Option<String>,
    },
    /// Answer an agent question (desktop QuestionCard parity): the turn is
    /// parked until this lands. `answers` maps the question text to the chosen
    /// option label (or an array for multi-select), `response` is free text.
    ResolveSessionQuestion {
        session_id: String,
        pending_id: String,
        answers: serde_json::Value,
        #[serde(default)]
        response: Option<String>,
    },
    /// Approve/reject a plan proposal card. `approved: false` optionally
    /// carries revision feedback back to the model (same core the desktop
    /// card uses).
    ResolvePlanProposal {
        session_id: String,
        pending_id: String,
        approved: bool,
        feedback: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// Desktop → Mobile messages
// ---------------------------------------------------------------------------

/// One connector row (composer @-menu parity) — mirrors
/// `ConnectorWithStatus` without the OAuth plumbing the phone never needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorInfo {
    pub id: String,
    pub display_name: String,
    pub icon: String,
    pub family: String,
    pub description: String,
    pub connected: bool,
    pub account_display: Option<String>,
}

/// One memory record (desktop MemoryPanel row; the full record carries
/// provenance fields the phone doesn't render).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryInfo {
    pub id: String,
    pub kind: String,
    pub content: String,
    pub keywords: Vec<String>,
    pub importance: i64,
    pub confidence: f64,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One installed skill/loop (desktop SkillsLibrary row).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledSkillInfo {
    pub slug: String,
    pub name: String,
    pub description: String,
    /// "claude" | "kimi" | "both"
    pub source: String,
    /// "skill" | "loop"
    pub kind: String,
}

/// One ACP agent row (desktop picker parity).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpAgentInfo {
    pub id: String,
    pub display_name: String,
    pub installed: bool,
}

/// One per-project budget (mirrors `commands::budget::BudgetConfig`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetInfo {
    pub project_id: String,
    /// Monthly cap in USD; non-positive means "no budget".
    pub monthly_usd: f64,
    /// 0..100 — percent of the cap at which the alert fires.
    pub threshold_pct: f64,
}

/// One project row (mirrors `types::Project`, Serialize-only there).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub is_git_repo: bool,
    pub created_at: i64,
    pub last_opened_at: Option<i64>,
}

/// One automation row (desktop Automations view parity). Mirrors
/// `db::automations::Automation`, which is Serialize-only and so cannot be
/// nested directly in this Deserialize+Serialize enum.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationInfo {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub harness: String,
    pub model: String,
    pub cwd: String,
    pub schedule: String,
    pub enabled: bool,
    pub last_run_at: Option<i64>,
    pub last_status: Option<String>,
    pub chat_session_id: Option<String>,
    pub created_at: i64,
    pub origin: String,
    /// "cron" | "webhook" | "file" | "git" | "gmail"
    pub trigger_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationRunInfo {
    pub id: String,
    pub automation_id: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    /// "running" | "ok" | "skipped" | error text
    pub status: String,
    pub summary: String,
    pub chat_session_id: Option<String>,
    /// "scheduled" | "manual"
    pub source: String,
}

/// One `/`-menu skill (desktop ChatComposer slash menu parity).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSkillInfo {
    pub slug: String,
    pub name: String,
    pub description: String,
    /// "installed" | "builtin"
    pub origin: String,
}

/// One chat-history search hit (desktop command-palette FTS parity).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatSearchHit {
    pub chat_session_id: String,
    pub session_title: Option<String>,
    pub message_id: Option<i64>,
    pub snippet: Option<String>,
    pub role: Option<String>,
    pub created_at: i64,
}

/// One turn checkpoint (desktop TurnChangesRow Undo parity).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatCheckpointInfo {
    pub id: i64,
    pub message_id: Option<i64>,
    /// Files changed vs the previous checkpoint.
    pub files: Vec<CheckpointFileInfo>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointFileInfo {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DesktopMessage {
    /// Provider list response, plus agent-harness families and the desktop's
    /// auto-route default so the phone's composer mirrors the desktop picker.
    AvailableProviders {
        providers: Vec<ProviderInfo>,
        #[serde(default)]
        harnesses: Vec<HarnessInfo>,
        #[serde(default)]
        default_provider: Option<String>,
        #[serde(default)]
        default_model: Option<String>,
    },
    /// Active CLI session list response.
    SessionList { sessions: Vec<SessionInfo> },
    /// Artifact library response (desktop Sidebar → ArtifactLibrary parity).
    ArtifactLibrary {
        artifacts: Vec<ArtifactLibraryEntry>,
    },
    /// Cost rollups response — the same payload the desktop CostDashboard
    /// renders (totals, byKind, perModel, perProject, daily). Held as a
    /// pre-serialized value: CostRollups serializes but doesn't derive
    /// Deserialize, and the enum requires both directions.
    CostRollups {
        rollups: serde_json::Value,
    },
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
    /// Pairing challenge (anti-replay, 2026-10-01). Sent PLAINTEXT the moment
    /// the WebSocket is accepted, BEFORE any Pair frame is read. Challenge-
    /// capable clients answer with `Pair { v2: true, proof }` where proof =
    /// `HMAC(key = token, "E2E-NONCE-V1" || nonce)` — bound to THIS
    /// connection, so a captured Pair frame cannot be replayed. Clients that
    /// never saw a challenge (pre-v2 builds) keep the legacy static proof;
    /// `mobile.pairing.require_challenge` refuses it once the fleet is v2.
    /// Base64url (no padding), 32 bytes.
    PairChallenge { nonce: String },
    /// Pairing accepted. Sent PLAINTEXT immediately after a valid Pair proof
    /// and before any encrypted frame (same-socket ordering guarantees the
    /// phone processes it first). The salt is public: the session key is
    /// `HKDF(ikm = token, salt)` on both sides, so the key is unique per
    /// connection (audit C1 — reconnecting must not reuse nonces under one
    /// key). Base64url (no padding), 32 bytes.
    PairOk { salt: String },
    /// Response to GetTranscript — the rendered terminal screen (SGR-styled
    /// rows) plus the terminal size, so the phone can fit the font to the
    /// terminal's column count instead of sideways-scrolling a desktop-width
    /// layout.
    Transcript {
        session_id: String,
        text: String,
        cols: u16,
        rows: u16,
        /// M11: true when the screen is byte-identical to the last snapshot
        /// sent on this connection — `text` is empty and the client should
        /// keep rendering the previous snapshot. Full-screen SGR snapshots
        /// are the relay's largest messages; deduping them kills the
        /// per-poll bandwidth while the terminal is static.
        #[serde(default)]
        unchanged: bool,
    },
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
    /// The approval was resolved (from ANY surface — desktop card or phone)
    /// so every phone can dismiss its matching card instead of waiting for a
    /// timeout that never comes.
    SessionApprovalResolved {
        session_id: String,
        pending_id: String,
    },
    /// A `present_plan` proposal card, forwarded to the phone. The plan body
    /// is the markdown "approach" text; the phone renders an Approve /
    /// Revise card and answers via `ResolvePlanProposal`.
    SessionPlanProposal {
        session_id: String,
        pending_id: String,
        title: String,
        plan: String,
    },
    /// Ack for `SetSessionModel` — the session row now carries this model.
    SessionModelSet {
        session_id: String,
        provider_id: String,
        model: String,
        #[serde(default)]
        effort: Option<String>,
    },
    /// Ack for `DeleteChatSession`.
    SessionDeleted {
        session_id: String,
    },
    /// Ack for `DeleteChatMessage` (a fresh `SessionMessages` follows).
    SessionMessageDeleted {
        session_id: String,
        message_id: i64,
    },
    /// Response to `SearchChatMessages`.
    ChatSearchResults {
        query: String,
        results: Vec<ChatSearchHit>,
    },
    /// Response to `ListChatCheckpoints` (newest last, like the desktop).
    ChatCheckpoints {
        session_id: String,
        checkpoints: Vec<ChatCheckpointInfo>,
    },
    /// Ack for `RestoreChatCheckpoint`.
    SessionCheckpointRestored {
        session_id: String,
        checkpoint_id: i64,
        deleted_messages: i64,
    },
    /// A harness asked the user a question mid-turn (forwarded from the
    /// desktop's `chat:question-request`).
    SessionQuestionRequest {
        session_id: String,
        pending_id: String,
        questions: serde_json::Value,
    },
    /// Ack for `ResolveSessionQuestion` (also clears the phone's card).
    SessionQuestionResolved {
        pending_id: String,
    },
    /// Ack for `SetSessionPermissionMode`.
    SessionPermissionModeSet {
        session_id: String,
        mode: String,
    },
    /// Ack for `CompactSession`.
    SessionCompacted {
        session_id: String,
    },
    /// Response to `GetSessionMeta` — header + model-sheet state for a chat.
    SessionMeta {
        session_id: String,
        provider: String,
        model: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        effort: Option<String>,
        /// Permission posture (plan | read_only | manual | auto_edit |
        /// full_auto) so the phone's mode chip starts on the real value.
        #[serde(default)]
        permission_mode: Option<String>,
        /// The chat's bound project, when one is bound — keys the diff peek
        /// (file-edit activity rows fetch that project's git diff for path).
        #[serde(default)]
        project_id: Option<String>,
    },
    /// Ack for `RegisterPushToken`.
    PushAck {
        ok: bool,
        #[serde(default)]
        error: Option<String>,
    },
    /// Response to `ListConnectors` (composer @-menu).
    ConnectorList {
        connectors: Vec<ConnectorInfo>,
    },
    /// The session's attached connector ids.
    SessionConnectors {
        session_id: String,
        connector_ids: Vec<String>,
    },
    /// Ack for `SetSessionConnectors`.
    SessionConnectorsSet {
        session_id: String,
        connector_ids: Vec<String>,
    },
    /// Response to `ListMemoryRecords`.
    MemoryList {
        records: Vec<MemoryInfo>,
    },
    /// Acks for memory mutations.
    MemoryUpdated {
        memory_id: String,
    },
    MemoryDeleted {
        memory_id: String,
    },
    MemoryPurged {
        count: usize,
    },
    /// Response to `ListInstalledSkills`.
    InstalledSkillList {
        skills: Vec<InstalledSkillInfo>,
    },
    /// Response to `ReadInstalledSkill`.
    InstalledSkillContent {
        slug: String,
        kind: String,
        content: String,
    },
    /// Ack after save/create/delete/globalize.
    InstalledSkillAck {
        slug: String,
        mirrored: usize,
    },
    /// Response to `GitStatus` (branch + ahead/behind + changed files, the
    /// shape the desktop Git rail header shows).
    GitStatusMsg {
        is_repo: bool,
        branch: Option<String>,
        dirty: bool,
        ahead: i64,
        behind: i64,
        remote_url: Option<String>,
        changed_files: Vec<serde_json::Value>,
    },
    /// Unified text reply for diff / commit / push.
    GitOutput {
        output: String,
    },
    /// Response to `GitBranches` / `GitLog` (desktop GitLogEntry shape).
    GitBranchesMsg {
        branches: Vec<serde_json::Value>,
    },
    GitLogMsg {
        entries: Vec<serde_json::Value>,
    },
    /// Response to `ListAcpAgents`.
    AcpAgentList {
        agents: Vec<AcpAgentInfo>,
    },
    /// Response to `ListBudgets` / `SetBudget` ack.
    BudgetList {
        budgets: Vec<BudgetInfo>,
    },
    /// Response to `ListHiddenCostProjects` / hide / unhide.
    HiddenCostProjects {
        project_ids: Vec<String>,
    },
    /// One project row (desktop Project parity).
    ProjectList {
        projects: Vec<ProjectInfo>,
    },
    /// Ack after add/rename.
    ProjectUpserted {
        project: ProjectInfo,
    },
    /// Ack after remove.
    ProjectRemoved {
        project_id: String,
    },
    /// Response to `ListAutomations`.
    AutomationList {
        automations: Vec<AutomationInfo>,
    },
    /// Ack for `CreateAutomation` / `UpdateAutomation` / `SetAutomationEnabled`
    /// (the phone re-lists to converge).
    AutomationUpdated {
        automation_id: String,
    },
    /// Ack for `DeleteAutomation`.
    AutomationDeleted {
        automation_id: String,
    },
    /// Ack for `RunAutomationNow`.
    AutomationRunStarted {
        automation_id: String,
    },
    /// Ack for `StopAutomationRun` — `stopped` false means the run already
    /// ended or belongs to the Task-Scheduler binary (desktop parity).
    AutomationRunStopped {
        automation_id: String,
        stopped: bool,
    },
    /// Response to `ListAutomationRuns`.
    AutomationRuns {
        automation_id: String,
        runs: Vec<AutomationRunInfo>,
    },
    /// Response to `ListChatSkills`.
    ChatSkills {
        skills: Vec<ChatSkillInfo>,
    },
    /// Response to `ReadArtifactPreview` — the desktop `ArtifactPreview`
    /// shape (Serialize-only there, mirrored here for the phone enum).
    ArtifactPreviewMsg {
        path: String,
        filename: String,
        ext: String,
        /// text | markdown | csv | json | html | diagram | code | image |
        /// pdf | office | binary
        kind: String,
        text: Option<String>,
        data_uri: Option<String>,
        truncated: bool,
    },
    /// Response to `ListHarnessModels` — one CLI harness's own model catalog,
    /// endpoint, and effort tiers (the desktop harness pane's payload).
    HarnessModels {
        harness_id: String,
        models: Vec<HarnessModelRow>,
        #[serde(default)]
        default_model: Option<String>,
        #[serde(default)]
        endpoint: Option<String>,
        #[serde(default)]
        effort: Option<String>,
        #[serde(default)]
        effort_options: Vec<String>,
    },
    /// Response to `ListSessionArtifacts`.
    SessionArtifacts {
        session_id: String,
        artifacts: Vec<ChatArtifactPayload>,
    },
    /// Response to `ReadArtifact` — preview bytes for one artifact.
    /// `text` for previewable text formats, `data_base64` otherwise.
    ArtifactContent {
        session_id: String,
        path: String,
        filename: String,
        /// Extension-derived format tag ("md", "pdf", "png", …).
        kind: String,
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        data_base64: Option<String>,
        /// True when the artifact exceeded the size cap and only a prefix is
        /// returned (text formats) or nothing (binary).
        #[serde(default)]
        truncated: bool,
    },
    /// Response to `TranscribeAudio`.
    Transcription {
        #[serde(default)]
        text: Option<String>,
        #[serde(default)]
        error: Option<String>,
    },
    SessionArtifact {
        session_id: String,
        message_id: Option<i64>,
        artifact: ChatArtifactPayload,
    },
    /// Broadcast to every connected phone when an automation run finishes
    /// (scheduled or manual). The phone shows it as a local alert — the
    /// "your nightly task failed" pocket pager.
    AutomationRunFinished {
        automation_id: String,
        name: String,
        /// "ok" | "skipped" | error text.
        status: String,
        summary: String,
    },
    /// Broadcast: a project's spend crossed its budget threshold.
    BudgetAlert {
        project_id: String,
        project_name: String,
        monthly_usd: f64,
        spent_usd: f64,
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

/// One model row of a harness's own catalog (desktop AgentModelPicker pane
/// parity): `source` is "config" | "cli" | "builtin" — the badge the desktop
/// shows next to the label.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HarnessModelRow {
    pub id: String,
    pub label: String,
    pub source: String,
    /// Per-model thinking tiers (empty → the harness-wide effort_options).
    #[serde(default)]
    pub thinking: Vec<String>,
}

/// An agent-harness family the desktop can drive (Claude Code, Kimi Code,
/// OpenCode, …). Mirrors the desktop agent picker's entries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HarnessInfo {
    pub id: String,
    pub display_name: String,
    /// Whether the CLI is installed on the desktop (probed with a 30s cache;
    /// may be false purely because the cache is cold).
    pub installed: bool,
    /// The CLI's own model catalog + endpoint + effort tiers — filled from
    /// the warm probe cache when available; the phone fetches a cold pane's
    /// catalog via ListHarnessModels (desktop fetches on picker open too).
    #[serde(default)]
    pub models: Vec<HarnessModelRow>,
    #[serde(default)]
    pub default_model: Option<String>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub effort_options: Vec<String>,
}

/// One entry of the artifact library — the same deduped, newest-first list
/// the desktop's sidebar ArtifactLibrary renders. `chat_session_id` lets the
/// phone open/read the artifact through the existing session-scoped read op.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactLibraryEntry {
    pub chat_session_id: Option<String>,
    pub filename: String,
    pub path: String,
    /// Lowercase extension: "docx" | "pptx" | "pdf" | "xlsx" | "html" | …
    pub kind: String,
    pub created_at: i64,
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
    /// Desktop sidebar parity: pinned chats sort first, unread show a dot.
    #[serde(default)]
    pub starred: bool,
    #[serde(default)]
    pub unread: bool,
    /// Reasoning effort stored on the chat row (None = provider default) —
    /// seeds the picker's effort slider.
    #[serde(default)]
    pub effort: Option<String>,
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
    /// Extension-derived format tag ("md", "pdf", "png", "docx", …) so the
    /// phone can pick a preview without reading the bytes.
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline: Option<ChatArtifactInline>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatArtifactInline {
    pub kind: String, // "jsx" | "tsx"
    pub code: String,
}
