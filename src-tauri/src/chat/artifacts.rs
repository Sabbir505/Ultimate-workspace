//! File/artifact generation for the chat `generate_file` tool.
//!
//! Produces real, openable files from model-supplied text content:
//!   * Plain formats (txt, md, csv, json, html) — written verbatim.
//!   * `pdf` — a minimal hand-rolled PDF (Helvetica, paginated) — no deps.
//!   * `docx`, `pptx`, `xlsx` — minimal but valid OpenXML packages built with
//!     the `zip` crate.
//!
//! Nothing here executes model input; content is only ever written to a file
//! inside the caller-provided artifacts directory.

use std::io::Write;
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;

/// A generated file on disk.
pub struct GeneratedFile {
    pub path: PathBuf,
    pub filename: String,
}

/// Formats the tool understands (anything else → error).
pub fn is_supported(format: &str) -> bool {
    matches!(
        format,
        "txt" | "text" | "md" | "markdown" | "csv" | "json" | "html" | "htm"
            | "pdf" | "docx" | "pptx" | "xlsx"
    ) || is_code_format(format)
}

/// Source-code / config formats written verbatim, mapped to a real extension so
/// a Python file is `.py`, C++ is `.cpp`, etc. (never `foo.py.txt`).
pub(crate) fn is_code_format(format: &str) -> bool {
    !matches!(code_ext(format), "")
}

/// Canonical source extension for a code/config language, or "" if unknown.
fn code_ext(format: &str) -> &'static str {
    match format {
        "python" | "py" => "py",
        "javascript" | "js" | "node" => "js",
        "typescript" | "ts" => "ts",
        "jsx" => "jsx",
        "tsx" => "tsx",
        "java" => "java",
        "c" => "c",
        "cpp" | "c++" | "cxx" | "cc" => "cpp",
        "h" | "hpp" => "h",
        "csharp" | "c#" | "cs" => "cs",
        "go" | "golang" => "go",
        "rust" | "rs" => "rs",
        "ruby" | "rb" => "rb",
        "php" => "php",
        "swift" => "swift",
        "kotlin" | "kt" => "kt",
        "scala" => "scala",
        "sh" | "bash" | "shell" | "zsh" => "sh",
        "sql" => "sql",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "ini" => "ini",
        "xml" => "xml",
        "css" => "css",
        "scss" => "scss",
        "r" => "r",
        "dart" => "dart",
        "lua" => "lua",
        "perl" | "pl" => "pl",
        _ => "",
    }
}

/// Whether `name` already ends with a recognized code/text extension, so we
/// keep the author's own extension instead of appending another.
fn has_known_ext(name: &str) -> bool {
    let lower = name.to_lowercase();
    match lower.rsplit_once('.') {
        Some((_, ext)) => {
            !matches!(code_ext(ext), "")
                || matches!(
                    ext,
                    "txt" | "md" | "markdown" | "csv" | "json" | "html" | "htm"
                        | "pdf" | "docx" | "pptx" | "xlsx"
                )
        }
        None => false,
    }
}

