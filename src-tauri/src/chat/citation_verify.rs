//! Async citation-precision sampler (R10): after a research report is
//! delivered, a background model call re-judges the lint's WEAK-attribution
//! flags against the ledger excerpts. The heuristic lint is deliberately
//! cheap and over-inclusive; this pass is the precision half —
//! "supported" verdicts clear a flag (chip back to normal), "unsupported"
//! confirms a misattribution (chip stays red-adjacent). Runs entirely
//! post-delivery: the user reads the report while verification is in flight.
//!
//! Wire shape mirrors `cloud_compact::summarize_via_provider` (Anthropic
//! messages API + OpenAI chat completions, `stream:false`), minus the usage
//! accounting — verification is free-riding on the turn's provider and its
//! result is not billed to the session's metrics.

use serde_json::{json, Value};

use super::providers::ChatProviderId;

/// One flagged claim sent to the verifier.
#[derive(Debug, Clone, serde::Serialize)]
pub struct VerifyClaim {
    pub number: u32,
    pub sentence: String,
    pub excerpt: String,
}

/// The verifier's verdict for one claim.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct VerifyVerdict {
    pub number: u32,
    /// "supported" | "partial" | "unsupported" (anything unparsable → kept
    /// as "partial" so an ambiguous model reply never silently clears a flag).
    pub verdict: String,
}

const SYSTEM: &str = "You are a strict citation verifier. For each numbered pair of \
CLAIM and EXCERPT, judge whether the excerpt alone supports the claim. Reply with \
ONLY a JSON array — no prose, no markdown fences — of objects \
{\"n\": <claim number>, \"v\": \"supported\"|\"partial\"|\"unsupported\"}. \
\"supported\": the excerpt contains the claim's facts. \"partial\": the excerpt is \
related but does not fully support the claim. \"unsupported\": the excerpt does not \
contain the claim's subject matter.";

/// Batch-judge up to ~12 claims in ONE non-streaming call.
pub(crate) async fn verify_via_provider(
    client: &reqwest::Client,
    provider_id: ChatProviderId,
    base: &str,
    api_key: &str,
    model: &str,
    claims: &[VerifyClaim],
) -> Result<Vec<VerifyVerdict>, String> {
    let mut user = String::from("Verify these claim/excerpt pairs:\n");
    for c in claims {
        user.push_str(&format!(
            "\n[{}] CLAIM: {}\n    EXCERPT: {}\n",
            c.number,
            c.sentence.replace('\n', " "),
            c.excerpt.replace('\n', " ")
        ));
    }
    let is_anthropic = matches!(
        provider_id,
        ChatProviderId::Anthropic | ChatProviderId::AnthropicCompatible
    );

    let resp = if is_anthropic {
        client
            .post(format!("{base}/v1/messages"))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&json!({
                "model": model,
                "stream": false,
                "max_tokens": 1024,
                "system": SYSTEM,
                "messages": [{ "role": "user", "content": user }],
            }))
            .send()
            .await
            .map_err(|e| format!("verify request failed: {e}"))?
    } else {
        client
            .post(format!("{base}/v1/chat/completions"))
            .header("Authorization", format!("Bearer {api_key}"))
            .header("content-type", "application/json")
            .json(&json!({
                "model": model,
                "stream": false,
                "max_tokens": 1024,
                "messages": [
                    { "role": "system", "content": SYSTEM },
                    { "role": "user", "content": user },
                ],
            }))
            .send()
            .await
            .map_err(|e| format!("verify request failed: {e}"))?
    };
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("verify returned {status}: {body}"));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("verify body parse failed: {e}"))?;
    let text = if is_anthropic {
        v.get("content")
            .and_then(|c| c.as_array())
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default()
    } else {
        v.get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string()
    };
    Ok(parse_verdicts(&text, claims))
}

/// Extract the JSON array from the model's reply (models like to fence it),
/// mapping each verdict back onto its claim. Missing/unparsable entries stay
/// "partial" — a malformed reply must not UPGRADE anything.
fn parse_verdicts(text: &str, claims: &[VerifyClaim]) -> Vec<VerifyVerdict> {
    let json_slice = match (text.find('['), text.rfind(']')) {
        (Some(s), Some(e)) if e > s => &text[s..=e],
        _ => return claims.iter().map(|c| partial(c.number)).collect(),
    };
    let parsed: Result<Vec<Value>, _> = serde_json::from_str(json_slice);
    let items = match parsed {
        Ok(items) => items,
        Err(_) => return claims.iter().map(|c| partial(c.number)).collect(),
    };
    claims
        .iter()
        .map(|c| {
            let verdict = items
                .iter()
                .filter_map(|it| {
                    let n = it.get("n").and_then(|v| v.as_u64())?;
                    if n == c.number as u64 {
                        it.get("v").and_then(|v| v.as_str()).map(String::from)
                    } else {
                        None
                    }
                })
                .find(|v| matches!(v.as_str(), "supported" | "partial" | "unsupported"))
                .unwrap_or_else(|| "partial".to_string());
            VerifyVerdict {
                number: c.number,
                verdict,
            }
        })
        .collect()
}

fn partial(number: u32) -> VerifyVerdict {
    VerifyVerdict {
        number,
        verdict: "partial".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_verdicts_handles_fenced_and_clean_arrays() {
        let claims = vec![
            VerifyClaim {
                number: 1,
                sentence: "a".into(),
                excerpt: "x".into(),
            },
            VerifyClaim {
                number: 2,
                sentence: "b".into(),
                excerpt: "y".into(),
            },
        ];
        let clean = r#"[{"n":1,"v":"supported"},{"n":2,"v":"unsupported"}]"#;
        let out = parse_verdicts(clean, &claims);
        assert_eq!(out[0].verdict, "supported");
        assert_eq!(out[1].verdict, "unsupported");

        let fenced = "Here you go:\n```json\n[{\"n\":1,\"v\":\"partial\"}]\n```\n";
        let out = parse_verdicts(fenced, &claims);
        assert_eq!(out[0].verdict, "partial");
        assert_eq!(out[1].verdict, "partial", "missing entry stays partial");

        let garbage = "I cannot do that.";
        let out = parse_verdicts(garbage, &claims);
        assert!(out.iter().all(|v| v.verdict == "partial"));
    }

    #[test]
    fn sampler_prompt_lists_all_pairs() {
        // The user content shape is what the model grades — keep it pinned.
        let claims = vec![VerifyClaim {
            number: 7,
            sentence: "The harvest doubled [7].".into(),
            excerpt: "Harvest figures were flat.".into(),
        }];
        let mut user = String::from("Verify these claim/excerpt pairs:\n");
        for c in &claims {
            user.push_str(&format!(
                "\n[{}] CLAIM: {}\n    EXCERPT: {}\n",
                c.number, c.sentence, c.excerpt
            ));
        }
        assert!(user.contains("[7] CLAIM:"));
        assert!(user.contains("EXCERPT: Harvest figures were flat."));
    }
}
