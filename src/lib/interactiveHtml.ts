/** Classify whether HTML content is interactive (a webapp) or static (a
 *  diagram/document). Interactive signals: <script>, inline event handlers,
 *  forms/inputs/buttons, addEventListener. Static content renders safely in a
 *  scripts-blocked sandboxed frame (inline diagrams, content measurement);
 *  interactive content must render in a live `allow-scripts` frame or its
 *  buttons/scripts silently do nothing.
 *
 *  Shared by InlineDiagram (inline-vs-chip decision) and ArtifactPreviewPane
 *  (static DiagramFrame-vs-live HtmlPreview decision) so both surfaces agree
 *  on what renders live.
 */
export function isInteractiveHtml(html: string): boolean {
  const lower = html.toLowerCase();
  const hasScript =
    /<script\b[^>]*>[\s\S]*?<\/script>/i.test(html) ||
    /\bon(?:click|load|change|submit|input|mouseover|keyup|keydown)\s*=/i.test(html);
  const hasForm = /<\s*(?:form|input|textarea|select|button)\b/i.test(lower);
  const hasEventListener = /addeventlistener\s*\(/i.test(lower);
  if (hasScript || hasForm || hasEventListener) {
    // If it ALSO has an <svg> and the script is tiny (inline styling only),
    // it's still a diagram with minor scripting, not a real app.
    if (/<svg\b/i.test(lower)) {
      const scripts = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
      const totalScriptSize = scripts.reduce((sum, s) => sum + s.length, 0);
      // Under 200 chars of script = probably just styling, not a real app.
      if (totalScriptSize < 200) return false;
    }
    return true;
  }
  return false;
}
