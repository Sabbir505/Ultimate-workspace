//! Context builder for artifact generation.
//!
//! Phase 1: simple recent messages + workspace context.
//! Phase 2+: semantic retrieval, existing artifact search.

use crate::artifacts::proposal::ArtifactIntent;
use crate::artifacts::schemas::ArtifactType;
use crate::DbState;
use crate::commands::skills_cmds::list_installed_skills;
use crate::db::{list_skills, list_automations};
use tauri::State;

/// Context passed to the artifact generator.
#[derive(Debug, Clone)]
pub struct ArtifactGenerationContext {
    pub recent_messages: Vec<ChatMessage>,
    pub workspace: WorkspaceContext,
    pub user_instruction: Option<String>,
    pub artifact_type: ArtifactType,
    /// LLM credentials for generation (chat session's provider/model/key).
    pub llm: LlmContext,
}

/// LLM credentials for artifact generation — pulled from the chat session
/// so generation uses the same model the user is chatting with.
#[derive(Debug, Clone)]
pub struct LlmContext {
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub base_url: Option<String>,
}

/// A chat message for context.
#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Workspace context — available tools, project info.
#[derive(Debug, Clone)]
pub struct WorkspaceContext {
    pub project_id: Option<String>,
    pub project_path: Option<String>,
    pub available_tools: Vec<String>,
    pub available_skills: Vec<SkillSummary>,
    pub existing_artifacts: Vec<ArtifactSummary>,
}

/// Summary of an available skill/loop.
#[derive(Debug, Clone)]
pub struct SkillSummary {
    pub name: String,
    pub slug: String,
    pub description: String,
    pub kind: String,
}

/// Summary of an existing artifact for duplicate detection.
#[derive(Debug, Clone)]
pub struct ArtifactSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub artifact_type: ArtifactType,
}

/// Build generation context from intent and chat session.
pub async fn build_context(
    db: State<'_, DbState>,
    intent: &ArtifactIntent,
    chat_session_id: &str,
) -> Result<ArtifactGenerationContext, String> {
    // Get recent messages (last 15) from the chat session
    let recent_messages = get_recent_messages(&db, chat_session_id).await?;
    
    // Get workspace info
    let workspace = get_workspace_context(&db, chat_session_id).await?;
    
    // Get artifact type from intent
    let artifact_type = intent.artifact_type.unwrap_or(ArtifactType::Skill);
    
    // Get LLM credentials from chat session
    let llm = get_llm_context(&db, chat_session_id).await?;
    
    Ok(ArtifactGenerationContext {
        recent_messages,
        workspace,
        user_instruction: intent.instruction.clone(),
        artifact_type,
        llm,
    })
}

/// Get recent messages from chat session (last 15, for generator context).
async fn get_recent_messages(
    db: &State<'_, DbState>,
    chat_session_id: &str,
) -> Result<Vec<ChatMessage>, String> {
    // Fetch from the existing chat_messages table.
    let conn = db.0.lock();
    let all = crate::db::list_chat_messages(&conn, chat_session_id)
        .map_err(|e| e.to_string())?;
    // Take the last 15 messages and map to the lightweight context type.
    let recent: Vec<ChatMessage> = all
        .into_iter()
        .rev()
        .take(15)
        .rev()
        .map(|m| ChatMessage {
            role: m.role,
            content: m.content,
        })
        .collect();
    Ok(recent)
}

