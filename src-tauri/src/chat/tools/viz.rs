//! The `visualize` tool: structured visualization payloads rendered by
//! Relay's OWN components (docs/architecture/IN_APP_VISUALIZATION.md, the
//! structured-renderer layer). The model supplies a presentation type and a
//! data payload — never UI code. [`build_viz_payload`] is the single
//! validator/normalizer: `execute_tool` turns its errors into model-facing
//! retryable text, and `proto::tool_block` embeds the normalized payload in
//! the `viz-data` marker the frontend renders through its renderer registry.

use serde_json::{json, Value};

/// Hard cap on the normalized payload (serialized JSON chars). A chart, table
/// or board past this size is unreadable as a chat card anyway; the model is
/// told to aggregate. `tool_block` also refuses to embed anything larger.
pub const VIZ_MAX_PAYLOAD_CHARS: usize = 32_768;

const MAX_BARS: usize = 200;
const MAX_TABLE_COLS: usize = 12;
const MAX_TABLE_ROWS: usize = 500;
const MAX_BOARD_COLS: usize = 8;
const MAX_BOARD_TASKS: usize = 100;
const MAX_TIMELINE_EVENTS: usize = 100;
const MAX_LINE_POINTS: usize = 200;
const MAX_DONUT_SEGMENTS: usize = 12;
const MAX_STATS: usize = 8;
const MAX_PALETTE: usize = 8;

// ── Composition (the `stack` container) ────────────────────────────────────
// A stack composes other renderers plus prose into one card. The per-kind
// caps above still apply to EACH child, but composition must not become a way
// around them, so the budget is also AGGREGATE across the whole tree: the
// same numbers, summed. One shared struct so the two sides of the mirror (this
// file and src/lib/viz.ts) count identically — see `tally`.
const MAX_STACK_SECTIONS: usize = 8;
const MAX_STACK_DEPTH: usize = 3;
const MAX_STACK_LEAVES: usize = 12;
const MAX_PROSE_CHARS: usize = 4_096;

pub const VIZ_KINDS: [&str; 10] = [
    "chart",
    "table",
    "task-board",
    "timeline",
    "line",
    "donut",
    "stat",
    // Composition: a container whose sections are other cards + prose.
    "stack",
    // Leaf kinds that make the reference "rich content"/"patterns" cases
    // expressible inside a typed card (markdown reuses the chat's own
    // renderer, so headings, code, math, tables and citations come free).
    "prose",
    "divider",
];

/// A color the model may hand a renderer: hex, rgb()/rgba(), hsl()/hsla()
/// only — anything that could smuggle CSS (url(), var(), semicolons, braces)
/// is rejected here, so style values can be dropped into CSS custom
/// properties verbatim.
fn safe_color(v: &Value, what: &str) -> Result<String, String> {
    let s = v
        .as_str()
        .ok_or_else(|| format!("{what} must be a color string"))?
        .trim();
    if s.is_empty() || s.chars().count() > 40 {
        return Err(format!("{what} must be a color string of at most 40 characters"));
    }
    let ok = (s.starts_with('#')
        && s[1..]
            .chars()
            .all(|c| c.is_ascii_hexdigit())
        && matches!(s.len(), 4 | 5 | 7 | 9))
        || (s.starts_with("rgb(") && s.ends_with(')'))
        || (s.starts_with("rgba(") && s.ends_with(')'))
        || (s.starts_with("hsl(") && s.ends_with(')'))
        || (s.starts_with("hsla(") && s.ends_with(')'));
    if !ok || s.contains(';') || s.contains('{') || s.contains('}') || s.contains('<') {
        return Err(format!(
            "{what} must be a plain color (hex like #4f8ef7, or rgb()/rgba()/hsl()/hsla())"
        ));
    }
    Ok(s.to_string())
}

/// The agent-chosen style block — the model's creativity lever. Absent or
/// partial styles fall back to Relay's own theme per property, so a chart can
/// be "just data" one turn and art-directed the next.
fn build_style(payload: &Value) -> Result<Option<Value>, String> {
    let style = match payload.get("style") {
        None | Some(Value::Null) => return Ok(None),
        Some(v) if v.is_object() => v,
        Some(_) => return Err("style must be an object".into()),
    };
    let accent = match style.get("accent") {
        None | Some(Value::Null) => None,
        Some(v) => Some(safe_color(v, "style.accent")?),
    };
    let palette = match style.get("palette") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => {
            if items.is_empty() {
                return Err("style.palette must not be empty".into());
            }
            if items.len() > MAX_PALETTE {
                return Err(format!("style.palette must have at most {MAX_PALETTE} colors"));
            }
            let mut colors = Vec::with_capacity(items.len());
            for (i, c) in items.iter().enumerate() {
                colors.push(Value::String(safe_color(c, &format!("style.palette[{i}]"))?));
            }
            Some(Value::Array(colors))
        }
        Some(_) => return Err("style.palette must be an array of colors".into()),
    };
    let tone = match style.get("tone") {
        None | Some(Value::Null) => None,
        Some(Value::String(t)) => match t.trim() {
            "app" | "light" | "dark" => Some(t.trim().to_string()),
            other => {
                return Err(format!(
                    "style.tone must be \"app\", \"light\" or \"dark\" (got \"{other}\")"
                ))
            }
        },
        Some(_) => return Err("style.tone must be a string".into()),
    };
    let radius = match style.get("radius") {
        None | Some(Value::Null) => None,
        Some(Value::String(t)) => match t.trim() {
            "soft" | "sharp" | "pill" => Some(t.trim().to_string()),
            other => {
                return Err(format!(
                    "style.radius must be \"soft\", \"sharp\" or \"pill\" (got \"{other}\")"
                ))
            }
        },
        Some(_) => return Err("style.radius must be a string".into()),
    };
    if accent.is_none() && palette.is_none() && tone.is_none() && radius.is_none() {
        return Ok(None);
    }
    Ok(Some(json!({
        "accent": accent,
        "palette": palette,
        "tone": tone,
        "radius": radius,
    })))
}

fn read_title(args: &Value) -> Result<Option<String>, String> {
    match args.get("title") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() {
                return Ok(None);
            }
            if s.chars().count() > 120 {
                return Err("title must be at most 120 characters".into());
            }
            Ok(Some(s.to_string()))
        }
        Some(_) => Err("title must be a string".into()),
    }
}

/// Read one bounded string field; numbers are rejected (the model should send
/// strings for labels), but a missing field with a default is allowed.
fn bounded_string(value: &Value, field: &str, max: usize, required: bool) -> Result<String, String> {
    let s = match value.get(field) {
        None | Some(Value::Null) => {
            return if required {
                Err(format!("{field} is required"))
            } else {
                Ok(String::new())
            }
        }
        Some(Value::String(s)) => s.trim(),
        Some(_) => return Err(format!("{field} must be a string")),
    };
    if required && s.is_empty() {
        return Err(format!("{field} must not be empty"));
    }
    if s.chars().count() > max {
        return Err(format!("{field} must be at most {max} characters"));
    }
    Ok(s.to_string())
}

