//! docdesign — the shared design-token layer for document/deck/PDF
//! generation.
//!
//! `src/lib/docdesign/tokens.json` is the single source of truth: the JS
//! document engines import it (Vite), the bundled Python helper reads a staged
//! copy ([`super::pygen`] writes it next to `conduit_docgen.py`), and this
//! module embeds it at compile time to derive the HTML→PDF base stylesheet.
//! Change a token and every engine picks it up — no per-engine constants.
//!
//! Hex colors in the token file carry NO leading `#` (the PptxGenJS
//! requirement); [`base_css`] adds one for CSS contexts.

pub mod plan;
pub mod qa;

use once_cell::sync::Lazy;
use serde_json::Value;

/// Embedded token file (same bytes the frontend imports).
pub const TOKENS_JSON: &str = include_str!("../../../../src/lib/docdesign/tokens.json");

static TOKENS: Lazy<Value> =
    Lazy::new(|| serde_json::from_str(TOKENS_JSON).expect("docdesign tokens.json must parse"));

/// Parsed token root.
pub fn tokens() -> &'static Value {
    &TOKENS
}

/// Sorted theme ids ("ink", "midnight", …).
pub fn theme_ids() -> Vec<String> {
    TOKENS["themes"]
        .as_object()
        .map(|m| {
            let mut ids: Vec<String> = m.keys().cloned().collect();
            ids.sort();
            ids
        })
        .unwrap_or_default()
}

/// Resolve an alias ("blue" → "ink"); unknown names fall back to the default.
pub fn canonical_theme(name: &str) -> &str {
    let key = name.trim().to_ascii_lowercase();
    if TOKENS["themes"].get(&key).is_some() {
        return leaked(&key);
    }
    if let Some(alias) = TOKENS["aliases"].get(&key).and_then(|v| v.as_str()) {
        return leaked(alias);
    }
    leaked(TOKENS["defaultTheme"].as_str().unwrap_or("ink"))
}

/// Intern the theme id so it can be returned as &'static (theme ids are a
/// fixed, tiny set from the embedded file).
fn leaked(s: &str) -> &'static str {
    Lazy::force(&THEMES_LEAK);
    match THEMES_LEAK.iter().find(|t| **t == s) {
        Some(t) => *t,
        None => "ink",
    }
}

static THEMES_LEAK: Lazy<Vec<&'static str>> = Lazy::new(|| {
    theme_ids()
        .into_iter()
        .map(|id| Box::leak(id.into_boxed_str()) as &'static str)
        .collect()
});

/// A color token of a theme, as stored: hex WITHOUT `#`.
pub fn theme_color(theme: &str, key: &str) -> Option<&'static str> {
    TOKENS["themes"][canonical_theme(theme)]["color"][key].as_str()
}

/// Same, with a `#` prefix (CSS contexts).
pub fn theme_color_css(theme: &str, key: &str) -> Option<String> {
    theme_color(theme, key).map(|c| format!("#{c}"))
}

fn default_theme() -> &'static str {
    canonical_theme("")
}

fn face_css_stack(face: &str) -> String {
    TOKENS["faces"][face]["cssStack"]
        .as_str()
        .unwrap_or("sans-serif")
        .to_string()
}

fn type_pt(section: &str, key: &str) -> f64 {
    TOKENS["type"][section][key].as_f64().unwrap_or(11.0)
}

fn pt_fmt(v: f64) -> String {
    if (v - v.round()).abs() < f64::EPSILON {
        format!("{}", v.round() as i64)
    } else {
        format!("{v}")
    }
}

/// The default print stylesheet for the HTML→PDF engine, generated from the
/// default theme's tokens. This replaces what used to be a hand-written
/// `BASE_CSS` constant in `pdfprint.rs`: same structure and spirit (clean
/// white pages, editorial serif/sans pairing, one accent), but every font,
/// size, and color now comes from `tokens.json`.
pub fn base_css() -> String {
    base_css_for_theme(default_theme())
}

/// [`base_css`] for an explicit theme (used by the plan-compiled PDF path).
pub fn base_css_for_theme(theme: &str) -> String {
    let t = canonical_theme(theme);
    let c = |key: &str| theme_color_css(t, key).unwrap_or_else(|| "#000000".to_string());
    let doc = "doc";
    let margins = TOKENS["space"]["pdfMarginMm"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_f64())
                .map(|v| format!("{v}mm"))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_else(|| "20mm 17mm".to_string());

    format!(
        r#"@page {{ size: A4; margin: {margins}; }}
html, body {{ margin: 0; padding: 0; }}
body {{
  font-family: {body_stack};
  color: {ink}; line-height: {leading}; font-size: {body_pt}pt;
}}
h1, h2, h3, h4 {{ line-height: 1.2; margin: 1.4em 0 0.5em; font-family: {display_stack}; }}
h1 {{ font-size: {h1}pt; }} h2 {{ font-size: {h2}pt; }} h3 {{ font-size: {h3}pt; }}
p {{ margin: 0.55em 0; }}
table {{ border-collapse: collapse; width: 100%; margin: 1em 0; }}
th, td {{ border: 1px solid {hair}; padding: 6px 9px; text-align: left; }}
th {{ background: {surface}; }}
blockquote {{ margin: 1em 0; padding: 0.4em 1em; border-left: 3px solid {tint_dark}; color: {muted}; }}
code, pre {{ font-family: {mono_stack}; font-size: {code_pt}pt; }}
pre {{ background: {surface}; padding: 10px 12px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }}
img {{ max-width: 100%; }}
a {{ color: {accent}; text-decoration: none; }}
@media print {{ * {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }} }}
"#,
        margins = margins,
        body_stack = face_css_stack("body"),
        display_stack = face_css_stack("display"),
        mono_stack = face_css_stack("mono"),
        ink = c("ink"),
        leading = pt_fmt(type_pt(doc, "leadingCss")),
        body_pt = pt_fmt(type_pt(doc, "bodyPt")),
        h1 = pt_fmt(type_pt(doc, "h1Pt")),
        h2 = pt_fmt(type_pt(doc, "h2Pt")),
        h3 = pt_fmt(type_pt(doc, "h3Pt")),
        code_pt = pt_fmt(type_pt(doc, "codePt")),
        hair = c("hair"),
        surface = c("surface"),
        muted = c("muted"),
        accent = c("accent"),
        tint_dark = c("hair"),
    )
}

