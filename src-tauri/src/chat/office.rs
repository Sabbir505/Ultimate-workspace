//! Faithful in-app rendering of Office documents (docx / pptx / xlsx) to
//! self-contained HTML for the artifact preview pane.
//!
//! Unlike a plain text dump, these renderers preserve the visual design of the
//! file: run-level colours / bold / sizes and shaded tables for docx, and
//! geometry-positioned, colour-filled shapes for pptx (each slide laid out as a
//! scaled 16:9 card). The returned string is a full HTML document meant to be
//! shown inside a sandboxed iframe, so all styling is inline / embedded.
//!
//! Parsing is deliberately tolerant string scanning (no XML dependency): it
//! must cope with both python-docx/python-pptx output and the minimal OpenXML
//! produced by `artifacts.rs`.

use std::io::Read;

// ---------------------------------------------------------------------------
// Small XML scanning helpers.
// ---------------------------------------------------------------------------

fn xml_unescape(s: &str) -> String {
    // Order matters: `&amp;` must be resolved FIRST so that
    // double-escaped sequences like `&amp;lt;` (which should become
    // `&lt;`) don't lose their ampersand to the intermediate `<`
    // that `&lt;` would produce.
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// True when the char after an element-name prefix marks a real element start
/// (`<w:p>`, `<w:p …>`, `<w:p/>`) rather than a longer name (`<w:pPr>`).
fn is_real_start(after: &str) -> bool {
    matches!(after.chars().next(), Some('>') | Some(' ') | Some('/') | Some('\t') | Some('\r') | Some('\n'))
}

/// Return every full `<name …>…</name>` (or self-closing `<name …/>`) element
/// slice at any depth, honouring nested elements of the same name.
fn elements<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let open_prefix = format!("<{name}");
    let close = format!("</{name}>");
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(rel) = xml[i..].find(&open_prefix) {
        let start = i + rel;
        let after = &xml[start + open_prefix.len()..];
        if !is_real_start(after) {
            i = start + open_prefix.len();
            continue;
        }
        let open_end = match xml[start..].find('>') {
            Some(r) => start + r,
            None => break,
        };
        if xml.as_bytes()[open_end - 1] == b'/' {
            out.push(&xml[start..open_end + 1]);
            i = open_end + 1;
            continue;
        }
        let mut depth = 1usize;
        let mut j = open_end + 1;
        loop {
            let next_open = xml[j..].find(&open_prefix).map(|r| j + r);
            let next_close = xml[j..].find(&close).map(|r| j + r);
            match (next_open, next_close) {
                (Some(o), Some(c)) if o < c => {
                    if is_real_start(&xml[o + open_prefix.len()..]) {
                        depth += 1;
                    }
                    j = o + open_prefix.len();
                }
                (_, Some(c)) => {
                    depth -= 1;
                    j = c + close.len();
                    if depth == 0 {
                        out.push(&xml[start..j]);
                        break;
                    }
                }
                _ => {
                    i = xml.len();
                    return out;
                }
            }
        }
        i = j;
    }
    out
}

/// The opening tag slice (`<name …>`) of the first real occurrence of `name`.
fn opening_tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let prefix = format!("<{name}");
    let mut i = 0;
    loop {
        let rel = xml[i..].find(&prefix)?;
        let start = i + rel;
        if is_real_start(&xml[start + prefix.len()..]) {
            let end = start + xml[start..].find('>')?;
            return Some(&xml[start..=end]);
        }
        i = start + prefix.len();
    }
}

/// Value of attribute `attr` in an opening-tag slice.
fn attr<'a>(tag: &'a str, attr: &str) -> Option<&'a str> {
    let needle = format!("{attr}=\"");
    let s = tag.find(&needle)? + needle.len();
    let e = tag[s..].find('"')? + s;
    Some(&tag[s..e])
}

/// Concatenate all `<a:t>`/`<w:t>` text within `chunk` (already the right scope).
fn collect_text(chunk: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::new();
    let mut rest = chunk;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i + open.len()..];
        if !is_real_start(after) {
            rest = after;
            continue;
        }
        if let Some(gt) = after.find('>') {
            let content = &after[gt + 1..];
            if let Some(ce) = content.find(&close) {
                out.push_str(&content[..ce]);
                rest = &content[ce + close.len()..];
                continue;
            }
        }
        break;
    }
    xml_unescape(&out)
}

fn hex_ok(v: &str) -> bool {
    v.len() == 6 && v.bytes().all(|b| b.is_ascii_hexdigit())
}

/// First `<a:srgbClr>` / `<w:color>` colour inside a region (before `stop`).
fn first_srgb(region: &str) -> Option<String> {
    let tag = opening_tag(region, "a:srgbClr")?;
    let v = attr(tag, "val")?;
    hex_ok(v).then(|| v.to_ascii_uppercase())
}

