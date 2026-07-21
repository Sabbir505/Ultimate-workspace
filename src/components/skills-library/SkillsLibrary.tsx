// Skills & Loops Library. Three sections:
//  - Skills: SKILL.md files discovered in Claude Code's and Kimi Code's
//    on-disk skill directories (~/.claude/skills, ~/.agents/skills).
//  - Loops: same convention under loops/ — empty until a harness or the user
//    creates one.
//  - Prompt templates: Conduit's own DB-backed skills (§7.15) that expand when
//    typed as /slash-commands into any pane.
// Installed skills/loops are editable in place; creating one writes it to
// BOTH harness directories so either CLI discovers it by its slash name.
import { useCallback, useEffect, useState } from "react";
import {
  createInstalledSkill,
  deleteInstalledSkill,
  listInstalledLoops,
  listInstalledSkills,
  readInstalledSkill,
  saveInstalledSkill,
} from "../../lib/ipc";
import { useProjectsStore } from "../../state/projects";
import { useSkillsStore } from "../../state/skills";
import { useUiStore } from "../../state/ui";
import type { InstalledSkill, Skill } from "../../types";

type Tab = "skills" | "loops" | "templates";

export function SkillsLibrary() {
  const setActiveView = useUiStore((s) => s.setActiveView);
  const [tab, setTab] = useState<Tab>("skills");

  return (
    <div className="view-overlay modal-centered" onPointerDown={(e) => e.target === e.currentTarget && setActiveView("grid")}>
      <div className="view-panel">
        <div className="view-header">
          <h2>Skills &amp; Loops Library</h2>
          <button className="ghost" onClick={() => setActiveView("grid")}>
            ✕
          </button>
        </div>
        <div className="view-body">
          <div className="tab-bar">
            {(
              [
                ["skills", "Skills"],
                ["loops", "Loops"],
                ["templates", "Prompt templates"],
              ] as Array<[Tab, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                className={`tab${tab === key ? " active" : ""}`}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {/* Fixed-height container shared by every tab so the modal never
              resizes when switching between Skills / Loops / Prompt templates.
              Each tab fills this box; its own content scrolls internally. */}
          <div className="library-panel">
            {tab === "skills" && <InstalledPanel kind="skill" />}
            {tab === "loops" && <InstalledPanel kind="loop" />}
            {tab === "templates" && <TemplatesPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}

function InstalledPanel({ kind }: { kind: "skill" | "loop" }) {
  const [items, setItems] = useState<InstalledSkill[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<InstalledSkill | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const list =
      (await (kind === "skill" ? listInstalledSkills() : listInstalledLoops())) ?? [];
    setItems(list);
  }, [kind]);

  useEffect(() => {
    setSelected(null);
    setContent("");
    setDirty(false);
    setCreating(false);
    void reload();
  }, [reload]);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 2000);
  };

  const openItem = async (item: InstalledSkill) => {
    setSelected(item);
    setCreating(false);
    const body = await readInstalledSkill(item.slug, kind);
    setContent(body ?? "");
    setDirty(false);
  };

  const save = async () => {
    if (!selected) return;
    await saveInstalledSkill(selected.slug, kind, content);
    setDirty(false);
    flash("Saved to disk");
    void reload();
  };

  const create = async () => {
    if (!newName.trim() || !content.trim()) return;
    const created = await createInstalledSkill(newName.trim(), kind, content);
    if (created) {
      setCreating(false);
      setNewName("");
      flash(`Created in both harnesses as /${created.slug}`);
      await reload();
      void openItem(created);
    }
  };

  const remove = async (item: InstalledSkill) => {
    await deleteInstalledSkill(item.slug, kind);
    if (selected?.slug === item.slug) {
      setSelected(null);
      setContent("");
    }
    void reload();
  };

  const filtered = items.filter(
    (i) =>
      i.name.toLowerCase().includes(query.toLowerCase()) ||
      i.slug.includes(query.toLowerCase()) ||
      i.description.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="installed-panel">
      <div className="installed-list">
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <input
            style={{ flex: 1 }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${kind}s…`}
          />
          <button
            className="primary"
            onClick={() => {
              setCreating(true);
              setSelected(null);
              setContent("");
              setNewName("");
            }}
          >
            + New {kind}
          </button>
        </div>
        {items.length === 0 && (
          <div className="empty-reserved small" style={{ margin: "8px 0" }}>
            <span className="empty-icon">{kind === "loop" ? "🔁" : "✦"}</span>
            <span className="empty-text">
              {kind === "loop"
                ? "No loops found on either harness yet. Create one — it will be written to both Claude Code and Kimi Code."
                : "No installed skills found."}
            </span>
          </div>
        )}
        <div className="installed-items">
          {filtered.map((item) => (
            <div
              key={item.slug}
              className={`installed-item${selected?.slug === item.slug ? " active" : ""}`}
              onClick={() => void openItem(item)}
            >
              <div className="installed-item-head">
                <span className="mono">/{item.slug}</span>
                <span className={`source-badge ${item.source}`}>{item.source}</span>
              </div>
              {item.description && <div className="installed-item-desc">{item.description}</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="installed-editor">
        {notice && <p className="estimate-note">{notice}</p>}
        {creating && (
          <>
            <h3>New {kind}</h3>
            <div className="form-row">
              <label>Name</label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={kind === "loop" ? "nightly-review" : "audit-ai-slop"}
              />
            </div>
            <p className="estimate-note">
              Written to both Claude Code and Kimi Code — either harness can invoke it as{" "}
              <code>/{newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "…"}</code>
            </p>
            <textarea
              rows={14}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={kind === "loop" ? "Loop instructions…" : "Skill body (markdown)…"}
            />
            <div className="form-row" style={{ marginTop: 8 }}>
              <button className="primary" onClick={() => void create()} disabled={!newName.trim() || !content.trim()}>
                Create in both harnesses
              </button>
              <button onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </>
        )}
        {!creating && selected && (
          <>
            <div className="installed-item-head" style={{ marginBottom: 8 }}>
              <h3 className="mono" style={{ margin: 0, flex: 1 }}>
                /{selected.slug}
              </h3>
              <button className="danger" onClick={() => void remove(selected)}>
                Delete
              </button>
            </div>
            <textarea
              rows={16}
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
            />
            <div className="form-row" style={{ marginTop: 8 }}>
              <button className="primary" onClick={() => void save()} disabled={!dirty}>
                Save
              </button>
            </div>
          </>
        )}
        {!creating && !selected && (
          <p className="estimate-note">
            Select a {kind} to view and edit it, or create a new one. Source badges show which
            harness has it installed: <span className="source-badge claude">claude</span>{" "}
            <span className="source-badge kimi">kimi</span> <span className="source-badge both">both</span>
          </p>
        )}
      </div>
    </div>
  );
}

// ---- Existing Conduit prompt-template CRUD (§7.15) ----

function TemplatesPanel() {
  const skills = useSkillsStore((s) => s.skills);
  const create = useSkillsStore((s) => s.create);
  const update = useSkillsStore((s) => s.update);
  const remove = useSkillsStore((s) => s.remove);
  const projects = useProjectsStore((s) => s.projects);

  const [editing, setEditing] = useState<Skill | null>(null);
  const [name, setName] = useState("");
  const [slash, setSlash] = useState("");
  const [content, setContent] = useState("");
  const [scope, setScope] = useState("global");

  const reset = () => {
    setEditing(null);
    setName("");
    setSlash("");
    setContent("");
    setScope("global");
  };

  const startEdit = (skill: Skill) => {
    setEditing(skill);
    setName(skill.name);
    setSlash(skill.slashCommand);
    setContent(skill.content);
    setScope(skill.scope);
  };

  const save = async () => {
    const normalizedSlash = slash.trim().startsWith("/") ? slash.trim() : `/${slash.trim()}`;
    if (!name.trim() || normalizedSlash === "/" || !content.trim()) return;
    if (editing) {
      await update(editing.id, name.trim(), normalizedSlash, content);
    } else {
      await create(name.trim(), normalizedSlash, content, scope);
      // Also install as a real skill in both harness directories so Claude
      // Code and Kimi Code can invoke the same slash command natively.
      await createInstalledSkill(name.trim(), "skill", content);
      setInstallNote(`Also installed as /${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")} in Claude Code & Kimi Code`);
      window.setTimeout(() => setInstallNote(null), 3000);
    }
    reset();
  };

  const [installNote, setInstallNote] = useState<string | null>(null);

  return (
    <>
      <section>
        <h3>Saved templates</h3>
        <p className="estimate-note">
          Type a slash command (e.g. <code>/audit</code>) into any pane to expand it into the full
          template before sending. These are Conduit-side templates, separate from harness skills.
        </p>
        {skills.length === 0 && (
          <div className="empty-reserved small">
            <span className="empty-icon">✦</span>
            <span className="empty-text">No templates yet. Create one below — it installs as a slash command in every pane.</span>
          </div>
        )}
        {skills.length > 0 && (
          <table className="kv">
            <thead>
              <tr>
                <th>Name</th>
                <th>Command</th>
                <th>Scope</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => (
                <tr key={skill.id}>
                  <td>{skill.name}</td>
                  <td className="mono">{skill.slashCommand}</td>
                  <td>
                    {skill.scope === "global"
                      ? "global"
                      : (projects.find((p) => p.id === skill.scope)?.name ?? "project")}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button onClick={() => startEdit(skill)}>Edit</button>{" "}
                    <button className="danger" onClick={() => void remove(skill.id)}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3>{editing ? `Edit “${editing.name}”` : "New template"}</h3>
        {installNote && <p className="estimate-note">✓ {installNote}</p>}
        <div className="form-row">
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Audit AI slop" />
        </div>
        <div className="form-row">
          <label>Slash command</label>
          <input
            className="mono"
            value={slash}
            onChange={(e) => setSlash(e.target.value)}
            placeholder="/audit-ai-slop"
          />
        </div>
        {!editing && (
          <div className="form-row">
            <label>Scope</label>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="global">Global (all projects)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="form-row" style={{ alignItems: "flex-start" }}>
          <label>Template</label>
          <textarea
            rows={6}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="The full prompt text sent to the harness…"
          />
        </div>
        <div className="form-row">
          <button className="primary" onClick={() => void save()} disabled={!name.trim() || !content.trim()}>
            {editing ? "Save changes" : "Create template"}
          </button>
          {editing && <button onClick={reset}>Cancel</button>}
        </div>
      </section>
    </>
  );
}
