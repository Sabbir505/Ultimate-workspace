// Vault voice — the pieces that decide WHERE dictated text lands and WHICH
// key a read-aloud is filed under. The engines themselves (lib/tts.ts,
// lib/voiceDictationCore.ts) are exercised elsewhere; what's tested here is
// the vault's adapter contract, since that's the new surface.
import { describe, expect, it } from "vitest";
import {
  createVaultDictationTarget,
  readVaultSelection,
  vaultTtsKey,
  vaultTtsNote,
  VAULT_TTS_PREFIX,
} from "../components/vault/vaultVoice";
import { resolveDictationWrite } from "../lib/voiceDictationCore";

describe("vault TTS keys", () => {
  it("round-trips a note path", () => {
    expect(vaultTtsNote(vaultTtsKey("Journal/2026-09-26.md"))).toBe("Journal/2026-09-26.md");
  });

  it("keeps a selection read attached to its note", () => {
    // The '#sel' suffix must not leak into the note identity, or the
    // stop-on-note-switch guard would treat a selection read of the CURRENT
    // note as belonging to some other note and cut it off.
    const key = vaultTtsKey("notes/idea.md", true);
    expect(key).toBe(`${VAULT_TTS_PREFIX}notes/idea.md#sel`);
    expect(vaultTtsNote(key)).toBe("notes/idea.md");
  });

  it("ignores keys belonging to other surfaces", () => {
    // Chat and artifact reads share the one transport bar; the vault's
    // teardown guard must leave them alone.
    expect(vaultTtsNote("msg:s1:m1")).toBeNull();
    expect(vaultTtsNote("artifact:notes/idea.md")).toBeNull();
    expect(vaultTtsNote(null)).toBeNull();
  });
});

describe("resolveDictationWrite", () => {
  it("replaces its own span in place while the text there is unchanged", () => {
    const doc = "hello dictated world";
    // [6, 14) is exactly the dictated word; the engine wrote it there last tick.
    const range = resolveDictationWrite(doc, { from: 6, to: 14 }, "dictated");
    expect(range).toEqual({ from: 6, to: 14 });
  });

  it("appends instead of clobbering when the user edited inside the span", () => {
    // The user retyped the dictated region; writing there would delete their
    // edit, so the next chunk has to land at the end of the document.
    const doc = "hello MY EDIT world";
    const range = resolveDictationWrite(doc, { from: 6, to: 15 }, "dictated");
    expect(range).toEqual({ from: doc.length, to: doc.length });
  });

  it("appends when the user deleted the dictated region", () => {
    const doc = "hello ";
    const range = resolveDictationWrite(doc, { from: 6, to: 15 }, "dictated");
    expect(range).toEqual({ from: 6, to: 6 });
  });

  it("appends on the very first write, with no prior span", () => {
    const range = resolveDictationWrite("note body", null, "");
    expect(range).toEqual({ from: 9, to: 9 });
  });
});

/** Minimal stand-in for the slice of EditorView the target touches. */
function fakeView(doc: string) {
  const state = { doc: { toString: () => doc, length: doc.length } };
  return {
    state,
    focus: () => {},
    hasFocus: false,
    dispatch: (tx: { changes?: { from: number; to: number; insert: string } }) => {
      if (tx.changes) {
        const { from, to, insert } = tx.changes;
        state.doc = {
          toString: () => doc.slice(0, from) + insert + doc.slice(to),
          length: doc.length - (to - from) + insert.length,
        };
      }
    },
  };
}

describe("createVaultDictationTarget", () => {
  it("reads the live document", () => {
    const view = fakeView("# Heading\n\nbody");
    const target = createVaultDictationTarget(() => view as never);
    expect(target.read()).toBe("# Heading\n\nbody");
  });

  it("writes into the document and reports the new span", () => {
    const view = fakeView("abc");
    const target = createVaultDictationTarget(() => view as never);
    const span = target.write(3, 3, "dictated");
    expect(span).toEqual({ from: 3, to: 11 });
    expect(target.read()).toBe("abcdictated");
  });

  it("clamps a stale span to the live document length", () => {
    // The note shrank (reload, or an edit above the span) after the span was
    // captured — an unclamped dispatch would throw on out-of-range offsets.
    const view = fakeView("ab");
    const target = createVaultDictationTarget(() => view as never);
    const span = target.write(40, 60, "x");
    expect(span).toEqual({ from: 2, to: 3 });
    expect(target.read()).toBe("abx");
  });

  it("is inert when the editor is not mounted (preview mode, loading)", () => {
    const target = createVaultDictationTarget(() => null);
    expect(target.read()).toBe("");
    expect(() => target.write(0, 0, "x")).not.toThrow();
    expect(target.write(0, 0, "x")).toEqual({ from: 0, to: 0 });
    expect(target.isFocused()).toBe(false);
    expect(() => target.setCaret(5)).not.toThrow();
    expect(() => target.focus()).not.toThrow();
  });
});

describe("readVaultSelection", () => {
  const viewWith = (text: string, from: number, to: number) =>
    ({
      state: {
        selection: { main: { from, to, empty: from === to } },
        sliceDoc: (f: number, t: number) => text.slice(f, t),
      },
    }) as never;

  it("returns the selected text", () => {
    expect(readVaultSelection(viewWith("hello world", 6, 11))).toBe("world");
  });

  it("returns null for a bare caret — there is nothing to read", () => {
    expect(readVaultSelection(viewWith("hello world", 6, 6))).toBeNull();
  });

  it("returns null when only whitespace is selected", () => {
    expect(readVaultSelection(viewWith("hello world", 5, 6))).toBeNull();
  });

  it("returns null with no editor mounted", () => {
    expect(readVaultSelection(null)).toBeNull();
  });
});
