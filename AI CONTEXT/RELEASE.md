# Releasing Conduit (auto-update)

Conduit ships updates to your friends automatically. When you publish a new
version, every running copy checks GitHub Releases on startup (and every 4
hours), shows a banner with the changelog, and downloads + installs the update
with one click — no more hand-distributing `.exe` files.

This doc is the exact recipe. Follow it top-to-bottom each time you release.

---

## How it works (one-time setup — already done)

- **Signing keypair** lives at `.tauri/conduit-update.key` (private) and
  `.tauri/conduit-update.key.pub` (public). The private key is gitignored and
  **must never be committed or shared**. If you lose it, updates stop working
  and you'll need to regenerate it and have everyone reinstall once.
- The **public key** is baked into `tauri.conf.json` (`plugins.updater.pubkey`)
  so every install can verify updates are genuinely from you.
- The **update endpoint** is
  `https://github.com/Sabbir505/Ultimate-workspace/releases/latest/download/latest.json`
  — a file Tauri generates automatically on build and you attach to a GitHub
  Release. GitHub serves the latest release's assets at that stable URL.

## Platforms

Conduit ships for **Windows (NSIS)** and **Linux (AppImage + deb)**. The
GitHub Actions workflow (`.github/workflows/build.yml`) builds both on tag
push (`v*`) and publishes a single release with artifacts for every platform,
plus a shared cross-platform `latest.json` (one `platforms` entry per OS).

- **Windows** installs download the signed `.exe` updater package; the updater
  runs it in `passive` mode (a progress UI, no manual steps).
- **Linux AppImage** updates: the Tauri updater plugin surfaces "a new version
  is available" and links to the release; AppImage auto-replace is best-effort
  (the `.AppImage` is a portable single-file binary — to update, download the
  new one and replace the old file). The `latest.json` `linux-x86_64` entry
  carries the download URL for this.
- **Linux deb** packages are for apt-based distros; `sudo dpkg -i` installs,
  but the updater plugin does not auto-replace debs — treat deb as the
  install-once path; use the AppImage for auto-updates.

## Prerequisites

- The private key on the machine that builds releases. It's already at
  `.tauri/conduit-update.key` on the dev machine. If you build elsewhere, copy
  that file over (it's gitignored, so `git clone` won't bring it).
- `gh` CLI authenticated (`gh auth login`), OR willingness to attach files via
  the GitHub web UI. (The script below uses `gh` if present, else prints
  instructions.)

---

## Release steps

### 1. Bump the version

