#!/usr/bin/env node
// Thin wrapper: stage the relay-automation sidecar (see stage-sidecar.mjs —
// the shared implementation; --allow-debug and other args pass through).
// Kept for release-staging.mjs and the RELEASE.md docs.
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(
  process.execPath,
  [join(__dirname, "stage-sidecar.mjs"), "relay-automation", ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
