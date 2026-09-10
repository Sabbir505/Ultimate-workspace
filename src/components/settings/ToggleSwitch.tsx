// Shared settings toggle (switch-style button). Extracted from
// SettingsView so the extracted panels can use it too.
export function ToggleSwitch({ checked, onChange, id }: { checked: boolean; onChange: (v: boolean) => void; id?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      id={id}
      className={`settings-toggle${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="settings-toggle-thumb" />
    </button>
  );
}
