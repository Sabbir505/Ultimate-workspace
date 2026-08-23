//! Per-type strict validation of generated artifact specs.

use crate::artifacts::schemas::{
    ArtifactSpec, SkillSpec, LoopSpec, PromptTemplateSpec, AutomationSpec,
};
use crate::artifacts::proposal::{ArtifactProposal, ValidationResult};

/// Validate an artifact proposal against its type-specific schema.
pub fn validate_artifact(proposal: &ArtifactProposal) -> ValidationResult {
    match &proposal.spec {
        ArtifactSpec::Skill(s) => validate_skill(s),
        ArtifactSpec::Loop(l) => validate_loop(l),
        ArtifactSpec::PromptTemplate(p) => validate_prompt_template(p),
        ArtifactSpec::Automation(a) => validate_automation(a),
    }
}

fn validate_skill(spec: &SkillSpec) -> ValidationResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if spec.name.trim().is_empty() {
        errors.push("Skill name is required".to_string());
    }
    if spec.description.trim().is_empty() {
        warnings.push("Skill description is empty".to_string());
    }
    if spec.instructions.trim().is_empty() {
        errors.push("Skill instructions are required".to_string());
    }
    // Tools are optional but if present, warn about unknown tools
    if let Some(tools) = &spec.tools {
        for tool in tools {
            if !is_known_tool(tool) {
                warnings.push(format!("Unknown tool '{}' — may not be available", tool));
            }
        }
    }

    ValidationResult {
        valid: errors.is_empty(),
        errors,
        warnings,
    }
}

fn validate_loop(spec: &LoopSpec) -> ValidationResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if spec.name.trim().is_empty() {
        errors.push("Loop name is required".to_string());
    }
    if spec.objective.trim().is_empty() {
        errors.push("Loop objective is required".to_string());
    }
    if spec.steps.is_empty() {
        errors.push("At least one step is required".to_string());
    }
    if spec.iteration.max <= 0 {
        errors.push("maxIterations must be positive".to_string());
    }
    if spec.iteration.max > 100 {
        warnings.push("maxIterations > 100 may cause runaway loops".to_string());
    }
    // Validate each step has required fields
    for (i, step) in spec.steps.iter().enumerate() {
        if step.label.trim().is_empty() {
            errors.push(format!("Step {} label is required", i + 1));
        }
        if step.action.trim().is_empty() {
            errors.push(format!("Step {} action is required", i + 1));
        }
    }

    ValidationResult {
        valid: errors.is_empty(),
        errors,
        warnings,
    }
}

fn validate_prompt_template(spec: &PromptTemplateSpec) -> ValidationResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if spec.name.trim().is_empty() {
        errors.push("Template name is required".to_string());
    }
    if spec.template.trim().is_empty() {
        errors.push("Template content is required".to_string());
    }
    // Check that all variables used in template are declared
    let declared_vars: std::collections::HashSet<_> = spec.variables.iter().map(|v| v.name.as_str()).collect();
    let used_vars = extract_variables(&spec.template);
    for var in used_vars {
        if !is_declared(&declared_vars, &var) {
            warnings.push(format!("Variable '{}' used in template but not declared", var));
        }
    }
    // Check required variables have defaults or are marked required
    for var in &spec.variables {
        if var.required && var.default.is_none() {
            warnings.push(format!("Required variable '{}' has no default", var.name));
        }
    }

    ValidationResult {
        valid: errors.is_empty(),
        errors,
        warnings,
    }
}

fn validate_automation(spec: &AutomationSpec) -> ValidationResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if spec.name.trim().is_empty() {
        errors.push("Automation name is required".to_string());
    }
    if spec.steps.is_empty() {
        errors.push("At least one step is required".to_string());
    }
    // Validate trigger
    match spec.trigger.kind.as_str() {
        "schedule" => {
            if spec.trigger.schedule.is_none() || spec.trigger.schedule.as_ref().unwrap().trim().is_empty() {
                errors.push("Schedule cron expression is required for schedule trigger".to_string());
            } else if !is_valid_cron(spec.trigger.schedule.as_ref().unwrap()) {
                warnings.push("Schedule cron expression may be invalid".to_string());
            }
        }
        "event" => {
            if spec.trigger.schedule.is_some() {
                warnings.push("Event trigger should not have a schedule".to_string());
            }
        }
        "webhook" => {
            // webhook is valid, no schedule needed
        }
        _ => {
            errors.push(format!("Unknown trigger type: {}", spec.trigger.kind));
        }
    }

    // Validate steps
    for (i, step) in spec.steps.iter().enumerate() {
        if step.label.trim().is_empty() {
            errors.push(format!("Step {} label is required", i + 1));
        }
        if step.action.trim().is_empty() {
            errors.push(format!("Step {} action is required", i + 1));
        }
    }

    // Warn about enabled=false default
    if spec.enabled {
        warnings.push("Automation created enabled=true — will run on schedule".to_string());
    }

    ValidationResult {
        valid: errors.is_empty(),
        errors,
        warnings,
    }
}

/// Extract {{variable}} patterns from template string.
fn extract_variables(template: &str) -> Vec<String> {
    let re = regex::Regex::new(r"\{\{(\w+)\}\}").unwrap();
    re.captures_iter(template)
        .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

/// Check if variable is declared (reference to avoid move).
fn is_declared(declared_vars: &std::collections::HashSet<&str>, var: &str) -> bool {
    declared_vars.contains(var)
}

/// Simple cron validation — checks 5 fields.
fn is_valid_cron(cron: &str) -> bool {
    let fields: Vec<&str> = cron.split_whitespace().collect();
    fields.len() == 5
}

/// Known tool names for validation.
fn is_known_tool(tool: &str) -> bool {
    matches!(
        tool,
        "read_file" | "write_file" | "edit_file" | "list_directory" |
        "search_files" | "glob" | "grep" | "run_shell" | "download_file" |
        "web_search" | "web_fetch" | "browser_navigate" | "browser_click" |
        "browser_type" | "browser_extract" | "browser_screenshot" |
        "github_list_issues" | "github_get_issue" | "github_create_issue" |
        "github_comment_issue" | "github_list_prs" | "github_get_pr" |
        "github_create_pr" | "github_review_pr" | "git_status" | "git_diff" |
        "git_commit" | "git_push" | "git_log" | "git_branch" |
        "mcp_call_tool" | "think" | "todo_write"
    )
}