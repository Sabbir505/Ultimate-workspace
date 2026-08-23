//! Artifact generator — LLM structured output for artifact creation.

use crate::artifacts::context::{ArtifactGenerationContext, LlmContext};
use crate::artifacts::proposal::ArtifactProposal;
use crate::artifacts::schemas::{ArtifactSpec, ArtifactType};
use reqwest::Client;
use serde_json::Value;

/// Generate an artifact proposal from context using LLM structured output.
pub async fn generate_artifact(
    context: ArtifactGenerationContext,
) -> Result<ArtifactProposal, String> {
    let system_prompt = build_system_prompt(&context.artifact_type, &context.workspace);
    let user_prompt = build_user_prompt(&context);
    let json_schema = build_json_schema(&context.artifact_type);

    let spec = call_llm_structured(
        &context.llm,
        &system_prompt,
        &user_prompt,
        &json_schema,
    )
    .await?;

    let proposal = ArtifactProposal::new(context.artifact_type, spec, 0.9);
    Ok(proposal)
}

/// Regenerate an artifact with additional instruction.
pub async fn regenerate_artifact(
    original_context: ArtifactGenerationContext,
    additional_instruction: &str,
) -> Result<ArtifactProposal, String> {
    let mut new_context = original_context;
    new_context.user_instruction = Some(format!(
        "{}\n\nAdditional instruction: {}",
        new_context.user_instruction.unwrap_or_default(),
        additional_instruction
    ));
    generate_artifact(new_context).await
}

/// Build system prompt with artifact-type-specific instructions.
fn build_system_prompt(
    artifact_type: &ArtifactType,
    workspace: &crate::artifacts::context::WorkspaceContext,
) -> String {
    let base = "You are an expert at creating reusable Conduit artifacts. Generate a complete, valid artifact specification in JSON format.\n\n";

    let type_specific = match artifact_type {
        ArtifactType::Skill => r#"Create a SKILL artifact. A skill is a reusable prompt that can be invoked with `/skill-name` in chat.
Required fields: name, description, instructions, inputs[], outputs[], tools[], model?, permissions?, examples?
Example tools: "read_file", "write_file", "edit_file", "list_directory", "search_files", "run_shell", "web_search", "web_fetch", "github_list_issues", "github_get_issue", "git_status", "git_diff"
Permissions: "read_only" | "workspace_write" | "full_access""#,
        ArtifactType::Loop => r#"Create a LOOP artifact. A loop is an iterative workflow that runs until a condition is met.
Required fields: name, description, objective, inputs[], steps[], iteration{max, condition?}, outputs[], permissions?
Each step: label, description?, action, parameters?
Iteration: max (1-100), condition? (natural language stop condition)"#,
        ArtifactType::PromptTemplate => r#"Create a PROMPT_TEMPLATE artifact. A prompt template is a parameterized prompt with {{variables}}.
Required fields: name, description, template, variables[], output_format?, examples?
Variables: name, description?, required, default?
Template should use {{variable}} syntax for placeholders."#,
        ArtifactType::Automation => r#"Create an AUTOMATION artifact. An automation runs on a schedule or event.
Required fields: name, description, trigger{type, schedule?}, steps[], inputs?, outputs?, permissions?, enabled
Trigger types: "schedule" (needs 5-field cron), "event", "webhook"
Steps: label, description?, action, parameters?
enabled defaults to true — the automation is active right after the user presses Create. Set it to false ONLY if the user explicitly asked to create it paused/off. Always provide a concrete 5-field cron for schedule triggers."#,
    };

    let tools_list = workspace.available_tools.join(", ");
    let tools_context = format!("\n\nAvailable tools: {}", tools_list);

    let artifacts_context = if !workspace.existing_artifacts.is_empty() {
        let summaries: Vec<String> = workspace
            .existing_artifacts
            .iter()
            .map(|a| format!("- {} ({})", a.name, a.artifact_type.as_str()))
            .collect();
        format!("\n\nExisting artifacts for reference:\n{}", summaries.join("\n"))
    } else {
        String::new()
    };

    format!("{}{}{}{}", base, type_specific, tools_context, artifacts_context)
}

