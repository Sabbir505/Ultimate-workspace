// CodeMirror 6 note editor — the vault's EDIT surface (Obsidian-style live
// preview; Preview mode renders the same markdown through VaultPreview).
//
// CM6 keeps the document TEXT untouched and renders markdown via decorations
// — byte-perfect round-trips with a document look. Shipped here:
//   - heading lines sized by level, bold/italic/highlight/strike/code,
//     wikilink, markdown-link and URL styling; delimiters hide unless the
//     cursor is inside the token ("markers reappear while you edit")
//   - rendered task checkboxes (click toggles the file), rendered math
//     (inline $…$ and multi-line $$ blocks, via katex) when the cursor is
//     outside them, hidden `^block-id` markers
//   - [[ completion over the vault (create-new for unmatched names; async
//     `#heading` / `#^block` subpath completion), plus a `/` slash menu for
//     the toolbar constructs
//   - Ctrl+B/I/K wraps, Enter continues lists, Tab/Shift+Tab indent list
//     items, Ctrl+F in-note search (with match highlighting), spellcheck,
//     paste-URL-over-selection makes a link, image paste/drop import,
//     autosave debounce and Mod+S.

import { useEffect, useRef } from "react";
import { EditorState, Compartment, EditorSelection, StateField } from "@codemirror/state";
import { EditorView, keymap, highlightSpecialChars, drawSelection, ViewPlugin, Decoration, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle, foldGutter } from "@codemirror/language";
import { markdown, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import katex from "katex";
import "katex/dist/katex.min.css";
import { hoverHandlers, openVaultLinkHover, scheduleCloseVaultLinkHover } from "./VaultLinkHover";

export interface VaultEditorProps {
  value: string;
  onChange: (text: string) => void;
  /** Debounced save (store.scheduleSave) — fired on every change. */
  onEdit: () => void;
  /** Immediate save (Mod+S). */
  onSave: () => void;
  /** Note labels + paths for `[[` completion. */
  completionItems: { label: string; detail: string }[];
  onOpenLink: (target: string, subpath: string | null) => void;
  /** Hands the live EditorView to the parent — the toolbar's edit actions
   *  (bold/italic/image insert/…) dispatch through it. */
  onViewReady?: (view: EditorView | null) => void;
  /** An image arrived via clipboard paste or file drag-drop — the parent
   *  imports it into the vault and inserts the embed. */
  onImagePaste?: (file: File) => void;
}

// Module-level bridge so the completion source reads the CURRENT note list
// without rebuilding the extension on every tree change.
let currentCompletionItems: { label: string; detail: string }[] = [];
let openLinkHandler: ((target: string, subpath: string | null) => void) | null = null;

/** Subpath completion reads whole notes — cache the reads (per session). */
const noteContentCache = new Map<string, string>();

/** Drop the subpath-completion read cache. The store's bind() calls this on
 *  a vault (re)bind — cached entries are keyed by path, and a new vault
 *  must never resolve the previous vault's text. */
export function clearNoteContentCache() {
  noteContentCache.clear();
}

/** Wrap the selection (or insert an empty pair at the cursor) — the engine
 *  behind Ctrl+B/I and the slash menu's inline constructs. Multi-cursor safe
 *  via changeByRange. */
function wrapSelection(before: string, after: string) {
  return (view: EditorView): boolean => {
    const tr = view.state.changeByRange((range) => {
      const text = view.state.sliceDoc(range.from, range.to);
      if (range.empty) {
        return {
          changes: { from: range.from, insert: before + after },
          range: EditorSelection.cursor(range.from + before.length),
        };
      }
      return {
        changes: { from: range.from, to: range.to, insert: before + text + after },
        range: EditorSelection.range(range.from + before.length, range.to + before.length),
      };
    });
    view.dispatch(tr);
    return true;
  };
}

/** Markdown link: wraps the selection as [text](url); empty selection gets a
 *  ready-to-fill [](https://) with the cursor between the brackets. */
function wrapMarkdownLink(view: EditorView): boolean {
  const tr = view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to);
    if (range.empty) {
      return {
        changes: { from: range.from, insert: "[](https://)" },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    return {
      changes: { from: range.from, to: range.to, insert: `[${text}](https://)` },
      range: EditorSelection.range(range.from + text.length + 3, range.from + text.length + 11),
    };
  });
  view.dispatch(tr);
  return true;
}

