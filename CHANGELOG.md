# Conduit Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **Agent/Model picker redesign** — Combined agent/model selection with icon rail and per-model local runtime settings ([cb7d782a](https://github.com/Conduit-official/Conduit/commit/cb7d782a))
- **Conversational artifacts** — Artifacts now support conversational context and can be referenced in chat ([045e9a9d](https://github.com/Conduit-official/Conduit/commit/045e9a9d))
- **MCP server gallery** — Built-in chat can now launch stdio MCP servers with one click ([b2c3d8ab](https://github.com/Conduit-official/Conduit/commit/b2c3d8ab))
- **AI diff review quick action** — Per-file and whole-tree AI diff review cards in the Git tools sidebar ([52e76ddd](https://github.com/Conduit-official/Conduit/commit/52e76ddd))
- **Per-turn RAG auto-retrieval** — Chat automatically retrieves relevant documents per turn; support for per-chat doc attachments and MCP `search_docs` ([a0635298](https://github.com/Conduit-official/Conduit/commit/a0635298))
- **Activity strip** — Added §3.1.6 activity strip to GitToolsSidebar ([ed35499b](https://github.com/Conduit-official/Conduit/commit/ed35499b))
- **Automation hardening** — Dual permission policies and settings improvements ([887d3364](https://github.com/Conduit-official/Conduit/commit/887d3364))
- **Mobile remote access** — E2E relay encryption (HKDF+XChaCha20-Poly1305) and Tailscale auto-serve with QR pairing ([9aed4a84](https://github.com/Conduit-official/Conduit/commit/9aed4a84), [03361f16](https://github.com/Conduit-official/Conduit/commit/03361f16), [aa7b3e4b](https://github.com/Conduit-official/Conduit/commit/aa7b3e4b))
- **Browser devtools** — New `browser_open_devtools` command to open native devtools for a browser tab
- **Conduit bundle wiring** — Interactive PTY panes now integrate the Conduit bundle ([6aae1759](https://github.com/Conduit-official/Conduit/commit/6aae1759))

### Changed
- **Chat UI** — Replaced per-message Save As / Find & Update chips with natural language controls ([4b38ded0](https://github.com/Conduit-official/Conduit/commit/4b38ded0))
- **Automation view** — Made responsive when tool panel opens ([246ca988](https://github.com/Conduit-official/Conduit/commit/246ca988), [d8c79312](https://github.com/Conduit-official/Conduit/commit/d8c79312))

### Fixed
- **Artifact creation** — `/create` now works across all providers, harness CLIs, and local models ([47ba0e86](https://github.com/Conduit-official/Conduit/commit/47ba0e86))
- **Permission policy** — Full Auto mode no longer asks for every shell command or in-roots delete ([ea4e0a96](https://github.com/Conduit-official/Conduit/commit/ea4e0a96))
- **Automation view responsiveness** — Fixed tool panel open/close behavior ([d8c79312](https://github.com/Conduit-official/Conduit/commit/d8c79312), [246ca988](https://github.com/Conduit-official/Conduit/commit/246ca988))
- **Bug audit fixes** — 26 bug and edge-case fixes from full-project audit ([c79a9e7a](https://github.com/Conduit-official/Conduit/commit/c79a9e7a))
- **Remote access binding** — Fixed relay binding to tailnet IP so phone can connect cross-network without HTTPS serve ([760bdffc](https://github.com/Conduit-official/Conduit/commit/760bdffc))
- **Remote portal QR modal** — Centered the sidebar pairing QR modal on screen ([57ca347b](https://github.com/Conduit-official/Conduit/commit/57ca347b))
- **Async serve-enable** — Added activation check for remote portal ([d9794a82](https://github.com/Conduit-official/Conduit/commit/d9794a82))

### Documentation & Maintenance
- Updated AI_CONTEXT.md to reflect 226 commands and 21 tables
- Updated BUG_AUDIT.md and PERFORMANCE_AUDIT.md to reflect current state (all Sev H/M resolved, 407/407 tests passing)
- Updated PROJECT_OVERVIEW.md with current architecture and metrics

---

## [0.4.1] — 2026-08-17

### Added
- **Full project audit** — 26 bug and edge-case fixes surfaced from a full codebase audit ([c79a9e7a](https://github.com/Conduit-official/Conduit/commit/c79a9e7a))

### Fixed
- **Bug audit issues** — Resolved issues across browser event paths, stream buffering, usage sync, and session id collisions

---

## [0.4.0] — 2026-08-14

### Added
- **Mobile companion app** — React Native/Expo app with E2E encrypted relay and QR pairing ([aa7b3e4b](https://github.com/Conduit-official/Conduit/commit/aa7b3e4b), [9aed4a84](https://github.com/Conduit-official/Conduit/commit/9aed4a84))
- **Remote access** — Tailscale auto-serve and portal QR modal ([03361f16](https://github.com/Conduit-official/Conduit/commit/03361f16), [57ca347b](https://github.com/Conduit-official/Conduit/commit/57ca347b), [d9794a82](https://github.com/Conduit-official/Conduit/commit/d9794a82))
- **RAG integration** — Per-turn auto-retrieval and per-chat document attachment ([a0635298](https://github.com/Conduit-workspace/Conduit/commit/a0635298))
- **AI diff review** — Quick action for per-file and whole-tree AI diff review cards ([52e76ddd](https://github.com/Conduit-official/Conduit/commit/52e76ddd))
- **Activity strip** — §3.1.6 activity strip in GitToolsSidebar ([ed35499b](https://github.com/Conduit-official/Conduit/commit/ed35499b))

### Changed
- **Chat streaming** — Improved token batching and UI flushing

### Fixed
- **Automation view** — Made responsive when tool panel opens ([246ca988](https://github.com/Conduit-official/Conduit/commit/246ca988))

---

## [0.3.x] — 2026-07 (series)

### Added
- **Permission policies** — Dual policy modes (Full Auto vs Ask) and settings improvements ([887d3364](https://github.com/Conduit-official/Conduit/commit/887d3364))
- **MCP gallery** — Built-in chat MCP server gallery with one-click install ([b2c3d8ab](https://github.com/Conduit-official/Conduit/commit/b2c3d8ab))

### Fixed
- **Shell permission prompts** — Full Auto no longer asks for every shell command ([ea4e0a96](https://github.com/Conduit-official/Conduit/commit/ea4e0a96))

---

## [0.2.x] — 2026-06 (series)

### Added
- **Artifact conversational support** — Artifacts now carry conversational context ([045e9a9d](https://github.com/Conduit-official/Conduit/commit/045e9a9d))
- **Conduit bundle integration** — Interactive PTY panes wire the Conduit bundle ([6aae1759](https://github.com/Conduit-official/Conduit/commit/6aae1759))

### Changed
- **Chat UI** — Replaced per-message Save As / Find & Update chips with natural language ([4b38ded0](https://github.com/Conduit-official/Conduit/commit/4b38ded0))

### Fixed
- **Artifact creation** — `/create` now works across all providers and local models ([47ba0e86](https://github.com/Conduit-official/Conduit/commit/47ba0e86))

---

## [0.1.x] — 2026-05 (series)

### Added
- Initial desktop shell with Tauri, multi-pane PTY, browser panes, chat, git sidebar, local models, automations, and cost dashboard.

---

**Legend:**
- 🆕 = New feature
- 🔧 = Changed behavior
- 🐛 = Bug fix
- 📚 = Documentation / maintenance