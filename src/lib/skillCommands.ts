// Slash-command tokens for chat skills. A skill is only injected into the
// system prompt when the user invokes it with `/command` in their message —
// this module is the single source of truth for how a skill maps to its token.
// The Rust send path (`chat::commands::skill_matches_message`) reimplements the
// same rules; keep them in sync.

export interface SkillLike {
  name: string;
  command?: string;
}

/** Derive a slash token from a skill name: lowercase, runs of
 *  non-alphanumerics collapse to `-`, edges trimmed.
 *  "Word documents (.docx)" → "word-documents-docx". */
export function slugifyCommand(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The skill's effective slash token: its explicit `command` if set,
 *  otherwise the slugified name. Returns "" for empty/nameless skills. */
export function skillCommand(skill: SkillLike): string {
  const explicit = skill.command?.trim().replace(/^\/+/, "") ?? "";
  return explicit || slugifyCommand(skill.name);
}