fn build_chart(title: Option<String>, payload: &Value, style: Option<Value>) -> Result<Value, String> {
    let bars = payload
        .get("bars")
        .and_then(Value::as_array)
        .ok_or("chart payload needs a \"bars\" array")?;
    if bars.is_empty() {
        return Err("chart bars must contain at least one item".into());
    }
    if bars.len() > MAX_BARS {
        return Err(format!("chart bars must have at most {MAX_BARS} items — aggregate the data"));
    }
    let mut out = Vec::with_capacity(bars.len());
    for (i, bar) in bars.iter().enumerate() {
        let label = bounded_string(bar, "label", 120, true)
            .map_err(|e| format!("bars[{i}]: {e}"))?;
        let value = bar
            .get("value")
            .and_then(Value::as_f64)
            .ok_or(format!("bars[{i}]: value must be a finite number"))?;
        if !value.is_finite() {
            return Err(format!("bars[{i}]: value must be a finite number"));
        }
        // Integers serialize without the trailing ".0" so the UI's labels read clean.
        let value = if value.fract() == 0.0 && value.abs() < 1e15 {
            json!(value as i64)
        } else {
            json!(value)
        };
        out.push(json!({ "label": label, "value": value }));
    }
    let unit = match payload.get("unit") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.chars().count() > 24 {
                return Err("unit must be at most 24 characters".into());
            }
            if s.is_empty() { None } else { Some(s.to_string()) }
        }
        Some(_) => return Err("unit must be a string".into()),
    };
    Ok(json!({
        "kind": "chart",
        "title": title,
        "unit": unit,
        "style": style,
        "bars": out,
    }))
}

fn build_table(title: Option<String>, payload: &Value, style: Option<Value>) -> Result<Value, String> {
    let columns = payload
        .get("columns")
        .and_then(Value::as_array)
        .ok_or("table payload needs a \"columns\" array")?;
    if columns.is_empty() {
        return Err("table columns must contain at least one column".into());
    }
    if columns.len() > MAX_TABLE_COLS {
        return Err(format!("table columns must have at most {MAX_TABLE_COLS} entries"));
    }
    let mut cols = Vec::with_capacity(columns.len());
    for (i, col) in columns.iter().enumerate() {
        let (label, align) = match col {
            Value::String(s) => {
                let s = s.trim();
                if s.is_empty() {
                    return Err(format!("columns[{i}]: label must not be empty"));
                }
                if s.chars().count() > 80 {
                    return Err(format!("columns[{i}]: label must be at most 80 characters"));
                }
                (s.to_string(), "left")
            }
            Value::Object(_) => {
                let label = bounded_string(col, "label", 80, true)
                    .map_err(|e| format!("columns[{i}]: {e}"))?;
                let align = match col.get("align") {
                    None | Some(Value::Null) => "left",
                    Some(Value::String(a)) if a == "left" || a == "right" => a.as_str(),
                    Some(_) => return Err(format!("columns[{i}]: align must be \"left\" or \"right\"")),
                };
                (label, align)
            }
            _ => return Err(format!("columns[{i}]: must be a string or {{label, align}}")),
        };
        cols.push(json!({ "label": label, "align": align }));
    }
    let rows = payload
        .get("rows")
        .and_then(Value::as_array)
        .ok_or("table payload needs a \"rows\" array")?;
    if rows.len() > MAX_TABLE_ROWS {
        return Err(format!("table rows must have at most {MAX_TABLE_ROWS} entries — paginate or aggregate"));
    }
    let width = cols.len();
    let mut out_rows: Vec<Vec<Value>> = Vec::with_capacity(rows.len());
    for (r, row) in rows.iter().enumerate() {
        let cells = row
            .as_array()
            .ok_or(format!("rows[{r}]: must be an array of cells"))?;
        if cells.len() != width {
            return Err(format!(
                "rows[{r}]: has {} cells, expected {width} (one per column)",
                cells.len()
            ));
        }
        let mut out_cells = Vec::with_capacity(cells.len());
        for (c, cell) in cells.iter().enumerate() {
            let text = match cell {
                Value::String(s) => {
                    if s.chars().count() > 300 {
                        return Err(format!("rows[{r}][{c}]: cell must be at most 300 characters"));
                    }
                    s.clone()
                }
                // Numbers are common model output for data tables — stringify.
                Value::Number(n) => n.to_string(),
                Value::Null => String::new(),
                _ => return Err(format!("rows[{r}][{c}]: cell must be a string or number")),
            };
            out_cells.push(Value::String(text));
        }
        out_rows.push(out_cells);
    }
    let rows_json: Vec<Value> = out_rows
        .into_iter()
        .map(|cells| Value::Array(cells))
        .collect();
    Ok(json!({
        "kind": "table",
        "title": title,
        "style": style,
        "columns": cols,
        "rows": rows_json,
    }))
}

fn build_board(title: Option<String>, payload: &Value, style: Option<Value>) -> Result<Value, String> {
    let columns = payload
        .get("columns")
        .and_then(Value::as_array)
        .ok_or("task-board payload needs a \"columns\" array")?;
    if columns.is_empty() {
        return Err("task-board columns must contain at least one column".into());
    }
    if columns.len() > MAX_BOARD_COLS {
        return Err(format!("task-board columns must have at most {MAX_BOARD_COLS} entries"));
    }
    let mut cols = Vec::with_capacity(columns.len());
    for (i, col) in columns.iter().enumerate() {
        let col_title =
            bounded_string(col, "title", 80, true).map_err(|e| format!("columns[{i}]: {e}"))?;
        let tasks = col
            .get("tasks")
            .and_then(Value::as_array)
            .ok_or(format!("columns[{i}]: needs a \"tasks\" array"))?;
        if tasks.len() > MAX_BOARD_TASKS {
            return Err(format!(
                "columns[{i}]: tasks must have at most {MAX_BOARD_TASKS} entries"
            ));
        }
        let mut out_tasks = Vec::with_capacity(tasks.len());
        for (t, task) in tasks.iter().enumerate() {
            let task_title = bounded_string(task, "title", 160, true)
                .map_err(|e| format!("columns[{i}].tasks[{t}]: {e}"))?;
            let meta = bounded_string(task, "meta", 120, false)
                .map_err(|e| format!("columns[{i}].tasks[{t}]: {e}"))?;
            out_tasks.push(if meta.is_empty() {
                json!({ "title": task_title })
            } else {
                json!({ "title": task_title, "meta": meta })
            });
        }
        cols.push(json!({ "title": col_title, "tasks": out_tasks }));
    }
    Ok(json!({
        "kind": "task-board",
        "title": title,
        "style": style,
        "columns": cols,
    }))
}

