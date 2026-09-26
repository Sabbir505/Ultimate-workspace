#!/usr/bin/env node
// Syncs the release list in site/releases.html from CHANGELOG.md (the source
// of truth), so the page stops being a hand-maintained second copy that
// silently drifts. Run via `npm run sync:releases` after cutting a release.
//
// What is DERIVED from CHANGELOG.md:
//   - the version list (`## [X.Y.Z] — date` sections; `[Unreleased]` skipped)
//   - each entry's date markup (a single ISO date becomes a <time> element; a
//     range like 0.1.x's `2026-07-21 → 2026-07-23` stays plain text)
//   - the "Latest" badge (always the first listed version)
//   - download + release-page URLs, following the asset naming the releases
//     repo actually uses: `Relay_<v>_x64-setup.exe` from 0.4.2 on (the first
//     version shipped after the Conduit→Relay rename), `Conduit_<v>_x64-
//     setup.exe` before that. The button label follows the era.
//
// What is PRESERVED from the existing page (editorial, not in the changelog):
//   - each entry's <li> class list (release-legacy / release-compact / ...)
//   - each entry's hand-written <p class="release-summary"> text
// An entry for a version not yet on the page gets a mechanical digest summary
// built from its changelog section (lede paragraph, else the bold lead of each
// top-level bullet) — hand-polish it on the page after syncing; later runs
// keep whatever summary is there. Page entries with no changelog section are
// dropped (reported), since the changelog is the source of truth.
//
// The generated block is delimited by `<!-- releases:begin -->` /
// `<!-- releases:end -->` inside the page's <ol class="release-list">; only
// that region is ever rewritten. On the first run (no markers yet) the whole
// <ol> content is migrated into the marker-delimited region.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = join(root, "CHANGELOG.md");
const PAGE = join(root, "site", "releases.html");
const RELEASES_REPO = "Sabbir505/relay-releases";
const BEGIN = "<!-- releases:begin -->";
const END = "<!-- releases:end -->";
const LI_INDENT = "          "; // indentation of one <li> inside the <ol>
// First version published with the `Relay_` installer name (post-rename).
const RELAY_ERA_FROM = [0, 4, 2];

// --- parse CHANGELOG.md into `## [ver] — date` sections ---
// Same splitting approach make-latest-json.mjs's extractSection uses.
function parseChangelog(md) {
  const sections = [];
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    if (/^##\s/.test(line)) {
      sections.push({ title: line, body: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1].body.push(line);
    }
  }
  const releases = [];
  for (const { title, body } of sections) {
    const m = /^##\s\[([^\]]+)\]\s—\s(.*)$/.exec(title);
    if (!m) continue;
    const [, version, datePart] = m;
    if (version === "Unreleased") continue;
    releases.push({ version, datePart, body: body.join("\n") });
  }
  return releases;
}

// `2026-09-21` → <time>; `2026-07-21 → 2026-07-23` (0.1.x) → plain text.
function dateMarkup(datePart) {
  const dates = datePart.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  if (dates.length === 1) return `<time datetime="${dates[0]}">${dates[0]}</time>`;
  if (dates.length >= 2) return `${dates[0]} → ${dates[dates.length - 1]}`;
  return datePart.trim(); // unexpected format — render verbatim
}

function verTuple(v) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), m[3] === undefined ? 0 : Number(m[3])] : null;
}

function isRelayEra(version) {
  const t = verTuple(version);
  if (!t) return false;
  const [maj, min, patch] = RELAY_ERA_FROM;
  return t[0] !== maj ? t[0] > maj : t[1] !== min ? t[1] > min : t[2] >= patch;
}

function isPrerelease(release) {
  return /pre-release/i.test(release.datePart);
}

