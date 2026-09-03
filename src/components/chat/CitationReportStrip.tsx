// End-of-turn citation-integrity strip, rendered above the composer after a
// research turn completes. The backend lints the generated report against the
// session's source ledger (orphan citations, unused sources, weak
// attribution — zero model calls), and this strip reports what was
// mechanically verified instead of implying perfection.
//
// Styling lives in chat.css (.citation-report-strip*) — single compact row:
// health dot · label · counts, with the hint as a truncating muted tail.
import { useChatStore } from "../../state/chat";

/** Overall health bucket: green = everything resolved and attributed,
 *  amber = weak/unused sources worth a look, red = orphan citations (claims
 *  citing sources that were never read). */
function healthLevel(
  orphanCount: number,
  weakCount: number,
  unusedCount: number,
): "ok" | "warn" | "bad" {
  if (orphanCount > 0) return "bad";
  if (weakCount > 0 || unusedCount > 0) return "warn";
  return "ok";
}

const HINTS: Record<"ok" | "warn" | "bad", string> = {
  ok: "Every citation resolves to a source the agent actually read.",
  warn: "A few citations look soft — hover a chip to inspect its source.",
  bad: "Some citations point at sources that were never read — treat those claims with care.",
};

export function CitationReportStrip({
  chatSessionId,
  onFix,
}: {
  chatSessionId: string | null;
  /** When provided and the verdict isn't clean, a "Fix citations" action
   *  renders; clicking it hands the repair request to the caller (ChatView
   *  builds the RARR-style instruction from the stored lint detail). */
  onFix?: (chatSessionId: string) => void;
}) {
  const report = useChatStore((s) =>
    chatSessionId ? s.citationReports[chatSessionId] : undefined,
  );
  if (!chatSessionId || !report) return null;

  const level = healthLevel(report.orphanCount, report.weakCount, report.unusedCount);

  const counts: string[] = [`${report.totalCitations} checked`];
  if (report.weakCount > 0) counts.push(`${report.weakCount} weak`);
  if (report.unusedCount > 0) counts.push(`${report.unusedCount} unused`);
  if (report.uncitedSentences > 0) counts.push(`${report.uncitedSentences} uncited`);
  if (report.orphanCount > 0) counts.push(`${report.orphanCount} orphan${report.orphanCount === 1 ? "" : "s"}`);

  return (
    <div
      className={`citation-report-strip is-${level}`}
      role="status"
      title={`Mechanical citation lint against the session's source ledger — ${HINTS[level]}`}
    >
      <span className="citation-report-strip-dot" aria-hidden />
      <span className="citation-report-strip-label">Citation check</span>
      <span className="citation-report-strip-counts">
        {counts.map((c) => (
          <span key={c}>
            <span className="citation-report-strip-sep">·</span>
            {c}
          </span>
        ))}
      </span>
      <span className="citation-report-strip-hint">{HINTS[level]}</span>
      {onFix && level !== "ok" && (
        <button
          type="button"
          className="citation-report-strip-fix"
          onClick={() => onFix(chatSessionId)}
          title="Send a repair pass: the model re-cites or drops the flagged claims and regenerates the report"
        >
          Fix citations
        </button>
      )}
    </div>
  );
}
