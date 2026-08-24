//! Tauri commands for conversational artifact creation.

use crate::artifacts::{
    ArtifactProposal, ArtifactSpec, ArtifactProvenance, ArtifactType, ArtifactIntent,
    classify_intent, build_context, generate_artifact, validate_artifact, adapt,
    IntentDecision,
};
use crate::artifacts::adapter::AdaptedArtifact;
use crate::artifacts::proposal::ArtifactAction;
use crate::DbState;
use crate::commands::skills_cmds::{create_installed_skill, save_installed_skill};
use crate::db::{create_skill, create_automation, update_skill, update_automation, list_skills, list_automations, get_automation};
use tauri::State;

/// Request for artifact generation.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateArtifactRequest {
    pub chat_session_id: String,
    pub user_message: String,
    /// Optionally provided by the frontend when the artifact type is already known
    /// (e.g. from a /create command or natural-language detection). When present,
    /// the backend skips intent classification.
    #[serde(default)]
    pub artifact_type: Option<crate::artifacts::schemas::ArtifactType>,
}

/// Request for artifact validation.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateArtifactRequest {
    pub proposal: ArtifactProposal,
}

/// Request for artifact creation.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArtifactRequest {
    pub spec: ArtifactSpec,
    pub provenance: ArtifactProvenance,
}

/// Response from artifact creation.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedArtifact {
    pub id: String,
    pub artifact_type: ArtifactType,
    pub name: String,
}

/// Generate an artifact proposal from a user message.
#[tauri::command]
pub async fn generate_artifact_cmd(
    db: State<'_, DbState>,
    request: GenerateArtifactRequest,
) -> Result<ArtifactProposal, String> {
    // If the frontend already determined the artifact type (e.g. from a
    // /create command or natural-language detection), skip classification
    // and go straight to generation. This prevents the backend from
    // re-classifying a message the frontend already parsed and failing.
    let intent = if let Some(ref artifact_type) = request.artifact_type {
        ArtifactIntent {
            action: ArtifactAction::Create,
            artifact_type: Some(artifact_type.clone()),
            instruction: Some(request.user_message.clone()),
            confidence: 1.0,
        }
    } else {
        // No type provided — classify intent from the message text
        let decision = classify_intent(&request.user_message, &request.chat_session_id).await?;
        match decision {
            crate::artifacts::IntentDecision::CreateProposal { intent } => intent,
            crate::artifacts::IntentDecision::SaveProposal { intent } => intent,
            crate::artifacts::IntentDecision::UpdateProposal { intent } => intent,
            crate::artifacts::IntentDecision::AskClarification { message } => {
                return Err(format!("CLARIFICATION: {}", message));
            }
            crate::artifacts::IntentDecision::NormalConversation => {
                return Err("NO_INTENT".to_string());
            }
        }
    };

    // Build context + generate
    let context = build_context(db, &intent, &request.chat_session_id).await?;
    let proposal = generate_artifact(context).await?;
    let validation = validate_artifact(&proposal);
    if !validation.valid {
        return Ok(proposal.with_missing(validation.errors));
    }
    Ok(proposal)
}

/// Validate an artifact proposal (never persists).
#[tauri::command]
pub async fn validate_artifact_cmd(
    request: ValidateArtifactRequest,
) -> Result<crate::artifacts::ValidationResult, String> {
    let result = validate_artifact(&request.proposal);
    Ok(result)
}

