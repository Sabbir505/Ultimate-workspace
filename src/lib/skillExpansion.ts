// Skill slash-command expansion (PRD §7.15): typing `/skill-name rest of text`
// into a pane expands to the stored template before being sent to the harness.
// Pure client-side text substitution, run before write_pty.

export interface SkillLike {
  slashCommand: string;
  content: string;
}

/**
 * Expand a leading slash command in `input` using the given skills.
 * - Only the first token is considered (`/audit-ai-slop extra args`).
 * - The slash command match is exact and case-sensitive.
 * - Any trailing text after the command is appended after the template,
 *   separated by a blank line, so users can pass context along.
 * - Returns the input unchanged when the first token is not a known skill.
 */
export function expandSkillCommand(input: string, skills: SkillLike[]): string {
  const trimmedStart = input.trimStart();
  if (!trimmedStart.startsWith("/")) return input;

  const firstSpaceIdx = trimmedStart.search(/\s/);
  const command = firstSpaceIdx === -1 ? trimmedStart : trimmedStart.slice(0, firstSpaceIdx);
  const rest = firstSpaceIdx === -1 ? "" : trimmedStart.slice(firstSpaceIdx).trim();

  const skill = skills.find((s) => s.slashCommand === command);
  if (!skill) return input;

  return rest.length > 0 ? `${skill.content}\n\n${rest}` : skill.content;
}
