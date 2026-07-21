import { describe, expect, it } from "vitest";
import {
  acceleratorFromEvent,
  DEFAULT_KEYBINDINGS,
  matchesAccelerator,
  parseAccelerator,
} from "../lib/keybindings";

const ev = (key: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
});

describe("parseAccelerator", () => {
  it("parses modifiers and key", () => {
    expect(parseAccelerator("Mod+Shift+B")).toEqual({ mod: true, shift: true, alt: false, key: "b" });
    expect(parseAccelerator("Mod+K")).toEqual({ mod: true, shift: false, alt: false, key: "k" });
    expect(parseAccelerator("Mod+,")).toEqual({ mod: true, shift: false, alt: false, key: "," });
    expect(parseAccelerator("Mod+`")).toEqual({ mod: true, shift: false, alt: false, key: "`" });
  });

  it("accepts ctrl/cmd/meta/control aliases for Mod", () => {
    expect(parseAccelerator("Ctrl+W").mod).toBe(true);
    expect(parseAccelerator("Cmd+W").mod).toBe(true);
    expect(parseAccelerator("Meta+W").mod).toBe(true);
    expect(parseAccelerator("Control+W").mod).toBe(true);
  });

  it("throws on invalid accelerators", () => {
    expect(() => parseAccelerator("")).toThrow();
    expect(() => parseAccelerator("Mod+")).toThrow();
    expect(() => parseAccelerator("Mod+K+W")).toThrow();
  });
});

describe("matchesAccelerator", () => {
  it("matches Cmd (meta) OR Ctrl for Mod", () => {
    expect(matchesAccelerator("Mod+K", ev("k", { meta: true }))).toBe(true);
    expect(matchesAccelerator("Mod+K", ev("k", { ctrl: true }))).toBe(true);
  });

  it("is case-insensitive on the key", () => {
    expect(matchesAccelerator("Mod+K", ev("K", { meta: true }))).toBe(true);
  });

  it("requires shift when specified", () => {
    expect(matchesAccelerator("Mod+Shift+B", ev("b", { ctrl: true }))).toBe(false);
    expect(matchesAccelerator("Mod+Shift+B", ev("b", { ctrl: true, shift: true }))).toBe(true);
  });

  it("rejects when shift is pressed but not in the accelerator", () => {
    expect(matchesAccelerator("Mod+K", ev("k", { ctrl: true, shift: true }))).toBe(false);
  });

  it("rejects missing mod", () => {
    expect(matchesAccelerator("Mod+K", ev("k"))).toBe(false);
  });

  it("matches digit and punctuation keys", () => {
    expect(matchesAccelerator("Mod+1", ev("1", { ctrl: true }))).toBe(true);
    expect(matchesAccelerator("Mod+,", ev(",", { meta: true }))).toBe(true);
    expect(matchesAccelerator("Mod+`", ev("`", { ctrl: true }))).toBe(true);
  });

  it("returns false for malformed accelerators instead of throwing", () => {
    expect(matchesAccelerator("not-a-real-accel+x+y", ev("x", { ctrl: true }))).toBe(false);
  });

  it("default keybinding map matches the documented §7.6 shortcuts", () => {
    expect(matchesAccelerator(DEFAULT_KEYBINDINGS.openPalette, ev("k", { meta: true }))).toBe(true);
    expect(matchesAccelerator(DEFAULT_KEYBINDINGS.closePane, ev("w", { ctrl: true }))).toBe(true);
    expect(matchesAccelerator(DEFAULT_KEYBINDINGS.toggleBroadcast, ev("b", { ctrl: true, shift: true }))).toBe(true);
    expect(matchesAccelerator(DEFAULT_KEYBINDINGS.openSettings, ev(",", { meta: true }))).toBe(true);
    expect(matchesAccelerator(DEFAULT_KEYBINDINGS.cyclePane, ev("`", { ctrl: true }))).toBe(true);
    expect(matchesAccelerator(DEFAULT_KEYBINDINGS.newSession, ev("n", { ctrl: true }))).toBe(true);
    expect(matchesAccelerator(DEFAULT_KEYBINDINGS.focusPane4, ev("4", { meta: true }))).toBe(true);
  });
});

describe("acceleratorFromEvent", () => {
  it("serializes a key event into an accelerator string", () => {
    expect(acceleratorFromEvent(ev("k", { ctrl: true }))).toBe("Mod+k");
    expect(acceleratorFromEvent(ev("B", { meta: true, shift: true }))).toBe("Mod+Shift+b");
    expect(acceleratorFromEvent(ev(",", { ctrl: true }))).toBe("Mod+,");
  });

  it("returns null for pure modifier presses", () => {
    expect(acceleratorFromEvent(ev("Control", { ctrl: true }))).toBeNull();
    expect(acceleratorFromEvent(ev("Shift", { shift: true }))).toBeNull();
    expect(acceleratorFromEvent(ev("Meta", { meta: true }))).toBeNull();
  });

  it("round-trips through matchesAccelerator", () => {
    const e = ev("d", { ctrl: true, shift: true });
    const accel = acceleratorFromEvent(e)!;
    expect(matchesAccelerator(accel, e)).toBe(true);
  });
});