/// One-paragraph digest of the shared design system for tool-result guidance —
/// the single place theme names are listed (replaces per-engine theme lists
/// drifting apart).
pub fn style_digest() -> String {
    let ids = theme_ids().join(", ");
    format!(
        "DESIGN SYSTEM: every document is styled from the shared token set \
         (type scale, spacing, one restrained accent per theme). Available \
         themes: {ids}. Hierarchy comes from type scale, weight and whitespace — \
         never decorative bars, stripes, or title underlines."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_parse_with_seven_themes() {
        assert_eq!(theme_ids().len(), 7);
        assert_eq!(canonical_theme(""), "ink");
        assert_eq!(canonical_theme("blue"), "ink");
        assert_eq!(canonical_theme("PURPLE"), "plum");
        assert_eq!(canonical_theme("nonexistent"), "ink");
    }

    #[test]
    fn colors_are_bare_hex() {
        for theme in theme_ids() {
            let color = &TOKENS["themes"][&theme]["color"];
            let obj = color.as_object().unwrap();
            assert!(!obj.is_empty(), "{theme} has no colors");
            for (key, value) in obj {
                let hex = value.as_str().unwrap_or_else(|| panic!("{theme}.{key} not a string"));
                assert_eq!(hex.len(), 6, "{theme}.{key} = {hex} is not 6 hex digits");
                assert!(!hex.contains('#'), "{theme}.{key} carries a '#' (pptxgenjs corruption)");
                assert!(
                    hex.chars().all(|ch| ch.is_ascii_hexdigit()),
                    "{theme}.{key} = {hex} has non-hex chars"
                );
            }
            let palette = TOKENS["themes"][&theme]["chartPalette"]
                .as_array()
                .expect("chart palette");
            assert!(palette.len() >= 4, "{theme} chart palette too small");
        }
    }

    #[test]
    fn body_text_meets_contrast_on_bg() {
        for theme in theme_ids() {
            let ink = theme_color(&theme, "ink").unwrap();
            let bg = theme_color(&theme, "bg").unwrap();
            let ratio = contrast_ratio(ink, bg);
            assert!(
                ratio >= 4.5,
                "{theme}: body text contrast {ratio:.2} < 4.5"
            );
            let cbg = theme_color(&theme, "coverBg").unwrap();
            let cfg = theme_color(&theme, "coverFg").unwrap();
            let cover_ratio = contrast_ratio(cfg, cbg);
            assert!(cover_ratio >= 4.5, "{theme}: cover contrast {cover_ratio:.2} < 4.5");
        }
    }

    /// Re-implementation of the WCAG ratio for the Rust-side token test —
    /// mirrors `contrastRatio` in the frontend token module.
    pub fn contrast_ratio(a: &str, b: &str) -> f64 {
        fn lum(hex: &str) -> f64 {
            let ch = |i: usize| -> f64 {
                let c = i64::from_str_radix(&hex[i..i + 2], 16).unwrap() as f64 / 255.0;
                if c <= 0.03928 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
            };
            0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4)
        }
        let (la, lb) = (lum(a), lum(b));
        let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
        (hi + 0.05) / (lo + 0.05)
    }

    #[test]
    fn base_css_is_generated_from_tokens() {
        let css = base_css();
        // Fonts from the face stacks…
        assert!(css.contains("Calibri"), "body face missing:\n{css}");
        assert!(css.contains("Georgia"), "display face missing");
        assert!(css.contains("Consolas"), "mono face missing");
        // …sizes from the type scale…
        assert!(css.contains("font-size: 11pt"));
        assert!(css.contains("h1 { font-size: 24pt"));
        assert!(css.contains("h2 { font-size: 17pt"));
        assert!(css.contains("h3 { font-size: 13.5pt"));
        // …and colors from the default theme (hex gets a '#' prefix here).
        let ink = theme_color("ink", "ink").unwrap().to_lowercase();
        assert!(css.to_lowercase().contains(&format!("color: #{ink}")));
        let accent = theme_color("ink", "accent").unwrap().to_lowercase();
        assert!(css.to_lowercase().contains(&format!("color: #{accent}")));
        // Margins from space tokens.
        assert!(css.contains("@page { size: A4; margin: 20mm 17mm; }"));
    }

    #[test]
    fn base_css_for_theme_uses_that_theme() {
        let css = base_css_for_theme("emerald").to_lowercase();
        let accent = theme_color("emerald", "accent").unwrap();
        assert!(css.contains(&format!("#{}", accent.to_lowercase())));
        let ink_css = base_css_for_theme("ink").to_lowercase();
        let ink_accent = theme_color("ink", "accent").unwrap().to_lowercase();
        assert!(ink_css.contains(&format!("#{ink_accent}")));
    }

    #[test]
    fn style_digest_lists_every_theme() {
        let digest = style_digest();
        for id in theme_ids() {
            assert!(digest.contains(&id), "digest missing theme {id}");
        }
    }
}
