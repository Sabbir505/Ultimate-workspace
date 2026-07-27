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
  /** Short slash token used to invoke the skill in chat (e.g. `/docx`). */
  command: string;
  content: string;
  /** One-line description for the skills table. */
  description?: string;
}

/** Strip a leading YAML frontmatter block so only the instructional body is
 *  injected into the system prompt. Also extracts `description` from frontmatter. */
function parseFrontmatter(text: string): { body: string; description?: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { body: text.trim() };
  const end = lines.indexOf("---", 1);
  if (end === -1) return { body: text.trim() };
  const frontmatter = lines.slice(1, end).join("\n");
  const descMatch = frontmatter.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  return {
    body: lines.slice(end + 1).join("\n").trim(),
    description: descMatch ? descMatch[1].trim() : undefined,
  };
}

export const DEFAULT_SKILLS: DefaultSkill[] = [
  { name: "Word documents (.docx)", command: "docx", content: parseFrontmatter(docxSkill).body, description: parseFrontmatter(docxSkill).description },
  { name: "Slide decks (.pptx)", command: "pptx", content: parseFrontmatter(pptxSkill).body, description: parseFrontmatter(pptxSkill).description },
  { name: "PDF documents", command: "pdf", content: parseFrontmatter(pdfSkill).body, description: parseFrontmatter(pdfSkill).description },
  { name: "Diagrams (vector SVG)", command: "diagram", content: parseFrontmatter(diagramSkill).body, description: parseFrontmatter(diagramSkill).description },
];

/** Skill records ready to persist, with stable ids. */
export function seededSkills(): Array<{
  id: string;
  name: string;
  command: string;
  content: string;
  enabled: boolean;
  author: string;
  updatedAt: string;
  description?: string;
}> {
  const today = new Date().toISOString().split("T")[0];
  return DEFAULT_SKILLS.map((d, i) => ({
    id: `skill_default_${i}`,
    name: d.name,
    command: d.command,
    content: d.content,
    enabled: true,
    author: "Anthropic",
    updatedAt: today,
    description: d.description,
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
