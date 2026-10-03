# Relay — Documentation Map

All project documentation lives under `docs/`. The README at the repo root is the entry point; `CHANGELOG.md` stays at the root by convention.

| Folder | Contents |
|---|---|
| [`ai-context/`](ai-context/) | **Canonical, living docs for AI assistants and contributors** — start at [`ai-context/AI_CONTEXT.md`](ai-context/AI_CONTEXT.md) (code map), plus the IPC contract (`CONTRACT.md`), product spec (`PRD.md`), build log (`BUILD_LOG.md`), release flow (`RELEASE.md`), and historical bug audits. Kept in sync with the code; the code is the source of truth. |
| [`architecture/`](architecture/) | Design docs for shipped subsystems: user memory, document design layer, context compaction, self-improving artifacts, Session Mesh. Status headers state what shipped. |
| [`research/`](research/) | Point-in-time research notes that fed features (auto model routing, browser system, TTS, document fidelity, competitor analysis, …). Not kept up to date. |
| [`audits/`](audits/) | Audit reports, bug lists, issue trackers, roadmaps, and progress logs (e.g. `PROJECT_AUDIT.md`, `PERFORMANCE_AUDIT.md`, `BUG_AUDIT.md`). Each is a snapshot of its date — trust the code over any finding here. |
| [`notes/`](notes/) | One-off reports, release/social posts, and old task briefs. |
| [`superpowers/`](superpowers/) | Dated implementation plans (`plans/`) and design specs (`specs/`) from past feature branches. |
| `remote-access.md` | Pairing the mobile companion over USB or Tailscale. |

## Conventions

- **Living vs. historical:** `ai-context/` is updated as the code changes. Everything else is a dated record — do not silently rewrite history in it; add a new doc instead.
- Code comments cite docs by bare filename (e.g. `PERFORMANCE_AUDIT.md C6`) — the filename stays unique after the 2026-09-14 reorganization into these folders.
- The built-in skills under `skills/` are embedded at compile time (`installed_skills.rs`) and are prompt content, not documentation.

## Security notes

- **Microphone access is auto-granted in the main window** (`--use-fake-ui-for-media-stream` in `src-tauri/tauri.conf.json`): WebView2's permission prompt cannot be wired through wry, so the flag is what makes hands-free dictation work. Accepted risk: any script executing in the main window could open the mic without an OS prompt — DOMPurify (`src/lib/sanitize.ts`) is the gate that keeps model/CLI markup inert. If a future wry version exposes WebView2's `PermissionRequested`, replace the flag with a gated handler.
- **cdnjs.cloudflare.com appears in the CSP** (`script-src`/`style-src`/`font-src`): used only inside `sandbox="allow-scripts"` opaque-origin preview iframes (pdf.js assets), pinned by `src/test/csp.test.ts`. The main window never loads remote scripts.
