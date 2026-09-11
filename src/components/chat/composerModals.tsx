// The composer's two picker modals (prompt-template insert + team broadcast),
// carved out of ChatComposer.tsx verbatim. Their STATE deliberately stays in
// ChatComposer and flows in as props: the drafts/targets survive close +
// reopen today, and hoisting the state in here would silently reset them.
import { templateVariables, fillTemplate, type PromptTemplate } from "../../lib/ipc";

export function TemplatePickerModal({
  promptTemplates,
  fillingTemplate,
  setFillingTemplate,
  fillValues,
  setFillValues,
  onClose,
  insertTemplateText,
}: {
  promptTemplates: PromptTemplate[];
  fillingTemplate: PromptTemplate | null;
  setFillingTemplate: (t: PromptTemplate | null) => void;
  fillValues: Record<string, string>;
  setFillValues: (
    f: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>),
  ) => void;
  onClose: () => void;
  insertTemplateText: (text: string) => void;
}) {
  return (
    <div className="composer-template-picker">
      <div className="composer-template-picker-head">
        <span>Insert prompt template</span>
        <button type="button" className="ghost" onClick={() => { onClose(); setFillingTemplate(null); }}>
          ✕
        </button>
      </div>
      {fillingTemplate ? (
        <div className="composer-template-fill">
          <div className="composer-template-fill-title">{fillingTemplate.name}</div>
          {templateVariables(fillingTemplate.body).map((v) => (
            <input
              key={v}
              value={fillValues[v] ?? ""}
              placeholder={`{{${v}}}`}
              onChange={(e) => setFillValues((f) => ({ ...f, [v]: e.target.value }))}
              autoFocus={v === templateVariables(fillingTemplate.body)[0]}
            />
          ))}
          <div className="composer-template-fill-actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                const filled = fillTemplate(fillingTemplate.body, fillValues);
                insertTemplateText(filled);
                onClose();
                setFillingTemplate(null);
                setFillValues({});
              }}
            >
              Insert
            </button>
            <button type="button" className="ghost" onClick={() => setFillingTemplate(null)}>
              Back
            </button>
          </div>
        </div>
      ) : promptTemplates.length === 0 ? (
        <div className="composer-template-empty">No templates yet — add one under Settings → Assistant → Prompt templates.</div>
      ) : (
        <div className="composer-template-list">
          {promptTemplates.map((t) => (
            <button
              key={t.id}
              type="button"
              className="composer-template-item"
              onClick={() => {
                if (templateVariables(t.body).length > 0) {
                  setFillingTemplate(t);
                  setFillValues({});
                } else {
                  insertTemplateText(t.body);
                  onClose();
                }
              }}
            >
              <span className="composer-template-item-name">{t.name}</span>
              <span className="composer-template-item-vars">
                {templateVariables(t.body).map((v) => `{{${v}}}`).join(" ")}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function BroadcastModal({
  broadcastSessions,
  broadcastTargets,
  setBroadcastTargets,
  broadcastText,
  setBroadcastText,
  broadcastToSessions,
  onClose,
}: {
  broadcastSessions: Array<{ id: string; title: string | null }>;
  broadcastTargets: Record<string, boolean>;
  setBroadcastTargets: (
    t: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>),
  ) => void;
  broadcastText: string;
  setBroadcastText: (t: string) => void;
  broadcastToSessions: (ids: string[], text: string) => Promise<unknown>;
  onClose: () => void;
}) {
  return (
    <div className="composer-template-picker">
      <div className="composer-template-picker-head">
        <span>Broadcast to chats</span>
        <button type="button" className="ghost" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="composer-broadcast-list">
        {broadcastSessions.map((s) => (
          <label key={s.id} className="composer-broadcast-item">
            <input
              type="checkbox"
              checked={!!broadcastTargets[s.id]}
              onChange={(e) =>
                setBroadcastTargets((t) => ({ ...t, [s.id]: e.target.checked }))
              }
            />
            <span className="composer-broadcast-name">{s.title || "Untitled"}</span>
          </label>
        ))}
      </div>
      <textarea
        className="composer-broadcast-text"
        rows={3}
        placeholder="Prompt to send to every selected chat…"
        value={broadcastText}
        onChange={(e) => setBroadcastText(e.target.value)}
      />
      <div className="composer-template-fill-actions">
        <button
          type="button"
          className="primary"
          disabled={
            !broadcastText.trim() ||
            !Object.values(broadcastTargets).some(Boolean)
          }
          onClick={() => {
            const ids = Object.entries(broadcastTargets)
              .filter(([, v]) => v)
              .map(([id]) => id);
            void broadcastToSessions(ids, broadcastText.trim());
            onClose();
            setBroadcastText("");
            setBroadcastTargets({});
          }}
        >
          Send to {Object.values(broadcastTargets).filter(Boolean).length || 0} chat(s)
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
