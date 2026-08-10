// Lazy-loaded markdown renderer for the update modal's release notes.
// Split into its own module so react-markdown + remark-gfm (~150 KB raw)
// are only fetched when an update is actually available and the user
// opens the modal — not on every app startup.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownNotes({ notes }: { notes: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{notes}</ReactMarkdown>;
}
