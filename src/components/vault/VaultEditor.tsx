// CodeMirror 6 note editor — the vault's editing surface.
//
// CM6 (the editor Obsidian itself builds on) keeps the document TEXT
// untouched and renders markdown syntax via decorations — the architecture
// that makes byte-perfect round-tripping possible. v1 ships: markdown
// syntax highlighting, wikilink highlighting + click-to-open, `[[`
// autocompletion over the vault's notes, autosave via the store's debounce,
// and Mod+S for an immediate save. Full Obsidian-style live preview
// (syntax hiding per line) is the documented next step — the decoration
// plugin below is the seam it plugs into.

import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, highlightSpecialChars, drawSelection, ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle, foldGutter } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";

export interface VaultEditorProps {
  value: string;
  onChange: (text: string) => void;
  /** Debounced save (store.scheduleSave) — fired on every change. */
  onEdit: () => void;
  /** Immediate save (Mod+S). */
  onSave: () => void;
  /** Note basenames + aliases for `[[` completion. */
  completionItems: { label: string; detail: string }[];
  onOpenLink: (target: string, subpath: string | null) => void;
}

// Module-level bridge so the completion source reads the CURRENT note list
// without rebuilding the extension on every tree change.
let currentCompletionItems: { label: string; detail: string }[] = [];
let openLinkHandler: ((target: string, subpath: string | null) => void) | null = null;

function wikilinkCompletion(context: CompletionContext) {
  const before = context.matchBefore(/\[\[([^\]\n]*)$/);
  if (!before) return null;
  const partial = before.text.slice(2);
  const options = currentCompletionItems.map((item) => ({
    label: item.label,
    detail: item.detail,
    type: "text",
    apply: `[[${item.label}]]`,
  }));
  const filtered = partial
    ? options.filter((o) => o.label.toLowerCase().includes(partial.toLowerCase()))
    : options;
  return {
    from: before.from + 2,
    options: filtered.slice(0, 30),
    validFor: /^[^\]\n]*$/,
  };
}

/** Highlight + click-to-open for `[[wikilinks]]` (decoration-only: the
 *  document text is never rewritten — the live-preview contract). */
const wikilinkDeco = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    view: EditorView;
    constructor(view: EditorView) {
      this.view = view;
      this.decorations = this.buildDeco(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDeco(update.view);
      }
    }
    buildDeco(view: EditorView): DecorationSet {
      const widgets: Array<{ from: number; to: number; deco: Decoration }> = [];
      const re = /\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g;
      for (const range of view.visibleRanges) {
        for (let pos = range.from; pos <= range.to; ) {
          const line = view.state.doc.lineAt(pos);
          let m: RegExpExecArray | null;
          while ((m = re.exec(line.text))) {
            const start = line.from + m.index;
            const end = start + m[0].length;
            widgets.push({
              from: start,
              to: end,
              deco: Decoration.mark({
                class: "cm-vault-wikilink",
                attributes: { title: m[1].trim() },
              }),
            });
          }
          pos = line.to + 1;
        }
      }
      widgets.sort((a, b) => a.from - b.from);
      return Decoration.set(widgets.map((w) => w.deco.range(w.from, w.to)));
    }
  },
  {
    eventHandlers: {
      mousedown(event) {
        const target = event.target as HTMLElement;
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
    },
  },
);

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
          autocompletion({ override: [wikilinkCompletion] }),
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
          themeComp.of(EditorView.theme({})),
          languageComp.of([]),
          wikilinkDeco,
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
    return () => {
      view.destroy();
      viewRef.current = null;
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