// ---------------------------------------------------------------------------
// Shared HTML document shell.
// ---------------------------------------------------------------------------

fn doc_shell(inner: String, body_css: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>\
*{{margin:0;padding:0;box-sizing:border-box}}\
html,body{{background:#f1f5f9}}\
body{{font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif;color:#1e293b;{body_css}}}\
</style></head><body>{inner}</body></html>"
    )
}

// ===========================================================================
// DOCX
// ===========================================================================

enum Block<'a> {
    Para(&'a str),
    Table(&'a str),
}

/// Split a `<w:body>` into its top-level paragraph and table blocks in order.
fn body_blocks(body: &str) -> Vec<Block<'_>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < body.len() {
        match find_real(body, "<w:tbl", i) {
            Some(t) => {
                for para in paragraphs_in(&body[i..t]) {
                    out.push(Block::Para(para));
                }
                match elements(&body[t..], "w:tbl").into_iter().next() {
                    Some(tbl) => {
                        let len = tbl.len();
                        out.push(Block::Table(tbl));
                        i = t + len;
                    }
                    None => break,
                }
            }
            None => {
                for para in paragraphs_in(&body[i..]) {
                    out.push(Block::Para(para));
                }
                break;
            }
        }
    }
    out
}

/// A docx toggle property (`<w:b/>`, `<w:i/>`, …) is on unless it carries an
/// explicit falsey `w:val` (`0` / `false` / `off`).
fn toggle_on(rpr: &str, name: &str) -> bool {
    match opening_tag(rpr, name) {
        None => false,
        Some(tag) => !matches!(attr(tag, "w:val"), Some("0") | Some("false") | Some("off")),
    }
}

/// Index of the next real element start of `name` at or after `from`.
fn find_real(xml: &str, name: &str, from: usize) -> Option<usize> {
    let mut i = from;
    loop {
        let rel = xml[i..].find(name)?;
        let start = i + rel;
        if is_real_start(&xml[start + name.len()..]) {
            return Some(start);
        }
        i = start + name.len();
    }
}

/// Top-level `<w:p>` slices in a table-free region.
fn paragraphs_in(region: &str) -> Vec<&str> {
    elements(region, "w:p")
}

fn docx_run_html(run: &str) -> String {
    let text = collect_text(run, "w:t");
    if text.is_empty() {
        // Preserve explicit breaks.
        if run.contains("<w:br") {
            return "<br>".to_string();
        }
        return String::new();
    }
    let rpr = elements(run, "w:rPr").into_iter().next().unwrap_or("");
    let mut style = String::new();
    if toggle_on(rpr, "w:b") {
        style.push_str("font-weight:600;");
    }
    if toggle_on(rpr, "w:i") {
        style.push_str("font-style:italic;");
    }
    if opening_tag(rpr, "w:u").and_then(|t| attr(t, "w:val")) != Some("none")
        && rpr.contains("<w:u")
    {
        style.push_str("text-decoration:underline;");
    }
    if let Some(c) = opening_tag(rpr, "w:color").and_then(|t| attr(t, "w:val").map(str::to_string)) {
        if hex_ok(&c) {
            style.push_str(&format!("color:#{};", c.to_ascii_uppercase()));
        }
    }
    if let Some(sz) = opening_tag(rpr, "w:sz").and_then(|t| attr(t, "w:val").map(str::to_string)) {
        if let Ok(halfpts) = sz.parse::<f64>() {
            style.push_str(&format!("font-size:{:.1}pt;", halfpts / 2.0));
        }
    }
    if let Some(f) = opening_tag(rpr, "w:rFonts").and_then(|t| attr(t, "w:ascii")) {
        style.push_str(&format!("font-family:{};", font_stack(f)));
    }
    format!("<span style=\"{style}\">{}</span>", html_escape(&text))
}

/// A CSS font-family stack for a document font name, with a generic fallback
/// that matches its classification so the preview echoes serif vs. sans.
fn font_stack(name: &str) -> String {
    const SERIF: [&str; 8] = [
        "georgia",
        "cambria",
        "times",
        "garamond",
        "constantia",
        "book antiqua",
        "liberation serif",
        "noto serif",
    ];
    let lower = name.to_ascii_lowercase();
    let generic = if SERIF.iter().any(|s| lower.contains(s)) {
        "serif"
    } else {
        "sans-serif"
    };
    format!("'{}',{generic}", name.replace('\'', ""))
}

fn docx_para_html(para: &str) -> String {
    let ppr = elements(para, "w:pPr").into_iter().next().unwrap_or("");
    let style_val = opening_tag(ppr, "w:pStyle")
        .and_then(|t| attr(t, "w:val"))
        .unwrap_or("");

    let runs: String = elements(para, "w:r")
        .iter()
        .map(|r| docx_run_html(r))
        .collect();
    let plain = collect_text(para, "w:t");
    if plain.trim().is_empty() && !para.contains("<w:br") {
        return String::new();
    }

    // Bottom rule (pBdr/bottom) → underline the block.
    let mut block_style = String::new();
    if let Some(b) = opening_tag(ppr, "w:bottom") {
        let color = attr(b, "w:color").filter(|c| hex_ok(c)).unwrap_or("E2E8F0");
        block_style.push_str(&format!("border-bottom:1.5px solid #{color};padding-bottom:4px;"));
    }

    match style_val {
        "Title" => format!("<h1 style=\"{block_style}\">{runs}</h1>"),
        "Heading1" => format!("<h2 style=\"{block_style}\">{runs}</h2>"),
        "Heading2" => format!("<h3 style=\"{block_style}\">{runs}</h3>"),
        s if s.starts_with("Heading") => format!("<h4 style=\"{block_style}\">{runs}</h4>"),
        s if s.starts_with("ListBullet") || s == "ListParagraph" => {
            format!("<div class=\"li bullet\">{runs}</div>")
        }
        s if s.starts_with("ListNumber") => format!("<div class=\"li num\">{runs}</div>"),
        _ => format!("<p style=\"{block_style}\">{runs}</p>"),
    }
}

/// CSS for a Word border spec (`val` style, `w:sz` eighths-of-a-point, colour).
fn edge_css(borders: &str, edge: &str) -> String {
    let tag = opening_tag(borders, &format!("w:{edge}"));
    let val = tag.and_then(|t| attr(t, "w:val")).unwrap_or("none");
    if val == "none" || val == "nil" {
        return "none".to_string();
    }
    let color = tag
        .and_then(|t| attr(t, "w:color"))
        .filter(|c| hex_ok(c))
        .map(|c| c.to_ascii_uppercase())
        .unwrap_or_else(|| "94A3B8".to_string());
    let pt = tag
        .and_then(|t| attr(t, "w:sz"))
        .and_then(|s| s.parse::<f64>().ok())
        .map(|e| (e / 8.0).max(0.5))
        .unwrap_or(0.5);
    format!("{pt:.1}pt solid #{color}")
}

fn docx_table_html(tbl: &str) -> String {
    let tblpr = elements(tbl, "w:tblPr").into_iter().next().unwrap_or("");
    let tb = elements(tblpr, "w:tblBorders").into_iter().next().unwrap_or("");
    let (top, bottom, left, right, ih, iv) = (
        edge_css(tb, "top"),
        edge_css(tb, "bottom"),
        edge_css(tb, "left"),
        edge_css(tb, "right"),
        edge_css(tb, "insideH"),
        edge_css(tb, "insideV"),
    );
    let trs = elements(tbl, "w:tr");
    let nrows = trs.len();
    let mut rows = String::new();
    for (ri, tr) in trs.iter().enumerate() {
        let tcs = elements(tr, "w:tc");
        let ncols = tcs.len();
        let mut cells = String::new();
        for (ci, tc) in tcs.iter().enumerate() {
            let tcpr = elements(tc, "w:tcPr").into_iter().next().unwrap_or("");
            let bt = if ri == 0 { &top } else { &ih };
            let mut bb = if ri + 1 == nrows { bottom.clone() } else { ih.clone() };
            let bl = if ci == 0 { &left } else { &iv };
            let br = if ci + 1 == ncols { &right } else { &iv };
            // A cell-level bottom border (e.g. a strong header rule) wins.
            let tcb = elements(tcpr, "w:tcBorders").into_iter().next().unwrap_or("");
            let cell_bottom = edge_css(tcb, "bottom");
            if cell_bottom != "none" {
                bb = cell_bottom;
            }
            let mut cs = format!(
                "padding:8px 14px 8px 0;vertical-align:top;border-top:{bt};border-bottom:{bb};\
                 border-left:{bl};border-right:{br};"
            );
            if let Some(shd) = opening_tag(tcpr, "w:shd") {
                if let Some(fill) = attr(shd, "w:fill").filter(|f| hex_ok(f)) {
                    cs.push_str(&format!(
                        "background:#{};padding-left:14px;",
                        fill.to_ascii_uppercase()
                    ));
                }
            }
            let inner: String = elements(tc, "w:p").iter().map(|p| docx_para_html(p)).collect();
            cells.push_str(&format!("<td style=\"{cs}\">{inner}</td>"));
        }
        rows.push_str(&format!("<tr>{cells}</tr>"));
    }
    format!(
        "<table style=\"border-collapse:collapse;width:100%;margin:12px 0;font-size:10.5pt\">{rows}</table>"
    )
}

pub fn docx_to_html(bytes: &[u8]) -> Option<String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut xml = String::new();
    zip.by_name("word/document.xml").ok()?.read_to_string(&mut xml).ok()?;
    let body = elements(&xml, "w:body").into_iter().next().unwrap_or(&xml);

    let mut inner = String::from("<div class=\"page\">");
    for block in body_blocks(body) {
        match block {
            Block::Para(p) => inner.push_str(&docx_para_html(p)),
            Block::Table(t) => inner.push_str(&docx_table_html(t)),
        }
    }
    inner.push_str("</div>");

    let css = "padding:28px 0";
    let page_css = "\
.page{background:#fff;max-width:820px;margin:0 auto;padding:64px 72px;\
box-shadow:0 1px 4px rgba(15,23,42,.12);border-radius:2px;line-height:1.5;font-size:10.5pt}\
.page h1{font-size:30pt;font-weight:700;margin:2px 0 4px;line-height:1.1}\
.page h2{font-size:16pt;font-weight:700;margin:16px 0 5px}\
.page h3{font-size:13pt;font-weight:700;margin:11px 0 3px}\
.page h4{font-size:11pt;font-weight:700;margin:9px 0 3px}\
.page p{margin:0 0 7px}\
.page .li{position:relative;margin:0 0 4px;padding-left:22px}\
.page .li.bullet:before{content:'\\2022';position:absolute;left:6px;font-weight:700}\
.page .li.num{counter-increment:li}\
.page .li.num:before{content:counter(li) '.';position:absolute;left:2px}\
.page{counter-reset:li}";
    Some(doc_shell(inner, css).replace("</style>", &format!("{page_css}</style>")))
}

// ===========================================================================
// PPTX
// ===========================================================================

fn slide_size(zip: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>) -> (f64, f64) {
    let mut xml = String::new();
    if zip
        .by_name("ppt/presentation.xml")
        .ok()
        .and_then(|mut f| f.read_to_string(&mut xml).ok())
        .is_some()
    {
        if let Some(tag) = opening_tag(&xml, "p:sldSz") {
            let cx = attr(tag, "cx").and_then(|v| v.parse::<f64>().ok());
            let cy = attr(tag, "cy").and_then(|v| v.parse::<f64>().ok());
            if let (Some(cx), Some(cy)) = (cx, cy) {
                return (cx, cy);
            }
        }
    }
    (12192000.0, 6858000.0)
}

struct Xfrm {
    x: f64,
    y: f64,
    cx: f64,
    cy: f64,
}

fn xfrm_of(sppr: &str) -> Option<Xfrm> {
    let off = opening_tag(sppr, "a:off")?;
    let ext = opening_tag(sppr, "a:ext")?;
    Some(Xfrm {
        x: attr(off, "x")?.parse().ok()?,
        y: attr(off, "y")?.parse().ok()?,
        cx: attr(ext, "cx")?.parse().ok()?,
        cy: attr(ext, "cy")?.parse().ok()?,
    })
}

/// Render the runs of a `<a:txBody>` as HTML paragraphs.
fn pptx_text_html(txbody: &str, default_color: &str) -> String {
    let mut out = String::new();
    for p in elements(txbody, "a:p") {
        let ppr_el = elements(p, "a:pPr").into_iter().next().unwrap_or("");
        let ppr = opening_tag(p, "a:pPr");
        let align = ppr.and_then(|t| attr(t, "algn")).unwrap_or("l");
        // Bullet marker: <a:buChar char="•"/> (unless <a:buNone/>).
        let bullet = if ppr_el.contains("<a:buNone") {
            None
        } else if let Some(tag) = opening_tag(ppr_el, "a:buChar") {
            attr(tag, "char").map(|c| xml_unescape(c))
        } else if ppr_el.contains("<a:buAutoNum") {
            Some("•".to_string())
        } else {
            None
        };
        let bullet_color = {
            let buclr = elements(ppr_el, "a:buClr").into_iter().next().unwrap_or("");
            first_srgb(buclr)
        };
        let css_align = match align {
            "ctr" => "center",
            "r" => "right",
            "just" => "justify",
            _ => "left",
        };
        let mut runs = String::new();
        for r in elements(p, "a:r") {
            let text = collect_text(r, "a:t");
            if text.is_empty() {
                continue;
            }
            let rpr = elements(r, "a:rPr").into_iter().next().unwrap_or("");
            let mut style = format!("color:#{default_color};");
            if let Some(sz) = attr(rpr, "sz") {
                if let Ok(hundredths) = sz.parse::<f64>() {
                    // pt → cqw relative to a 960pt-wide slide.
                    let cqw = hundredths / 100.0 / 960.0 * 100.0;
                    style.push_str(&format!("font-size:{cqw:.3}cqw;"));
                }
            }
            if attr(rpr, "b") == Some("1") {
                style.push_str("font-weight:700;");
            }
            if attr(rpr, "i") == Some("1") {
                style.push_str("font-style:italic;");
            }
            if let Some(c) = first_srgb(rpr) {
                style.push_str(&format!("color:#{c};"));
            }
            if let Some(f) = opening_tag(rpr, "a:latin").and_then(|t| attr(t, "typeface")) {
                style.push_str(&format!("font-family:{};", font_stack(f)));
            }
            runs.push_str(&format!("<span style=\"{style}\">{}</span>", html_escape(&text)));
        }
        if runs.is_empty() {
            out.push_str("<div class=\"ap\">&nbsp;</div>");
        } else if let Some(mark) = bullet {
            let mc = bullet_color.unwrap_or_else(|| default_color.to_string());
            out.push_str(&format!(
                "<div class=\"ap bul\" style=\"text-align:{css_align}\">\
                 <span class=\"bm\" style=\"color:#{mc}\">{}</span>\
                 <span class=\"bt\">{runs}</span></div>",
                html_escape(&mark)
            ));
        } else {
            out.push_str(&format!("<div class=\"ap\" style=\"text-align:{css_align}\">{runs}</div>"));
        }
    }
    out
}

fn pct(v: f64, total: f64) -> f64 {
    (v / total * 100.0).clamp(-5.0, 105.0)
}

fn pptx_shape_html(sp: &str, sw: f64, sh: f64, theme_text: &str) -> Option<String> {
    let sppr = elements(sp, "p:spPr").into_iter().next().unwrap_or("");
    let xf = xfrm_of(sppr)?;
    // Fill colour lives in spPr before any <a:ln> line section.
    let fill_region = sppr.split("<a:ln").next().unwrap_or(sppr);
    let fill = first_srgb(fill_region);

    let anchor = opening_tag(sp, "a:bodyPr")
        .and_then(|t| attr(t, "anchor"))
        .unwrap_or("t");
    let justify = match anchor {
        "ctr" => "center",
        "b" => "flex-end",
        _ => "flex-start",
    };

    let mut style = format!(
        "position:absolute;left:{:.3}%;top:{:.3}%;width:{:.3}%;height:{:.3}%;\
overflow:hidden;display:flex;flex-direction:column;justify-content:{justify};",
        pct(xf.x, sw),
        pct(xf.y, sh),
        pct(xf.cx, sw),
        pct(xf.cy, sh),
    );
    if let Some(f) = &fill {
        style.push_str(&format!("background:#{f};"));
    }
    // Text boxes get a little inset padding.
    let txbody = elements(sp, "p:txBody").into_iter().next().unwrap_or("");
    let inner = if txbody.is_empty() {
        String::new()
    } else {
        style.push_str("padding:0.4cqw 0.6cqw;");
        pptx_text_html(txbody, theme_text)
    };
    Some(format!("<div style=\"{style}\">{inner}</div>"))
}

fn pptx_table_html(gf: &str, sw: f64, sh: f64, theme_text: &str) -> Option<String> {
    let xf = xfrm_of(gf)?;
    let tbl = elements(gf, "a:tbl").into_iter().next()?;
    let mut rows = String::new();
    for tr in elements(tbl, "a:tr") {
        let mut cells = String::new();
        for tc in elements(tr, "a:tc") {
            let tcpr = elements(tc, "a:tcPr").into_iter().next().unwrap_or("");
            let fill = first_srgb(tcpr);
            let txbody = elements(tc, "p:txBody")
                .into_iter()
                .next()
                .or_else(|| elements(tc, "a:txBody").into_iter().next())
                .unwrap_or("");
            let mut cs = String::from(
                "border:1px solid rgba(148,163,184,.35);padding:0.5cqw 0.7cqw;vertical-align:middle;",
            );
            if let Some(f) = fill {
                cs.push_str(&format!("background:#{f};"));
            }
            cells.push_str(&format!("<td style=\"{cs}\">{}</td>", pptx_text_html(txbody, theme_text)));
        }
        rows.push_str(&format!("<tr>{cells}</tr>"));
    }
    let style = format!(
        "position:absolute;left:{:.3}%;top:{:.3}%;width:{:.3}%;\
border-collapse:collapse;",
        pct(xf.x, sw),
        pct(xf.y, sh),
        pct(xf.cx, sw),
    );
    Some(format!("<table style=\"{style}\">{rows}</table>"))
}

/// Iterate the direct children of a spTree in document order, classifying each
/// as a shape (`p:sp`) or table/graphic frame (`p:graphicFrame`).
fn pptx_slide_html(xml: &str, sw: f64, sh: f64, theme_text: &str) -> String {
    let tree = elements(xml, "p:spTree").into_iter().next().unwrap_or(xml);
    // Collect shapes and frames with their positions in the string to preserve
    // z-order (later elements paint on top).
    let mut items: Vec<(usize, String)> = Vec::new();
    for sp in elements(tree, "p:sp") {
        let off = sp.as_ptr() as usize - tree.as_ptr() as usize;
        if let Some(h) = pptx_shape_html(sp, sw, sh, theme_text) {
            items.push((off, h));
        }
    }
    for gf in elements(tree, "p:graphicFrame") {
        let off = gf.as_ptr() as usize - tree.as_ptr() as usize;
        if let Some(h) = pptx_table_html(gf, sw, sh, theme_text) {
            items.push((off, h));
        }
    }
    items.sort_by_key(|(o, _)| *o);
    items.into_iter().map(|(_, h)| h).collect()
}

pub fn pptx_to_html(bytes: &[u8]) -> Option<String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let (sw, sh) = slide_size(&mut zip);
    let aspect = sw / sh;

    let mut names: Vec<String> = zip
        .file_names()
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml") && !n.contains("_rels"))
        .map(|s| s.to_string())
        .collect();
    names.sort_by_key(|n| {
        n.trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(u32::MAX)
    });
    if names.is_empty() {
        return None;
    }

    let theme_text = "1e293b";
    let mut inner = String::new();
    for name in &names {
        let mut xml = String::new();
        if zip
            .by_name(name)
            .ok()
            .and_then(|mut f| f.read_to_string(&mut xml).ok())
            .is_none()
        {
            continue;
        }
        let shapes = pptx_slide_html(&xml, sw, sh, theme_text);
        inner.push_str(&format!("<div class=\"slide\">{shapes}</div>"));
    }

    let css = "padding:20px";
    let deck_css = format!(
        "\
.slide{{position:relative;width:100%;max-width:960px;margin:0 auto 20px;\
aspect-ratio:{aspect:.4};background:#fff;border:1px solid #e2e8f0;border-radius:6px;\
overflow:hidden;box-shadow:0 2px 10px rgba(15,23,42,.14);container-type:inline-size;\
font-size:2.2cqw;line-height:1.15}}\
.slide .ap{{width:100%}}\
.slide .ap.bul{{display:flex;align-items:baseline;gap:0.8cqw}}\
.slide .ap.bul .bm{{flex:0 0 auto;font-weight:700}}\
.slide .ap.bul .bt{{flex:1 1 auto}}\
.slide table{{font-size:2cqw}}"
    );
    Some(doc_shell(inner, css).replace("</style>", &format!("{deck_css}</style>")))
}

