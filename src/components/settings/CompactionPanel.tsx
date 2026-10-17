// Settings → Compaction. One home for every context-compaction engine, moved
// out of Local Models: folding long context is not a local-model concern — it
// applies to cloud sessions and idle threads too. Three independent groups,
// each with its own trigger:
//
//   - Idle threads   — the background sweep (chat/idle_compact.rs) summarizes
//                      long chats the user stepped away from, before the next
//                      turn re-sends them.
//   - Cloud & API    — pre-send + overflow-retry compaction
//                      (chat/cloud_compact.rs) as a request nears the window.
//   - Local (GGUF)   — small-window compaction via the running sidecar
//                      (chat/compaction.rs).
//
// Every field mirrors a Rust loader default/clamp; the store setters clamp to
// the same bands, pinned by src/test/compactionSettings.test.ts so the UI and
// the backend cannot drift.
import { useSettingsStore } from "../../state/settings";
import { GlassSelect } from "../common/GlassSelect";
import { ToggleSwitch } from "./ToggleSwitch";

/** A labeled number input in the compaction grids. Integer unless `allowFloat`
 *  (the thresholds are fractions; everything else counts). */
function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max?: number;
  step: number;
  disabled?: boolean;
  allowFloat?: boolean;
  hint: string;
  onChange: (value: number) => void;
}) {
  const { label, value, min, max, step, disabled, allowFloat, hint, onChange } = props;
  return (
    <label className="compaction-field">
      <span className="compaction-field-label">{label}</span>
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(allowFloat ? Number(e.target.value) : Math.floor(Number(e.target.value)))}
      />
      <span className="compaction-field-hint">{hint}</span>
    </label>
  );
}

/** Settings → Compaction panel. */
export function CompactionPanel() {
  return (
    <>
      <div className="panel-head">
        <h3>Compaction</h3>
        <span className="panel-count">Folding long context into summaries</span>
      </div>

      <div className="settings-section">
        <p className="settings-section-hint">
          Condenses older turns into a running summary so long conversations stay
          workable. Three independent triggers, each on safe defaults.
        </p>
      </div>

      <IdleCompactionSection />
      <CloudCompactionSection />
      <LocalCompactionSection />
    </>
  );
}

/** Idle threads: the background sweep for chats the user has stepped away from. */
function IdleCompactionSection() {
  const enabled = useSettingsStore((s) => s.idleCompactionEnabled);
  const minutes = useSettingsStore((s) => s.idleCompactionMinutes);
  const minTokens = useSettingsStore((s) => s.idleCompactionMinTokens);
  const maxPerPass = useSettingsStore((s) => s.idleCompactionMaxPerPass);
  const setEnabled = useSettingsStore((s) => s.setIdleCompactionEnabled);
  const setMinutes = useSettingsStore((s) => s.setIdleCompactionMinutes);
  const setMinTokens = useSettingsStore((s) => s.setIdleCompactionMinTokens);
  const setMaxPerPass = useSettingsStore((s) => s.setIdleCompactionMaxPerPass);

  return (
    <div className="settings-section">
      <div className="settings-section-title">Idle threads</div>
      <p className="settings-section-hint">
        Summarizes the older turns of long chats in the background while you're
        away, so the next message sends a small context. CLI harnesses manage
        their own context.
      </p>

      <div className="settings-toggle-row">
        <div className="settings-toggle-label">
          <span className="settings-toggle-name">Compact long idle threads</span>
          <span className="settings-toggle-desc">
            Scans once a minute; acts only after a thread is idle past the time
            below and over the token floor.
          </span>
        </div>
        <ToggleSwitch id="idle-compaction-enabled" checked={enabled} onChange={setEnabled} />
      </div>

      <div className={`compaction-field-grid${enabled ? "" : " is-disabled"}`}>
        <NumberField
          label="Idle time (minutes)"
          value={minutes}
          min={5}
          max={1440}
          step={5}
          disabled={!enabled}
          onChange={setMinutes}
          hint="Wait at least the provider's prompt-cache lifetime (default 60)."
        />
        <NumberField
          label="Minimum tokens"
          value={minTokens}
          min={1000}
          max={5000000}
          step={10000}
          disabled={!enabled}
          onChange={setMinTokens}
          hint="Only threads above this size are compacted (default 200,000)."
        />
        <NumberField
          label="Max per sweep"
          value={maxPerPass}
          min={1}
          max={50}
          step={1}
          disabled={!enabled}
          onChange={setMaxPerPass}
          hint="Cost cap: threads compacted per minute-long sweep (default 3)."
        />
      </div>
    </div>
  );
}

