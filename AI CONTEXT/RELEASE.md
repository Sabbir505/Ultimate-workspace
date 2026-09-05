# Releasing Relay (auto-update)

> **Naming.** "Relay" is the product name on every surface: user-visible strings (window title, `package.json` name, `tauri.conf.json` `productName`, `<title>`), the Rust crate (`relay`, lib `relay_lib`), the bundle identifier (`dev.relay.app`), the sidecar binaries (`relay-browser-mcp`, `relay-automation`) and their `RELAY_*` env vars, the MCP server identifiers (`relay-browser`, `relay-tools`), the NSIS installer filename (`Relay_<version>_x64-setup.exe`, driven by `productName`), the updater signing key file (`.tauri/relay-update.key`), the OS keychain service, the mobile app (`Relay Mobile`, `com.relay.mobile`), and the Windows scheduled-task entry (`RelayAutomations`). The only pre-rebrand value kept on purpose is the E2E pairing crypto constant (`conduit-e2e-relay-*`) — protocol-anchored on both the desktop and the phone; renaming it breaks existing pairings for no benefit.
>
> **Compatibility for existing installs** (all handled in code, nothing moves behind the user's back):
>
> - **App data dir** — `%APPDATA%/dev.conduit.app` renames itself to `%APPDATA%/dev.relay.app` on first launch of the new build (`user_dirs::ensure_app_data_dir`, run before any window exists). If the legacy dir is locked (the headless automation runner mid-turn), the DB files are copied out instead, and the next launch converges. Every app-data consumer resolves through `user_dirs::app_data_dir` — never through Tauri's `app_data_dir()` directly.
> - **Keychain** — new writes go to service `dev.relay.app` + `relay:*` accounts; reads fall back to the legacy service/account generations, and deletes clean up all of them.
> - **DB file** — `conduit.db` keeps being used when it's the only file in the (migrated) dir (`db::db_file_in`, honored by the GUI and the headless binary).
> - **Artifacts/models** — `Documents/Conduit` and `~/Conduit/models` stay readable/scannable; new defaults are `Documents/Relay` and `~/Relay/models` (`user_dirs.rs`).
> - **Scheduled task** — the legacy `ConduitAutomations` task is deleted best-effort whenever `RelayAutomations` registers or unregisters.
> - **Updater** — the `make-latest-json.mjs` regex still accepts legacy `Conduit_` release assets.
> - **Mobile** — AsyncStorage keys `conduit.relayUrl/Token` are re-homed to `relay.*` on first read; the bundle id change (`com.conduit.mobile` → `com.relay.mobile`) requires a fresh install on devices.
>
> Known one-time leftovers after upgrading an installed copy: a stale Windows uninstall registry entry under the old identifier and a stale toast AUMID key (`Software\Classes\AppUserModelId\dev.conduit.app`) — both cosmetic; a clean reinstall removes them.

Relay ships updates automatically via the Tauri updater plugin. When you publish
a new version, every running copy checks GitHub Releases on startup (and every 4
hours), shows a banner with the changelog, and downloads + installs the update
with one click.

Releases are built and published automatically by the CI pipeline
(`.github/workflows/build.yml`). You just need to bump versions, push a tag,
and CI handles the rest.

---

## How it works (one-time setup — already done)

- **Signing keypair** lives at `.tauri/relay-update.key` (private) and
  `.tauri/relay-update.key.pub` (public). The private key is gitignored and
  **must never be committed or shared**. If you lose it, updates stop working
  and you'll need to regenerate it and have everyone reinstall once.
- The **public key** is baked into `tauri.conf.json` (`plugins.updater.pubkey`)
  so every install can verify updates are genuinely from you.
- The **update endpoint** is
  `https://github.com/Sabbir505/Ultimate-workspace/releases/latest/download/latest.json`
  — a file attached as a release asset to each GitHub Release. GitHub serves the
  latest release's assets at that stable URL.

## Platform

Relay ships for **Windows (NSIS installer)** only. The installer is built on
`windows-latest` in CI, signed on `ubuntu-latest`, and distributed via GitHub
Releases.

---

## Release steps (CI path)

### 1. Bump the version

Edit these three files and set the same version in all of them:

- `src-tauri/tauri.conf.json` → `"version"`
- `package.json` → `"version"`
- `src-tauri/Cargo.toml` → `[package] version`

Use [semver](https://semver.org): patch for bugfixes, minor for features,
major for breaking changes.

### 2. Commit and tag

```powershell
git add -A
git commit -m "chore: bump to v0.5.0"
git tag v0.5.0
git push origin master --tags
```

### 3. CI does the rest

Pushing the tag triggers `.github/workflows/build.yml`, which:

1. **Build (Windows):** Builds the `relay-browser-mcp` sidecar, stages it,
   runs `npm run tauri build` (no signing env vars — avoids password prompt
   hang), and uploads the NSIS installer as an artifact.
2. **Release (Ubuntu):** Downloads the installer, restores the signing key from
   GitHub Actions secrets, signs the `.exe` with `tauri signer sign`, generates
   `latest.json`, and creates the GitHub Release with both files attached.

Monitor the run at:
`https://github.com/Sabbir505/Ultimate-workspace/actions`

The moment the release is live, every running Relay sees it within 4 hours
(or on their next launch) and shows the update banner.

### Release notes

The CI workflow uses `generate_release_notes: true`, so GitHub auto-generates
release notes from merged PRs. The `latest.json` notes field carries a pointer
to the full GitHub Release description.

---

## Manual release (fallback)

If CI is unavailable, you can cut a release manually:

```powershell
# 1. Bump version in all three files (as above)

# 2. Build the sidecar and stage it
cd src-tauri
cargo build --release --bin relay-browser-mcp
node ../scripts/stage-browser-mcp.mjs
cd ..

# 3. Build (no signing env vars — signing hangs the build)
#    Set connector credentials as needed (see CI workflow for env vars)
npm run tauri build

# 4. Sign + generate latest.json
npm run release:latest-json -- --notes "Your release notes here"

# 5. Create GitHub Release at:
#    https://github.com/Sabbir505/Ultimate-workspace/releases/new
#    Tag: v<version>
#    Attach: the .exe from src-tauri/target/release/bundle/nsis/
#             latest.json from src-tauri/target/release/bundle/
```

---

## Required GitHub Secrets

Configured in Settings → Secrets and variables → Actions:

| Secret | Description |
|--------|-------------|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `.tauri/relay-update.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Empty string (signer is invoked `-p ""`) |
| `NOTION_CLIENT_ID` | Notion integration client ID |
| `NOTION_CLIENT_SECRET` | Notion integration secret |
| `GOOGLE_CLIENT_ID` | Google Cloud Console "Desktop app" client ID |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console "Desktop app" secret |
| `GH_CLIENT_ID` | GitHub OAuth App client ID |
| `GH_CLIENT_SECRET` | GitHub OAuth App secret |

---

## Troubleshooting

- **CI build fails at sidecar step** — the placeholder touch + `cargo build`
  must complete before `tauri build` runs. Check that the sidecar binary name
  matches the target triple in `stage-browser-mcp.mjs`.
- **"Could not fetch a valid release JSON"** in dev logs — expected until you
  publish your first release with a `latest.json`. After publishing it goes away.
- **Update downloads but won't install ("signature mismatch")** — you signed
  the build with a different key than the `pubkey` in `tauri.conf.json`. Re-sign
  with the matching `.tauri/relay-update.key`, or regenerate the keypair and
  update `pubkey` (then everyone reinstalls once).
- **Users don't see the banner** — confirm the release is marked "Latest" on
  GitHub (not a draft/prerelease).
- **`latest.json` 404s** — the file must be attached as a release asset named
  exactly `latest.json`, on the release tagged "Latest". The
  `/releases/latest/download/latest.json` URL only resolves for the latest
  non-prerelease release.
- **`tauri build` hangs at "Decrypting updater signing key"** — you set
  `TAURI_SIGNING_PRIVATE_KEY*` env vars before the build. Don't: Tauri's
  built-in signing prompts for a password that the env var doesn't suppress.
  Build plain, then sign with `tauri signer sign` (non-interactive).
