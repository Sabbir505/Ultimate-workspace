// Prompt template library (roadmap #14): reusable prompt bodies with
// `{{variable}}` placeholders, managed here and insertable from the composer.
// Generalizes QuickActions into text templates the chat can reuse.
import { useCallback, useEffect, useState } from "react";
import {
  listPromptTemplates,
  savePromptTemplates,
  templateVariables,
  type PromptTemplate,
} from "../../lib/ipc";

export function PromptTemplatesPanel() {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Draft editor state.
  const [draftName, setDraftName] = useState("");
  const [draftTrigger, setDraftTrigger] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const loaded = await listPromptTemplates();
    // Deduplicate persisted entries that share the same (name, trigger, body)
    // — historical appends with no dedup guard could leave duplicates behind.
    const seen = new Set<string>();
    const deduped = loaded.filter((t) => {
      const key = `${t.name}│${t.trigger ?? ""}│${t.body}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    setTemplates(deduped);
    if (deduped.length !== loaded.length) {
      void savePromptTemplates(deduped);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const persist = async (next: PromptTemplate[]) => {
    setTemplates(next);
    try {
      await savePromptTemplates(next);
      setError(null);
    } catch (err) {
      setError(`Failed to save templates: ${String(err)}`);
      setTemplates(await listPromptTemplates());
    }
  };

  const saveDraft = async () => {
    if (!draftName.trim() || !draftBody.trim()) {
      setError("Name and prompt body are required.");
      return;
    }
    setBusy(true);
    const draftVars = templateVariables(draftBody);
    const existing = templates.find((t) => t.id === editingId);
    const next: PromptTemplate = {
      id: editingId ?? `pt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      name: draftName.trim(),
      trigger: draftTrigger.trim().replace(/^\//, "") || undefined,
      body: draftBody,
      createdAt: existing?.createdAt ?? Math.floor(Date.now() / 1000),
    };
    const vars = draftVars.length
      ? ` with ${draftVars.map((v) => `{{${v}}}`).join(", ")}`
      : "";
    try {
      if (editingId) {
        await persist(templates.map((t) => (t.id === editingId ? next : t)));
        setNote(`Updated template "${next.name}"${vars}.`);
      } else {
        // Prevent duplicate prompts by replacing any exact same-name/trigger/body
        // template, and also collapsing same name+trigger variants to a single
        // latest entry.
        const sameKey = templates.filter(
          (t) => !(t.name === next.name && (t.trigger ?? "") === (next.trigger ?? "") && t.body === next.body),
        );
        const sameSlot = sameKey.filter(
          (t) => !(t.name === next.name && (t.trigger ?? "") === (next.trigger ?? "")),
        );
        await persist([...sameSlot, next]);
        setNote(`Added template "${next.name}"${vars}.`);
      }
      setEditingId(null);
      setDraftName(""); setDraftTrigger(""); setDraftBody("");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (t: PromptTemplate) => {
    setEditingId(t.id);
    setDraftName(t.name);
    setDraftTrigger(t.trigger ?? "");
    setDraftBody(t.body);
    setError(null);
  };

  const removeTemplate = async (id: string) => {
    await persist(templates.filter((t) => t.id !== id));
  };

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h3>Prompt templates</h3>
      </div>

      <p className="settings-note">
        Reusable prompts with <code>{"{{variable}}"}</code> placeholders. In the composer,
        type a <code>/</code> to list templates (and skills); the templates are also
        usable from the composer's prompt button. Variables are filled before the
        prompt is sent.
      </p>

      {note && <div className="settings-note">{note}</div>}
      {error && (
        <div className="settings-note" style={{ color: "var(--danger, #f85149)" }}>
          {error}
        </div>
      )}

      {/* Template editor */}
      <div className="settings-form-row" style={{ alignItems: "flex-start" }}>
        <label className="settings-form-label">{editingId ? "Edit" : "New"} template</label>
        <div className="settings-form-control" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
          <input
            type="text"
            value={draftName}
            placeholder="Template name"
            onChange={(e) => setDraftName(e.target.value)}
          />
          <input
            type="text"
            value={draftTrigger}
            placeholder="Slash trigger (optional, e.g. review)"
            onChange={(e) => setDraftTrigger(e.target.value)}
          />
          <textarea
            rows={5}
            value={draftBody}
            placeholder={"Prompt body… use {{variable}} for inputs, e.g.\nGive me a {{type}} review of {{code}}"}
            onChange={(e) => setDraftBody(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button className="primary" onClick={() => void saveDraft()} disabled={busy}>
              {editingId ? "Save changes" : "Add template"}
            </button>
            {editingId && (
              <button className="ghost" onClick={() => { setEditingId(null); setDraftName(""); setDraftTrigger(""); setDraftBody(""); }}>
                Cancel
              </button>
            )}
          </div>
          {templateVariables(draftBody).length > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              Variables: {templateVariables(draftBody).map((v) => `{{${v}}}`).join(", ")}
            </div>
          )}
        </div>
      </div>

      {/* Existing templates */}
      {templates.length === 0 ? (
        <div className="empty-reserved">
          <div className="empty-text">No templates yet. Add one above.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          {templates.map((t) => (
            <div key={t.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm, 6px)" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  {t.name}
                  {t.trigger && <span style={{ color: "var(--text-dim)", fontWeight: 400 }}> · /{t.trigger}</span>}
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.body}
                </div>
              </div>
              {templateVariables(t.body).length > 0 && (
                <span style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
                  {templateVariables(t.body).map((v) => `{{${v}}}`).join(" ")}
                </span>
              )}
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <button className="ghost" onClick={() => startEdit(t)}>Edit</button>
                <button className="ghost" style={{ color: "var(--danger, #f85149)" }} onClick={() => void removeTemplate(t.id)}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
