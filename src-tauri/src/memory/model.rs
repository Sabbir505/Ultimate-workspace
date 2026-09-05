//! The `MemoryRecord` shape and store-wide constants (design §6).

/// Memory kinds (design §6.1). Procedural memory is intentionally absent —
/// Relay's procedure lives in the skills catalog + custom system prompt.
pub mod kind {
    pub const IDENTITY: &str = "identity";
    pub const PREFERENCE: &str = "preference";
    pub const FACT: &str = "fact";
    pub const PROJECT: &str = "project";
    pub const FEEDBACK: &str = "feedback";
    pub const EPISODE: &str = "episode";

    pub const ALL: [&str; 6] = [IDENTITY, PREFERENCE, FACT, PROJECT, FEEDBACK, EPISODE];

    pub fn is_valid(k: &str) -> bool {
        ALL.contains(&k)
    }

    /// Kinds the consolidation judge treats as mutually exclusive per
    /// (subject, topic) — a new contradicting one supersedes rather than
    /// coexisting (design §10.2).
    pub fn exclusive(k: &str) -> bool {
        matches!(k, IDENTITY | PREFERENCE | FEEDBACK)
    }

    /// Kinds the deterministic document renders as the profile sections
    /// Identity / Preferences / Feedback.
    pub fn profile_eligible(k: &str) -> bool {
        matches!(k, IDENTITY | PREFERENCE | FEEDBACK)
    }
}

pub mod status {
    pub const ACTIVE: &str = "active";
    pub const SUPERSEDED: &str = "superseded";
    pub const RETIRED: &str = "retired";
    pub const FLAGGED: &str = "flagged";
}

pub mod origin {
    pub const EXTRACTED: &str = "extracted";
    pub const AGENT_TOOL: &str = "agent_tool";
    pub const USER_CREATED: &str = "user_created";
    pub const REFLECTION: &str = "reflection";
}

/// Retrieval drops memories below this confidence (design §8.3 floor).
pub const MIN_CONFIDENCE: f64 = 0.35;
/// Consolidation judge comparison fetch: cosine gate (design §10.1).
pub const SIMILARITY_GATE: f32 = 0.55;
/// Comparison fetch width (Mem0's top-s).
pub const SIMILAR_TOP_S: usize = 5;
/// Similarity an existing ACTIVE memory must reach before the Add branch may
/// supersede it for an exclusive kind — ABOVE the fetch gate on purpose. The
/// judge already decided the candidate is novel; second-guessing it should
/// only collapse near-duplicates ("prefers tabs" vs "prefers tabs, mostly"),
/// not complementary facts of the same kind ("is named X" vs "is from Y"),
/// which used to overwrite each other down to the last identity fact written.
pub const ADD_SUPERSEDE_SIMILARITY: f32 = 0.8;

/// One durable fact about the user or a project. Mirrors the `memories` row
/// (see `db/memory.rs`); `embedding` is `None` when written with the sidecar
/// down (backfilled on a later pass; retrieval then degrades to FTS-only).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub kind: String,
    pub profile: String,
    pub project_id: Option<String>,
    pub subject: String,
    pub content: String,
    pub keywords: Vec<String>,
    pub importance: i64,
    pub confidence: f64,
    pub status: String,
    pub superseded_by: Option<String>,
    /// World-time validity (Zep's bi-temporal t_valid / t_invalid), unix secs.
    pub valid_from: i64,
    pub valid_until: Option<i64>,
    /// Store-time bookkeeping, unix secs.
    pub created_at: i64,
    pub updated_at: i64,
    pub superseded_at: Option<i64>,
    pub last_accessed_at: Option<i64>,
    pub access_count: i64,
    pub origin: String,
    /// Reflection bookkeeping (§8.4): 1 once a memory has been folded into a
    /// reflection insight (or considered and left out). Low-level facts whose
    /// insights exist can then be retired without losing their abstraction.
    pub reflected: bool,
    pub embedding: Option<Vec<f32>>,
}

impl MemoryRecord {
    /// A fresh ACTIVE memory created by the background extractor (or the
    /// agent tool — pass the right `origin`). `valid_from` = now.
    pub fn new_extracted(
        id: &str,
        kind: &str,
        project_id: Option<&str>,
        subject: &str,
        content: &str,
        importance: i64,
        embedding: Option<Vec<f32>>,
    ) -> Self {
        let now = crate::db::now_ts();
        MemoryRecord {
            id: id.to_string(),
            kind: kind.to_string(),
            profile: "default".to_string(),
            project_id: project_id.map(String::from),
            subject: subject.to_string(),
            content: content.to_string(),
            keywords: Vec::new(),
            importance,
            confidence: 0.8,
            status: status::ACTIVE.to_string(),
            superseded_by: None,
            valid_from: now,
            valid_until: None,
            created_at: now,
            updated_at: now,
            superseded_at: None,
            last_accessed_at: None,
            access_count: 0,
            origin: origin::EXTRACTED.to_string(),
            reflected: false,
            embedding,
        }
    }
}

/// A candidate produced by the extraction phase, before the judge decides
/// what (if anything) to write.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MemoryCandidate {
    pub content: String,
    pub kind: String,
    #[serde(default = "default_subject")]
    pub subject: String,
    #[serde(default)]
    pub quote: String,
    #[serde(default)]
    pub message_ids: Vec<i64>,
    #[serde(default)]
    pub importance: i64,
}

fn default_subject() -> String {
    "user".to_string()
}

/// One judge operation, parsed from the consolidation LLM's tool-call JSON.
#[derive(Debug, Clone, PartialEq)]
pub enum JudgeOp {
    Add,
    Update { target_id: String, merged_content: String },
    Delete { target_id: String },
    Noop,
}

impl JudgeOp {
    pub fn name(&self) -> &'static str {
        match self {
            JudgeOp::Add => "ADD",
            JudgeOp::Update { .. } => "UPDATE",
            JudgeOp::Delete { .. } => "DELETE",
            JudgeOp::Noop => "NOOP",
        }
    }
}