// ===========================================================================
// XLSX
// ===========================================================================

pub fn xlsx_to_html(bytes: &[u8]) -> Option<String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;

    let mut shared: Vec<String> = Vec::new();
    if let Ok(mut f) = zip.by_name("xl/sharedStrings.xml") {
        let mut xml = String::new();
        if f.read_to_string(&mut xml).is_ok() {
            for si in elements(&xml, "si") {
                shared.push(collect_text(si, "t"));
            }
        }
    }

    let mut xml = String::new();
    zip.by_name("xl/worksheets/sheet1.xml").ok()?.read_to_string(&mut xml).ok()?;

    let mut rows_html = String::new();
    for (ri, row) in elements(&xml, "row").iter().enumerate().take(500) {
        let mut cells_html = String::new();
        for cell in elements(row, "c") {
            let open = cell.find('>').map(|i| &cell[..i]).unwrap_or(cell);
            let is_shared = open.contains("t=\"s\"");
            let raw = collect_text(cell, "v");
            let value = if is_shared {
                raw.trim()
                    .parse::<usize>()
                    .ok()
                    .and_then(|i| shared.get(i).cloned())
                    .unwrap_or_default()
            } else if raw.is_empty() {
                collect_text(cell, "t")
            } else {
                raw
            };
            let tag = if ri == 0 { "th" } else { "td" };
            cells_html.push_str(&format!("<{tag}>{}</{tag}>", html_escape(value.trim())));
        }
        rows_html.push_str(&format!("<tr>{cells_html}</tr>"));
    }
    if rows_html.is_empty() {
        return None;
    }

    let css = "padding:28px";
    let sheet_css = "\
table{border-collapse:collapse;margin:0 auto;background:#fff;font-size:11pt;\
box-shadow:0 1px 4px rgba(15,23,42,.12)}\
th,td{border:1px solid #e2e8f0;padding:7px 12px;text-align:left}\
th{background:#2563eb;color:#fff;font-weight:600}\
tr:nth-child(even) td{background:#f8fafc}";
    Some(
        doc_shell(format!("<table>{rows_html}</table>"), css)
            .replace("</style>", &format!("{sheet_css}</style>")),
    )
}