fn build_timeline(title: Option<String>, payload: &Value, style: Option<Value>) -> Result<Value, String> {
    let events = payload
        .get("events")
        .and_then(Value::as_array)
        .ok_or("timeline payload needs an \"events\" array")?;
    if events.is_empty() {
        return Err("timeline events must contain at least one event".into());
    }
    if events.len() > MAX_TIMELINE_EVENTS {
        return Err(format!(
            "timeline events must have at most {MAX_TIMELINE_EVENTS} entries"
        ));
    }
    let mut out = Vec::with_capacity(events.len());
    for (i, ev) in events.iter().enumerate() {
        let label =
            bounded_string(ev, "label", 160, true).map_err(|e| format!("events[{i}]: {e}"))?;
        let detail = bounded_string(ev, "detail", 300, false)
            .map_err(|e| format!("events[{i}]: {e}"))?;
        let at = bounded_string(ev, "at", 40, false).map_err(|e| format!("events[{i}]: {e}"))?;
        out.push(json!({
            "label": label,
            "detail": detail,
            "at": at,
        }));
    }
    Ok(json!({
        "kind": "timeline",
        "title": title,
        "style": style,
        "events": out,
    }))
}

fn build_line(title: Option<String>, payload: &Value, style: Option<Value>) -> Result<Value, String> {
    let points = payload
        .get("points")
        .and_then(Value::as_array)
        .ok_or("line payload needs a \"points\" array")?;
    if points.len() < 2 {
        return Err("line points must contain at least 2 items — a line needs a trend".into());
    }
    if points.len() > MAX_LINE_POINTS {
        return Err(format!("line points must have at most {MAX_LINE_POINTS} entries — downsample"));
    }
    let mut out = Vec::with_capacity(points.len());
    for (i, pt) in points.iter().enumerate() {
        let value = pt
            .get("value")
            .and_then(Value::as_f64)
            .ok_or(format!("points[{i}]: value must be a finite number"))?;
        if !value.is_finite() {
            return Err(format!("points[{i}]: value must be a finite number"));
        }
        let label = bounded_string(pt, "label", 80, false)
            .map_err(|e| format!("points[{i}]: {e}"))?;
        out.push(json!({
            "label": label,
            "value": if value.fract() == 0.0 && value.abs() < 1e15 { json!(value as i64) } else { json!(value) },
        }));
    }
    let unit = match payload.get("unit") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.chars().count() > 24 {
                return Err("unit must be at most 24 characters".into());
            }
            if s.is_empty() { None } else { Some(s.to_string()) }
        }
        Some(_) => return Err("unit must be a string".into()),
    };
    let area = match payload.get("area") {
        None | Some(Value::Null) => true, // area fill reads better by default
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("area must be a boolean".into()),
    };
    Ok(json!({
        "kind": "line",
        "title": title,
        "unit": unit,
        "area": area,
        "style": style,
        "points": out,
    }))
}

fn build_donut(title: Option<String>, payload: &Value, style: Option<Value>) -> Result<Value, String> {
    let segments = payload
        .get("segments")
        .and_then(Value::as_array)
        .ok_or("donut payload needs a \"segments\" array")?;
    if segments.is_empty() {
        return Err("donut segments must contain at least one segment".into());
    }
    if segments.len() > MAX_DONUT_SEGMENTS {
        return Err(format!(
            "donut segments must have at most {MAX_DONUT_SEGMENTS} entries — merge the small slices"
        ));
    }
    let mut out = Vec::with_capacity(segments.len());
    let mut total: f64 = 0.0;
    for (i, seg) in segments.iter().enumerate() {
        let label = bounded_string(seg, "label", 120, true)
            .map_err(|e| format!("segments[{i}]: {e}"))?;
        let value = seg
            .get("value")
            .and_then(Value::as_f64)
            .ok_or(format!("segments[{i}]: value must be a finite number"))?;
        if !value.is_finite() || value < 0.0 {
            return Err(format!("segments[{i}]: value must be a non-negative finite number"));
        }
        total += value;
        out.push(json!({ "label": label, "value": value }));
    }
    if total <= 0.0 {
        return Err("donut segments must sum to a positive total".into());
    }
    let unit = match payload.get("unit") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.chars().count() > 24 {
                return Err("unit must be at most 24 characters".into());
            }
            if s.is_empty() { None } else { Some(s.to_string()) }
        }
        Some(_) => return Err("unit must be a string".into()),
    };
    Ok(json!({
        "kind": "donut",
        "title": title,
        "unit": unit,
        "style": style,
        "total": total,
        "segments": out,
    }))
}

fn build_stat(title: Option<String>, payload: &Value, style: Option<Value>) -> Result<Value, String> {
    let stats = payload
        .get("stats")
        .and_then(Value::as_array)
        .ok_or("stat payload needs a \"stats\" array")?;
    if stats.is_empty() {
        return Err("stat stats must contain at least one item".into());
    }
    if stats.len() > MAX_STATS {
        return Err(format!("stat stats must have at most {MAX_STATS} items"));
    }
    let mut out = Vec::with_capacity(stats.len());
    for (i, st) in stats.iter().enumerate() {
        let label =
            bounded_string(st, "label", 80, true).map_err(|e| format!("stats[{i}]: {e}"))?;
        let value = bounded_string(st, "value", 24, true).map_err(|e| format!("stats[{i}]: {e}"))?;
        // Optional signed delta: rendered with +/− direction and success/danger color.
        let delta = match st.get("delta") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => {
                let s = s.trim();
                if s.chars().count() > 24 {
                    return Err(format!("stats[{i}]: delta must be at most 24 characters"));
                }
                if s.is_empty() { None } else { Some(s.to_string()) }
            }
            Some(_) => return Err(format!("stats[{i}]: delta must be a string")),
        };
        let good = match st.get("good") {
            None | Some(Value::Null) => None,
            Some(Value::Bool(b)) => Some(*b),
            Some(_) => return Err(format!("stats[{i}]: good must be a boolean")),
        };
        out.push(json!({
            "label": label,
            "value": value,
            "delta": delta,
            "good": good,
        }));
    }
    Ok(json!({
        "kind": "stat",
        "title": title,
        "style": style,
        "stats": out,
    }))
}