/// Write `content` (and optional `title`) to a `format` file named `filename`
/// (extension added if missing) inside `dir`. Returns the created file.
pub fn generate(
    dir: &Path,
    format: &str,
    filename: &str,
    title: Option<&str>,
    content: &str,
) -> Result<GeneratedFile, String> {
    if !is_supported(format) {
        return Err(format!("unsupported format \"{format}\""));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create artifacts dir: {e}"))?;

    let ext = canonical_ext(format);
    let base = sanitize_filename(filename);
    let name = if base.to_lowercase().ends_with(&format!(".{ext}")) || has_known_ext(&base) {
        // Respect an extension the author already chose (e.g. `main.py`) rather
        // than appending another (which produced `main.py.txt`).
        base
    } else {
        format!("{base}.{ext}")
    };
    let path = dir.join(&name);

    match format {
        "pdf" => write_pdf(&path, title, content)?,
        "docx" => write_docx(&path, title, content)?,
        "pptx" => write_pptx(&path, title, content)?,
        "xlsx" => write_xlsx(&path, title, content)?,
        // Everything else (text, markdown, html, and all code/config
        // languages) is written verbatim.
        _ => {
            let body = match (format, title) {
                ("html" | "htm", Some(t)) if !t.is_empty() => wrap_html(t, content),
                ("md" | "markdown", Some(t)) if !t.is_empty() => {
                    format!("# {t}\n\n{content}")
                }
                _ => content.to_string(),
            };
            std::fs::write(&path, body).map_err(|e| e.to_string())?;
        }
    }

    Ok(GeneratedFile {
        path,
        filename: name,
    })
}

pub(crate) fn canonical_ext(format: &str) -> &'static str {
    match format {
        "markdown" | "md" => "md",
        "txt" | "text" => "txt",
        "csv" => "csv",
        "json" => "json",
        "html" | "htm" => "html",
        "pdf" => "pdf",
        "docx" => "docx",
        "pptx" => "pptx",
        "xlsx" => "xlsx",
        _ => {
            let code = code_ext(format);
            if code.is_empty() {
                "txt"
            } else {
                code
            }
        }
    }
}

/// Keep a filename to a safe basename (no path separators, no traversal).
pub(crate) fn sanitize_filename(name: &str) -> String {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("artifact")
        .trim();
    let cleaned: String = base
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' '))
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "artifact".to_string()
    } else {
        cleaned
    }
}

fn wrap_html(title: &str, content: &str) -> String {
    format!(
        "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<title>{}</title>\n</head>\n<body>\n{}\n</body>\n</html>\n",
        xml_escape(title),
        content
    )
}

// ---- XML / text helpers ----

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

// ---- PDF ----

/// Escape a string for a PDF literal string `(...)` and fold to Latin-1,
/// replacing characters outside that range so the standard Helvetica encoding
/// renders them.
fn pdf_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        let mapped = match c {
            '—' | '–' => '-',
            '“' | '”' => '"',
            '‘' | '’' => '\'',
            '…' => '.', // keep it simple
            _ => c,
        };
        match mapped {
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) <= 0xFF => out.push(c),
            _ => out.push('?'),
        }
    }
    out
}

/// Greedy word-wrap at `width` characters.
fn wrap_lines(content: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for raw in content.split('\n') {
        if raw.trim().is_empty() {
            lines.push(String::new());
            continue;
        }
        let mut current = String::new();
        for word in raw.split_whitespace() {
            if current.is_empty() {
                current = word.to_string();
            } else if current.len() + 1 + word.len() <= width {
                current.push(' ');
                current.push_str(word);
            } else {
                lines.push(std::mem::take(&mut current));
                current = word.to_string();
            }
        }
        if !current.is_empty() {
            lines.push(current);
        }
    }
    lines
}

