//! Artifact adapter — translates ArtifactSpec into existing persistence model inputs.
//!
//! This is the boundary between the generation contract and the existing
//! artifact systems. The existing systems receive inputs in their native shape.
//!
//! Translation map:
//! - Skill/Loop → `create_installed_skill` (filesystem skill with frontmatter)
//! - PromptTemplate → `create_skill` (DB-backed skill/prompt template)
//! - Automation → `create_automation` (DB-backed automation)

use crate::artifacts::schemas::{
    ArtifactSpec, SkillSpec, LoopSpec, PromptTemplateSpec, AutomationSpec,
};
use crate::db::AutomationInput;
use serde::{Deserialize, Serialize};

/// Parameters for creating an installed skill (filesystem).
/// Matches the `create_installed_skill` Tauri command's args.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkillInput {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub content: String,
    pub kind: String,
}

/// Parameters for creating a DB-backed prompt template.
/// Matches the `create_skill` Tauri command's args.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplateInput {
    pub name: String,
    pub slash_command: String,
    pub content: String,
    pub scope: String,
}

/// The unified adapter output — one variant per existing creation path.
#[derive(Debug, Clone)]
pub enum AdaptedArtifact {
    /// For skills and loops — installed skill (filesystem).
    InstalledSkill(InstalledSkillInput),
    /// For prompt templates — DB-backed skill.
    PromptTemplate(PromptTemplateInput),
    /// For automations — DB-backed automation.
    Automation(AutomationInput),
}

/// Convert an ArtifactSpec into the existing persistence system's input shape.
pub fn adapt(spec: &ArtifactSpec) -> Result<AdaptedArtifact, String> {
    match spec {
        ArtifactSpec::Skill(s) => Ok(AdaptedArtifact::InstalledSkill(adapt_skill(s, "skill"))),
        ArtifactSpec::Loop(l) => Ok(AdaptedArtifact::InstalledSkill(adapt_skill_from_loop(l))),
        ArtifactSpec::PromptTemplate(p) => Ok(AdaptedArtifact::PromptTemplate(adapt_prompt_template(p))),
        ArtifactSpec::Automation(a) => Ok(AdaptedArtifact::Automation(adapt_automation(a))),
    }
}

