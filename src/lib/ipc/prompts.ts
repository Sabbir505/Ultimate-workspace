// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";
import { ChatAttachmentInput, jsonSetting } from "../ipc";
import type { AvailableSkill, InstalledSkill } from "../../types";

// ---- Prompt templates (roadmap #14) ----
// A prompt template is a reusable prompt body with `{{variable}}` placeholders.
// Selecting one in the composer fills the variables and inserts the completed
// text. Stored as a JSON array under the `prompts.templates` app_settings key.

export interface PromptTemplate {
  id: string;
  name: string;
  /** Prompt body with `{{varName}}` placeholders. */
  body: string;
  /** Optional `/trigger` that lists this template in the slash menu. */
  trigger?: string;
  createdAt: number;
}

const PROMPT_TEMPLATES_KEY = "prompts.templates";
const jsonTemplates = jsonSetting<PromptTemplate>(PROMPT_TEMPLATES_KEY);

export const listPromptTemplates = jsonTemplates.load;
export const savePromptTemplates = jsonTemplates.save;

/** Extract `{{var}}` placeholders from a template body (deduped, in order). */
export function templateVariables(body: string): string[] {
  const vars: string[] = [];
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (!vars.includes(m[1])) vars.push(m[1]);
  }
  return vars;
}

/** Substitute `{{var}}` placeholders using the provided values (missing → empty). */
export function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => values[name] ?? "");
}

// --- Installed skills / loops (harness skill directories) ---
export const listInstalledSkills = () => safeInvoke<InstalledSkill[] | null>("list_installed_skills");
export const listInstalledLoops = () => safeInvoke<InstalledSkill[] | null>("list_installed_loops");
export const readInstalledSkill = (slug: string, kind: string) =>
  safeInvoke<string | null>("read_installed_skill", { slug, kind });
export const saveInstalledSkill = (slug: string, kind: string, content: string) =>
  safeInvoke<void>("save_installed_skill", { slug, kind, content });
export const createInstalledSkill = (name: string, kind: string, content: string) =>
  safeInvoke<InstalledSkill | null>("create_installed_skill", { name, kind, content });
export const deleteInstalledSkill = (slug: string, kind: string) =>
  safeInvoke<void>("delete_installed_skill", { slug, kind });

/**
 * Make every installed skill/loop global — i.e. readable by any harness.
 * Copies each entry that currently lives in only one harness dir into the
 * other so its source becomes "both". Returns the number of entries mirrored.
 */
export const makeInstalledGlobal = (kind: string) =>
  safeInvoke<number>("make_installed_global", { kind });

// --- Chat `/` menu: on-disk harness skills merged with the built-in
// doc/pptx/pdf/diagram skills (on-disk wins on slug collision). ---
export const listChatSkills = () =>
  safeInvoke<AvailableSkill[] | null>("list_chat_skills");

// --- Chat mode (direct LLM HTTP API, separate from CLI agent panes) ---
// Command names and arg shapes are binding per CONTRACT.md — do not rename
// without updating the Rust backend in lockstep. Types mirror the serde
// structs (camelCase fields).