/// Build user prompt from context.
fn build_user_prompt(context: &ArtifactGenerationContext) -> String {
    let mut prompt = String::new();

    if let Some(instruction) = &context.user_instruction {
        prompt.push_str(&format!("User request: {}\n\n", instruction));
    }

    if !context.recent_messages.is_empty() {
        prompt.push_str("Recent conversation:\n");
        for msg in context.recent_messages.iter().take(10) {
            prompt.push_str(&format!("{}: {}\n", msg.role, msg.content));
        }
        prompt.push('\n');
    }

    prompt.push_str("Generate a complete artifact specification as JSON.");
    prompt
}

/// Build JSON schema for the artifact type.
fn build_json_schema(artifact_type: &ArtifactType) -> Value {
    match artifact_type {
        ArtifactType::Skill => serde_json::json!({
            "type": "object",
            "properties": {
                "type": {"const": "skill"},
                "name": {"type": "string", "minLength": 1},
                "description": {"type": "string", "minLength": 1},
                "instructions": {"type": "string", "minLength": 1},
                "inputs": {"type": "array", "items": {"type": "object"}},
                "outputs": {"type": "array", "items": {"type": "object"}},
                "tools": {"type": "array", "items": {"type": "string"}},
                "permissions": {
                    "type": "string",
                    "enum": ["read_only", "workspace_write", "full_access"],
                    "description": "Permission scope for the artifact."
                },
                "examples": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "input": {"type": ["string", "object", "array"]},
                            "output": {"type": ["string", "object", "array"]}
                        },
                        "required": ["input", "output"]
                    }
                }
            },
            "required": ["type", "name", "description", "instructions"]
        }),
        ArtifactType::Loop => serde_json::json!({
            "type": "object",
            "properties": {
                "type": {"const": "loop"},
                "name": {"type": "string", "minLength": 1},
                "description": {"type": "string", "minLength": 1},
                "objective": {"type": "string", "minLength": 1},
                "inputs": {"type": "array", "items": {"type": "object"}},
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string"},
                            "action": {"type": "string"},
                            "description": {"type": "string"},
                            "parameters": {"type": "object"}
                        },
                        "required": ["label", "action"]
                    }
                },
                "iteration": {"type": "object", "properties": {"max": {"type": "integer", "minimum": 1, "maximum": 100}, "condition": {"type": "string"}}},
                "outputs": {"type": "array", "items": {"type": "object"}},
                "permissions": {
                    "type": "string",
                    "enum": ["read_only", "workspace_write", "full_access"],
                    "description": "Permission scope for the artifact."
                }
            },
            "required": ["type", "name", "description", "objective", "steps", "iteration"]
        }),
        ArtifactType::PromptTemplate => serde_json::json!({
            "type": "object",
            "properties": {
                "type": {"const": "prompt_template"},
                "name": {"type": "string", "minLength": 1},
                "description": {"type": "string", "minLength": 1},
                "template": {"type": "string", "minLength": 1},
                "variables": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "description": {"type": "string"},
                            "required": {"type": "boolean"},
                            "default": {"type": ["string", "object", "null"]}
                        },
                        "required": ["name"]
                    }
                },
                "output_format": {"type": "string"},
                "examples": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "variables": {"type": "object"},
                            "output": {"type": ["string", "object", "array"]}
                        },
                        "required": ["output"]
                    }
                }
            },
            "required": ["type", "name", "description", "template"]
        }),
        ArtifactType::Automation => serde_json::json!({
            "type": "object",
            "properties": {
                "type": {"const": "automation"},
                "name": {"type": "string", "minLength": 1},
                "description": {"type": "string", "minLength": 1},
                "trigger": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": ["schedule", "event", "webhook"]},
                        "schedule": {"type": ["string", "object"]}
                    },
                    "required": ["type"]
                },
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string"},
                            "action": {"type": "string"},
                            "description": {"type": "string"},
                            "parameters": {"type": "object"}
                        },
                        "required": ["label", "action"]
                    }
                },
                "inputs": {"type": "array", "items": {"type": "object"}},
                "outputs": {"type": "array", "items": {"type": "object"}},
                "permissions": {
                    "type": "string",
                    "enum": ["read_only", "workspace_write", "full_access"],
                    "description": "Permission scope for the artifact."
                },
                "enabled": {"type": "boolean"}
            },
            "required": ["type", "name", "description", "trigger", "steps"]
        }),
    }
}

