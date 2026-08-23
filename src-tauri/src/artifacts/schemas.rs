//! Artifact generation contracts — typed structs the LLM produces.
//!
//! These are the GENERATION contract types, NOT the persistence models.
//! Translation to existing models happens in `adapter.rs`.
//!
//! Each spec is complete enough to be shown in the UI before user confirmation.

use serde::{Deserialize, Serialize};

/// Artifact type classifier.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactType {
    Skill,
    Loop,
    PromptTemplate,
    Automation,
}

impl ArtifactType {
    /// Returns the artifact type as a string.
    pub fn as_str(&self) -> &'static str {
        match self {
            ArtifactType::Skill => "skill",
            ArtifactType::Loop => "loop",
            ArtifactType::PromptTemplate => "prompt_template",
            ArtifactType::Automation => "automation",
        }
    }
}

/// Input definition for skill/loop/automation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDefinition {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

/// Output definition for skill/loop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDefinition {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
}

/// Permission policy options.
///
/// `Unknown` exists so that an LLM-invented value (e.g. `"web_access"`) doesn't
/// cause `serde_json::from_str` to reject the whole `ArtifactSpec` — losing the
/// user's `name`, `description`, and `steps` is worse than silently treating
/// an unrecognized scope as workspace-write. The validator / adapter then
/// treat `Unknown` as the default scope.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PermissionPolicy {
    ReadOnly,
    WorkspaceWrite,
    FullAccess,
    #[serde(other)]
    #[default]
    Unknown,
}

/// Tool configuration for skills.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
}

/// Example for skill/prompt template.
///
/// `input` and `output` are typed as `String` (the adapter reads them as
/// scalars), but LLMs sometimes emit a JSON object/map for `input`
/// (e.g. `{"input": {"query": "..."}}`) because the JSON schema leaves the
/// inner shape of `examples[]` unconstrained. We accept either form and
/// normalize a map to a JSON-encoded string so the whole spec isn't dropped.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Example {
    #[serde(deserialize_with = "deserialize_string_or_map")]
    pub input: String,
    #[serde(deserialize_with = "deserialize_string_or_map")]
    pub output: String,
}

/// Prompt variable for template specs.
///
/// `default` is `Option<String>`, but the LLM may emit a map (e.g.
/// `{"default": {"value": "ts"}}`) because the schema doesn't constrain the
/// inner shape of `variables[].default`. We coerce to an optional JSON-encoded
/// string rather than dropping the entire spec on a single malformed field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptVariable {
    pub name: String,
    #[serde(default, deserialize_with = "deserialize_optional_string_or_map")]
    pub description: Option<String>,
    #[serde(default)]
    pub required: bool,
    #[serde(default, deserialize_with = "deserialize_optional_string_or_map")]
    pub default: Option<String>,
}

/// Example for prompt template.
///
/// `output` is `String` but the LLM may emit an object (e.g. when it tries to
/// attach format metadata). We coerce a map to a JSON-encoded string so the
/// spec survives for the user to review/edit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptExample {
    pub variables: serde_json::Value,
    #[serde(deserialize_with = "deserialize_string_or_map")]
    pub output: String,
}

/// Workflow step for loops/automations.
///
/// `label` and `action` are `String`, but the LLM may emit an object instead
/// (e.g. `{"action": {"name": "search", ...}}`) because the loop/automation
/// schemas don't constrain the inner shape of `steps[]`. We coerce a map to a
/// JSON-encoded string so the spec survives.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStep {
    #[serde(deserialize_with = "deserialize_string_or_map")]
    pub label: String,
    pub description: Option<String>,
    #[serde(deserialize_with = "deserialize_string_or_map")]
    pub action: String,
    #[serde(default)]
    pub parameters: Option<serde_json::Value>,
}

/// Iteration configuration for loops.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IterationConfig {
    pub max: i64,
    #[serde(default)]
    pub condition: Option<String>,
}

/// Trigger type for automations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationTrigger {
    #[serde(rename = "type")]
    pub kind: String,

    /// Cron schedule string. The LLM may produce either:
    /// - schedule: "0 8 * * 1-5" (string)
    /// - schedule: { cron: "0 8 * * 1-5" } (object)
    /// This deserializes both gracefully without hard failure.
    #[serde(deserialize_with = "deserialize_trigger_schedule")]
    pub schedule: Option<String>,
}