/// Extract readable plain text from a supported Office file's bytes, so it can
/// be handed to the model as message context. Returns `None` for unsupported
/// formats or unparseable files. `format` is the lowercase extension.
pub fn doc_to_text(format: &str, bytes: &[u8]) -> Option<String> {
    let text = match format {
        "docx" => docx_bytes_to_text(bytes)?,
        "pptx" => pptx_bytes_to_text(bytes)?,
        "xlsx" => strip_html_to_text(&xlsx_to_html(bytes)?),
        "pdf" => pdf_bytes_to_text(bytes)?,
        // Legacy binary Office (OLE2/CFBF): the zip-based extractors above
        // can't read these. `office_oxide` parses the compound-file container
        // and pulls plain text from the WordDocument / PowerPoint Document
        // stream. Wrapped in catch_unwind because third-party parsers can
        // panic on malformed legacy files — degrade to None like the PDF path.
        "doc" | "ppt" | "xls" => legacy_office_bytes_to_text(format, bytes)?,
        _ => return None,
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Cap to keep the prompt bounded on very large documents, but make the
    // cut visible so the model knows text continues beyond what it can see.
    //
    // The limit tracks the smallest context window among the providers this
    // app supports. Claude's Sonnet/Opus family sits at 200K tokens; ChatGPT's
    // GPT-4o line at 128K tokens (~512K chars at ~4 chars/token). 250K chars
    // is a safe single-attachment budget that fits inside the 128K-token
    // window even alongside the rest of the turn's conversation + tool output.
    // Images and plain-text attachments take separate paths (vision input /
    // direct inline) and never reach this cap.
    const MAX_CHARS: usize = 250_000;
    if trimmed.chars().count() <= MAX_CHARS {
        return Some(trimmed.to_string());
    }
    let head: String = trimmed.chars().take(MAX_CHARS).collect();
    Some(format!(
        "{head}\n\n[... document truncated: showing first {MAX_CHARS} characters of a longer file ...]"
    ))
}

/// Extract text from a PDF's bytes. Uses `pdf-extract`, which can panic on some
/// malformed inputs, so the call is wrapped in `catch_unwind` to degrade
/// gracefully to `None` rather than taking down the chat task.
fn pdf_bytes_to_text(bytes: &[u8]) -> Option<String> {
    let owned = bytes.to_vec();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pdf_extract::extract_text_from_mem(&owned).ok()
    }));
    result.ok().flatten()
}