/// Parse a JSON-stringified object field in place. Several models emit the
/// nested `payload` (or its `style`) as a STRING instead of an inline object;
/// a valid stringified object is still the request they meant, so it is
/// parsed rather than rejected. Anything that is not a JSON object is left
/// untouched for the validator to reject with its precise error.
fn unstringify(map: &mut serde_json::Map<String, Value>, key: &str) {
    let Some(Value::String(raw)) = map.get(key) else {
        return;
    };
    let Ok(Value::Object(inner)) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    map.insert(key.to_string(), Value::Object(inner));
}

/// Normalize a `visualize` request into the canonical arg shape (`viz`,
/// optional `title`, `payload` object) BEFORE validation. Harness CLIs report
/// tool calls in shapes the tool loop already tolerates elsewhere: the call
/// wrapped in an `arguments` envelope (object or JSON string), and objects
/// the model JSON-stringified. Normalizing here — inside the one validator —
/// keeps the tool AND both marker emitters (`proto::tool_block`,
/// `agent_sessions::tool_meta_generic`) validating the SAME shape.
///
/// The regression this fixes: commandcode reported seven `visualize` calls
/// whose `payload` was a stringified object, repaired it client-side before
/// calling the tool (so every card rendered) — while the marker path
/// re-validated the CLI's raw input, failed on "payload must be an object",
/// and degraded all seven rows to a bare "Preparing visualization" step with
/// no card and no reason.
fn normalize_viz_args(args: &Value) -> Value {
    let Some(map) = args.as_object() else {
        return args.clone();
    };
    let mut out = if !map.contains_key("viz") && !map.contains_key("payload") {
        match map.get("arguments") {
            Some(Value::Object(inner)) => inner.clone(),
            Some(Value::String(raw)) => match serde_json::from_str::<Value>(raw) {
                Ok(Value::Object(inner)) => inner,
                _ => serde_json::Map::new(),
            },
            _ => map.clone(),
        }
    } else {
        map.clone()
    };
    // Style may be flattened onto the args (documented leniency) or hung off
    // the payload (documented shape) — unstringify both positions.
    unstringify(&mut out, "payload");
    unstringify(&mut out, "style");
    if let Some(Value::Object(payload)) = out.get_mut("payload") {
        unstringify(payload, "style");
    }
    Value::Object(out)
}

/// Aggregate composition budget: the leaf renderer count plus every data
/// element summed across the whole `stack` tree. The per-kind caps still apply
/// to EACH child (in the `build_*` functions); this is the aggregate, so
/// nesting cannot be used to smuggle eight 200-bar charts into one card.
///
/// Mirrored one-for-one by `src/lib/viz.ts` (the rendering gate). A drift
/// between the two shows up exactly the way the last two bugs did — a card
/// the backend accepts that the gate refuses — which is why the shared corpus
/// (`src/test/viz-corpus.json`) is asserted from BOTH languages.
#[derive(Default)]
struct VizBudget {
    leaves: usize,
    bars: usize,
    points: usize,
    rows: usize,
    tasks: usize,
    events: usize,
    segments: usize,
    stats: usize,
}

impl VizBudget {
    /// Count one built child and enforce the aggregate caps.
    fn tally(&mut self, kind: &str, built: &Value) -> Result<(), String> {
        if kind != "stack" {
            self.leaves += 1;
        }
        let len = |k: &str| {
            built
                .get(k)
                .and_then(Value::as_array)
                .map(|a| a.len())
                .unwrap_or(0)
        };
        match kind {
            "chart" => self.bars += len("bars"),
            "line" => self.points += len("points"),
            "table" => self.rows += len("rows"),
            "timeline" => self.events += len("events"),
            "donut" => self.segments += len("segments"),
            "stat" => self.stats += len("stats"),
            "task-board" => {
                self.tasks += built
                    .get("columns")
                    .and_then(Value::as_array)
                    .map(|cols| {
                        cols.iter()
                            .map(|c| {
                                c.get("tasks")
                                    .and_then(Value::as_array)
                                    .map(|t| t.len())
                                    .unwrap_or(0)
                            })
                            .sum()
                    })
                    .unwrap_or(0);
            }
            _ => {}
        }
        if self.leaves > MAX_STACK_LEAVES {
            return Err(format!(
                "a card may render at most {MAX_STACK_LEAVES} sections in total — split it into a second card"
            ));
        }
        for (label, got, cap) in [
            ("bars", self.bars, MAX_BARS),
            ("line points", self.points, MAX_LINE_POINTS),
            ("table rows", self.rows, MAX_TABLE_ROWS),
            ("board tasks", self.tasks, MAX_BOARD_TASKS),
            ("timeline events", self.events, MAX_TIMELINE_EVENTS),
            ("donut segments", self.segments, MAX_DONUT_SEGMENTS),
            ("stats", self.stats, MAX_STATS),
        ] {
            if got > cap {
                return Err(format!(
                    "a card may carry at most {cap} {label} in total — aggregate, or split it into a second card"
                ));
            }
        }
        Ok(())
    }
}

/// Prose: markdown rendered by the chat's OWN markdown pipeline, which is what
/// opens reference "rich content" (headings, code with highlighting, KaTeX
/// math, GFM tables, mermaid, `[1]` citation chips) inside a typed card. This
/// is a delegation, not a new renderer — the XSS posture is the chat body's
/// (markdown only, no raw HTML, URLs scheme-sanitized by `urlTransform`).
fn build_prose(title: Option<String>, payload: &Value, style: Option<Value>) -> Result<Value, String> {
    let markdown = bounded_string(payload, "markdown", MAX_PROSE_CHARS, true)?;
    Ok(json!({
        "kind": "prose",
        "title": title,
        "style": style,
        "markdown": markdown,
    }))
}

/// Divider: a hairline plus spacing between sections. The presence of a
/// payload object is the whole request — nothing to read or validate.
fn build_divider(title: Option<String>, _payload: &Value, style: Option<Value>) -> Result<Value, String> {
    Ok(json!({
        "kind": "divider",
        "title": title,
        "style": style,
    }))
}

