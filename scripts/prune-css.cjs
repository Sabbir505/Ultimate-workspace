#!/usr/bin/env node
// Dead-CSS-selector pruner (PERFORMANCE_AUDIT.md item 2 / mi29).
//
// Parses src/styles/global.css rule-by-rule, extracts class selectors, and
// substring-searches every desktop source file (src/**/*.{ts,tsx,css}, plus
// index.html) for each class name. A selector list entry with zero hits is
// dropped; a rule whose selector list becomes empty (and which contained at
// least one class selector) is removed entirely.
//
// Conservative by design:
//  - substring search (not word-boundary) — dynamic class building like
//    `is-${state}` or template literals still count as a hit;
//  - rules without any class selector (element/pseudo/attribute selectors,
//    at-rules like @media/@keyframes) are always kept;
//  - CSS custom-property definitions and @keyframes are never pruned.
//
// Usage: node scripts/prune-css.js [--write]   (dry-run without --write)

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const STYLES_DIR = path.join(ROOT, "src/styles");
// The monolith was split 2026-08-15: prune every feature file; global.css is
// just the @import aggregator and is skipped.
const CSS_FILES = fs
  .readdirSync(STYLES_DIR)
  .filter((f) => f.endsWith(".css") && f !== "global.css")
  .map((f) => path.join(STYLES_DIR, f));
const SRC_DIRS = ["src"];
const SRC_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".html"]);

function collectSources() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (SRC_EXTS.has(path.extname(e.name))) files.push(p);
    }
  };
  for (const d of SRC_DIRS) walk(path.join(ROOT, d));
  files.push(path.join(ROOT, "index.html"));
  // Exclude ALL stylesheets from the haystack — selector names obviously
  // appear in their own definitions (and a class may be referenced in a
  // sibling CSS file's composed selector).
  return files
    .filter((f) => !CSS_FILES.includes(f) && f !== path.join(STYLES_DIR, "global.css") && fs.existsSync(f))
    .map((f) => fs.readFileSync(f, "utf8"));
}

// Split a stylesheet into top-level statements, preserving order and tracking
// whether each is a rule (selectors + block) or an at-rule. Naive but robust
// for this file: no strings containing unbalanced braces in selectors.
function splitTopLevel(css) {
  const out = [];
  let i = 0;
  const n = css.length;
  while (i < n) {
    // whitespace
    const wsStart = i;
    while (i < n && /\s/.test(css[i])) i++;
    if (i > wsStart) out.push({ kind: "ws", text: css.slice(wsStart, i) });
    if (i >= n) break;
    // comment
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out.push({ kind: "comment", text: css.slice(i, stop) });
      i = stop;
      continue;
    }
    // read prelude until '{' or ';'
    let j = i;
    let inStr = null;
    while (j < n) {
      const ch = css[j];
      if (inStr) {
        if (ch === inStr && css[j - 1] !== "\\") inStr = null;
      } else if (ch === '"' || ch === "'") {
        inStr = ch;
      } else if (ch === "{" || ch === ";") {
        break;
      }
      j++;
    }
    const prelude = css.slice(i, j).trim();
    if (j >= n) {
      out.push({ kind: "raw", text: css.slice(i) });
      break;
    }
    if (css[j] === ";") {
      out.push({ kind: "stmt", prelude, text: css.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    // css[j] === '{': find matching '}' with nesting + string/comment awareness
    let depth = 0;
    let k = j;
    inStr = null;
    while (k < n) {
      const ch = css[k];
      if (inStr) {
        if (ch === inStr && css[k - 1] !== "\\") inStr = null;
      } else if (css.startsWith("/*", k)) {
        const end = css.indexOf("*/", k + 2);
        k = end === -1 ? n : end + 2;
        continue;
      } else if (ch === '"' || ch === "'") {
        inStr = ch;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          k++;
          break;
        }
      }
      k++;
    }
    out.push({ kind: "block", prelude, text: css.slice(i, k) });
    i = k;
  }
  return out;
}

const CLASS_RE = /\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g;

function classesInSelector(sel) {
  const out = [];
  let m;
  CLASS_RE.lastIndex = 0;
  while ((m = CLASS_RE.exec(sel)) !== null) out.push(m[1]);
  return out;
}

function pruneFile(cssFile, haystacks) {
  const css = fs.readFileSync(cssFile, "utf8");
  const usageCache = new Map();
  const isUsed = (cls) => {
    if (!usageCache.has(cls)) {
      let used = haystacks.some((h) => h.includes(cls));
      // Dynamic suffix construction: `dev-diff-kind-${kind}` never contains
      // the literal `dev-diff-kind-M` — treat `<stem>-${` in source as a hit.
      if (!used) {
        const idx = cls.lastIndexOf("-");
        if (idx > 0) {
          const stem = cls.slice(0, idx + 1) + "${";
          used = haystacks.some((h) => h.includes(stem));
        }
      }
      usageCache.set(cls, used);
    }
    return usageCache.get(cls);
  };

  const parts = splitTopLevel(css);
  let removedRules = 0;
  let prunedSelectors = 0;
  const listMode = process.argv.includes("--list");
  const removedPreludes = [];
  const kept = [];
  for (const part of parts) {
    if (part.kind !== "block" || part.prelude.startsWith("@")) {
      kept.push(part.text);
      continue;
    }
    // Selector list rule. Split on top-level commas.
    const selectors = part.prelude
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const hasClass = selectors.some((s) => classesInSelector(s).length > 0);
    if (!hasClass) {
      kept.push(part.text);
      continue;
    }
    const alive = selectors.filter((sel) => {
      const classes = classesInSelector(sel);
      // A selector with no classes (e.g. `button` in `x, button`) is kept.
      if (classes.length === 0) return true;
      return classes.some((c) => isUsed(c));
    });
    prunedSelectors += selectors.length - alive.length;
    if (alive.length === 0) {
      removedRules++;
      removedPreludes.push(part.prelude.split("\n")[0].slice(0, 100));
      continue;
    }
    if (alive.length === selectors.length) {
      kept.push(part.text);
      continue;
    }
    // Rebuild the rule with only the live selectors.
    const openIdx = part.text.indexOf("{");
    const body = part.text.slice(openIdx);
    kept.push(alive.join(",\n") + " " + body);
  }

  const result = kept.join("");
  const beforeLines = css.split("\n").length;
  const afterLines = result.split("\n").length;
  const name = path.basename(cssFile);
  console.log(`[${name}] rules removed: ${removedRules}, selectors pruned: ${prunedSelectors}, lines: ${beforeLines} -> ${afterLines}, bytes: ${css.length} -> ${result.length}`);
  if (listMode && removedPreludes.length) {
    console.log("--- removed rules ---\n" + removedPreludes.join("\n"));
  }
  if (process.argv.includes("--write") && result !== css) {
    fs.writeFileSync(cssFile, result);
    console.log(`[${name}] written`);
  }
}

function main() {
  const haystacks = collectSources();
  for (const f of CSS_FILES) pruneFile(f, haystacks);
  if (!process.argv.includes("--write")) {
    console.log("(dry run — pass --write to apply)");
  }
}

main();
