// Settings → Appearance → Fonts: UI + mono font pickers. Each option chip
// previews itself in its own family; the selection persists via the settings
// store and applies instantly through the --font-ui / --font-mono root
// variables (see App.tsx + lib/fonts.ts).
import { useSettingsStore } from "../../state/settings";
import { MONO_FONT_OPTIONS, UI_FONT_OPTIONS, type FontOption } from "../../lib/fonts";

export function FontSettingsPanel() {
  const uiFont = useSettingsStore((s) => s.uiFont);
  const monoFont = useSettingsStore((s) => s.monoFont);
  const setUiFont = useSettingsStore((s) => s.setUiFont);
  const setMonoFont = useSettingsStore((s) => s.setMonoFont);

  const group = (
    title: string,
    desc: string,
    options: FontOption[],
    value: string,
    onPick: (id: string) => void,
  ) => (
    <div className="font-picker-group">
      <div className="font-picker-title">{title}</div>
      <div className="font-picker-desc">{desc}</div>
      <div className="font-option-grid">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`font-option${value === o.id ? " active" : ""}`}
            style={{ fontFamily: o.stack }}
            onClick={() => onPick(o.id)}
            title={`Switch to ${o.label}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h3>Fonts</h3>
      </div>
      {group(
        "Interface font",
        "Used across the app chrome and chat.",
        UI_FONT_OPTIONS,
        uiFont,
        setUiFont,
      )}
      {group(
        "Code & terminal font",
        "Used by code blocks, diffs and terminal panes.",
        MONO_FONT_OPTIONS,
        monoFont,
        setMonoFont,
      )}
    </div>
  );
}