/** Cloud & API chats: pre-send + overflow-retry compaction. */
function CloudCompactionSection() {
  const enabled = useSettingsStore((s) => s.cloudCompactionEnabled);
  const threshold = useSettingsStore((s) => s.cloudCompactionThreshold);
  const pin = useSettingsStore((s) => s.cloudPinExchanges);
  const contextLimit = useSettingsStore((s) => s.cloudContextLimit);
  const setEnabled = useSettingsStore((s) => s.setCloudCompactionEnabled);
  const setThreshold = useSettingsStore((s) => s.setCloudCompactionThreshold);
  const setPin = useSettingsStore((s) => s.setCloudPinExchanges);
  const setContextLimit = useSettingsStore((s) => s.setCloudContextLimit);

  return (
    <div className="settings-section">
      <div className="settings-section-title">Cloud &amp; API chats</div>
      <p className="settings-section-hint">
        Summarizes older turns as a request approaches the model's window.
        Overflow rejections are compacted and retried regardless of this switch.
      </p>

      <div className="settings-toggle-row">
        <div className="settings-toggle-label">
          <span className="settings-toggle-name">Compact cloud conversations</span>
          <span className="settings-toggle-desc">
            On by default; the session's own provider writes the summary.
          </span>
        </div>
        <ToggleSwitch id="cloud-compaction-enabled" checked={enabled} onChange={setEnabled} />
      </div>

      <div className={`compaction-field-grid${enabled ? "" : " is-disabled"}`}>
        <NumberField
          label="Threshold"
          value={threshold}
          min={0.25}
          max={0.99}
          step={0.05}
          disabled={!enabled}
          allowFloat
          onChange={setThreshold}
          hint="Fraction of the window before folding (default 0.75)."
        />
        <NumberField
          label="Pin exchanges"
          value={pin}
          min={1}
          max={50}
          step={1}
          disabled={!enabled}
          onChange={setPin}
          hint="Recent user+assistant pairs kept verbatim (default 6)."
        />
        <NumberField
          label="Context limit (tokens)"
          value={contextLimit}
          min={0}
          step={10000}
          disabled={!enabled}
          onChange={setContextLimit}
          hint="Cap the effective window below the model's own; 0 = auto."
        />
      </div>
    </div>
  );
}

/** Local models (GGUF): small-window compaction via the running sidecar. */
function LocalCompactionSection() {
  const threshold = useSettingsStore((s) => s.localCompactionThreshold);
  const pin = useSettingsStore((s) => s.localPinExchanges);
  const summarizer = useSettingsStore((s) => s.localCompactionSummarizer);
  const rebuildFromRaw = useSettingsStore((s) => s.localCompactionRebuildFromRaw);
  const setThreshold = useSettingsStore((s) => s.setLocalCompactionThreshold);
  const setPin = useSettingsStore((s) => s.setLocalPinExchanges);
  const setSummarizer = useSettingsStore((s) => s.setLocalCompactionSummarizer);
  const setRebuildFromRaw = useSettingsStore((s) => s.setLocalCompactionRebuildFromRaw);

  return (
    <div className="settings-section">
      <div className="settings-section-title">Local models (GGUF)</div>
      <p className="settings-section-hint">
        Small-window models compact earlier and more aggressively. The summarizer
        can use a configured cloud key.
      </p>

      <div className="compaction-field-grid">
        <div className="compaction-field">
          <span className="compaction-field-label">Summarizer</span>
          <GlassSelect<string>
            ariaLabel="Compaction summarizer"
            value={summarizer}
            options={[
              { value: "sidecar", label: "Sidecar model (default)" },
              { value: "cloud", label: "Cloud provider (needs an API key)" },
            ]}
            onChange={(v) => setSummarizer(v === "cloud" ? "cloud" : "sidecar")}
          />
          <span className="compaction-field-hint">Which model writes the summary.</span>
        </div>
        <NumberField
          label="Threshold"
          value={threshold}
          min={0.25}
          max={0.99}
          step={0.05}
          allowFloat
          onChange={setThreshold}
          hint="Fraction of the small window before folding (default 0.75)."
        />
        <NumberField
          label="Pin exchanges"
          value={pin}
          min={1}
          max={50}
          step={1}
          onChange={setPin}
          hint="Recent user+assistant pairs kept verbatim (default 6)."
        />
      </div>

      <div className="settings-toggle-row" style={{ marginTop: 12 }}>
        <div className="settings-toggle-label">
          <span className="settings-toggle-name">Rebuild summaries from the original turns</span>
          <span className="settings-toggle-desc">
            Re-derives each summary from the raw turns instead of stacking
            summaries.
          </span>
        </div>
        <ToggleSwitch id="local-compaction-rebuild" checked={rebuildFromRaw} onChange={setRebuildFromRaw} />
      </div>
    </div>
  );
}