const LIST_ITEM_RE = /^(\s*)([-*+]\s|\d+[.)]\s)/;

/** Tab / Shift+Tab on list items: indent or outdent each touched line by a
 *  level (2 spaces). Outside lists the keys fall through to the default
 *  indent behavior. */
function listIndent(more: boolean) {
  return (view: EditorView): boolean => {
    const state = view.state;
    let handled = false;
    const tr = state.changeByRange((range) => {
      const startLine = state.doc.lineAt(range.from);
      const endLine = state.doc.lineAt(range.to);
      const lines: ReturnType<typeof state.doc.lineAt>[] = [];
      for (let n = startLine.number; n <= endLine.number; n += 1) lines.push(state.doc.line(n));
      if (!lines.every((l) => LIST_ITEM_RE.test(l.text))) return { range };
      handled = true;
      const changes: { from: number; to?: number; insert?: string }[] = [];
      let delta = 0;
      for (const l of lines) {
        if (more) {
          changes.push({ from: l.from, insert: "  " });
          delta = 2;
        } else {
          const m = /^ {1,2}/.exec(l.text);
          if (m) {
            changes.push({ from: l.from, to: l.from + m[0].length });
            delta = -2;
          }
        }
      }
      return {
        changes,
        range: EditorSelection.range(
          Math.max(lines[0].from, range.from + delta),
          Math.max(lines[0].from, range.to + delta),
        ),
      };
    });
    if (!handled) return false;
    view.dispatch(tr);
    return true;
  };
}

/** Rendered math. `output: "html"` keeps the widget self-contained; errors
 *  fall back to the raw TeX so a typo can never blank a note region. */
class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = this.display ? "cm-vault-math-render block" : "cm-vault-math-render";
    try {
      katex.render(this.tex, span, { throwOnError: false, displayMode: this.display, output: "html" });
    } catch {
      span.textContent = this.tex;
    }
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

/** Rendered task checkbox — click toggles the `[ ]`/`[x]` in the source. */
class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: TaskWidget) {
    return other.checked === this.checked;
  }
  toDOM() {
    const box = document.createElement("span");
    box.className = `cm-vault-task-box${this.checked ? " checked" : ""}`;
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

/** Multi-line $$ … $$ blocks across the WHOLE doc (fence state is global, so
 *  a block above the viewport still affects what the viewport may show). */
function mathBlockRanges(doc: { iterLines(): Iterator<string> }): { from: number; to: number; tex: string }[] {
  const out: { from: number; to: number; tex: string }[] = [];
  let offset = 0;
  let startFrom = -1;
  let texLines: string[] = [];
  const iter = doc.iterLines();
  for (let next = iter.next(); !next.done; next = iter.next()) {
    const line = next.value;
    const trimmed = line.trim();
    if (startFrom === -1 && trimmed === "$$") {
      startFrom = offset;
      texLines = [];
    } else if (startFrom !== -1 && trimmed === "$$") {
      out.push({ from: startFrom, to: offset + line.length, tex: texLines.join("\n") });
      startFrom = -1;
    } else if (startFrom !== -1) {
      texLines.push(line);
    }
    offset += line.length + 1;
  }
  return out;
}

/** $$ blocks live in a STATE field, not the view plugin: CodeMirror only
 *  allows BLOCK decorations from state-level sources ("Block decorations
 *  may not be specified via plugins"). When the cursor sits inside a block
 *  it renders raw (editable); otherwise the whole block collapses into one
 *  katex display widget. The field stores the block RANGES alongside the
 *  decorations so the live-preview plugin never rescans the document. */
interface MathBlockState {
  ranges: { from: number; to: number; tex: string }[];
  deco: DecorationSet;
}

const mathBlockField = StateField.define<MathBlockState>({
  create: () => ({ ranges: [], deco: Decoration.none }),
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value;
    // One mathBlockRanges scan per transaction — buildDeco reads these
    // ranges back out of the field instead of computing them again.
    const blocks = mathBlockRanges(tr.state.doc);
    const cursor = tr.state.selection.main;
    let emitted = false;
    const pending: ReturnType<Decoration["range"]>[] = [];
    for (const b of blocks) {
      const inside = cursor.from <= b.to && cursor.to >= b.from;
      if (!inside) {
        pending.push(Decoration.replace({ block: true, widget: new MathWidget(b.tex, true) }).range(b.from, b.to));
        emitted = true;
      } else {
        for (let p = b.from; p <= b.to; ) {
          const line = tr.state.doc.lineAt(p);
          pending.push(Decoration.line({ class: "cm-vault-math-block" }).range(line.from));
          emitted = true;
          p = line.to + 1;
        }
      }
    }
    let deco = Decoration.none;
    if (emitted) {
      try {
        deco = Decoration.set(pending, true);
      } catch {
        deco = Decoration.none;
      }
    }
    return { ranges: blocks, deco };
  },
  provide: (f) => EditorView.decorations.compute([f], (state) => state.field(f).deco),
});

