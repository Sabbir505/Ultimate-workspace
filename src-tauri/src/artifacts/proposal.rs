//! Artifact proposal types — what flows between generation, validation, and UI.

use crate::artifacts::schemas::{ArtifactSpec, ArtifactType};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Source of the artifact.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactSource {
    Manual,
    Chat,
}

/// Provenance metadata — separate from the artifact config.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactProvenance {
    pub source: ArtifactSource,
    pub conversation_id: Option<String>,
    pub source_message_ids: Option<Vec<i64>>,
    pub created_at: i64,
    pub schema_version: u32,
    pub generator_version: String,
}

impl ArtifactProvenance {
    pub fn new_chat(conversation_id: String, source_message_ids: Option<Vec<i64>>) -> Self {
        Self {
            source: ArtifactSource::Chat,
            conversation_id: Some(conversation_id),
            source_message_ids,
            created_at: chrono::Utc::now().timestamp_millis(),
            schema_version: 1,
            generator_version: "artifact-generator-v1".to_string(),
        }
    }
}

/// Intent classifier action — Phase 1: Create, Phase 2: Save, Phase 3: Update.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactAction {
    Create,
    Save,
    Update,
    None,
}

/// What the intent classifier detected.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactIntent {
    pub action: ArtifactAction,
    pub artifact_type: Option<ArtifactType>,
    /// The rest of the user message after intent keywords.
    #[serde(default)]
    pub instruction: Option<String>,
    /// Confidence score from classifier (0.0-1.0).
    #[serde(default)]
    pub confidence: f32,
}

/// Decision returned to frontend — no numerical thresholds exposed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum IntentDecision {
    CreateProposal { intent: ArtifactIntent },
    SaveProposal { intent: ArtifactIntent },
    UpdateProposal { intent: ArtifactIntent },
    AskClarification { message: String },
    NormalConversation,
}

/// Validation result from the validator.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// Main proposal type — returned by generator, shown in UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactProposal {
    /// UUID for tracking across regenerate/edit cycles.
    pub id: String,
    pub artifact_type: ArtifactType,
    /// The artifact configuration (no provenance here).
    pub spec: ArtifactSpec,
    /// Estimated proposal quality (0.0-1.0): intent-classification confidence
    /// × generated-spec completeness. Computed by the generator, never static.
    pub confidence: f32,
    /// Fields the generator couldn't determine.
    #[serde(default)]
    pub missing_fields: Vec<String>,
    /// Assumptions the generator made (non-critical).
    #[serde(default)]
    pub assumptions: Vec<String>,
}

impl ArtifactProposal {
    pub fn new(artifact_type: ArtifactType, spec: ArtifactSpec, confidence: f32) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            artifact_type,
            spec,
            confidence,
            missing_fields: Vec::new(),
            assumptions: Vec::new(),
        }
    }

    pub fn with_missing(mut self, fields: Vec<String>) -> Self {
        self.missing_fields = fields;
        self
    }

    pub fn with_assumptions(mut self, assumptions: Vec<String>) -> Self {
        self.assumptions = assumptions;
        self
    }
}

/// Result of artifact creation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedArtifact {
    pub id: String,
    pub artifact_type: ArtifactType,
    pub name: String,
}