fn write_pdf(path: &Path, title: Option<&str>, content: &str) -> Result<(), String> {
    const LINES_PER_PAGE: usize = 52;
    const WRAP: usize = 92;

    let mut all_lines: Vec<String> = Vec::new();
    if let Some(t) = title {
        if !t.is_empty() {
            all_lines.push(t.to_string());
            all_lines.push(String::new());
        }
    }
    all_lines.extend(wrap_lines(content, WRAP));

    let pages: Vec<&[String]> = if all_lines.is_empty() {
        vec![&[][..]]
    } else {
        all_lines.chunks(LINES_PER_PAGE).collect()
    };

    // Object layout: 1=Catalog, 2=Pages, 3=Font, then for each page a page
    // object and a content object.
    let n_pages = pages.len();
    let mut objects: Vec<String> = Vec::new();

    objects.push("<< /Type /Catalog /Pages 2 0 R >>".to_string());

    let mut kids = String::new();
    for i in 0..n_pages {
        let page_obj = 4 + i * 2;
        kids.push_str(&format!("{page_obj} 0 R "));
    }
    objects.push(format!(
        "<< /Type /Pages /Kids [ {}] /Count {} >>",
        kids.trim_end(),
        n_pages
    ));

    objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string());

    for (i, page_lines) in pages.iter().enumerate() {
        let content_obj = 5 + i * 2;
        let mut stream = String::from("BT\n/F1 11 Tf\n50 760 Td\n14 TL\n");
        for (j, line) in page_lines.iter().enumerate() {
            if j == 0 {
                stream.push_str(&format!("({}) Tj\n", pdf_escape(line)));
            } else {
                stream.push_str(&format!("T*\n({}) Tj\n", pdf_escape(line)));
            }
        }
        stream.push_str("ET");

        // Page object.
        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
             /Resources << /Font << /F1 3 0 R >> >> /Contents {content_obj} 0 R >>"
        ));
        // Content stream object.
        objects.push(format!(
            "<< /Length {} >>\nstream\n{}\nendstream",
            stream.len(),
            stream
        ));
    }

    // Serialize with a byte-accurate xref table.
    let mut pdf = String::from("%PDF-1.4\n");
    let mut offsets = Vec::with_capacity(objects.len());
    for (i, obj) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.push_str(&format!("{} 0 obj\n{}\nendobj\n", i + 1, obj));
    }
    let xref_pos = pdf.len();
    let n = objects.len() + 1;
    pdf.push_str(&format!("xref\n0 {n}\n0000000000 65535 f \n"));
    for off in &offsets {
        pdf.push_str(&format!("{off:010} 00000 n \n"));
    }
    pdf.push_str(&format!(
        "trailer\n<< /Size {n} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF"
    ));

    std::fs::write(path, pdf.as_bytes()).map_err(|e| e.to_string())
}

// ---- OpenXML (zip) helpers ----

fn zip_write(path: &Path, parts: &[(&str, String)]) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, contents) in parts {
        zip.start_file(*name, opts).map_err(|e| e.to_string())?;
        zip.write_all(contents.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

// ---- DOCX ----

fn write_docx(path: &Path, title: Option<&str>, content: &str) -> Result<(), String> {
    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#;

    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

    let mut body = String::new();
    if let Some(t) = title {
        if !t.is_empty() {
            body.push_str(&format!(
                "<w:p><w:pPr><w:rPr><w:b/><w:sz w:val=\"32\"/></w:rPr></w:pPr>\
                 <w:r><w:rPr><w:b/><w:sz w:val=\"32\"/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
                xml_escape(t)
            ));
        }
    }
    for para in content.split('\n') {
        body.push_str(&format!(
            "<w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
            xml_escape(para)
        ));
    }

    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>{body}<w:sectPr/></w:body>
</w:document>"#
    );

    zip_write(
        path,
        &[
            ("[Content_Types].xml", content_types.to_string()),
            ("_rels/.rels", rels.to_string()),
            ("word/document.xml", document),
        ],
    )
}

// ---- XLSX ----

fn write_xlsx(path: &Path, _title: Option<&str>, content: &str) -> Result<(), String> {
    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#;

    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#;

    let workbook = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#;

    let workbook_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#;

    // Content is treated as CSV: rows by newline, cells by comma. Everything is
    // written as inline strings ("t=inlineStr") to avoid a shared-strings part.
    let mut rows = String::new();
    for (r, line) in content.split('\n').enumerate() {
        let row_idx = r + 1;
        let mut cells = String::new();
        for (c, cell) in line.split(',').enumerate() {
            let col = column_letter(c);
            cells.push_str(&format!(
                "<c r=\"{col}{row_idx}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
                xml_escape(cell)
            ));
        }
        rows.push_str(&format!("<row r=\"{row_idx}\">{cells}</row>"));
    }

    let sheet = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>{rows}</sheetData>
</worksheet>"#
    );

    zip_write(
        path,
        &[
            ("[Content_Types].xml", content_types.to_string()),
            ("_rels/.rels", rels.to_string()),
            ("xl/workbook.xml", workbook.to_string()),
            ("xl/_rels/workbook.xml.rels", workbook_rels.to_string()),
            ("xl/worksheets/sheet1.xml", sheet),
        ],
    )
}