/// Create an artifact from validated spec + provenance (only after user confirmation).
#[tauri::command]
pub async fn create_artifact_cmd(
    db: State<'_, DbState>,
    request: CreateArtifactRequest,
) -> Result<CreatedArtifact, String> {
    // Validate first
    let proposal = ArtifactProposal {
        id: uuid::Uuid::new_v4().to_string(),
        artifact_type: match &request.spec {
            ArtifactSpec::Skill(_) => ArtifactType::Skill,
            ArtifactSpec::Loop(_) => ArtifactType::Loop,
            ArtifactSpec::PromptTemplate(_) => ArtifactType::PromptTemplate,
            ArtifactSpec::Automation(_) => ArtifactType::Automation,
        },
        spec: request.spec.clone(),
        confidence: 1.0,
        missing_fields: vec![],
        assumptions: vec![],
    };
    
    let validation = validate_artifact(&proposal);
    if !validation.valid {
        return Err(format!("Validation failed: {}", validation.errors.join(", ")));
    }
    
    // Translate to existing persistence model
    let adapted = adapt(&request.spec)?;
    
    // Create using existing Tauri commands
    let (id, name) = match adapted {
        AdaptedArtifact::InstalledSkill(input) => {
            // Skills and loops use create_installed_skill (filesystem)
            let installed = create_installed_skill(
                input.slug.clone(),
                input.kind.clone(),
                input.content.clone(),
            )?;
            
            // Also save with metadata (the save command handles frontmatter)
            save_installed_skill(
                installed.slug.clone(),
                input.kind.clone(),
                input.content.clone(),
            )?;
            
            (installed.slug, input.name)
        }
        AdaptedArtifact::PromptTemplate(input) => {
            // Prompt templates: create DB skill + install as harness skill
            let skill = create_skill(
                &db.0.lock(),
                &input.name,
                &input.slash_command,
                &input.content,
                &input.scope,
            ).map_err(|e| e.to_string())?;
            
            // Also install as harness skill for slash command access
            let slug = input.slash_command.trim_start_matches('/').to_string();
            create_installed_skill(
                slug,
                "skill".to_string(),
                input.content,
            )?;
            
            (skill.id, skill.name)
        }
        AdaptedArtifact::Automation(input) => {
            let automation = create_automation(&db.0.lock(), &input)
                .map_err(|e| e.to_string())?;
            (automation.id, automation.name)
        }
    };
    
    Ok(CreatedArtifact {
        id,
        artifact_type: match &request.spec {
            ArtifactSpec::Skill(_) => ArtifactType::Skill,
            ArtifactSpec::Loop(_) => ArtifactType::Loop,
            ArtifactSpec::PromptTemplate(_) => ArtifactType::PromptTemplate,
            ArtifactSpec::Automation(_) => ArtifactType::Automation,
        },
        name,
    })
}

/// Regenerate an artifact with additional instruction.
#[tauri::command]
pub async fn regenerate_artifact_cmd(
    db: State<'_, DbState>,
    chat_session_id: String,
    user_message: String,
    additional_instruction: String,
    original_instruction: String,
    artifact_type: Option<ArtifactType>,
) -> Result<ArtifactProposal, String> {
    // Prefer the original instruction so intent classification sees the user's
    // full request. Older proposals may not have it, so use the known artifact
    // type as a deterministic fallback.
    let classification_input = if !original_instruction.is_empty() {
        original_instruction.clone()
    } else {
        user_message
    };
    let mut decision = classify_intent(&classification_input, &chat_session_id).await?;
    if let Some(art_type) = artifact_type {
        if !matches!(decision, crate::artifacts::IntentDecision::CreateProposal { .. }) {
            decision = crate::artifacts::IntentDecision::CreateProposal {
                intent: ArtifactIntent {
                    action: ArtifactAction::Create,
                    artifact_type: Some(art_type),
                    instruction: Some(classification_input.clone()),
                    confidence: 1.0,
                },
            };
        }
    }

    match decision {
        crate::artifacts::IntentDecision::CreateProposal { intent } => {
            let mut context = build_context(db, &intent, &chat_session_id).await?;
            context.user_instruction = Some(format!(
                "{}\n\nAdditional instruction: {}",
                context.user_instruction.unwrap_or_default(),
                additional_instruction
            ));
            let proposal = generate_artifact(context).await?;
            Ok(proposal)
        }
        _ => Err("Invalid state for regeneration".to_string()),
    }
}