/// The composition container. `sections` are `(viz, payload)` pairs — the same
/// shape as a top-level call — so recursion is a dispatch, not a second
/// implementation of every kind.
///
/// `columns` (1 or 2, default 1) gives two-column composition without a new
/// kind: a comparison pattern is a stack of rows, two sections wide. It is
/// deliberately NOT `n` columns — two is what reads at chat width, and an
/// arbitrary grid is `render_widget`'s job.
fn build_stack(
    title: Option<String>,
    payload: &Value,
    style: Option<Value>,
    budget: &mut VizBudget,
    depth: usize,
) -> Result<Value, String> {
    if depth > MAX_STACK_DEPTH {
        return Err(format!(
            "stack is nested too deeply (at most {MAX_STACK_DEPTH} levels) — flatten the sections"
        ));
    }
    let sections = payload
        .get("sections")
        .and_then(Value::as_array)
        .ok_or("stack payload needs a \"sections\" array")?;
    if sections.is_empty() {
        return Err("stack sections must contain at least one section".into());
    }
    if sections.len() > MAX_STACK_SECTIONS {
        return Err(format!(
            "stack sections must have at most {MAX_STACK_SECTIONS} entries — split the card in two"
        ));
    }
    let columns = match payload.get("columns") {
        None | Some(Value::Null) => 1,
        Some(Value::Number(n)) => match n.as_u64() {
            Some(1) => 1,
            Some(2) => 2,
            _ => return Err("stack columns must be 1 or 2".into()),
        },
        Some(_) => return Err("stack columns must be the number 1 or 2".into()),
    };
    let mut out = Vec::with_capacity(sections.len());
    for (i, section) in sections.iter().enumerate() {
        let built = build_viz_section(section, budget, depth)
            .map_err(|e| format!("sections[{i}]: {e}"))?;
        out.push(built);
    }
    Ok(json!({
        "kind": "stack",
        "title": title,
        "style": style,
        "columns": columns,
        "sections": out,
    }))
}

/// Build ONE section of a stack. Sections carry no title (a section has no card
/// chrome — a `prose` section is the heading) and no arg-level flattening, so
/// their style can only come from their own payload. A stack child recurses
/// with the SAME budget, so the aggregate caps hold across the whole tree.
fn build_viz_section(
    section: &Value,
    budget: &mut VizBudget,
    depth: usize,
) -> Result<Value, String> {
    let viz = section
        .get("viz")
        .and_then(Value::as_str)
        .ok_or("every stack section needs a \"viz\" type")?;
    if !VIZ_KINDS.contains(&viz) {
        let kinds = VIZ_KINDS.join(", ");
        return Err(format!("unknown viz type \"{viz}\" in a stack section — supported: {kinds}"));
    }
    let payload = section
        .get("payload")
        .ok_or("every stack section needs a \"payload\" object")?;
    if !payload.is_object() {
        return Err(format!("stack section \"{viz}\": payload must be an object"));
    }
    // Same flattening leniency the top level gets: style may ride the payload
    // (documented) or the section itself (what models actually send).
    let style = match build_style(payload)? {
        Some(s) => Some(s),
        None => build_style(section)?,
    };
    let built = match viz {
        "chart" => build_chart(None, payload, style)?,
        "table" => build_table(None, payload, style)?,
        "task-board" => build_board(None, payload, style)?,
        "timeline" => build_timeline(None, payload, style)?,
        "line" => build_line(None, payload, style)?,
        "donut" => build_donut(None, payload, style)?,
        "stat" => build_stat(None, payload, style)?,
        "stack" => build_stack(None, payload, style, budget, depth + 1)?,
        "prose" => build_prose(None, payload, style)?,
        "divider" => build_divider(None, payload, style)?,
        _ => unreachable!("viz kind gated above"),
    };
    budget.tally(viz, &built)?;
    Ok(built)
}

/// Validate + normalize one visualization payload from the tool's flattened
/// args (`viz`, optional `title`, `payload` object). Returns the normalized
/// payload tagged with its kind, or a precise error the model can fix.
pub(crate) fn build_viz_payload(args: &Value) -> Result<Value, String> {
    let args = normalize_viz_args(args);
    let kinds = VIZ_KINDS.join(", ");
    let viz = args
        .get("viz")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("visualize requires a \"viz\" type ({kinds})"))?;
    if !VIZ_KINDS.contains(&viz) {
        return Err(format!("unknown viz type \"{viz}\" — supported: {kinds}"));
    }
    let title = read_title(&args)?;
    let payload = args
        .get("payload")
        .ok_or("visualize requires a \"payload\" object with the data")?;
    if !payload.is_object() {
        return Err("payload must be an object".into());
    }
    // The model may hang style off the payload (documented) or at the top
    // level of its args (common flattening mistake) — accept both, payload
    // wins, so art direction never silently vanishes.
    let style = match build_style(payload)? {
        Some(s) => Some(s),
        None => build_style(&args)?,
    };
    let built = match viz {
        "chart" => build_chart(title, payload, style)?,
        "table" => build_table(title, payload, style)?,
        "task-board" => build_board(title, payload, style)?,
        "timeline" => build_timeline(title, payload, style)?,
        "line" => build_line(title, payload, style)?,
        "donut" => build_donut(title, payload, style)?,
        "stat" => build_stat(title, payload, style)?,
        "stack" => build_stack(title, payload, style, &mut VizBudget::default(), 1)?,
        "prose" => build_prose(title, payload, style)?,
        "divider" => build_divider(title, payload, style)?,
        _ => unreachable!("viz kind gated above"),
    };
    let size = serde_json::to_string(&built)
        .map(|s| s.chars().count())
        .unwrap_or(usize::MAX);
    if size > VIZ_MAX_PAYLOAD_CHARS {
        return Err(format!(
            "payload is too large ({size} chars; max {}) — aggregate or trim the data",
            VIZ_MAX_PAYLOAD_CHARS
        ));
    }
    Ok(built)
}