fn deserialize_trigger_schedule<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{self, Deserialize, MapAccess, Visitor};

    #[derive(Debug)]
    enum ScheduleValue {
        String(String),
        Object { cron: Option<String> },
        Missing,
    }

    impl<'de> Deserialize<'de> for ScheduleValue {
        fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            struct ScheduleVisitor;

            impl<'de> Visitor<'de> for ScheduleVisitor {
                type Value = ScheduleValue;

                fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                    formatter.write_str("a string or object with `cron` field")
                }

                fn visit_str<E>(self, s: &str) -> Result<Self::Value, E>
                where
                    E: de::Error,
                {
                    Ok(ScheduleValue::String(s.to_owned()))
                }

                fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
                where
                    A: MapAccess<'de>,
                {
                    let mut cron = None;
                    while let Some(key) = map.next_key::<String>()? {
                        if key == "cron" {
                            cron = Some(map.next_value::<String>()?);
                        } else {
                            map.next_value::<serde_json::Value>()?;
                        }
                    }
                    Ok(ScheduleValue::Object { cron })
                }

                fn visit_none<E>(self) -> Result<Self::Value, E>
                where
                    E: de::Error,
                {
                    Ok(ScheduleValue::Missing)
                }

                fn visit_unit<E>(self) -> Result<Self::Value, E>
                where
                    E: de::Error,
                {
                    Ok(ScheduleValue::Missing)
                }
            }

            deserializer.deserialize_any(ScheduleVisitor)
        }
    }

    match Option::<ScheduleValue>::deserialize(deserializer)? {
        None => Ok(None),
        Some(ScheduleValue::String(s)) => Ok(Some(s)),
        Some(ScheduleValue::Object { cron }) => Ok(cron),
        Some(ScheduleValue::Missing) => Ok(None),
    }
}

/// Coerce any JSON value into a `String`.
///
/// LLMs sometimes emit a JSON object/map where a scalar `String` is expected
/// (e.g. `{"input": {"query": "..."}}` for a skill example, or `{"action":
/// {"name": "search"}}` for a loop step). Without this coercion, serde rejects
/// the ENTIRE `ArtifactSpec` — losing the user's `name`, `description`,
/// `steps`, etc. — for one malformed field. Instead, we JSON-encode the value
/// so the spec survives for the user to review and edit.
fn coerce_value_to_string(value: serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s,
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Null => String::new(),
        // Map or array → JSON-encode so the data is preserved and the user can
        // see what the LLM produced rather than getting a generic parse error.
        other => other.to_string(),
    }
}

/// Deserialize a field as a `String`, coercing non-string JSON values (objects,
/// arrays, numbers, booleans) to their JSON string form instead of failing.
fn deserialize_string_or_map<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(coerce_value_to_string(value))
}

/// Deserialize an `Option<String>` field, coercing non-string JSON values to
/// their JSON string form, and treating `null`/missing as `None`.
fn deserialize_optional_string_or_map<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.map(coerce_value_to_string))
}

/// The main generation contract — what LLM produces.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ArtifactSpec {
    Skill(SkillSpec),
    Loop(LoopSpec),
    PromptTemplate(PromptTemplateSpec),
    Automation(AutomationSpec),
}

impl ArtifactSpec {
    /// Extract the artifact name from any variant.
    pub fn name(&self) -> String {
        match self {
            ArtifactSpec::Skill(s) => s.name.clone(),
            ArtifactSpec::Loop(l) => l.name.clone(),
            ArtifactSpec::PromptTemplate(p) => p.name.clone(),
            ArtifactSpec::Automation(a) => a.name.clone(),
        }
    }

    /// Generate a URL-safe slug from the artifact name.
    pub fn slug(&self) -> String {
        slugify(&self.name())
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

/// Skill generation contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSpec {
    pub name: String,
    pub description: String,
    pub instructions: String,
    #[serde(default)]
    pub inputs: Vec<InputDefinition>,
    #[serde(default)]
    pub outputs: Vec<OutputDefinition>,
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    #[serde(default)]
    pub model: Option<ModelConfig>,
    #[serde(default)]
    pub permissions: Option<PermissionPolicy>,
    #[serde(default)]
    pub examples: Option<Vec<Example>>,
}

/// Loop generation contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopSpec {
    pub name: String,
    pub description: String,
    pub objective: String,
    #[serde(default)]
    pub inputs: Vec<InputDefinition>,
    pub steps: Vec<WorkflowStep>,
    pub iteration: IterationConfig,
    #[serde(default)]
    pub outputs: Vec<OutputDefinition>,
    #[serde(default)]
    pub permissions: Option<PermissionPolicy>,
}

/// Prompt template generation contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptTemplateSpec {
    pub name: String,
    pub description: String,
    pub template: String,
    #[serde(default)]
    pub variables: Vec<PromptVariable>,
    #[serde(default)]
    pub output_format: Option<String>,
    #[serde(default)]
    pub examples: Option<Vec<PromptExample>>,
}

/// Automation generation contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSpec {
    pub name: String,
    pub description: String,
    pub trigger: AutomationTrigger,
    pub steps: Vec<WorkflowStep>,
    /// Harness/agent that runs each fire ("claude_code", "opencode", …).
    /// Optional — the adapter falls back to the default harness.
    #[serde(default)]
    pub harness: Option<String>,
    /// Model to use within the harness. Empty/None = harness's default model.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub inputs: Option<Vec<InputDefinition>>,
    #[serde(default)]
    pub outputs: Option<Vec<OutputDefinition>>,
    #[serde(default)]
    pub permissions: Option<PermissionPolicy>,
    /// Active on creation unless the user explicitly asked for it paused.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}