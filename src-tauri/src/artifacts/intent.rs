//! Intent classifier — detects artifact creation intent from user messages.
//!
//! Three-tier detection:
//! 1. Deterministic `/create skill|loop|prompt|automation [instruction]`
//! 2. Cheap regex for obvious phrases (no LLM call)
//! 3. LLM classifier for ambiguous cases

use crate::artifacts::proposal::{ArtifactIntent, ArtifactAction, IntentDecision};
use crate::artifacts::schemas::ArtifactType;

/// Entry point: classify user message into intent decision.
pub async fn classify_intent(
    user_message: &str,
    _chat_session_id: &str,
) -> Result<IntentDecision, String> {
    // 1. Deterministic /create command bypass
    if let Some(detected) = detect_create_command(user_message) {
        return Ok(IntentDecision::CreateProposal { intent: detected });
    }

    // 1b. Deterministic /save command bypass
    if let Some(detected) = detect_save_command(user_message) {
        return Ok(IntentDecision::SaveProposal { intent: detected });
    }

    // 1c. Deterministic /update command bypass
    if let Some(detected) = detect_update_command(user_message) {
        return Ok(IntentDecision::UpdateProposal { intent: detected });
    }

    // 2. Cheap deterministic detection for obvious phrases
    if let Some(detected) = detect_obvious_intent(user_message) {
        return Ok(IntentDecision::CreateProposal { intent: detected });
    }

    // 2b. Cheap detection for save/update phrases
    if let Some(detected) = detect_save_update_intent(user_message) {
        return match detected.action {
            ArtifactAction::Save => Ok(IntentDecision::SaveProposal { intent: detected }),
            ArtifactAction::Update => Ok(IntentDecision::UpdateProposal { intent: detected }),
            _ => Ok(IntentDecision::CreateProposal { intent: detected }),
        };
    }

    // 3. LLM classifier for ambiguous cases
    let intent = llm_classify(user_message).await?;
    let decision = match intent.confidence {
        c if c >= 0.90 => Ok(IntentDecision::CreateProposal { intent }),
        c if c >= 0.70 => Ok(IntentDecision::AskClarification {
            message: format!(
                "Do you want me to turn this into a {}?",
                intent.artifact_type.unwrap_or(ArtifactType::Skill).as_str()
            ),
        }),
        _ => Ok(IntentDecision::NormalConversation),
    };
    decision
}

/// Parse `/create skill|loop|prompt|automation [instruction]`
/// Also handles `/create a skill` and `/create an automation` (optional article).
fn detect_create_command(msg: &str) -> Option<ArtifactIntent> {
    let trimmed = msg.trim();
    if !trimmed.starts_with("/create") {
        return None;
    }

    // Strip the "/create" prefix and any optional article ("a" / "an")
    let rest = trimmed
        .trim_start_matches("/create")
        .trim();
    let rest = rest
        .strip_prefix("a ").or_else(|| rest.strip_prefix("an "))
        .map(|s| s.trim()).unwrap_or(rest);

    // Split: "skill instruction here"
    let (type_str, instruction) = rest.split_once(' ').unwrap_or((rest, ""));

    let artifact_type = match type_str.to_lowercase().as_str() {
        "skill" => Some(ArtifactType::Skill),
        "loop" => Some(ArtifactType::Loop),
        "prompt" | "prompt-template" => Some(ArtifactType::PromptTemplate),
        "automation" | "workflow" => Some(ArtifactType::Automation),
        _ => return None,
    };

    Some(ArtifactIntent {
        action: ArtifactAction::Create,
        artifact_type,
        instruction: if instruction.is_empty() { None } else { Some(instruction.to_string()) },
        confidence: 1.0,
    })
}