fn slugify(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn adapt_skill(spec: &SkillSpec, kind: &str) -> InstalledSkillInput {
    let slug = slugify(&spec.name);
    let content = format_skill_markdown(spec);
    InstalledSkillInput {
        slug,
        name: spec.name.clone(),
        description: spec.description.clone(),
        content,
        kind: kind.to_string(),
    }
}

fn adapt_skill_from_loop(spec: &LoopSpec) -> InstalledSkillInput {
    let slug = slugify(&spec.name);
    let content = format_loop_markdown(spec);
    InstalledSkillInput {
        slug,
        name: spec.name.clone(),
        description: spec.description.clone(),
        content,
        kind: "loop".to_string(),
    }
}

fn adapt_prompt_template(spec: &PromptTemplateSpec) -> PromptTemplateInput {
    let slug = slugify(&spec.name);
    let slash_command = format!("/{}", slug);
    PromptTemplateInput {
        name: spec.name.clone(),
        slash_command,
        content: spec.template.clone(),
        scope: "global".to_string(),
    }
}

fn adapt_automation(spec: &AutomationSpec) -> AutomationInput {
    let provided_schedule = spec.trigger.schedule.clone();
    let schedule = provided_schedule.clone().unwrap_or_else(|| "0 9 * * *".to_string());
    let prompt = format_automation_prompt(spec);
    // Creating from chat IS the explicit act of switching the automation on
    // (the user reviewed the preview card and pressed Create). Keep it paused
    // only when the user/model asked for that, or when a schedule-trigger
    // carries no real cron yet — the fallback above invents one, and we never
    // want to start firing on a schedule nobody actually wrote.
    let active = if spec.trigger.kind.eq_ignore_ascii_case("schedule") && provided_schedule.is_none() {
        false
    } else {
        spec.enabled
    };
    // Use the harness/model from the spec (set by the UI picker) or fall back
    // to sensible defaults. This gives users control over how automations
    // run their agent loops.
    AutomationInput {
        name: spec.name.clone(),
        prompt,
        harness: spec.harness.clone().unwrap_or_else(|| "claude_code".to_string()),
        model: spec.model.clone(),
        cwd: None,
        schedule,
        enabled: Some(active),
    }
}

fn format_skill_markdown(spec: &SkillSpec) -> String {
    let mut md = String::new();
    md.push_str(&format!("# {}\n\n", spec.name));
    md.push_str(&format!("{}\n\n", spec.description));
    md.push_str("## Instructions\n\n");
    md.push_str(&format!("{}\n\n", spec.instructions));

    if !spec.inputs.is_empty() {
        md.push_str("## Inputs\n\n");
        for input in &spec.inputs {
            md.push_str(&format!("- **{}**", input.name));
            if let Some(desc) = &input.description {
                md.push_str(&format!(": {}", desc));
            }
            md.push('\n');
        }
        md.push('\n');
    }

    if !spec.outputs.is_empty() {
        md.push_str("## Outputs\n\n");
        for output in &spec.outputs {
            md.push_str(&format!("- **{}**", output.name));
            if let Some(desc) = &output.description {
                md.push_str(&format!(": {}", desc));
            }
            md.push('\n');
        }
        md.push('\n');
    }

    if let Some(tools) = &spec.tools {
        if !tools.is_empty() {
            md.push_str("## Tools\n\n");
            for tool in tools {
                md.push_str(&format!("- {}\n", tool));
            }
            md.push('\n');
        }
    }

    if let Some(examples) = &spec.examples {
        if !examples.is_empty() {
            md.push_str("## Examples\n\n");
            for (i, ex) in examples.iter().enumerate() {
                md.push_str(&format!("### Example {}\n\n", i + 1));
                md.push_str(&format!("**Input:** {}\n\n", ex.input));
                md.push_str(&format!("**Output:** {}\n\n", ex.output));
            }
        }
    }

    md
}

fn format_loop_markdown(spec: &LoopSpec) -> String {
    let mut md = String::new();
    md.push_str(&format!("# {}\n\n", spec.name));
    md.push_str(&format!("{}\n\n", spec.description));
    md.push_str("## Objective\n\n");
    md.push_str(&format!("{}\n\n", spec.objective));

    md.push_str("## Steps\n\n");
    for (i, step) in spec.steps.iter().enumerate() {
        md.push_str(&format!("{}. **{}** — {}\n", i + 1, step.label, step.action));
        if let Some(desc) = &step.description {
            md.push_str(&format!("   {}\n", desc));
        }
    }
    md.push('\n');

    md.push_str("## Iteration\n\n");
    md.push_str(&format!("- Max iterations: {}\n", spec.iteration.max));
    if let Some(cond) = &spec.iteration.condition {
        md.push_str(&format!("- Stop condition: {}\n", cond));
    }
    md.push('\n');

    if !spec.inputs.is_empty() {
        md.push_str("## Inputs\n\n");
        for input in &spec.inputs {
            md.push_str(&format!("- **{}", input.name));
            if let Some(desc) = &input.description {
                md.push_str(&format!(": {}", desc));
            }
            md.push('\n');
        }
        md.push('\n');
    }

    if !spec.outputs.is_empty() {
        md.push_str("## Outputs\n\n");
        for output in &spec.outputs {
            md.push_str(&format!("- **{}**", output.name));
            if let Some(desc) = &output.description {
                md.push_str(&format!(": {}", desc));
            }
            md.push('\n');
        }
        md.push('\n');
    }

    md
}

fn format_automation_prompt(spec: &AutomationSpec) -> String {
    let mut prompt = String::new();
    prompt.push_str(&format!("# {}\n\n", spec.name));
    prompt.push_str(&format!("{}\n\n", spec.description));
    prompt.push_str("## Steps\n\n");
    for (i, step) in spec.steps.iter().enumerate() {
        prompt.push_str(&format!("{}. {} ({})\n", i + 1, step.label, step.action));
        if let Some(desc) = &step.description {
            prompt.push_str(&format!("   {}\n", desc));
        }
    }
    if let Some(inputs) = &spec.inputs {
        if !inputs.is_empty() {
            prompt.push_str("\n## Inputs\n\n");
            for input in inputs {
                prompt.push_str(&format!("- {}", input.name));
                if let Some(desc) = &input.description {
                    prompt.push_str(&format!(": {}", desc));
                }
                prompt.push('\n');
            }
        }
    }
    prompt
}