/// Get workspace context including available tools and existing artifacts.
async fn get_workspace_context(
    db: &State<'_, DbState>,
    chat_session_id: &str,
) -> Result<WorkspaceContext, String> {
    // Get project binding for this chat session
    let project_id = get_chat_project_id(db, chat_session_id).await?;
    let project_path = match &project_id {
        Some(id) => get_project_path(db, id).await.ok().flatten(),
        None => None,
    };
    
    // Available built-in tools
    let available_tools = vec![
        "read_file".to_string(),
        "write_file".to_string(),
        "edit_file".to_string(),
        "list_directory".to_string(),
        "search_files".to_string(),
        "run_shell".to_string(),
        "web_search".to_string(),
        "web_fetch".to_string(),
        "github_list_issues".to_string(),
        "github_get_issue".to_string(),
        "git_status".to_string(),
        "git_diff".to_string(),
    ];
    
    // Get existing skills (installed + DB-backed)
    let mut available_skills = Vec::new();
    
    // Installed skills (harness skills) — takes no arguments
    let installed = list_installed_skills()
        .await
        .map_err(|e| e.to_string())?;
    for s in installed {
        available_skills.push(SkillSummary {
            name: s.name,
            slug: s.slug,
            description: s.description,
            kind: s.kind,
        });
    }
    
    // DB-backed prompt templates
    if let Some(pid) = &project_id {
        let db_skills = list_skills(&db.0.lock(), Some(pid.as_str()))
            .map_err(|e| e.to_string())?;
        for s in db_skills {
            available_skills.push(SkillSummary {
                name: s.name,
                slug: s.slash_command,
                description: s.content.chars().take(100).collect(),
                kind: "prompt_template".to_string(),
            });
        }
    }
    
    // Existing automations
    let mut existing_artifacts = Vec::new();
    let autos = list_automations(&db.0.lock())
        .map_err(|e| e.to_string())?;
    for a in autos {
        existing_artifacts.push(ArtifactSummary {
            id: a.id,
            name: a.name,
            description: a.prompt.chars().take(100).collect(),
            artifact_type: ArtifactType::Automation,
        });
    }
    
    Ok(WorkspaceContext {
        project_id,
        project_path,
        available_tools,
        available_skills,
        existing_artifacts,
    })
}

/// Get the project ID bound to a chat session.
async fn get_chat_project_id(db: &State<'_, DbState>, chat_session_id: &str) -> Result<Option<String>, String> {
    let conn = db.0.lock();
    let result: Option<String> = conn
        .query_row(
            "SELECT project_id FROM chat_sessions WHERE id = ?1",
            rusqlite::params![chat_session_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    Ok(result)
}

/// Get project path from project ID.
async fn get_project_path(db: &State<'_, DbState>, project_id: &str) -> Result<Option<String>, String> {
    let conn = db.0.lock();
    let result: Option<String> = conn
        .query_row(
            "SELECT path FROM projects WHERE id = ?1",
            rusqlite::params![project_id],
            |row| row.get(0),
        )
        .ok()
        .flatten();
    Ok(result)
}

/// Get LLM credentials from the chat session's provider/model + stored API key.
async fn get_llm_context(db: &State<'_, DbState>, chat_session_id: &str) -> Result<LlmContext, String> {
    let conn = db.0.lock();
    let cs = crate::db::get_chat_session(&conn, chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "chat session not found".to_string())?;

    // Harness/ACP-agent sessions: the provider/model columns don't name an
    // HTTP API (model holds a CLI alias like "sonnet"; there may be no key for
    // the stale provider). Route generation through the CLI itself — the
    // generator dispatches on this "harness:<id>" provider string.
    if let Some(agent) = cs.agent.as_deref() {
        if agent.starts_with("harness:") {
            return Ok(LlmContext {
                provider: agent.to_string(),
                model: cs.model,
                api_key: String::new(),
                base_url: None,
            });
        }
        if agent.starts_with("acp:") {
            return Err(
                "/create isn't available for ACP agents yet — switch the chat to a built-in, local, or CLI harness agent.".to_string(),
            );
        }
    }

    let api_key = crate::secrets::get_chat_api_key(&conn, &cs.provider).unwrap_or_default();
    // Match chat/dispatch.rs exactly: filter out empty/whitespace base_urls so
    // they fall through to the provider default (e.g. https://api.openai.com).
    // Without this, an empty-string setting would produce a broken URL like
    // "/v1/chat/completions" and the request would return HTML instead of JSON.
    let base_url = crate::db::get_setting(&conn, &format!("chat.{}.base_url", cs.provider))
        .ok()
        .flatten()
        .filter(|b| !b.trim().is_empty());

    // local_gguf: mirror the send path's model resolution — the session's
    // model column carries the GGUF display name ("DeepSeek R1 …"), which
    // llama-server rejects with HTTP 400; the server only accepts the model
    // it was started with (the `chat.local_gguf.model` setting, written by
    // the sidecar start).
    let model = if cs.provider == "local_gguf" {
        crate::db::get_setting(&conn, "chat.local_gguf.model")
            .ok()
            .flatten()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| cs.model.clone())
    } else {
        cs.model.clone()
    };

    // The base_url is written when the llama-server sidecar starts; without a
    // running server every request would fail with a connection error — fail
    // fast with an actionable message instead.
    if cs.provider == "local_gguf" && base_url.is_none() {
        return Err(
            "The local model isn't running — start it from the model menu, then try /create again.".to_string(),
        );
    }

    Ok(LlmContext {
        provider: cs.provider,
        model,
        api_key,
        base_url,
    })
}