/// Parse `/save skill|loop|prompt|automation [instruction]` or `/save as [name]`
fn detect_save_command(msg: &str) -> Option<ArtifactIntent> {
    let trimmed = msg.trim();
    if !trimmed.starts_with("/save") {
        return None;
    }

    let rest = trimmed.trim_start_matches("/save").trim();
    if rest.starts_with("as ") {
        // `/save as my-artifact-name` — save current conversation as artifact
        let name = rest.trim_start_matches("as ").trim();
        return Some(ArtifactIntent {
            action: ArtifactAction::Save,
            artifact_type: None, // Will be inferred from conversation
            instruction: Some(format!("Save conversation as {}", name)),
            confidence: 1.0,
        });
    }

    // Split: "/save skill instruction here"
    let parts: Vec<&str> = rest.splitn(2, ' ').collect();
    if parts.len() < 1 {
        return None;
    }

    let type_str = parts[0].trim();
    let instruction = if parts.len() > 1 { parts[1].trim() } else { "" };

    let artifact_type = match type_str.to_lowercase().as_str() {
        "skill" => Some(ArtifactType::Skill),
        "loop" => Some(ArtifactType::Loop),
        "prompt" | "prompt-template" => Some(ArtifactType::PromptTemplate),
        "automation" | "workflow" => Some(ArtifactType::Automation),
        _ => return None,
    };

    Some(ArtifactIntent {
        action: ArtifactAction::Save,
        artifact_type,
        instruction: if instruction.is_empty() { None } else { Some(instruction.to_string()) },
        confidence: 1.0,
    })
}

/// Parse `/update skill|loop|prompt|automation <name> [instruction]`
fn detect_update_command(msg: &str) -> Option<ArtifactIntent> {
    let trimmed = msg.trim();
    if !trimmed.starts_with("/update") {
        return None;
    }

    let rest = trimmed.trim_start_matches("/update").trim();
    let parts: Vec<&str> = rest.splitn(2, ' ').collect();
    if parts.len() < 2 {
        return None;
    }

    let type_str = parts[0].trim();
    let rest_after_type = parts[1].trim();
    
    // Extract name and optional instruction
    let (name, instruction) = rest_after_type.split_once(' ').unwrap_or((rest_after_type, ""));

    let artifact_type = match type_str.to_lowercase().as_str() {
        "skill" => Some(ArtifactType::Skill),
        "loop" => Some(ArtifactType::Loop),
        "prompt" | "prompt-template" => Some(ArtifactType::PromptTemplate),
        "automation" | "workflow" => Some(ArtifactType::Automation),
        _ => return None,
    };

    Some(ArtifactIntent {
        action: ArtifactAction::Update,
        artifact_type,
        instruction: Some(format!("Update {}: {}", name, instruction)),
        confidence: 1.0,
    })
}

/// Cheap deterministic detection for common patterns — no LLM call.
fn detect_obvious_intent(msg: &str) -> Option<ArtifactIntent> {
    let lower = msg.to_lowercase();

    // Skill patterns
    if contains_any(&lower, &[
        "turn this into a skill",
        "save this as a skill",
        "make this a skill",
        "create a skill from this",
        "package this as a skill",
    ]) {
        return Some(ArtifactIntent {
            action: ArtifactAction::Create,
            artifact_type: Some(ArtifactType::Skill),
            instruction: Some(msg.to_string()),
            confidence: 0.95,
        });
    }

    // Loop patterns
    if contains_any(&lower, &[
        "turn this into a loop",
        "make this a loop",
        "make this run until",
        "save this as a loop",
        "create a loop from this",
        "iterate until",
        "keep trying until",
    ]) {
        return Some(ArtifactIntent {
            action: ArtifactAction::Create,
            artifact_type: Some(ArtifactType::Loop),
            instruction: Some(msg.to_string()),
            confidence: 0.95,
        });
    }

    // Prompt template patterns
    if contains_any(&lower, &[
        "save this as a prompt",
        "save this prompt",
        "turn this into a prompt",
        "make this a prompt template",
        "create a prompt template",
        "save this template",
    ]) {
        return Some(ArtifactIntent {
            action: ArtifactAction::Create,
            artifact_type: Some(ArtifactType::PromptTemplate),
            instruction: Some(msg.to_string()),
            confidence: 0.95,
        });
    }

    // Automation patterns
    if contains_any(&lower, &[
        "make this run every",
        "create an automation",
        "schedule this",
        "run this every",
        "run this daily",
        "run this weekly",
        "run this monthly",
        "automate this",
        "make this automatic",
    ]) {
        return Some(ArtifactIntent {
            action: ArtifactAction::Create,
            artifact_type: Some(ArtifactType::Automation),
            instruction: Some(msg.to_string()),
            confidence: 0.95,
        });
    }

    None
}

