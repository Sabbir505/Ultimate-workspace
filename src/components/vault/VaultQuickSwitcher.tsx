// Vault quick switcher (Ctrl/Cmd+P inside the Vault view) + the search and
// tags rails + the note's right rail (backlinks / outline). All read from
// the store; opening a result is the same openNote path a tree click uses.

import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Hash, Link2, ListTree, Search } from "lucide-react";
import { useVaultStore } from "../../state/vault";
import { basenameOf, snippetToPlain, stemOf } from "../../lib/vaultLinks";
import type { VaultSearchHit } from "../../lib/ipc";

/** Lightweight subsequence scorer for the switcher (same feel as the
 *  command palette's fuzzy.ts, local to avoid cross-surface coupling). */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      streak += 1;
      score += 1 + streak; // consecutive matches compound
      if (ti === 0 || /[\s/_-]/.test(t[ti - 1])) score += 3; // prefix bonus
      qi += 1;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : 0;
}

export function VaultQuickSwitcher() {
  const open = useVaultStore((s) => s.switcherOpen);
  const setOpen = useVaultStore((s) => s.setSwitcherOpen);
  const tree = useVaultStore((s) => s.tree);
  const openNote = useVaultStore((s) => s.openNote);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const notes = useMemo(() => {
    const out: { path: string; name: string }[] = [];
    const walk = (nodes: typeof tree) => {
      for (const n of nodes) {
        if (n.kind === "note") out.push({ path: n.path, name: n.name });
        walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);

  const results = useMemo(() => {
    const scored = notes
      .map((n) => ({ ...n, score: Math.max(fuzzyScore(query, n.name), fuzzyScore(query, n.path) * 0.8) }))
      .filter((n) => n.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);
    return scored;
  }, [notes, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  if (!open) return null;

  const commit = (path: string) => {
    void openNote(path);
    setOpen(false);
  };

  return (
    <div className="vault-switcher-overlay" onClick={() => setOpen(false)}>
      <div className="vault-switcher" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="vault-switcher-input"
          placeholder="Jump to a note… (Enter creates nothing — use + for new notes)"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, results.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            }
            if (e.key === "Enter" && results[cursor]) {
              commit(results[cursor].path);
            }
          }}
        />
        <div className="vault-switcher-results">
          {results.map((r, i) => (
            <button
              key={r.path}
              className={`vault-switcher-row${i === cursor ? " active" : ""}`}
              onClick={() => commit(r.path)}
              onMouseEnter={() => setCursor(i)}
            >
              <FileText size={14} />
              <span className="vault-switcher-name">{basenameOf(r.name)}</span>
              <span className="vault-switcher-path">{r.path}</span>
            </button>
          ))}
          {results.length === 0 && (
            <div className="vault-switcher-empty">No matching notes.</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function VaultSearchPanel() {
  const query = useVaultStore((s) => s.searchQuery);
  const setQuery = useVaultStore((s) => s.setSearchQuery);
  const hits = useVaultStore((s) => s.searchHits);
  const loading = useVaultStore((s) => s.searchLoading);
  const openNote = useVaultStore((s) => s.openNote);

  const renderHit = (hit: VaultSearchHit) => (
    <button key={hit.path} className="vault-search-hit" onClick={() => void openNote(hit.path)}>
      <FileText size={13} />
      <span className="vault-search-hit-title">{hit.title ?? hit.basename}</span>
      <span className="vault-search-hit-path">{hit.path}</span>
      <span className="vault-search-hit-snippet">{snippetToPlain(hit.snippet).slice(0, 140)}</span>
    </button>
  );

  return (
    <div className="vault-search-panel">
      <div className="vault-rail-search-box">
        <Search size={13} />
        <input
          autoFocus
          placeholder='Search… (tag:x, path:y, "phrase", -exclude)'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="vault-search-hits">
        {loading ? <div className="vault-rail-hint">Searching…</div> : null}
        {!loading && query.trim() === "" ? (
          <div className="vault-rail-hint">
            Full-text search across every note. Results rank like Obsidian: matches in names and
            headings float up.
          </div>
        ) : null}
        {!loading && query.trim() !== "" && hits.length === 0 ? (
          <div className="vault-rail-hint">No matches.</div>
        ) : null}
        {hits.map(renderHit)}
      </div>
    </div>
  );
}

export function VaultTagsPanel() {
  const tags = useVaultStore((s) => s.tags);
  const setQuery = useVaultStore((s) => s.setSearchQuery);
  const setRail = useVaultStore((s) => s.setRail);
  if (tags.length === 0) {
    return <div className="vault-rail-hint">No tags yet — add #tags in notes or a tags: frontmatter list.</div>;
  }
  return (
    <div className="vault-tags-panel">
      {tags.map((t) => (
        <button
          key={t.tag}
          className="vault-tag-row"
          onClick={() => {
            setQuery(`tag:${t.tag}`);
            setRail("search");
          }}
        >
          <Hash size={12} />
          <span>{t.tag}</span>
          <span className="vault-tag-count">{t.count}</span>
        </button>
      ))}
    </div>
  );
}

export function VaultNoteRail() {
  const meta = useVaultStore((s) => s.meta);
  const activePath = useVaultStore((s) => s.activePath);
  const openNote = useVaultStore((s) => s.openNote);
  const savedContent = useVaultStore((s) => s.savedContent);
  const content = useVaultStore((s) => s.content);
  if (!activePath || !meta) {
    return <div className="vault-rail-hint">Open a note to see its backlinks and outline.</div>;
  }
  const headings = meta.headings;
  const outgoing = meta.outgoing.slice(0, 30);
  const aliases = meta.aliases;
  return (
    <div className="vault-note-rail">
      <section className="vault-rail-section">
        <h4><ListTree size={12} /> Outline</h4>
        {headings.length === 0 ? (
          <div className="vault-rail-hint">No headings.</div>
        ) : (
          <div className="vault-outline">
            {headings.map(([level, text, line], i) => (
              <button
                key={`${line}-${i}`}
                className="vault-outline-row"
                style={{ paddingLeft: (level - 1) * 10 }}
                title={text}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("vault:scroll-text", { detail: { text } }));
                }}
              >
                {text}
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="vault-rail-section">
        <h4><Link2 size={12} /> Backlinks ({meta.backlinks.length})</h4>
        {meta.backlinks.length === 0 ? (
          <div className="vault-rail-hint">No notes link here yet.</div>
        ) : (
          meta.backlinks.map((m, i) => (
            <button key={`${m.src}-${m.line}-${i}`} className="vault-backlink-row" onClick={() => void openNote(m.src)}>
              <span className="vault-backlink-src">{stemOf(basenameOf(m.src))}</span>
              <span className="vault-backlink-raw">[[{m.raw}]]</span>
            </button>
          ))
        )}
      </section>
      {meta.unresolved_mentions.length > 0 ? (
        <section className="vault-rail-section">
          <h4>Unresolved links ({meta.unresolved_mentions.length})</h4>
          {meta.unresolved_mentions.slice(0, 10).map((m, i) => (
            <div key={i} className="vault-backlink-row static">
              <span className="vault-backlink-src">{m.raw}</span>
              <span className="vault-backlink-hint">create with +</span>
            </div>
          ))}
        </section>
      ) : null}
      <section className="vault-rail-section">
        <h4>Outgoing ({outgoing.length})</h4>
        {outgoing.length === 0 ? (
          <div className="vault-rail-hint">No outgoing links.</div>
        ) : (
          outgoing.map((m, i) => (
            <button
              key={`${m.raw}-${m.line}-${i}`}
              className="vault-backlink-row"
              onClick={() => m.src !== activePath && void openNote(m.src)}
            >
              <span className="vault-backlink-src">[[{m.raw}]]</span>
            </button>
          ))
        )}
      </section>
      {aliases.length > 0 ? (
        <section className="vault-rail-section">
          <h4>Aliases</h4>
          <div className="vault-rail-hint">{aliases.join(", ")}</div>
        </section>
      ) : null}
      <section className="vault-rail-section">
        <h4>Stats</h4>
        <div className="vault-rail-hint">
          {meta.word_count} words{content !== savedContent ? " · unsaved edits" : ""}
        </div>
      </section>
    </div>
  );
}