/** One inline markdown token found on a line. */
interface InlineToken {
  from: number;
  to: number;
  /** CSS class for the INNER text decoration. */
  cls: string;
  /** Lengths of the leading/trailing delimiters hidden in live preview. */
  open: number;
  close: number;
  /** Exact inner-text bounds (absolute) when the hidden syntax is NOT just
   *  the open/close pairs — markdown links hide `[` AND `](url)`. */
  textFrom?: number;
  textTo?: number;
  /** Math tokens render through katex when the cursor is elsewhere. */
  tex?: string;
  display?: boolean;
}

/** Scan one line for the inline tokens the live preview decorates. Order
 *  matters: first-match-wins so **bold** is never re-matched as *em*. */
function scanInlineTokens(line: string, lineFrom: number): InlineToken[] {
  const tokens: InlineToken[] = [];
  const taken = new Array<boolean>(line.length).fill(false);
  const take = (start: number, len: number) => {
    for (let i = start; i < start + len; i += 1) {
      if (taken[i]) return false;
    }
    for (let i = start; i < start + len; i += 1) taken[i] = true;
    return true;
  };
  const patterns: Array<{ re: RegExp; cls: string; open: number; close: number; display?: boolean }> = [
    { re: /\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g, cls: "cm-vault-wikilink", open: 2, close: 2 },
    // Display math on a single line, then inline math. The $-heuristics:
    // no space after the opening $ / before the closing $, and a spaced
    // numeric bookend ("$5 and $10") is money, not math.
    { re: /\$\$([^$\n]+)\$\$/g, cls: "cm-vault-math", open: 2, close: 2, display: true },
    { re: /\$([^$\n]+?)\$/g, cls: "cm-vault-math", open: 1, close: 1 },
    // External links: the text keeps a link look, and `[` plus `](url)` hide
    // when the token is not being edited (textFrom/textTo below).
    { re: /\[[^\]\n]*\]\([^)\n]+\)/g, cls: "cm-vault-mdlink", open: 1, close: 1 },
    // Bare URLs stay visible, in the link color.
    { re: /https?:\/\/[^\s)\]}<>"]+/g, cls: "cm-vault-url", open: 0, close: 0 },
    { re: /\*\*[^*\n]+\*\*/g, cls: "cm-vault-strong", open: 2, close: 2 },
    { re: /==[^=\n]+==/g, cls: "cm-vault-mark", open: 2, close: 2 },
    { re: /~~[^~\n]+~~/g, cls: "cm-vault-strike", open: 2, close: 2 },
    { re: /`[^`\n]+`/g, cls: "cm-vault-code-inline", open: 1, close: 1 },
    { re: /\*[^*\n]+\*/g, cls: "cm-vault-em", open: 1, close: 1 },
  ];
  for (const { re, cls, open, close, display } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (cls === "cm-vault-math" && display !== true) {
        const tex = m[1] ?? "";
        if (!tex.trim() || tex.startsWith(" ") || tex.endsWith(" ")) continue; // not math
        if (/\s/.test(tex) && /^\d/.test(tex) && /\d$/.test(tex)) continue; // "$5 and $10"
      }
      if (!take(m.index, m[0].length)) continue;
      const from = lineFrom + m.index;
      const to = from + m[0].length;
      if (cls === "cm-vault-mdlink") {
        const closeBracket = m[0].indexOf("]");
        tokens.push({ from, to, cls, open, close, textFrom: from + 1, textTo: from + closeBracket });
      } else if (cls === "cm-vault-math") {
        tokens.push({ from, to, cls, open, close, tex: m[1] ?? "", display });
      } else {
        tokens.push({ from, to, cls, open, close });
      }
    }
  }
  return tokens;
}

/** The live-preview decoration set: markdown rendered document-style.
 *  Delimiters are HIDDEN (replaced with nothing) unless the selection sits
 *  inside the token — Obsidian's "markers reappear while you edit" rule. */
const livePreviewDeco = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      this.decorations = this.buildDeco(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = this.buildDeco(update.view);
      }
    }
    /** Is the token's (slightly padded) range inside any selection? While
     *  editing a token its raw markers must stay visible to type against. */
    tokenActive(view: EditorView, from: number, to: number): boolean {
      const pad = 1;
      return view.state.selection.ranges.some(
        (r) => r.from <= to + pad && r.to >= from - pad,
      );
    }
    buildDeco(view: EditorView): DecorationSet {
      const pending: Array<{ from: number; to: number; deco: Decoration }> = [];
      const hide = () => Decoration.replace({});
      const mark = (cls: string) => Decoration.mark({ class: cls });

      const cursor = view.state.selection.main;
      // $$ block ranges AND decorations come from mathBlockField (computed
      // once per transaction there); here we only need the ranges to skip
      // inline scanning of the raw TeX while it is being edited.
      const mathBlocks = view.state.field(mathBlockField).ranges;
      const inMathBlock = (pos: number) => mathBlocks.some((b) => pos >= b.from && pos <= b.to);

      for (const range of view.visibleRanges) {
        for (let pos = range.from; pos <= range.to; ) {
          const line = view.state.doc.lineAt(pos);
          const onLine = cursor.from >= line.from && cursor.to <= line.to;

          // Headings: size the whole line, hide the #'s unless this line is
          // being edited.
          const h = /^(#{1,6})\s+(.*)$/.exec(line.text);
          if (h) {
            pending.push({
              from: line.from,
              to: line.from,
              deco: Decoration.line({ class: `cm-vault-heading cm-vault-h${h[1].length}` }),
            });
            if (!onLine) {
              pending.push({ from: line.from, to: line.from + h[1].length + 1, deco: hide() });
            }
          }
          // Blockquote marker: the line gets a quote style (body stays plain).
          if (/^>\s?/.test(line.text)) {
            pending.push({
              from: line.from,
              to: line.from,
              deco: Decoration.line({ class: "cm-vault-quote-line" }),
            });
          }
          // Task list: render the [ ] / [x] as a real checkbox widget (the
          // mousedown handler below toggles it in the source).
          const task = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(line.text);
          if (task) {
            pending.push({
              from: line.from + task[1].length,
              to: line.from + task[1].length + 3,
              deco: Decoration.replace({ widget: new TaskWidget(task[2] !== " ") }),
            });
          }
          // Block definition (`^block-id` at line end): hides unless this
          // line is being edited — links target it, readers never see it.
          const bid = /\s+\^[A-Za-z0-9][\w-]*\s*$/.exec(line.text);
          if (bid && !onLine) {
            pending.push({ from: line.from + bid.index, to: line.to, deco: hide() });
          }

          if (!inMathBlock(line.from)) {
            for (const t of scanInlineTokens(line.text, line.from)) {
              if (t.cls === "cm-vault-math" && t.tex != null) {
                if (onLine || this.tokenActive(view, t.from, t.to)) {
                  pending.push({ from: t.from, to: t.to, deco: mark(t.cls) });
                } else {
                  pending.push({
                    from: t.from,
                    to: t.to,
                    deco: Decoration.replace({ widget: new MathWidget(t.tex, t.display === true) }),
                  });
                }
                continue;
              }
              // Inner text class always applies (weight/color/underline); the
              // delimiters hide unless the cursor is inside the token — they
              // must stay visible while the token is being typed.
              const active = this.tokenActive(view, t.from, t.to);
              pending.push({ from: t.from, to: t.to, deco: mark(t.cls) });
              if (!active) {
                const textFrom = t.textFrom ?? t.from + t.open;
                const textTo = t.textTo ?? t.to - t.close;
                if (textFrom > t.from) pending.push({ from: t.from, to: textFrom, deco: hide() });
                if (t.to > textTo) pending.push({ from: textTo, to: t.to, deco: hide() });
              }
            }
          }
          pos = line.to + 1;
        }
      }
      // sort=true lets line decorations, marks and replace spans coexist;
      // block replaces never overlap the per-line spans above.
      try {
        return Decoration.set(
          pending.map((d) => d.deco.range(d.from, d.to)),
          true,
        );
      } catch (e) {
        console.error("[vault-live] buildDeco failed", e);
        return Decoration.none;
      }
    }
  },
  {
    // WITHOUT this, CM never reads the plugin's `decorations` field — the
    // decorations built above silently never reach the DOM (which is why
    // editor-side wikilinks were never styled or clickable before).
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mousedown(event) {
        const target = event.target as HTMLElement;
        // Task checkbox: flip the marker character in the source.
        const box = target.closest?.(".cm-vault-task-box");
        if (box) {
          const pos = this.view.posAtDOM(box);
          const line = this.view.state.doc.lineAt(pos);
          const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(line.text);
          if (m) {
            // m[1] ends at the '['; the toggleable space/x is the NEXT char.
            const charPos = line.from + m[1].length;
            event.preventDefault();
            this.view.dispatch({
              changes: { from: charPos, to: charPos + 1, insert: m[2] === " " ? "x" : " " },
              selection: { anchor: this.view.state.selection.main.head },
            });
            return true;
          }
        }
        const link = target.closest?.(".cm-vault-wikilink");
        if (!link) return false;
        const pos = this.view.posAtDOM(link as Node);
        const line = this.view.state.doc.lineAt(pos);
        // Rescan the whole line for the link under the click position.
        const re = /\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;
        let found: string | null = null;
        let subpath: string | null = null;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(line.text))) {
          const s = line.from + mm.index;
          if (pos >= s && pos <= s + mm[0].length) {
            const full = mm[1];
            const hash = full.indexOf("#");
            found = hash === -1 ? full : full.slice(0, hash);
            subpath = hash === -1 ? null : full.slice(hash);
            break;
          }
        }
        if (found != null) {
          event.preventDefault();
          openLinkHandler?.(found.trim(), subpath);
          return true;
        }
        return false;
      },
      mousemove(event) {
        const target = event.target as HTMLElement;
        const link = target.closest?.(".cm-vault-wikilink");
        if (!link) {
          // Grace-gap close, not instant: the cursor may be travelling to
          // the card itself (pin) or to another link (reopen).
          scheduleCloseVaultLinkHover();
          return false;
        }
        const pos = this.view.posAtDOM(link as Node);
        const line = this.view.state.doc.lineAt(pos);
        const re = /\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(line.text))) {
          const s = line.from + mm.index;
          if (pos >= s && pos <= s + mm[0].length) {
            const full = mm[1];
            const hash = full.indexOf("#");
            const target = (hash === -1 ? full : full.slice(0, hash)).trim();
            const rect = (link as HTMLElement).getBoundingClientRect();
            openVaultLinkHover({ target, anchor: rect });
            return false;
          }
        }
        return false;
      },
    },
  },
);

/** `[[` completion. Plain names resolve against the tree (with a create-new
 *  entry for unmatched names). `Note#…` goes async: headings and `^block`
 *  ids are offered from the note's actual content (empty note part = the
 *  note being edited). */
async function wikilinkCompletion(context: CompletionContext): Promise<CompletionResult | null> {
  const before = context.matchBefore(/\[\[([^\]\n]*)$/);
  if (!before) return null;
  const partial = before.text.slice(2);
  const hash = partial.indexOf("#");

  if (hash === -1) {
    const name = partial.trim();
    const lc = name.toLowerCase();
    const options = currentCompletionItems.map((item) => ({
      label: item.label,
      detail: item.detail,
      type: "text",
      apply: `[[${item.label}]]`,
    }));
    const filtered = name
      ? options.filter((o) => o.label.toLowerCase().includes(lc) || o.detail.toLowerCase().includes(lc))
      : options;
    const list = [];
    // Obsidian's move: an unmatched name is a CREATE action. The inserted
    // [[link]] stays unresolved — clicking it then creates + opens the note
    // (openNote's unresolved branch), which is also how nested paths
    // ("Folder/Note") come into existence.
    if (name && !options.some((o) => o.label.toLowerCase() === lc)) {
      list.push({
        label: `Create "${name}"`,
        detail: "new note",
        type: "text",
        apply: `[[${name}]]`,
        boost: 60,
      });
    }
    list.push(...filtered.slice(0, 30));
    if (list.length === 0) return null;
    return {
      from: before.from + 2,
      options: list,
      validFor: /^[^\]\n]*$/,
    };
  }

  // Subpath completion: headings + block ids from the target note's text.
  const notePart = partial.slice(0, hash).trim();
  const sub = partial.slice(hash + 1);
  let content: string | null;
  let label: string;
  if (!notePart) {
    content = context.state.doc.toString();
    label = "";
  } else {
    const item = currentCompletionItems.find((i) => i.label.toLowerCase() === notePart.toLowerCase());
    if (!item) return null;
    label = item.label;
    content = noteContentCache.get(item.detail) ?? null;
    if (content == null) {
      const { vaultReadNote } = await import("../../lib/ipc");
      content = await vaultReadNote(item.detail)
        .then((c) => {
          noteContentCache.set(item.detail, c);
          return c;
        })
        .catch(() => null);
    }
  }
  if (content == null) return null;
  const wantBlock = sub.startsWith("^");
  const lcSub = sub.replace(/^\^/, "").toLowerCase();
  const options: { label: string; detail: string; type: string; apply: string }[] = [];
  if (!wantBlock) {
    for (const m of content.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)) {
      const text = m[2].trim();
      if (lcSub && !text.toLowerCase().includes(lcSub)) continue;
      options.push({ label: text.slice(0, 48), detail: `heading · h${m[1].length}`, type: "text", apply: `${label}#${text}]]` });
    }
  }
  for (const m of content.matchAll(/\^([A-Za-z0-9][\w-]*)\s*$/gm)) {
    if (lcSub && !m[1].toLowerCase().includes(lcSub)) continue;
    options.push({ label: `^${m[1]}`, detail: "block", type: "text", apply: `${label}#^${m[1]}]]` });
  }
  if (options.length === 0) return null;
  return {
    from: before.from + 2 + hash + 1,
    options: options.slice(0, 20),
    validFor: /^[^\]\n]*$/,
  };
}