/// Save a conversation as a new artifact (Phase 2).
#[tauri::command]
pub async fn save_artifact_cmd(
    db: State<'_, DbState>,
    request: GenerateArtifactRequest,
) -> Result<CreatedArtifact, String> {
    // 1. Classify intent — should be SaveProposal
    let decision = classify_intent(&request.user_message, &request.chat_session_id).await?;
    
    let intent = match decision {
        IntentDecision::SaveProposal { intent } => intent,
        IntentDecision::CreateProposal { intent } => intent, // Allow create as fallback
        IntentDecision::AskClarification { message } => {
            return Err(format!("CLARIFICATION: {}", message));
        }
        _ => return Err("NO_INTENT".to_string()),
    };
    
    // 2. Build context with recent messages
    let context = build_context(db.clone(), &intent, &request.chat_session_id).await?;
    
    // 3. Generate artifact from conversation context
    let proposal = generate_artifact(context).await?;
    
    // 4. Create the artifact
    let spec = proposal.spec;
    
    // Translate to existing persistence model
    let adapted = adapt(&spec)?;
    
    let (id, name) = match adapted {
        AdaptedArtifact::InstalledSkill(input) => {
            let installed = create_installed_skill(
                input.slug.clone(),
                input.kind.clone(),
                input.content.clone(),
            )?;
            save_installed_skill(
                installed.slug.clone(),
                input.kind.clone(),
                input.content.clone(),
            )?;
            (installed.slug, input.name)
        }
        AdaptedArtifact::PromptTemplate(input) => {
            let skill = create_skill(
                &db.0.lock(),
                &input.name,
                &input.slash_command,
                &input.content,
                &input.scope,
            ).map_err(|e| e.to_string())?;
            let slug = input.slash_command.trim_start_matches('/').to_string();
            create_installed_skill(slug, "skill".to_string(), input.content)?;
            (skill.id, skill.name)
        }
        AdaptedArtifact::Automation(input) => {
            let automation = create_automation(&db.0.lock(), &input)
                .map_err(|e| e.to_string())?;
            (automation.id, automation.name)
        }
    };
    
    Ok(CreatedArtifact {
        id,
        artifact_type: match &spec {
            ArtifactSpec::Skill(_) => ArtifactType::Skill,
            ArtifactSpec::Loop(_) => ArtifactType::Loop,
            ArtifactSpec::PromptTemplate(_) => ArtifactType::PromptTemplate,
            ArtifactSpec::Automation(_) => ArtifactType::Automation,
        },
        name,
    })
}

/// Search existing artifacts by name/type (Phase 2).
#[tauri::command]
pub async fn search_artifacts_cmd(
    db: State<'_, DbState>,
    query: String,
    artifact_type: Option<String>,
) -> Result<Vec<ArtifactSummary>, String> {
    let conn = db.0.lock();
    
    let mut results = Vec::new();
    
    // Search skills by name or slash command
    if artifact_type.is_none() || artifact_type.as_deref() == Some("skill") || artifact_type.as_deref() == Some("loop") {
        let skills = list_skills(&conn, None)
            .map_err(|e| e.to_string())?;
        for skill in skills {
            if skill.name.to_lowercase().contains(&query.to_lowercase())
                || skill.slash_command.to_lowercase().contains(&query.to_lowercase())
            {
                results.push(ArtifactSummary {
                    id: skill.id,
                    name: skill.name,
                    description: skill.content.chars().take(100).collect(),
                    artifact_type: ArtifactType::Skill,
                    created_at: skill.created_at,
                });
            }
        }
    }
    
    // Search automations
    if artifact_type.is_none() || artifact_type.as_deref() == Some("automation") {
        let autos = list_automations(&conn)
            .map_err(|e| e.to_string())?;
        for auto in autos {
            if auto.name.to_lowercase().contains(&query.to_lowercase()) {
                results.push(ArtifactSummary {
                    id: auto.id,
                    name: auto.name,
                    description: auto.prompt.chars().take(100).collect(),
                    artifact_type: ArtifactType::Automation,
                    created_at: auto.created_at,
                });
            }
        }
    }
    
    Ok(results)
}

