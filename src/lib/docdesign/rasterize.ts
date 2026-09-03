// docdesign — L4 render probes: load the QA PDF (pdf.js) and check what was
// ACTUALLY laid out, because font substitution and engine layout can break a
// document that looked fine in the plan. Deterministic, zero model calls:
//   - text-outside-page (real overflow, measured against the rendered page box)
//   - blank / near-empty pages (widow content, broken pagination)
//   - page count (compared against expectations by the caller)
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Issue } from "./ir";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface ProbeResult {
  issues: Issue[];
  pageCount: number;
  skipped?: string;
}

const OUTSIDE_TOLERANCE_PX = 4;

/** Probe the rendered PDF (bytes of a .pdf file). Best-effort: any pdf.js
 *  failure degrades to a single warning issue, never an error. */
export async function probePdf(data: Uint8Array, kind: "doc" | "deck"): Promise<ProbeResult> {
  try {
    const pdf = await pdfjs.getDocument({ data: sliceCopy(data) }).promise;
    const issues: Issue[] = [];
    const pageCount = pdf.numPages;
    let blank = 0;

    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items as Array<{
        str?: string;
        transform?: number[];
        width?: number;
        height?: number;
      }>;

      const visible = items.filter((it) => typeof it.str === "string" && it.str.trim().length > 0);
      if (visible.length === 0) {
        blank++;
        continue;
      }

      for (const it of visible) {
        const t = it.transform;
        if (!t || typeof it.width !== "number") continue;
        const x = t[4];
        const yTop = t[5];
        // pdf.js y grows upward from the page bottom; only the horizontal
        // overflow and above/below-page cases are unambiguous signals.
        const outsideLeft = x < -OUTSIDE_TOLERANCE_PX;
        const outsideRight = x + it.width > viewport.width + OUTSIDE_TOLERANCE_PX;
        const abovePage = yTop > viewport.height + OUTSIDE_TOLERANCE_PX;
        const belowPage = yTop < -OUTSIDE_TOLERANCE_PX - (it.height ?? 0);
        if (outsideLeft || outsideRight || abovePage || belowPage) {
          const preview = (it.str ?? "").slice(0, 40);
          issues.push({
            severity: kind === "deck" ? "warning" : "warning",
            rule: "probe/overflow",
            message: `page ${i}: text renders outside the page box ("${preview}${preview.length === 40 ? "…" : ""}")`,
            pointer: `page:${i}`,
          });
          break; // one report per page is enough
        }
      }
    }

    if (blank > 0) {
      issues.push({
        severity: "warning",
        rule: "probe/blank-page",
        message: `${blank} blank page${blank > 1 ? "s" : ""} in the rendered document — check pagination and trailing content`,
        pointer: kind === "deck" ? "slides" : "sections",
      });
    }

    return { issues, pageCount };
  } catch (err) {
    return {
      issues: [
        {
          severity: "warning",
          rule: "probe/skipped",
          message: `render probes could not run (${String(err)}) — document saved unprobed`,
        },
      ],
      pageCount: 0,
      skipped: String(err),
    };
  }
}

/** pdf.js transfers and detaches the buffer — always hand it a copy. */
function sliceCopy(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/** Decode a `data:application/pdf;base64,…` URI (the officeAccuratePdf IPC
 *  payload) to bytes. */
export function dataUriToBytes(dataUri: string): Uint8Array {
  const comma = dataUri.indexOf(",");
  const b64 = comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