/** `/` slash menu — the toolbar's constructs without leaving the keyboard.
 *  Line-prefix entries replace the slash; block entries replace it with a
 *  skeleton and drop the cursor inside. */
function slashCompletion(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/\/([\w-]*)$/);
  if (!before) return null;
  const line = context.state.doc.lineAt(before.from);
  const beforeSlash = line.text.slice(0, before.from - line.from);
  // Only a slash at line start or after whitespace — never inside a URL.
  if (beforeSlash.length > 0 && !/\s$/.test(beforeSlash)) return null;
  const applyInsert = (text: string, cursorOffset?: number) =>
    (view: EditorView, _c: unknown, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + (cursorOffset ?? text.length) },
      });
    };
  const applyPrefix = (prefix: string) =>
    (view: EditorView, _c: unknown, from: number, to: number) => {
      view.dispatch({ changes: { from, to, insert: prefix } });
    };
  const options = [
    { label: "/h1", detail: "Heading 1", apply: applyPrefix("# ") },
    { label: "/h2", detail: "Heading 2", apply: applyPrefix("## ") },
    { label: "/h3", detail: "Heading 3", apply: applyPrefix("### ") },
    { label: "/bold", detail: "Bold **…**", apply: applyInsert("**bold text**", 2, ) },
    { label: "/italic", detail: "Italic *…*", apply: applyInsert("*italic text*", 1) },
    { label: "/highlight", detail: "Highlight ==…==", apply: applyInsert("==highlight==", 2) },
    { label: "/code", detail: "Inline code", apply: applyInsert("`code`", 1) },
    { label: "/codeblock", detail: "Fenced code block", apply: applyInsert("```js\n\n```", 5) },
    { label: "/quote", detail: "Blockquote", apply: applyPrefix("> ") },
    { label: "/bullet", detail: "Bullet list", apply: applyPrefix("- ") },
    { label: "/numbered", detail: "Numbered list", apply: applyPrefix("1. ") },
    { label: "/task", detail: "Task list item", apply: applyPrefix("- [ ] ") },
    { label: "/divider", detail: "Horizontal rule", apply: applyInsert("\n---\n", 1) },
    { label: "/table", detail: "Table skeleton", apply: applyInsert("\n| Column | Column |\n| --- | --- |\n|  |  |\n", 1) },
    { label: "/callout", detail: "Callout [!note]", apply: applyInsert("\n> [!note] Title\n> Body text\n", 1) },
    { label: "/wikilink", detail: "Internal link [[…]]", apply: applyInsert("[[", 2) },
    { label: "/math", detail: "Math block $$…$$", apply: applyInsert("$$\n\n$$", 3) },
    { label: "/footnote", detail: "Footnote [^1]", apply: applyInsert("[^1]", 4) },
  ];
  return {
    from: before.from,
    options,
    validFor: /^\/?[\w-]*$/,
  };
}

