// docdesign — the document (report/brief) IR and its validator (QA layer L1).
//
// A DocPlan is the format-agnostic content projection for flowing documents
// (docx / pdf): titled sections carrying typed content blocks. The same
// design rules apply as for decks — the model owns content, the compiler
// owns presentation — with budgets sized for prose instead of slides.
import { issue, type Issue, type Kpi } from "./ir";

export type DocBlock =
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "numbered"; items: string[] }
  | { type: "callout"; text: string }
  | { type: "quote"; text: string; attribution?: string }
  | { type: "table"; columns: string[]; rows: string[][]; source?: string }
  | { type: "chart"; chart: Record<string, unknown>; caption?: string }
  | { type: "kpi-strip"; kpis: Kpi[] };

export interface DocSection {
  id: string;
  heading: string;
  blocks: DocBlock[];
}

export interface DocPlan {
  v: 1;
  kind: "doc";
  title: string;
  subtitle?: string;
  author?: string;
  theme?: string;
  language?: string;
  sections: DocSection[];
}

export { issue };
export type { Issue };

const MAX_SECTIONS = 40;
const MAX_BLOCKS_PER_SECTION = 30;

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every(isStr);

const BLOCK_TYPES = [
  "paragraph",
  "bullets",
  "numbered",
  "callout",
  "quote",
  "table",
  "chart",
  "kpi-strip",
] as const;

/** Validate + normalize a raw doc plan. Errors block compilation; warnings
 *  ride along with the result. */