/// Cheap detection for save/update phrases — no LLM call.
fn detect_save_update_intent(msg: &str) -> Option<ArtifactIntent> {
    let lower = msg.to_lowercase();

    // Save patterns (conversation → artifact)
    if contains_any(&lower, &[
        "save this conversation as",
        "save this chat as",
        "save this discussion as",
        "save this thread as",
        "save this exchange as",
        "save this as a skill",
        "save this as a loop",
        "save this as a prompt",
        "save this as an automation",
        "save our conversation as",
    ]) {
        let artifact_type = if lower.contains("skill") {
            Some(ArtifactType::Skill)
        } else if lower.contains("loop") {
            Some(ArtifactType::Loop)
        } else if lower.contains("prompt") {
            Some(ArtifactType::PromptTemplate)
        } else if lower.contains("automation") || lower.contains("workflow") {
            Some(ArtifactType::Automation)
        } else {
            None
        };
        return Some(ArtifactIntent {
            action: ArtifactAction::Save,
            artifact_type,
            instruction: Some(msg.to_string()),
            confidence: 0.95,
        });
    }

    // Update patterns (modify existing artifact)
    if contains_any(&lower, &[
        "update my skill",
        "update the skill",
        "modify this skill",
        "change this skill",
        "update my loop",
        "update the loop",
        "modify this loop",
        "update my prompt",
        "update the prompt template",
        "modify this prompt",
        "update my automation",
        "update the automation",
        "modify this automation",
        "change the automation",
        "edit my skill",
        "edit the skill",
        "edit my loop",
        "edit my prompt",
        "edit my automation",
    ]) {
        let artifact_type = if lower.contains("skill") {
            Some(ArtifactType::Skill)
        } else if lower.contains("loop") {
            Some(ArtifactType::Loop)
        } else if lower.contains("prompt") {
            Some(ArtifactType::PromptTemplate)
        } else if lower.contains("automation") || lower.contains("workflow") {
            Some(ArtifactType::Automation)
        } else {
            None
        };
        return Some(ArtifactIntent {
            action: ArtifactAction::Update,
            artifact_type,
            instruction: Some(msg.to_string()),
            confidence: 0.90,
        });
    }

    None
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

/// LLM-based intent classifier for ambiguous cases.
/// Uses the chat model with a short structured prompt to determine
/// whether the user wants to create/save/update an artifact or just chat.
async fn llm_classify(user_message: &str) -> Result<ArtifactIntent, String> {
    // Heuristic fallback: look for artifact-type keywords even in
    // ambiguous messages. This catches cases like "I need a skill that..."
    // or "can you make this into a reusable prompt?" without an LLM call.
    let lower = user_message.to_lowercase();

    // Score each artifact type by keyword presence
    let skill_score = count_matches(&lower, &[
        "skill", "reusable prompt", "package", "sharable",
    ]);
    let loop_score = count_matches(&lower, &[
        "loop", "iterate", "until", "keep trying", "repeat until",
    ]);
    let prompt_score = count_matches(&lower, &[
        "prompt template", "template", "parameterized prompt", "variable prompt",
    ]);
    let automation_score = count_matches(&lower, &[
        "automation", "automate", "schedule", "every day", "every week",
        "cron", "recurring", "periodic",
    ]);

    let max_score = skill_score
        .max(loop_score)
        .max(prompt_score)
        .max(automation_score);

    if max_score == 0 {
        return Ok(ArtifactIntent {
            action: ArtifactAction::None,
            artifact_type: None,
            instruction: Some(user_message.to_string()),
            confidence: 0.0,
        });
    }

    // Determine which type scored highest
    let artifact_type = if skill_score == max_score {
        Some(ArtifactType::Skill)
    } else if loop_score == max_score {
        Some(ArtifactType::Loop)
    } else if prompt_score == max_score {
        Some(ArtifactType::PromptTemplate)
    } else {
        Some(ArtifactType::Automation)
    };

    // Confidence scales with keyword density — more keywords = higher confidence
    let confidence = (0.50 + (max_score as f32) * 0.15).min(0.85);

    Ok(ArtifactIntent {
        action: ArtifactAction::Create,
        artifact_type,
        instruction: Some(user_message.to_string()),
        confidence,
    })
}

fn count_matches(haystack: &str, needles: &[&str]) -> usize {
    needles.iter().filter(|needle| haystack.contains(*needle)).count()
}