export function VaultEditor(props: VaultEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Latest props without re-creating the editor: callbacks read through refs.
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    currentCompletionItems = props.completionItems;
  }, [props.completionItems]);

  useEffect(() => {
    openLinkHandler = props.onOpenLink;
    return () => {
      openLinkHandler = null;
    };
  }, [props.onOpenLink]);

  useEffect(() => {
    if (!hostRef.current) return;
    const themeComp = new Compartment();
    const languageComp = new Compartment();
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: propsRef.current.value,
        extensions: [
          highlightSpecialChars(),
          history(),
          drawSelection(),
          foldGutter(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          markdown(),
          // In-note find & replace (Ctrl+F / Ctrl+H) + selection match glow.
          search({ top: true }),
          highlightSelectionMatches(),
          autocompletion({ override: [wikilinkCompletion, slashCompletion] }),
          keymap.of([
            { key: "Mod-b", run: wrapSelection("**", "**"), preventDefault: true },
            { key: "Mod-i", run: wrapSelection("*", "*"), preventDefault: true },
            { key: "Mod-k", run: wrapMarkdownLink, preventDefault: true },
            // Enter continues lists ("- ", "1. ", "- [ ] " carry over and
            // numbers increment); outside a list it defers to the default.
            { key: "Enter", run: insertNewlineContinueMarkup },
            { key: "Tab", run: listIndent(true) },
            { key: "Shift-Tab", run: listIndent(false) },
            ...searchKeymap,
          ]),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                propsRef.current.onSave();
                return true;
              },
            },
          ]),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.lineWrapping,
          // OS spellcheck (red squiggles from the platform dictionary).
          EditorView.contentAttributes.of({ spellcheck: "true" }),
          // Clipboard paste / file drop of IMAGES → the parent's importer
          // (writes the bytes into vault assets, inserts the embed). A pasted
          // URL over a selection becomes a markdown link. Text paste/drop
          // otherwise falls through to CodeMirror untouched.
          EditorView.domEventHandlers({
            paste: (event, view) => {
              const items = Array.from(event.clipboardData?.items ?? []);
              const img = items.find((i) => i.kind === "file" && i.type.startsWith("image/"));
              if (img) {
                const file = img.getAsFile();
                if (file) {
                  event.preventDefault();
                  propsRef.current.onImagePaste?.(file);
                  return true;
                }
              }
              const text = (event.clipboardData?.getData("text/plain") ?? "").trim();
              if (/^https?:\/\/\S+$/.test(text) && !view.state.selection.main.empty) {
                event.preventDefault();
                return wrapMarkdownLink(view);
              }
              return false;
            },
            drop: (event) => {
              const files = Array.from(event.dataTransfer?.files ?? []).filter((f) =>
                f.type.startsWith("image/"),
              );
              if (files.length === 0) return false;
              event.preventDefault();
              for (const file of files) propsRef.current.onImagePaste?.(file);
              return true;
            },
          }),
          themeComp.of(EditorView.theme({})),
          languageComp.of([]),
          mathBlockField,
          livePreviewDeco,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              propsRef.current.onChange(update.state.doc.toString());
              propsRef.current.onEdit();
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    propsRef.current.onViewReady?.(view);
    // Devtools handle for click/cursor debugging (same pattern as __vaultGraph).
    (window as unknown as Record<string, unknown>).__vaultEditorView = view;
    return () => {
      view.destroy();
      viewRef.current = null;
      propsRef.current.onViewReady?.(null);
    };
    // The editor is created ONCE per mount; value changes flow through
    // the sync effect below (externally loaded notes / watcher reloads).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value sync: the parent keys this component per note, so the
  // only value changes arriving here are watcher reloads of a CLEAN buffer
  // — swap the doc wholesale (selection resets, which is correct for an
  // external change).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== props.value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: props.value },
        selection: { anchor: 0 },
      });
    }
  }, [props.value]);

  return <div className="vault-editor" ref={hostRef} />;
}