Edit `src-tauri/tauri.conf.json` and bump `"version"` (e.g. `0.1.0` → `0.2.0`).
Use [semver](https://semver.org): patch for bugfixes, minor for features,
major for breaking changes.

Also update the version in `package.json` **and** `src-tauri/Cargo.toml`
to match (keeps all three in sync — `tauri.conf.json`, `package.json`,
and `Cargo.toml` must agree).

### 2. Write the changelog

The release notes come from the **GitHub Release description**, which becomes
the `body` field in `latest.json`. Tauri copies the notes you write on the
GitHub Release into the JSON. So: write your changelog as the release
description when you create the release (step 5). Markdown is supported and
renders in the update banner.

### 3. Build the bundle (do NOT set signing env vars)

> **Important:** do *not* set `TAURI_SIGNING_PRIVATE_KEY_PATH` /
> `TAURI_SIGNING_PRIVATE_KEY` before `tauri build`. Tauri's built-in signing
> step hangs on an interactive password prompt that the env var does not
> suppress, and the build never finishes. Instead, build plain, then sign in
> the next step with `tauri signer sign` (which *is* non-interactive).

> **Connector credentials required at build time.** `option_env!` in
> `src-tauri/src/connectors/config.rs` bakes the Notion `client_id` /
> `client_secret` into the binary when cargo compiles. If these are unset,
> the published build ships with empty credentials and every user's
> **Settings → Connectors → Connect** fails with "no client_id configured".
> Set them in the same shell before the build command (PowerShell):
>
> ```powershell
> $env:NOTION_CLIENT_ID = "3a9d872b-..."        # your integration's client id
> $env:NOTION_CLIENT_SECRET = "secret_..."      # your integration's secret
> ```
>
> These are the *integration's* credentials (registered once at
> https://www.notion.so/profile/integrations), NOT per-user. Each end user
> still connects **their own** Notion account and gets their own access token
> stored in their own OS keychain. The shared secret lets the app complete
> the confidential-client token exchange on behalf of any authorizing user.
> **The secret is extractable from the published `.exe`** — accepted trade-off
> for the embedded-secret model; rotate it in the Notion integration dashboard
> if it leaks. (See `src-tauri/src/connectors/config.rs` doc comment.)

```powershell
npm run tauri build
```

This produces, under `src-tauri/target/release/bundle/`:
- `nsis/Conduit_<version>_x64-setup.exe` — the installer your friends run once.
- `msi/Conduit_<version>_x64_en-US.msi` — alternate installer.

No signature yet — that's step 3b.

### 3b. Sign + generate `latest.json` (one command)

```powershell
# write your changelog to a file, then:
npm run release:latest-json -- --notes-file src-tauri/target/release/bundle/release-notes-0.2.0.md
```

The `release:latest-json` script (`scripts/make-latest-json.mjs`):
1. Signs the built `-setup.exe` with `tauri signer sign -f .tauri/conduit-update.key -p ""` (non-interactive).
2. Reads the resulting `.sig`.
3. Writes `latest.json` (version + notes + signature + download URL).

You can also pass `--notes "..."` for a short inline changelog, or omit both
for a default placeholder.

> The `.exe` setup file is what the updater downloads and runs silently. The
> `.msi` is optional. Either works for the initial hand-out install.

### 4. (First time only) Give your friends the initial installer

For someone to receive updates, they must first install a **signed** build. So
the very first time, send them the `Conduit_<version>_x64-setup.exe` from step
3. After that, they never need a manual install again — updates flow
automatically. (If you previously gave them an unsigned build, they need to
reinstall once with a signed one.)

### 5. Publish the GitHub Release

Create a release tagged `v<version>` (e.g. `v0.2.0`) on
`https://github.com/Sabbir505/Ultimate-workspace/releases/new`, then attach:
- The signed installer: `Conduit_<version>_x64-setup.exe`
- (optional) the `.msi`
- `latest.json` (generated by the helper script in step 6)

Paste your changelog into the release description. Publish.

The moment the release is live, every running Conduit sees it within 4 hours
(or on their next launch) and shows the update banner.

### 6. Generate `latest.json` (helper script)

Run the helper, which reads the built bundle + signature and writes a
`latest.json` you attach to the release:

```bash
npm run release:latest-json
```

This prints the path to `latest.json`. Attach it to the GitHub Release (same
release, as a release asset named exactly `latest.json`).

The file looks like:

```json
{
  "version": "0.2.0",
  "notes": "...",
  "pub_date": "2026-07-24T15:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6...",
      "url": "https://github.com/Sabbir505/Ultimate-workspace/releases/download/v0.2.0/Conduit_0.2.0_x64-setup.exe"
    }
  }
}
```

The `signature` field is what the client checks against the baked-in public key
before installing. If it doesn't match, the update is refused.

---

## Quick reference (every release)

```powershell
# 1. bump version in src-tauri/tauri.conf.json + package.json
# 2. build (no signing env vars — signing hangs the build; the script signs)
npm run tauri build
# 3. write changelog to a .md file, then sign + generate latest.json:
npm run release:latest-json -- --notes-file src-tauri/target/release/bundle/release-notes-<ver>.md
# 4. create GitHub Release v<version>, attach the -setup.exe + latest.json,
#    paste changelog as the description, publish.
```

## Troubleshooting

- **`tauri build` hangs at "Decrypting updater signing key, expect a prompt"**
  — you set `TAURI_SIGNING_PRIVATE_KEY*` env vars before the build. Don't:
  Tauri's built-in signing prompts for a password that the env var doesn't
  suppress, so the build never returns. Build plain (no signing env vars), then
  sign with `npm run release:latest-json`, which calls
  `tauri signer sign -f … -p ""` non-interactively.
- **"Could not fetch a valid release JSON"** in dev logs — that's expected until
  you publish your first release with a `latest.json`. After publishing it goes
  away.
- **Update downloads but won't install ("signature mismatch")** — you signed
  the build with a different key than the `pubkey` in `tauri.conf.json`. Re-sign
  with the matching `.tauri/conduit-update.key` (via the script), or regenerate
  the keypair and update `pubkey` (then everyone reinstalls once).
- **Friends don't see the banner** — make sure they're on a *signed* build
  (produced via the release script). Builds that were never signed skip update
  checks. Also confirm the release is marked "Latest" on GitHub (not a
  draft/prerelease).
- **`latest.json` 404s** — the file must be attached as a release asset named
  exactly `latest.json`, on the release tagged "Latest". The
  `/releases/latest/download/latest.json` URL only resolves for the latest
  non-prerelease release.
