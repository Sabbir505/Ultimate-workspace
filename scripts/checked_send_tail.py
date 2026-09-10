"""Codemod: migrate the google/gmail connector sites of the shape

    let resp = <builder>
        .send()
        .await
        .map_err(|e| format!("{OP} failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{OP} HTTP {status}: {body}"));
    }

to `checked_send_ctx(<builder>, 500, "<OP>")` + `let body = resp.text()…`
(the body variable is kept for the success path). Run from src-tauri/."""
import io
import re
import glob

PATTERN = re.compile(
    r"let resp = ((?:[^;])*?)\.send\(\)\n"
    r"\s*\.await\n"
    r"\s*\.map_err\(\|e\| format!\(\"([^\"]+) failed: \{e\}\"\)\)\?;\n"
    r"(\s*)let status = resp\.status\(\);\n"
    r"\s*let body = resp\.text\(\)\.await\.unwrap_or_default\(\);\n"
    r"\s*if !status\.is_success\(\) \{\n"
    r"\s*return Err\(format!\(\"\2 HTTP \{status\}: \{body\}\"\)\);\n"
    r"\s*\}"
)

total = 0
for path in glob.glob("src/**/*.rs", recursive=True):
    src = io.open(path, encoding="utf-8").read()

    def repl(m):
        builder = " ".join(m.group(1).split())
        op = m.group(2)
        return (
            f"let resp = crate::util::checked_send_ctx({builder}, 500, \"{op}\").await?;\n"
            f"{m.group(3)}let body = resp.text().await.unwrap_or_default();"
        )

    new, n = PATTERN.subn(repl, src)
    if n:
        io.open(path, "w", encoding="utf-8", newline="\n").write(new)
        print(f"  {path}: {n} sites")
        total += n
print("total migrated:", total)
