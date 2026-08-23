//! Artifacts module — conversational artifact creation pipeline.

pub mod schemas;
pub mod proposal;
pub mod validator;
pub mod adapter;
pub mod intent;
pub mod context;
pub mod generator;

pub use schemas::{ArtifactSpec, ArtifactType, SkillSpec, LoopSpec, PromptTemplateSpec, AutomationSpec};
pub use proposal::{ArtifactProposal, ArtifactProvenance, ArtifactIntent, ArtifactAction, IntentDecision, ValidationResult, CreatedArtifact};
pub use validator::validate_artifact;
pub use adapter::{adapt, AdaptedArtifact, InstalledSkillInput, PromptTemplateInput};
pub use intent::{classify_intent};
pub use context::{build_context, ArtifactGenerationContext, WorkspaceContext, ChatMessage, SkillSummary, ArtifactSummary};
pub use generator::{generate_artifact, regenerate_artifact};