/// Extract text from a legacy binary Office file (`.doc` / `.ppt` / `.xls`) via
/// `office_oxide`. `format` is the lowercase extension. Returns `None` on any
/// parse error or panic so the chat path degrades gracefully — the caller
/// surfaces a "could not be read as text" note rather than crashing the turn.
fn legacy_office_bytes_to_text(format: &str, bytes: &[u8]) -> Option<String> {
    let fmt = office_oxide::DocumentFormat::from_extension(format)?;
    let owned = bytes.to_vec();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        office_oxide::Document::from_reader(std::io::Cursor::new(owned), fmt)
            .ok()
            .map(|doc| doc.plain_text())
    }));
    result.ok().flatten()
}

fn docx_bytes_to_text(bytes: &[u8]) -> Option<String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut xml = String::new();
    zip.by_name("word/document.xml").ok()?.read_to_string(&mut xml).ok()?;
    let mut out = String::new();
    for para in elements(&xml, "w:p") {
        let line = collect_text(para, "w:t");
        out.push_str(line.trim_end());
        out.push('\n');
    }
    Some(out)
}

fn pptx_bytes_to_text(bytes: &[u8]) -> Option<String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let names: Vec<String> = zip
        .file_names()
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .map(|n| n.to_string())
        .collect();
    let mut ordered = names;
    ordered.sort();
    let mut out = String::new();
    for (i, name) in ordered.iter().enumerate() {
        let mut xml = String::new();
        if zip.by_name(name).ok()?.read_to_string(&mut xml).is_err() {
            continue;
        }
        out.push_str(&format!("--- Slide {} ---\n", i + 1));
        for para in elements(&xml, "a:p") {
            let line = collect_text(para, "a:t");
            if !line.trim().is_empty() {
                out.push_str(line.trim_end());
                out.push('\n');
            }
        }
        out.push('\n');
    }
    Some(out)
}