fn column_letter(mut idx: usize) -> String {
    let mut s = String::new();
    loop {
        let rem = idx % 26;
        s.insert(0, (b'A' + rem as u8) as char);
        if idx < 26 {
            break;
        }
        idx = idx / 26 - 1;
    }
    s
}

// ---- PPTX ----

fn write_pptx(path: &Path, title: Option<&str>, content: &str) -> Result<(), String> {
    // Slides: separated by a line of "---". First non-empty line of a slide is
    // its title; the rest are bullet lines.
    let deck_title = title.unwrap_or("Presentation");
    let mut slides: Vec<(String, Vec<String>)> = Vec::new();
    for block in content.split("\n---\n") {
        let mut lines = block.lines().map(|l| l.trim()).filter(|l| !l.is_empty());
        if let Some(head) = lines.next() {
            let bullets: Vec<String> = lines.map(|l| l.to_string()).collect();
            slides.push((head.to_string(), bullets));
        }
    }
    if slides.is_empty() {
        slides.push((deck_title.to_string(), Vec::new()));
    }
    let n = slides.len();

    let mut content_types = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
"#,
    );
    for i in 1..=n {
        content_types.push_str(&format!(
            "<Override PartName=\"/ppt/slides/slide{i}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>\n"
        ));
    }
    content_types.push_str("</Types>");

    let root_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>"#;

    // presentation.xml references each slide by rId.
    let mut sldid = String::new();
    let mut pres_rels = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
"#,
    );
    for i in 1..=n {
        sldid.push_str(&format!("<p:sldId id=\"{}\" r:id=\"rId{i}\"/>", 255 + i));
        pres_rels.push_str(&format!(
            "<Relationship Id=\"rId{i}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{i}.xml\"/>\n"
        ));
    }
    pres_rels.push_str("</Relationships>");

    let presentation = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldIdLst>{sldid}</p:sldIdLst>
<p:sldSz cx="9144000" cy="6858000"/>
</p:presentation>"#
    );

    let mut parts: Vec<(String, String)> = vec![
        ("[Content_Types].xml".to_string(), content_types),
        ("_rels/.rels".to_string(), root_rels.to_string()),
        ("ppt/presentation.xml".to_string(), presentation),
        ("ppt/_rels/presentation.xml.rels".to_string(), pres_rels),
    ];

    for (i, (head, bullets)) in slides.iter().enumerate() {
        parts.push((
            format!("ppt/slides/slide{}.xml", i + 1),
            pptx_slide_xml(head, bullets),
        ));
    }

    let borrowed: Vec<(&str, String)> = parts
        .iter()
        .map(|(k, v)| (k.as_str(), v.clone()))
        .collect();
    zip_write(path, &borrowed)
}

