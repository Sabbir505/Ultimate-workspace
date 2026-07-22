// Built-in skills seeded into the Assistant tab on first run, so document and
// diagram generation guidance is enabled out of the box. Users can edit,
// disable, or delete them like any other skill. The markdown lives in the
// repo's `skills/` folder and is embedded at build time via Vite `?raw`.
import docxSkill from "../../skills/docx-skill.md?raw";
import pptxSkill from "../../skills/pptx-skill.md?raw";
import pdfSkill from "../../skills/pdf-skill.md?raw";
import diagramSkill from "../../skills/diagram-html-svg-skill.md?raw";

export interface DefaultSkill {
  name: string;
  content: string;
}

/** Strip a leading YAML frontmatter block so only the instructional body is
 *  injected into the system prompt. */
function stripFrontmatter(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return text.trim();
  const end = lines.indexOf("---", 1);
  if (end === -1) return text.trim();
  return lines.slice(end + 1).join("\n").trim();
}

export const DEFAULT_SKILLS: DefaultSkill[] = [
  { name: "Word documents (.docx)", content: stripFrontmatter(docxSkill) },
  { name: "Slide decks (.pptx)", content: stripFrontmatter(pptxSkill) },
  { name: "PDF documents", content: stripFrontmatter(pdfSkill) },
  { name: "Diagrams (vector SVG)", content: stripFrontmatter(diagramSkill) },
];

/** Skill records ready to persist, with stable ids. */
export function seededSkills(): Array<{
  id: string;
  name: string;
  content: string;
  enabled: boolean;
}> {
  return DEFAULT_SKILLS.map((d, i) => ({
    id: `skill_default_${i}`,
    name: d.name,
    content: d.content,
    enabled: true,
  }));
}

/** Seed the built-in skills into `assistant.skills` if it has never been set,
 *  so the model gets document/diagram guidance even before the user opens the
 *  Assistant settings tab. No-op once the setting exists. */
export async function ensureDefaultSkills(): Promise<void> {
  const { getSetting, setSetting } = await import("./ipc");
  const existing = await getSetting("assistant.skills");
  if (existing == null) {
    await setSetting("assistant.skills", JSON.stringify(seededSkills()));
  }
}
