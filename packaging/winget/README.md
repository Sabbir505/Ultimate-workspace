# winget manifests for Relay

Submit these to `microsoft/winget-pkgs` under `manifests/s/Sabbir505/Relay/<version>/`
(adjust the publisher id when the manifest review assigns a final namespace —
the id below matches the public releases repo `Sabbir505/relay-releases`).

1. Replace every `{{VERSION}}` placeholder with the release version (e.g. `0.6.0`).
2. Replace every `{{SHA256}}` with the SHA-256 of the release installer
   (`Relay_<version>_x64-setup.exe` — printed by the release workflow output
   and listed in latest.json).
3. Validate locally: `winget validate --manifest .`
4. Submit a PR to winget-pkgs. The Community Repository Bot will request
   evidence (the public release URL) — the release assets are public by design.

§5.2 of FEATURE_MAP_AND_GAP_ANALYSIS: Authenticode signing is wired in CI
(`build.yml`, Azure Trusted Signing when secrets are present) — SmartScreen
reputation builds from signed installs, which is what makes the winget PR
review pass quickly.