fn pptx_slide_xml(title: &str, bullets: &[String]) -> String {
    let mut body = String::new();
    // Title text box.
    body.push_str(&format!(
        r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="685800" y="457200"/><a:ext cx="7772400" cy="1143000"/></a:xfrm></p:spPr>
<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US" sz="3200" b="1"/><a:t>{}</a:t></a:r></a:p></p:txBody></p:sp>"#,
        xml_escape(title)
    ));

    // Body text box with bullet paragraphs.
    let mut paras = String::new();
    if bullets.is_empty() {
        paras.push_str("<a:p></a:p>");
    } else {
        for b in bullets {
            paras.push_str(&format!(
                "<a:p><a:r><a:rPr lang=\"en-US\" sz=\"1800\"/><a:t>{}</a:t></a:r></a:p>",
                xml_escape(b)
            ));
        }
    }
    body.push_str(&format!(
        r#"<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="685800" y="1828800"/><a:ext cx="7772400" cy="4114800"/></a:xfrm></p:spPr>
<p:txBody><a:bodyPr/>{paras}</p:txBody></p:sp>"#
    ));

    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr/>
{body}
</p:spTree></p:cSld>
</p:sld>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn sanitize_strips_traversal() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("a/b/c.txt"), "c.txt");
        assert_eq!(sanitize_filename(""), "artifact");
        assert_eq!(sanitize_filename("re port!.pdf"), "re port.pdf");
    }

    #[test]
    fn column_letters() {
        assert_eq!(column_letter(0), "A");
        assert_eq!(column_letter(25), "Z");
        assert_eq!(column_letter(26), "AA");
        assert_eq!(column_letter(27), "AB");
    }

    #[test]
    fn wrap_respects_width_and_blank_lines() {
        let lines = wrap_lines("hello world foo\n\nbar", 9);
        assert_eq!(lines, vec!["hello", "world foo", "", "bar"]);
    }

    #[test]
    fn generates_plaintext_and_adds_extension() {
        let d = tmp();
        let f = generate(d.path(), "md", "notes", Some("Title"), "body text").unwrap();
        assert_eq!(f.filename, "notes.md");
        let s = std::fs::read_to_string(&f.path).unwrap();
        assert!(s.contains("# Title"));
        assert!(s.contains("body text"));
    }

    #[test]
    fn code_formats_get_language_extension() {
        let d = tmp();
        // format = language → correct source extension.
        let f = generate(d.path(), "python", "main", None, "print('hi')\n").unwrap();
        assert_eq!(f.filename, "main.py");
        let f = generate(d.path(), "cpp", "app", None, "int main(){}\n").unwrap();
        assert_eq!(f.filename, "app.cpp");
        // An author-supplied language extension is respected, never `foo.py.txt`.
        let f = generate(d.path(), "txt", "script.py", None, "print(1)\n").unwrap();
        assert_eq!(f.filename, "script.py");
        assert!(!f.filename.ends_with(".txt"));
        // Content is written verbatim for code.
        let f = generate(d.path(), "javascript", "index", None, "const x = 1;\n").unwrap();
        assert_eq!(f.filename, "index.js");
        assert_eq!(std::fs::read_to_string(&f.path).unwrap(), "const x = 1;\n");
    }

    #[test]
    fn generates_pdf_with_valid_markers() {
        let d = tmp();
        let f = generate(d.path(), "pdf", "doc", Some("Hello"), "line one\nline two").unwrap();
        let bytes = std::fs::read(&f.path).unwrap();
        assert!(bytes.starts_with(b"%PDF-1.4"));
        assert!(bytes.ends_with(b"%%EOF"));
        assert!(String::from_utf8_lossy(&bytes).contains("/Type /Catalog"));
    }

    #[test]
    fn generates_docx_pptx_xlsx_as_zip() {
        let d = tmp();
        for (fmt, entry) in [
            ("docx", "word/document.xml"),
            ("pptx", "ppt/presentation.xml"),
            ("xlsx", "xl/workbook.xml"),
        ] {
            let f = generate(d.path(), fmt, "out", Some("T"), "a,b\nc,d").unwrap();
            let file = std::fs::File::open(&f.path).unwrap();
            let mut zip = zip::ZipArchive::new(file).unwrap();
            assert!(zip.by_name("[Content_Types].xml").is_ok());
            assert!(zip.by_name(entry).is_ok(), "{fmt} missing {entry}");
        }
    }

    #[test]
    #[ignore = "writes fixtures to /tmp for external validation"]
    fn write_fixtures_for_validation() {
        let dir = std::path::Path::new("/tmp/relay_art");
        std::fs::create_dir_all(dir).unwrap();
        generate(dir, "pdf", "sample", Some("Sample Report"), "First line.\nSecond line — with an em dash and “quotes”.\nThird.").unwrap();
        generate(dir, "docx", "sample", Some("Sample Doc"), "Paragraph one.\nParagraph two.").unwrap();
        generate(dir, "xlsx", "sample", None, "Name,Score\nAlice,90\nBob,85").unwrap();
        generate(dir, "pptx", "sample", Some("Deck"), "Intro\nfirst point\nsecond point\n---\nNext Slide\nonly bullet").unwrap();
        println!("wrote fixtures to {}", dir.display());
    }

    #[test]
    fn rejects_unknown_format() {
        let d = tmp();
        assert!(generate(d.path(), "exe", "x", None, "").is_err());
        assert!(!is_supported("exe"));
        assert!(is_supported("pdf"));
    }
}