/// Call LLM with structured output. Uses prompt-based JSON for ALL providers
/// (more reliable than response_format, which many providers don't support
/// and return HTML error pages instead).
async fn call_llm_structured(
    llm: &LlmContext,
    system_prompt: &str,
    user_prompt: &str,
    json_schema: &Value,
) -> Result<ArtifactSpec, String> {
    let client = Client::new();
    let is_anthropic = matches!(llm.provider.as_str(), "anthropic" | "anthropic_compatible");

    if is_anthropic {
        call_anthropic_structured(&client, llm, system_prompt, user_prompt, json_schema).await
    } else {
        call_openai_structured(&client, llm, system_prompt, user_prompt, json_schema).await
    }
}

/// Call OpenAI-compatible API. Uses prompt-based JSON instead of response_format
/// because many providers (local GGUF, OpenRouter, etc.) don't support
/// response_format and return HTML error pages.
///
/// URL construction matches `chat/dispatch.rs` exactly: base_url default is
/// WITHOUT `/v1`, and we append `/v1/chat/completions`. This is critical when a
/// custom base_url is set (e.g. `https://openrouter.ai/api`) — appending just
/// `/chat/completions` instead of `/v1/chat/completions` hits the wrong path and
/// the provider returns an HTML error page.
async fn call_openai_structured(
    client: &Client,
    llm: &LlmContext,
    system_prompt: &str,
    user_prompt: &str,
    json_schema: &Value,
) -> Result<ArtifactSpec, String> {
    let base = llm.base_url.as_deref().unwrap_or("https://api.openai.com");
    let url = format!("{base}/v1/chat/completions");

    // Append schema instructions to the user prompt (prompt-based JSON)
    let user_with_schema = format!(
        "{}\n\nOutput ONLY valid JSON matching this schema. Do NOT include markdown fences or any other text:\n{}",
        user_prompt,
        serde_json::to_string_pretty(json_schema).unwrap()
    );

    let body = serde_json::json!({
        "model": llm.model,
        "stream": false,
        "temperature": 0.1,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_with_schema}
        ],
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", llm.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("API error {}: {}", status, text));
    }

    // Get raw text first so we can include it in error messages
    let raw = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;
    let v: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse JSON response: {} (raw: {})", e, &raw[..raw.len().min(200)]))?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| format!("Missing content in response (raw: {})", &raw[..raw.len().min(200)]))?;

    // Strip markdown fences if the LLM wrapped the JSON in ```json ... ```
    let json_str = content.trim();
    let json_str = if json_str.starts_with("```") {
        json_str
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
    } else {
        json_str
    };

    let spec: ArtifactSpec = serde_json::from_str(json_str).map_err(|e| {
        format!(
            "Failed to parse LLM output as ArtifactSpec: {} (content: {})",
            e,
            &content[..content.len().min(300)]
        )
    })?;

    Ok(spec)
}

/// Call Anthropic API with prompt-based JSON structured output.
async fn call_anthropic_structured(
    client: &Client,
    llm: &LlmContext,
    system_prompt: &str,
    user_prompt: &str,
    json_schema: &Value,
) -> Result<ArtifactSpec, String> {
    let base = llm.base_url.as_deref().unwrap_or("https://api.anthropic.com");
    let url = format!("{base}/v1/messages");

    let user_with_schema = format!(
        "{}\n\nOutput ONLY valid JSON matching this schema:\n{}",
        user_prompt,
        serde_json::to_string_pretty(json_schema).unwrap()
    );

    let body = serde_json::json!({
        "model": llm.model,
        "max_tokens": 4096,
        "stream": false,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_with_schema}]
    });

    let resp = client
        .post(&url)
        .header("x-api-key", &llm.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("HTTP error: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Anthropic API error {}: {}", status, text));
    }

    let raw = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read Anthropic response body: {}", e))?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| {
        format!(
            "Failed to parse Anthropic JSON response: {} (raw: {})",
            e,
            &raw[..raw.len().min(500)]
        )
    })?;
    let content = v["content"][0]["text"]
        .as_str()
        .ok_or_else(|| format!("Missing content in Anthropic response (raw: {})", &raw[..raw.len().min(500)]))?;

    // Strip markdown fences if present
    let json_str = content.trim();
    let json_str = if json_str.starts_with("```") {
        json_str
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
    } else {
        json_str
    };

    let spec: ArtifactSpec = serde_json::from_str(json_str).map_err(|e| {
        format!(
            "Failed to parse Anthropic LLM output as ArtifactSpec: {} (content: {})",
            e,
            &content[..content.len().min(600)]
        )
    })?;

    Ok(spec)
}
