// Skills library store (§7.15). Skills are listed for slash-command expansion
// and managed through the Skills Library view.
import { create } from "zustand";
import { createSkill, deleteSkill, listSkills, updateSkill } from "../lib/ipc";
import type { Skill } from "../types";

interface SkillsState {
  loaded: boolean;
  skills: Skill[];
  load: () => Promise<void>;
  create: (name: string, slashCommand: string, content: string, scope: string) => Promise<Skill | null>;
  update: (id: string, name: string, slashCommand: string, content: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  loaded: false,
  skills: [],

  load: async () => {
    const skills = await listSkills();
    set({ loaded: true, skills: skills ?? [] });
  },

  create: async (name, slashCommand, content, scope) => {
    const skill = await createSkill(name, slashCommand, content, scope);
    if (skill) set((s) => ({ skills: [...s.skills, skill] }));
    return skill;
  },

  update: async (id, name, slashCommand, content) => {
    await updateSkill(id, name, slashCommand, content);
    set((s) => ({
      skills: s.skills.map((sk) => (sk.id === id ? { ...sk, name, slashCommand, content } : sk)),
    }));
  },

  remove: async (id) => {
    await deleteSkill(id);
    set((s) => ({ skills: s.skills.filter((sk) => sk.id !== id) }));
  },
}));