export function validateDocPlan(
  raw: unknown,
): { plan: DocPlan; issues: Issue[] } | { plan: null; issues: Issue[] } {
  const issues: Issue[] = [];
  if (typeof raw !== "object" || raw === null) {
    return { plan: null, issues: [issue("error", "schema", "plan must be a JSON object")] };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.v !== 1) issues.push(issue("error", "schema", `plan.v must be 1 (got ${JSON.stringify(obj.v)})`));
  if (obj.kind !== "doc") issues.push(issue("error", "schema", `plan.kind must be "doc" (got ${JSON.stringify(obj.kind)})`));
  if (!isStr(obj.title) || !obj.title.trim()) {
    issues.push(issue("error", "schema", "plan.title is required"));
  }
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) {
    issues.push(issue("error", "schema", "plan.sections must be a non-empty array"));
    return { plan: null, issues };
  }
  if (obj.sections.length > MAX_SECTIONS) {
    issues.push(issue("error", "schema", `plan.sections exceeds ${MAX_SECTIONS}`));
    return { plan: null, issues };
  }

  const sections: DocSection[] = [];
  const ids = new Set<string>();
  for (const [i, rawSection] of obj.sections.entries()) {
    const sec = (typeof rawSection === "object" && rawSection !== null ? rawSection : {}) as Record<string, unknown>;
    const id = isStr(sec.id) && sec.id.trim() ? sec.id : `sec${i + 1}`;
    if (ids.has(id)) issues.push(issue("error", "schema", `duplicate section id "${id}"`, `sections[id=${id}]`));
    ids.add(id);

    if (!isStr(sec.heading) || !sec.heading.trim()) {
      issues.push(issue("error", "schema", `section "${id}" needs a heading`, `sections[id=${id}]`));
    } else if (sec.heading.length > 100) {
      issues.push(issue("error", "budget", `heading of "${id}" exceeds 100 chars — headings are signposts, not sentences`, `sections[id=${id}].heading`));
    }

    if (!Array.isArray(sec.blocks) || sec.blocks.length === 0) {
      issues.push(issue("error", "schema", `section "${id}" needs at least one block`, `sections[id=${id}]`));
      sections.push({ id, heading: isStr(sec.heading) ? sec.heading : "", blocks: [] });
      continue;
    }
    if (sec.blocks.length > MAX_BLOCKS_PER_SECTION) {
      issues.push(issue("error", "budget", `section "${id}" has more than ${MAX_BLOCKS_PER_SECTION} blocks — split the section`, `sections[id=${id}]`));
    }
    const blocks: DocBlock[] = [];
    for (const [b, rawBlock] of sec.blocks.entries()) {
      const at = `sections[id=${id}].blocks[${b}]`;
      const block = (typeof rawBlock === "object" && rawBlock !== null ? rawBlock : {}) as Record<string, unknown>;
      if (!BLOCK_TYPES.includes(block.type as (typeof BLOCK_TYPES)[number])) {
        issues.push(issue("error", "schema", `unknown block type ${JSON.stringify(block.type)} — use: ${BLOCK_TYPES.join(", ")}`, at));
        continue;
      }
      const type = block.type as DocBlock["type"];
      switch (type) {
        case "paragraph": {
          if (!isStr(block.text) || !block.text.trim()) {
            issues.push(issue("error", "schema", "paragraph needs text", at));
          } else if (block.text.length > 1500) {
            issues.push(issue("error", "budget", `paragraph exceeds 1500 chars (${block.text.length}) — split into paragraphs`, at));
          } else if (block.text.length > 900) {
            issues.push(issue("warning", "budget", "long paragraph — consider splitting for readability", at));
          }
          blocks.push({ type, text: isStr(block.text) ? block.text : "" });
          break;
        }
        case "bullets":
        case "numbered": {
          if (!isStrArray(block.items) || block.items.length === 0) {
            issues.push(issue("error", "schema", `${type} needs a non-empty items array`, at));
            break;
          }
          if (block.items.length > 8) {
            issues.push(issue("error", "budget", `${type} list exceeds 8 items — tighten or split`, at));
          }
          for (const [k, item] of block.items.entries()) {
            if (item.length > 250) {
              issues.push(issue("error", "budget", `item ${k} exceeds 250 chars — list items are headlines, not paragraphs`, `${at}.items[${k}]`));
            }
          }
          blocks.push({ type, items: block.items });
          break;
        }
        case "callout": {
          if (!isStr(block.text) || !block.text.trim()) {
            issues.push(issue("error", "schema", "callout needs text", at));
          } else if (block.text.length > 300) {
            issues.push(issue("error", "budget", `callout exceeds 300 chars (${block.text.length}) — a callout is a takeaway`, at));
          }
          blocks.push({ type, text: isStr(block.text) ? block.text : "" });
          break;
        }
        case "quote": {
          if (!isStr(block.text) || !block.text.trim()) {
            issues.push(issue("error", "schema", "quote needs text", at));
            break;
          }
          if (block.text.length > 450) {
            issues.push(issue("error", "budget", `quote exceeds 450 chars`, at));
          }
          if (block.attribution !== undefined && !isStr(block.attribution)) {
            issues.push(issue("error", "schema", "quote attribution must be a string", `${at}.attribution`));
          }
          blocks.push({ type, text: block.text, attribution: isStr(block.attribution) ? block.attribution : undefined });
          break;
        }
        case "table": {
          const cols = block.columns;
          const rows = block.rows;
          if (!isStrArray(cols) || cols.length < 2 || cols.length > 6) {
            issues.push(issue("error", "budget", "table needs 2–6 columns", at));
            break;
          }
          if (!Array.isArray(rows) || rows.length < 1 || !rows.every((r) => Array.isArray(r))) {
            issues.push(issue("error", "schema", "table.rows must be a non-empty array of arrays", at));
            break;
          }
          if (rows.length > 20) {
            issues.push(issue("error", "budget", `table exceeds 20 rows (${rows.length}) — split or summarize`, at));
          }
          for (const [r, row] of (rows as unknown[][]).entries()) {
            if (row.length !== cols.length) {
              issues.push(issue("error", "schema", `row ${r} has ${row.length} cells, expected ${cols.length}`, `${at}.rows[${r}]`));
            }
            for (const [cIdx, cell] of row.entries()) {
              if (String(cell ?? "").length > 90) {
                issues.push(issue("error", "budget", `cell [${r}][${cIdx}] exceeds 90 chars`, `${at}.rows[${r}][${cIdx}]`));
              }
            }
          }
          if (block.source !== undefined && !isStr(block.source)) {
            issues.push(issue("error", "schema", "table source must be a string", `${at}.source`));
          }
          blocks.push({ type, columns: cols, rows: rows as string[][], source: isStr(block.source) ? block.source : undefined });
          break;
        }
        case "chart": {
          // Native charts render in deck plans and in PDF targets. The docx
          // library cannot embed live charts, so document plans steer to
          // tables / KPI strips instead — data stays editable either way.
          issues.push(issue("error", "schema", "chart blocks belong in deck plans — for a doc use a table or kpi-strip", at));
          break;
        }
        case "kpi-strip": {
          const kpis = block.kpis;
          if (!Array.isArray(kpis) || kpis.length < 2 || kpis.length > 4) {
            issues.push(issue("error", "budget", "kpi-strip shows 2–4 stats", at));
            break;
          }
          blocks.push({ type, kpis: kpis as Kpi[] });
          break;
        }
      }
    }
    sections.push({ id, heading: isStr(sec.heading) ? sec.heading : "", blocks });
  }

  if (sections.length === 1) {
    issues.push(issue("warning", "coherence", "a single section makes a memo, not a report — plan 3+ sections for reports"));
  }

  const hasErrors = issues.some((i) => i.severity === "error");
  return hasErrors
    ? { plan: null, issues }
    : {
        plan: {
          v: 1,
          kind: "doc",
          title: obj.title as string,
          subtitle: isStr(obj.subtitle) ? obj.subtitle : undefined,
          author: isStr(obj.author) ? obj.author : undefined,
          theme: isStr(obj.theme) ? obj.theme : undefined,
          language: isStr(obj.language) ? obj.language : undefined,
          sections,
        },
        issues,
      };
}