/// Update an existing artifact (Phase 3).
#[tauri::command]
pub async fn update_artifact_cmd(
    db: State<'_, DbState>,
    artifact_id: String,
    artifact_type: String,
    new_spec: ArtifactSpec,
) -> Result<ArtifactUpdateResult, String> {
    let conn = db.0.lock();
    
    // Get current artifact for diff
    let (current_spec, _current_name) = match artifact_type.as_str() {
        "skill" | "loop" => {
            let skills = list_skills(&conn, None).map_err(|e| e.to_string())?;
            let skill = skills.iter().find(|s| s.id == artifact_id)
                .ok_or_else(|| format!("Artifact {} not found", artifact_id))?;
            (Some(skill.content.clone()), Some(skill.name.clone()))
        }
        "automation" => {
            let auto = get_automation(&conn, &artifact_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("Artifact {} not found", artifact_id))?;
            (Some(auto.prompt.clone()), Some(auto.name.clone()))
        }
        _ => return Err("Unsupported artifact type".to_string()),
    };
    
    // Generate new content
    let adapted = adapt(&new_spec)?;
    let new_content = match &adapted {
        AdaptedArtifact::InstalledSkill(input) => input.content.clone(),
        AdaptedArtifact::PromptTemplate(input) => input.content.clone(),
        AdaptedArtifact::Automation(input) => input.prompt.clone(),
    };
    
    // Update based on type
    match artifact_type.as_str() {
        "skill" | "loop" => {
            // Find the skill to update
            let skills = list_skills(&conn, None).map_err(|e| e.to_string())?;
            if let Some(_skill) = skills.iter().find(|s| s.id == artifact_id) {
                update_skill(
                    &conn,
                    &artifact_id,
                    &new_spec.name(),
                    &format!("/{}", new_spec.slug()),
                    &new_content,
                ).map_err(|e| e.to_string())?;
                
                // Also update the installed skill on disk
                save_installed_skill(
                    new_spec.slug(),
                    artifact_type.clone(),
                    new_content.clone(),
                ).map_err(|e| e.to_string())?;
            }
        }
        "automation" => {
            match adapted {
                AdaptedArtifact::Automation(input) => {
                    update_automation(&conn, &artifact_id, &input)
                        .map_err(|e| e.to_string())?;
                }
                _ => return Err("Adapter mismatch for automation".to_string()),
            }
        }
        _ => return Err("Unsupported artifact type".to_string()),
    }
    
    // Compute diff
    let diff = compute_diff(current_spec.as_deref(), &new_content);
    
    Ok(ArtifactUpdateResult {
        success: true,
        artifact_id,
        artifact_type,
        name: new_spec.name(),
        diff,
    })
}

/// Get recent messages for context (Phase 2 helper).
#[tauri::command]
pub async fn get_artifact_context_cmd(
    db: State<'_, DbState>,
    chat_session_id: String,
    include_messages: bool,
) -> Result<ArtifactContextResponse, String> {
    let context = build_context(
        db,
        &crate::artifacts::proposal::ArtifactIntent {
            action: ArtifactAction::None,
            artifact_type: None,
            instruction: Some("Get context".to_string()),
            confidence: 0.0,
        },
        &chat_session_id,
    ).await?;

    let messages = if include_messages {
        context.recent_messages.into_iter()
            .map(|m| ConversationMessage {
                role: m.role,
                content: m.content,
            })
            .collect()
    } else {
        Vec::new()
    };
    
    // Convert SkillSummary to string names for the response
    let available_skills = context.workspace.available_skills
        .into_iter()
        .map(|s| s.name)
        .collect();

    Ok(ArtifactContextResponse {
        available_tools: context.workspace.available_tools,
        available_skills,
        messages,
    })
}

/// Summary of an existing artifact for search results.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub artifact_type: ArtifactType,
    pub created_at: i64,
}

/// Result of an artifact update with diff preview.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactUpdateResult {
    pub success: bool,
    pub artifact_id: String,
    pub artifact_type: String,
    pub name: String,
    pub diff: String,
}

/// Response for artifact context retrieval.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactContextResponse {
    pub available_tools: Vec<String>,
    pub available_skills: Vec<String>,
    pub messages: Vec<ConversationMessage>,
}

/// A simplified conversation message for context display.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub role: String,
    pub content: String,
}

/// Compute a simple diff between old and new content.
fn compute_diff(old: Option<&str>, new: &str) -> String {
    match old {
        Some(old_str) if old_str == new => {
            "No changes detected.".to_string()
        }
        Some(old_str) => {
            // Simple line-by-line diff for display
            let old_lines: Vec<&str> = old_str.lines().collect();
            let new_lines: Vec<&str> = new.lines().collect();
            let mut diff = String::new();
            diff.push_str("--- old\n");
            diff.push_str("+++ new\n");
            
            let max_len = old_lines.len().max(new_lines.len());
            for i in 0..max_len {
                let old_line = old_lines.get(i).copied().unwrap_or("");
                let new_line = new_lines.get(i).copied().unwrap_or("");
                if old_line != new_line {
                    if !old_line.is_empty() {
                        diff.push_str(&format!("- {}\n", old_line));
                    }
                    if !new_line.is_empty() {
                        diff.push_str(&format!("+ {}\n", new_line));
                    }
                }
            }
            
            if diff.len() < 10 {
                "No significant changes.".to_string()
            } else {
                diff
            }
        }
        None => format!("New artifact created.\n{}", new),
    }
}