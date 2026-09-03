// Shared GFM-table renderer for markdown surfaces (chat bubbles + artifact
// preview). Wraps the rendered <table> in a hover toolbar with:
//   • Copy   — TSV onto the clipboard (pastes into Excel/Sheets as cells)
//   • Save   — a .csv download (blob + anchor; the Tauri webview supports
//              blob downloads — same path ArtifactExportMenu uses)
//
// The cell text comes from the hast `node` react-markdown hands the custom
// component, so no DOM scraping is needed and cached element trees keep
// working (the extraction is a pure function of the parsed node).
import { useMemo, useState, type ComponentPropsWithoutRef } from "react";
import type { ExtraProps } from "react-markdown";

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

/** Flatten one table cell (th/td) to plain text — `<br>` becomes a space. */
function cellText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.tagName === "br") return " ";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(cellText).join("");
}

/** Extract the table's rows as string arrays from the hast <table> node. */
export function rowsFromTableNode(node: HastNode | undefined): string[][] {
  const rows: string[][] = [];
  const walk = (n: HastNode | undefined): void => {
    if (!n || !n.children) return;
    if (n.tagName === "tr") {
      rows.push(
        n.children
          .filter((c) => c.tagName === "td" || c.tagName === "th")
          .map(cellText),
      );
      return;
    }
    n.children.forEach(walk);
  };
  walk(node);
  return rows;
}

/** RFC-4180-ish CSV: quote fields containing separators/quotes/newlines. */
export function toCsv(rows: string[][]): string {
  const escape = (cell: string): string =>
    /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  return rows.map((r) => r.map(escape).join(",")).join("\r\n");
}

/** TSV: tab-separated, newlines inside cells flattened so a paste lands in
 *  one spreadsheet row per table row. */
export function toTsv(rows: string[][]): string {
  return rows
    .map((r) => r.map((c) => c.replace(/[\t\n\r]+/g, " ").trim()).join("\t"))
    .join("\n");
}

function DownloadIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function triggerDownload(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Filename for the CSV export: a slug of the first header cell, falling back
 *  to a generic name when the table has no header text. */
function csvFilename(rows: string[][]): string {
  const first = rows[0]?.[0]?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${first ? first.slice(0, 40) : "table"}.csv`;
}

function TableActions({ rows }: { rows: string[][] }) {
  const [copied, setCopied] = useState(false);
  const disabled = rows.length === 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toTsv(rows));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable — silently ignore.
    }
  };

  return (
    <div className="chat-table-actions" role="group" aria-label="Table actions">
      <button
        type="button"
        className="chat-table-action"
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={copy}
        title="Copy table (pastes into spreadsheets as cells)"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <button
        type="button"
        className="chat-table-action"
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => triggerDownload(toCsv(rows), csvFilename(rows))}
        title="Download as CSV"
      >
        <DownloadIcon />
        CSV
      </button>
    </div>
  );
}

/** react-markdown `table` component override. Renders the same <table> the
 *  default renderer would (children arrive pre-rendered), wrapped with the
 *  hover toolbar. */
export function MarkdownTable({
  node,
  children,
  ...props
}: ComponentPropsWithoutRef<"table"> & ExtraProps) {
  const rows = useMemo(() => rowsFromTableNode(node as HastNode | undefined), [node]);
  return (
    <div className="chat-table-wrap">
      <TableActions rows={rows} />
      <table {...props}>{children}</table>
    </div>
  );
}