/// The model-facing result for a successfully validated visualization.
pub(crate) fn visualize(args: &Value) -> super::ToolOutcome {
    match build_viz_payload(args) {
        Ok(payload) => {
            let kind = payload.get("kind").and_then(Value::as_str).unwrap_or("viz");
            let title = payload
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("untitled");
            super::ToolOutcome::text(format!(
                "Rendered {kind} \"{title}\" as a native card in the chat. Do not restate its \
                 contents as text or code — the user can already see and interact with it."
            ))
        }
        Err(e) => super::ToolOutcome::text(format!("Error: visualize payload invalid: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_each_payload_type() {
        let chart = build_viz_payload(&json!({
            "viz": "chart", "title": "Deploys by week",
            "payload": { "unit": "deploys", "bars": [
                {"label": "W1", "value": 12}, {"label": "W2", "value": 9.5}
            ]}
        }))
        .unwrap();
        assert_eq!(chart["kind"], "chart");
        assert_eq!(chart["bars"][0]["value"], 12); // integer stays integer
        assert_eq!(chart["bars"][1]["value"], 9.5);
        assert_eq!(chart["unit"], "deploys");

        let table = build_viz_payload(&json!({
            "viz": "table", "title": "Latency",
            "payload": { "columns": [{"label": "Route", "align": "left"}, {"label": "p95", "align": "right"}],
                         "rows": [["/api/a", 120], ["/api/b", "340 ms"]] }
        }))
        .unwrap();
        assert_eq!(table["kind"], "table");
        assert_eq!(table["rows"][0][1], "120"); // numbers stringify
        assert_eq!(table["columns"][1]["align"], "right");

        let board = build_viz_payload(&json!({
            "viz": "task-board", "title": "Sprint",
            "payload": { "columns": [
                {"title": "Todo", "tasks": [{"title": "Design API", "meta": "2d"}]},
                {"title": "Done", "tasks": [{"title": "Spec"}]}
            ]}
        }))
        .unwrap();
        assert_eq!(board["kind"], "task-board");
        assert!(board["columns"][1]["tasks"][0].get("meta").is_none());

        let timeline = build_viz_payload(&json!({
            "viz": "timeline", "title": "Incident",
            "payload": { "events": [
                {"label": "Alert fired", "at": "14:02", "detail": "p95 breached"},
                {"label": "Rolled back", "at": "14:19"}
            ]}
        }))
        .unwrap();
        assert_eq!(timeline["kind"], "timeline");
        assert_eq!(timeline["events"][0]["at"], "14:02");

        let line = build_viz_payload(&json!({
            "viz": "line", "title": "p95 trend",
            "payload": { "unit": "ms", "points": [
                {"label": "Mon", "value": 120}, {"label": "Tue", "value": 96.5}, {"label": "Wed", "value": 140}
            ]}
        }))
        .unwrap();
        assert_eq!(line["kind"], "line");
        assert_eq!(line["area"], true);
        assert_eq!(line["points"][1]["value"], 96.5);

        let donut = build_viz_payload(&json!({
            "viz": "donut", "title": "Spend",
            "payload": { "unit": "%", "segments": [
                {"label": "Compute", "value": 60}, {"label": "Storage", "value": 30}, {"label": "Net", "value": 10}
            ]}
        }))
        .unwrap();
        assert_eq!(donut["kind"], "donut");
        assert_eq!(donut["total"], 100.0);

        let stat = build_viz_payload(&json!({
            "viz": "stat", "title": "Today",
            "payload": { "stats": [
                {"label": "Deploys", "value": "14", "delta": "+3", "good": true},
                {"label": "Error rate", "value": "0.4%", "delta": "-0.1%"}
            ]}
        }))
        .unwrap();
        assert_eq!(stat["kind"], "stat");
        assert_eq!(stat["stats"][0]["good"], true);

        // Agent-chosen style: validated, normalized, threaded through.
        let styled = build_viz_payload(&json!({
            "viz": "chart", "title": "Art-directed",
            "payload": { "style": { "accent": "#ff6b6b", "tone": "dark", "radius": "sharp",
                                    "palette": ["#ff6b6b", "rgba(1,2,3,0.5)", "hsl(200,50%,50%)"] },
                          "bars": [{"label": "a", "value": 1}] }
        }))
        .unwrap();
        assert_eq!(styled["style"]["accent"], "#ff6b6b");
        assert_eq!(styled["style"]["tone"], "dark");
        assert_eq!(styled["style"]["palette"].as_array().unwrap().len(), 3);
        // No style key → null in the normalized payload (frontend falls back).
        assert!(chart_payload_style_is_null());
    }

    fn chart_payload_style_is_null() -> bool {
        let c = build_viz_payload(&json!({
            "viz": "chart", "payload": {"bars": [{"label": "a", "value": 1}]}
        }))
        .unwrap();
        c["style"].is_null()
    }

    #[test]
    fn style_is_accepted_at_both_levels() {
        // Documented placement: style inside the payload.
        let nested = build_viz_payload(&json!({
            "viz": "donut", "title": "S",
            "payload": { "style": { "accent": "#e07a5f", "tone": "dark" },
                         "segments": [{"label": "a", "value": 1}] }
        }))
        .unwrap();
        assert_eq!(nested["style"]["accent"], "#e07a5f");
        // Common model flattening: style at the top level of the args.
        let flat = build_viz_payload(&json!({
            "viz": "donut", "title": "S", "style": { "accent": "#3d5a80", "tone": "light" },
            "payload": { "segments": [{"label": "a", "value": 1}] }
        }))
        .unwrap();
        assert_eq!(flat["style"]["accent"], "#3d5a80");
        assert_eq!(flat["style"]["tone"], "light");
        // Payload wins when both are present.
        let both = build_viz_payload(&json!({
            "viz": "donut", "title": "S", "style": { "accent": "#wrong" },
            "payload": { "style": { "accent": "#81b29a" },
                         "segments": [{"label": "a", "value": 1}] }
        }))
        .unwrap();
        assert_eq!(both["style"]["accent"], "#81b29a");
        // A hostile TOP-LEVEL style is still an error (never silently ignored).
        assert!(build_viz_payload(&json!({
            "viz": "donut", "title": "S", "style": { "accent": "url(evil)" },
            "payload": { "segments": [{"label": "a", "value": 1}] }
        }))
        .unwrap_err()
        .contains("plain color"));
    }

    #[test]
    fn rejects_hostile_and_invalid_styles() {
        for bad in ["url(javascript:x)", "var(--x)", "red; } body {", "auto", ""] {
            let err = build_viz_payload(&json!({
                "viz": "chart",
                "payload": { "style": { "accent": bad }, "bars": [{"label": "a", "value": 1}] }
            }))
            .unwrap_err();
            assert!(err.contains("plain color") || err.contains("color string"), "bad {bad:?}: {err}");
        }
        assert!(build_viz_payload(&json!({
            "viz": "chart",
            "payload": { "style": { "tone": "neon" }, "bars": [{"label": "a", "value": 1}] }
        }))
        .unwrap_err()
        .contains("tone"));
        assert!(build_viz_payload(&json!({
            "viz": "chart",
            "payload": { "style": { "palette": ["#fff", "nope"] }, "bars": [{"label": "a", "value": 1}] }
        }))
        .unwrap_err()
        .contains("palette"));
    }

    #[test]
    fn rejects_new_kind_bounds() {
        assert!(build_viz_payload(&json!(
            {"viz": "line", "payload": {"points": [{"value": 1}]}}
        ))
        .unwrap_err()
        .contains("at least 2"));
        assert!(build_viz_payload(&json!(
            {"viz": "donut", "payload": {"segments": [{"label": "a", "value": -1}]}}
        ))
        .unwrap_err()
        .contains("non-negative"));
        assert!(build_viz_payload(&json!(
            {"viz": "donut", "payload": {"segments": [{"label": "a", "value": 0}]}}
        ))
        .unwrap_err()
        .contains("positive total"));
        assert!(build_viz_payload(&json!(
            {"viz": "stat", "payload": {"stats": [{"label": "a"}]}}
        ))
        .unwrap_err()
        .contains("value"));
    }

    #[test]
    fn rejects_malformed_payloads_with_precise_errors() {
        // Unknown / missing type.
        assert!(build_viz_payload(&json!({"viz": "map", "payload": {}}))
            .unwrap_err()
            .contains("unknown viz type"));
        assert!(build_viz_payload(&json!({"payload": {}}))
            .unwrap_err()
            .contains("requires a \"viz\" type"));
        // Missing / empty / over-long bars.
        assert!(build_viz_payload(&json!({"viz": "chart", "payload": {}}))
            .unwrap_err()
            .contains("bars"));
        assert!(build_viz_payload(
            &json!({"viz": "chart", "payload": {"bars": []}})
        )
        .unwrap_err()
        .contains("at least one"));
        assert!(build_viz_payload(&json!(
            {"viz": "chart", "payload": {"bars": [{"label": "a", "value": "lots"}]}}
        ))
        .unwrap_err()
        .contains("finite number"));
        assert!(build_viz_payload(&json!(
            {"viz": "chart", "payload": {"bars": [{"label": "", "value": 1}]}}
        ))
        .unwrap_err()
        .contains("label"));
        // Table width mismatch + bad align.
        assert!(build_viz_payload(&json!(
            {"viz": "table", "payload": {"columns": ["a", "b"], "rows": [["only"]]}}
        ))
        .unwrap_err()
        .contains("expected 2"));
        assert!(build_viz_payload(&json!(
            {"viz": "table", "payload": {"columns": [{"label": "a", "align": "center"}], "rows": [[]]}}
        ))
        .unwrap_err()
        .contains("align"));
        // Board + timeline bounds.
        assert!(build_viz_payload(&json!(
            {"viz": "task-board", "payload": {"columns": [{"title": "c"}]}}
        ))
        .unwrap_err()
        .contains("tasks"));
        assert!(build_viz_payload(&json!(
            {"viz": "timeline", "payload": {"events": []}}
        ))
        .unwrap_err()
        .contains("at least one"));
        // Non-string title, non-object payload.
        assert!(build_viz_payload(&json!({"viz": "chart", "title": 3, "payload": {"bars": [{"label": "a", "value": 1}]}}))
            .unwrap_err()
            .contains("title"));
        assert!(build_viz_payload(&json!({"viz": "chart", "payload": [1]}))
            .unwrap_err()
            .contains("object"));
    }

    /// The commandcode regression: a harness CLI reported seven `visualize`
    /// calls whose `payload` was a JSON STRING (repaired client-side before
    /// the tool ran, so every card rendered) while the marker emitter
    /// re-validated the raw transcript input and dropped all seven cards to
    /// a bare "Preparing visualization" row. The stringified shape must
    /// validate identically to the inline one, on every call path.
    #[test]
    fn accepts_stringified_payloads_and_argument_envelopes() {
        let stringified = build_viz_payload(&json!({
            "viz": "chart", "title": "Deploys by week",
            "payload": "{\"bars\": [{\"label\": \"W1\", \"value\": 4}, {\"label\": \"W2\", \"value\": 9}], \"unit\": \"deploys\", \"style\": {\"accent\": \"#e07a5f\"}}"
        }))
        .expect("a stringified-but-valid payload must render");
        assert_eq!(stringified["kind"], "chart");
        assert_eq!(stringified["title"], "Deploys by week");
        assert_eq!(stringified["unit"], "deploys");
        assert_eq!(stringified["bars"][0]["value"], 4);
        // Style survives both the outer stringification and its own.
        assert_eq!(stringified["style"]["accent"], "#e07a5f");

        // Same for a stringified `style` hung off the payload, and one
        // flattened onto the args (documented leniency).
        let styled = build_viz_payload(&json!({
            "viz": "line",
            "payload": "{\"points\": [{\"label\": \"Mon\", \"value\": 1}, {\"label\": \"Tue\", \"value\": 2}], \"style\": \"{\\\"tone\\\": \\\"dark\\\"}\"}"
        }))
        .expect("a stringified style must survive");
        assert_eq!(styled["kind"], "line");
        assert_eq!(styled["style"]["tone"], "dark");

        // The `{arguments: …}` envelope harnesses report: object AND
        // JSON-string forms.
        for envelope in [
            json!({"arguments": {"viz": "stat", "title": "T",
                                  "payload": {"stats": [{"label": "Uptime", "value": "99.98%"}]}}}),
            json!({"arguments": "{\"viz\":\"stat\",\"title\":\"T\",\"payload\":{\"stats\":[{\"label\":\"Uptime\",\"value\":\"99.98%\"}]}}"}),
        ] {
            let built = build_viz_payload(&envelope)
                .expect("an arguments envelope must unwrap");
            assert_eq!(built["kind"], "stat");
            assert_eq!(built["title"], "T");
        }

        // A string that is NOT a JSON object still fails precisely — the
        // coercion never masks a genuinely malformed request.
        assert!(build_viz_payload(&json!({"viz": "chart", "payload": "bars: 4"}))
            .unwrap_err()
            .contains("object"));
    }

    #[test]
    fn builds_composed_stacks_from_the_same_builders() {
        // A stack of real sections, including a nested one and a two-column
        // layout — every child normalized by the SAME builder the top level
        // uses (a child chart is byte-identical to a top-level one minus the
        // title, because a section carries no card chrome).
        let built = build_viz_payload(&json!({
            "viz": "stack", "title": "Deploy health",
            "payload": {
                "columns": 2,
                "sections": [
                    {"viz": "stat", "payload": {"stats": [{"label": "Uptime", "value": "99.9%"}]}},
                    {"viz": "chart", "payload": {"unit": "deploys", "bars": [{"label": "W1", "value": 4}]}},
                    {"viz": "divider", "payload": {}},
                    {"viz": "prose", "payload": {"markdown": "The **W1** spike is the release train [1]"}},
                    {"viz": "stack", "payload": {"sections": [
                        {"viz": "table", "payload": {"columns": ["a"], "rows": [["x"]]}}
                    ]}}
                ]
            }
        }))
        .expect("a valid composition must build");
        assert_eq!(built["kind"], "stack");
        assert_eq!(built["title"], "Deploy health");
        assert_eq!(built["columns"], 2);
        let sections = built["sections"].as_array().unwrap();
        assert_eq!(sections.len(), 5);
        assert_eq!(sections[0]["kind"], "stat");
        assert_eq!(sections[0]["title"], Value::Null, "a section has no title");
        assert_eq!(sections[1]["bars"][0]["value"], 4);
        assert_eq!(sections[2]["kind"], "divider");
        assert_eq!(sections[3]["markdown"], "The **W1** spike is the release train [1]");
        // The nested stack's child is normalized by build_table too.
        assert_eq!(sections[4]["kind"], "stack");
        assert_eq!(sections[4]["sections"][0]["kind"], "table");
        assert_eq!(sections[4]["sections"][0]["rows"][0][0], "x");
    }

    #[test]
    fn rejects_broken_compositions_precisely() {
        // Missing shape.
        let e = build_viz_payload(&json!({"viz": "stack", "payload": {}})).unwrap_err();
        assert!(e.contains("sections"), "{e}");
        assert!(build_viz_payload(&json!({"viz": "prose", "payload": {}}))
            .unwrap_err()
            .contains("markdown"));
        // A section is not a (viz, payload) pair.
        assert!(build_viz_payload(&json!({"viz": "stack", "payload": {"sections": [{"bars": []}]}}))
            .unwrap_err()
            .contains("every stack section needs a \"viz\" type"));
        assert!(build_viz_payload(&json!({"viz": "stack", "payload": {"sections": [{"viz": "chart"}]}}))
            .unwrap_err()
            .contains("needs a \"payload\" object"));
        // A bad CHILD errors with its path, so the model knows where to fix.
        let e = build_viz_payload(&json!({
            "viz": "stack", "payload": {"sections": [{"viz": "chart", "payload": {"bars": []}}]}
        }))
        .unwrap_err();
        assert!(e.contains("sections[0]"), "{e}");
        assert!(e.contains("at least one"), "{e}");
        // Depth: 4 levels is refused, 3 is allowed.
        let nest = |depth: usize| {
            let mut section = json!({"viz": "table", "payload": {"columns": ["a"], "rows": [["x"]]}});
            for _ in 0..depth {
                section = json!({"viz": "stack", "payload": {"sections": [section]}});
            }
            json!({"viz": "stack", "payload": {"sections": [section]}})
        };
        assert!(build_viz_payload(&nest(3)).unwrap_err().contains("nested too deeply"));
        assert!(build_viz_payload(&nest(2)).is_ok(), "3 levels total is the cap");
        // Too many sections, and a bad column count.
        let many: Vec<Value> = (0..9)
            .map(|_| json!({"viz": "divider", "payload": {}}))
            .collect();
        assert!(build_viz_payload(&json!({"viz": "stack", "payload": {"sections": many}}))
            .unwrap_err()
            .contains("at most 8"));
        assert!(build_viz_payload(&json!({
            "viz": "stack", "payload": {"columns": 3, "sections": [{"viz": "divider", "payload": {}}]}
        }))
        .unwrap_err()
        .contains("columns must be 1 or 2"));
    }

    #[test]
    fn composition_respects_the_aggregate_budget() {
        // A single stack tops out at 8 sections, so the leaf budget binds only
        // through nesting: 7 sub-stacks of 2 dividers = 14 leaves (>12), while
        // 6 of them (12 leaves) is exactly the cap and must pass.
        let sub = |n: usize| {
            let sections: Vec<Value> = (0..n)
                .map(|_| json!({"viz": "divider", "payload": {}}))
                .collect();
            json!({"viz": "stack", "payload": {"sections": sections}})
        };
        let top = |n: usize| {
            let sections: Vec<Value> = (0..n).map(|_| sub(2)).collect();
            json!({"viz": "stack", "payload": {"sections": sections}})
        };
        assert!(build_viz_payload(&top(6)).is_ok(), "12 leaves is the cap");
        assert_eq!(
            build_viz_payload(&top(7)).unwrap_err().contains("at most 12"),
            true
        );
        // The same data cap, summed: three 200-bar charts (each legal alone)
        // exceed 200 bars in total.
        let bars: Vec<Value> = (0..200)
            .map(|i| json!({"label": format!("b{i}"), "value": 1}))
            .collect();
        let e = build_viz_payload(&json!({
            "viz": "stack",
            "payload": {"sections": [
                {"viz": "chart", "payload": {"bars": bars}},
                {"viz": "chart", "payload": {"bars": bars}},
                {"viz": "chart", "payload": {"bars": bars}},
            ]}
        }))
        .unwrap_err();
        assert!(e.contains("at most 200 bars in total"), "{e}");
        // Prose has its own cap.
        let long = "x".repeat(4_200);
        assert!(build_viz_payload(&json!({
            "viz": "stack", "payload": {"sections": [{"viz": "prose", "payload": {"markdown": long}}]}
        }))
        .unwrap_err()
        .contains("4096"));
    }

    #[test]
    fn style_inherits_into_sections() {
        // A container style is normalized once; children inherit it through the
        // CSS custom properties their renderers read, so no per-section style
        // is required (and a section may still override).
        let built = build_viz_payload(&json!({
            "viz": "stack",
            "payload": {
                "style": {"palette": ["#e07a5f", "#3d5a80"], "tone": "dark"},
                "sections": [
                    {"viz": "chart", "payload": {"bars": [{"label": "a", "value": 1}]}},
                    {"viz": "chart", "style": {"accent": "#123456"},
                     "payload": {"bars": [{"label": "a", "value": 1}]}},
                ]
            }
        }))
        .expect("both sections valid");
        assert_eq!(built["style"]["palette"][0], "#e07a5f");
        assert_eq!(built["sections"][0]["style"], Value::Null);
        assert_eq!(built["sections"][1]["style"]["accent"], "#123456");
    }

    #[test]
    fn rejects_bounds_and_oversized_payloads() {
        let mut big_rows = Vec::new();
        for i in 0..501 {
            big_rows.push(json!([format!("r{i}"), "x"]));
        }
        let err = build_viz_payload(&json!(
            {"viz": "table", "payload": {"columns": ["a", "b"], "rows": big_rows}}
        ))
        .unwrap_err();
        assert!(err.contains("at most 500"), "got: {err}");

        let mut long = String::new();
        for _ in 0..(33_000 / 10) {
            long.push_str("abcdefghij");
        }
        let err = build_viz_payload(&json!(
            {"viz": "chart", "title": long,
             "payload": {"bars": [{"label": "a", "value": 1}]}}
        ))
        .unwrap_err();
        assert!(err.contains("120 characters"), "got: {err}");

        // A genuinely oversized payload (many wide rows) trips the byte cap.
        let mut huge_rows = Vec::new();
        for i in 0..400 {
            huge_rows.push(json!([format!("row-{i}-{}", "x".repeat(90)), "y"]));
        }
        let err = build_viz_payload(&json!(
            {"viz": "table", "payload": {"columns": ["a", "b"], "rows": huge_rows}}
        ))
        .unwrap_err();
        assert!(err.contains("too large"), "got: {err}");
    }

    #[test]
    fn visualize_reports_success_and_errors_as_text() {
        let ok = visualize(&json!({
            "viz": "chart", "title": "T",
            "payload": {"bars": [{"label": "a", "value": 1}]}
        }));
        assert!(ok.artifact.is_none());
        assert!(ok.text.contains("Rendered chart"));
        assert!(ok.text.contains("Do not restate"));

        let bad = visualize(&json!({"viz": "chart", "payload": {"bars": []}}));
        assert!(bad.text.contains("Error: visualize payload invalid"));
    }
}