/// Strip HTML tags to plain text, turning row/paragraph boundaries into
/// newlines and cells into tab-separated values, then decode entities.
fn strip_html_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    let mut tag = String::new();
    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' => {
                in_tag = false;
                let t = tag.trim_start_matches('/').to_ascii_lowercase();
                if t.starts_with("tr") || t.starts_with("p") || t.starts_with("div")
                    || t.starts_with("br") || t.starts_with("h")
                {
                    out.push('\n');
                } else if t.starts_with("td") || t.starts_with("th") {
                    out.push('\t');
                }
            }
            _ if in_tag => tag.push(ch),
            _ => out.push(ch),
        }
    }
    let decoded = xml_unescape(&out);
    decoded
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elements_handles_nesting_and_self_close() {
        let xml = r#"<w:tbl><w:tr><w:tc><w:p><w:t>a</w:t></w:p></w:tc></w:tr></w:tbl><w:p><w:t>b</w:t></w:p>"#;
        let tbls = elements(xml, "w:tbl");
        assert_eq!(tbls.len(), 1);
        assert!(tbls[0].contains(">a<"));
        // Top-level w:p search should find both the in-table and trailing one.
        assert_eq!(elements(xml, "w:p").len(), 2);
    }

    #[test]
    fn attr_and_collect_text() {
        assert_eq!(attr("<a:off x=\"10\" y=\"20\"/>", "y"), Some("20"));
        let run = r#"<w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> A &amp; B</w:t></w:r>"#;
        assert_eq!(collect_text(run, "w:t"), "Hello A & B");
    }

    #[test]
    fn docx_render_from_generated_file() {
        let dir = std::env::temp_dir().join(format!("conduit-docx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = crate::chat::artifacts::generate(
            &dir,
            "docx",
            "t.docx",
            None,
            "Solar System\nEight planets orbit the Sun.",
        )
        .unwrap();
        let html = docx_to_html(&std::fs::read(&f.path).unwrap()).unwrap();
        assert!(html.contains("Solar System"), "{html}");
        assert!(html.contains("Eight planets"), "{html}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn doc_to_text_extracts_docx_and_pptx() {
        let dir = std::env::temp_dir().join(format!("conduit-doctext-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let docx = crate::chat::artifacts::generate(
            &dir,
            "docx",
            "t.docx",
            None,
            "Solar System\nEight planets orbit the Sun.",
        )
        .unwrap();
        let text = doc_to_text("docx", &std::fs::read(&docx.path).unwrap()).unwrap();
        assert!(text.contains("Solar System"), "{text}");
        assert!(text.contains("Eight planets orbit the Sun."), "{text}");
        assert!(!text.contains('<'), "should be plain text, got: {text}");

        let pptx = crate::chat::artifacts::generate(
            &dir,
            "pptx",
            "t.pptx",
            None,
            "Slide One\nAlpha\n---\nSlide Two\nBeta",
        )
        .unwrap();
        let ptext = doc_to_text("pptx", &std::fs::read(&pptx.path).unwrap()).unwrap();
        assert!(ptext.contains("Alpha") && ptext.contains("Beta"), "{ptext}");

        assert!(doc_to_text("bogus", b"not a real file").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn doc_to_text_extracts_pdf_and_handles_garbage() {
        let dir = std::env::temp_dir().join(format!("conduit-pdftext-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let pdf = crate::chat::artifacts::generate(
            &dir,
            "pdf",
            "t.pdf",
            Some("Quarterly Report"),
            "Revenue grew twelve percent.\nCosts stayed flat.",
        )
        .unwrap();
        let text = doc_to_text("pdf", &std::fs::read(&pdf.path).unwrap()).unwrap();
        assert!(text.contains("Revenue grew twelve percent."), "{text}");

        // Malformed PDF bytes degrade gracefully to None (never panic).
        assert!(doc_to_text("pdf", b"%PDF-1.4 not really a pdf").is_none());
        assert!(doc_to_text("pdf", b"").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn doc_to_text_handles_legacy_office_garbage() {
        // The legacy .doc/.ppt/.xls arms route through office_oxide. We can't
        // synthetically build a valid OLE2/CFBF file here, so this guards the
        // contract that matters for the chat path: malformed legacy bytes must
        // degrade to None rather than panic the streaming turn (mirroring the
        // PDF garbage test above), and the new format arms are actually
        // reached (unknown formats still fall through to None).
        assert!(doc_to_text("doc", b"not a real doc").is_none());
        assert!(doc_to_text("ppt", b"not a real ppt").is_none());
        assert!(doc_to_text("xls", b"not a real xls").is_none());
        assert!(doc_to_text("doc", b"").is_none());
        assert!(doc_to_text("ppt", b"").is_none());
        // An extension office_oxide doesn't map still returns None.
        assert!(doc_to_text("rtf", b"{\\rtf1 hi}").is_none());
    }

    #[test]
    fn pptx_render_positions_shapes() {
        let dir = std::env::temp_dir().join(format!("conduit-pptx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = crate::chat::artifacts::generate(
            &dir,
            "pptx",
            "t.pptx",
            None,
            "Slide One\nAlpha\n---\nSlide Two\nBeta",
        )
        .unwrap();
        let html = pptx_to_html(&std::fs::read(&f.path).unwrap()).unwrap();
        assert!(html.contains("Alpha") && html.contains("Beta"), "{html}");
        // Shapes are absolutely positioned from their EMU geometry.
        assert!(html.contains("position:absolute"), "{html}");
        assert_eq!(html.matches("class=\"slide\"").count(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