// --- markdown → inline HTML for GENERATED summaries (best-effort; these are
// placeholders meant to be hand-polished on the page afterwards) ---
function mdToHtml(md) {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\/commit\/[^)]*\)/g, "$1") // private commit links → text
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1") // other links → text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function digestSummary(body) {
  const lines = body.split("\n");
  const headingIdx = lines.findIndex((l) => /^###\s/.test(l));
  const lede = (headingIdx === -1 ? lines : lines.slice(0, headingIdx))
    .filter((l) => !/^\s*$/.test(l) && !/^>/.test(l) && !/^-{3,}\s*$/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (lede) return mdToHtml(lede);
  const leads = [];
  for (const l of lines) {
    const bold = /^- \*\*(.+?)\*\*/.exec(l);
    if (bold) leads.push(bold[1].split(/\s—\s/)[0]);
  }
  if (leads.length === 0) {
    for (const l of lines) {
      const plain = /^- (.+)$/.exec(l);
      if (plain) leads.push(plain[1].split(/\s\(/)[0].split(/\s—\s/)[0]);
    }
  }
  return mdToHtml(leads.join("; ") || "See the changelog for details.");
}

// --- entry generation (markup mirrors the page's existing classes exactly) ---
function entryId(version) {
  return `v${version.replace(/\./g, "-")}`;
}

function actionsMarkup(release, classes) {
  if (isPrerelease(release)) return ""; // 0.1.x: no public build was cut
  const { version } = release;
  const relayEra = isRelayEra(version);
  const prefix = relayEra ? "Relay" : "Conduit";
  const download = `https://github.com/${RELEASES_REPO}/releases/download/v${version}/${prefix}_${version}_x64-setup.exe`;
  const tag = `https://github.com/${RELEASES_REPO}/releases/tag/v${version}`;
  const rows = [];
  if (classes.includes("release-compact")) {
    rows.push(
      `              <a class="text-link" href="${download}">Download (${prefix})<svg class="icon"><use href="#arrow"/></svg></a>`,
    );
  } else {
    const label = relayEra ? "Download for Windows" : `Download (${prefix})`;
    rows.push(
      `              <a class="button button-light" href="${download}"><svg class="icon"><use href="#windows"/></svg>${label}<svg class="icon"><use href="#arrow"/></svg></a>`,
    );
  }
  rows.push(
    `              <a class="text-link" href="${tag}">Release page<svg class="icon"><use href="#up-right"/></svg></a>`,
  );
  return `\n            <div class="release-actions">\n${rows.join("\n")}\n            </div>`;
}

function buildEntry(release, existing, isLatest) {
  const classes = existing ? existing.class : defaultClasses(release);
  const summary = existing?.summary ?? digestSummary(release.body);
  const badge = isLatest
    ? `\n              <span class="badge-latest"><svg class="icon"><use href="#check"/></svg>Latest</span>`
    : "";
  return [
    `${LI_INDENT}<li class="${classes}" id="${entryId(release.version)}">`,
    `            <div class="release-head">`,
    `              <span class="version">v${release.version}</span>`,
    `              <span class="release-date"><svg class="icon"><use href="#clock"/></svg>${dateMarkup(release.datePart)}</span>${badge}`,
    `            </div>`,
    `            <p class="release-summary">${summary}</p>${actionsMarkup(release, classes)}`,
    `          </li>`,
  ].join("\n");
}

function defaultClasses(release) {
  const classes = ["release"];
  if (!isRelayEra(release.version)) classes.push("release-legacy");
  if (isPrerelease(release)) classes.push("release-compact", "release-pre");
  return classes.join(" ");
}

// --- read the page and carry over editorial content ---
const html = readFileSync(PAGE, "utf8");
const existing = new Map();
const liRe = /<li class="(release[^"]*)" id="([^"]+)">([\s\S]*?)<\/li>/g;
for (const m of html.matchAll(liRe)) {
  const summary = /<p class="release-summary">([\s\S]*?)<\/p>/.exec(m[3]);
  existing.set(m[2], { class: m[1], summary: summary ? summary[1] : null });
}

const releases = parseChangelog(readFileSync(CHANGELOG, "utf8"));
if (releases.length === 0) {
  console.error("No `## [version] — date` sections found in CHANGELOG.md — nothing to sync.");
  process.exit(1);
}
const entries = releases.map((r, i) => buildEntry(r, existing.get(entryId(r.version)), i === 0));
const generated = entries.join("\n\n");
const dropped = [...existing.keys()].filter(
  (id) => !releases.some((r) => entryId(r.version) === id),
);

// --- splice the generated block into the page ---
let next;
const beginIdx = html.indexOf(BEGIN);
const endIdx = html.indexOf(END);
if (beginIdx !== -1 && endIdx !== -1) {
  next =
    html.slice(0, beginIdx + BEGIN.length) +
    "\n" +
    generated +
    "\n" +
    LI_INDENT +
    html.slice(endIdx);
} else {
  const olRe = /([ \t]*)<ol class="release-list">[\s\S]*?([ \t]*)<\/ol>/;
  if (!olRe.test(html)) {
    console.error("No <ol class=\"release-list\"> and no release markers in site/releases.html — cannot sync.");
    process.exit(1);
  }
  next = html.replace(
    olRe,
    (_m, open, close) =>
      `${open}<ol class="release-list">\n${LI_INDENT}${BEGIN}\n${generated}\n${LI_INDENT}${END}\n${close}</ol>`,
  );
}

if (next === html) {
  console.log("site/releases.html is already in sync with CHANGELOG.md — no changes.");
} else {
  writeFileSync(PAGE, next);
  console.log(`✓ Synced ${releases.length} release entries into site/releases.html`);
}
console.log(`  versions: ${releases.map((r) => `v${r.version}`).join(", ")}`);
const carried = releases.filter((r) => existing.get(entryId(r.version))?.summary).length;
console.log(
  `  summaries: ${carried} carried over from the page, ` +
    `${releases.length - carried} generated from the changelog (hand-polish those)`,
);
if (dropped.length > 0) {
  console.log(`  dropped (no changelog section): ${dropped.join(", ")}`);
}
if (beginIdx === -1) {
  console.log(`  first run: added ${BEGIN} / ${END} markers around the generated block`);
}
