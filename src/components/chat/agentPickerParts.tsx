// Self-contained pieces of the AgentModelPicker's popup: the pane footer
// sliders (auto routing bias, harness effort, provider reasoning effort) and
// the local-row gear sub-modal. Carved out of AgentModelPicker.tsx verbatim;
// the picker's show*/guard conditions stay at the call sites.
import { createPortal } from "react-dom";
import type { LlamaOverrides } from "../../lib/ipc";
import { shortModelName } from "../../lib/modelLabel";
import { EFFORT_LABELS, HARNESS_EFFORT_COLORS, HARNESS_EFFORT_LABELS } from "./agentPickerShared";
import { SegmentedSlider } from "./SegmentedSlider";
import { LlamaAdvancedFields } from "./LlamaAdvancedFields";

/** Auto bias footer (Auto pane): Quality/Balanced/Economy as an animated
 *  slider. Rendered only when the parent's isAutoPane + setter guard holds. */
export function AutoBiasFooter({
  autoBias,
  onAutoBiasChange,
}: {
  autoBias: string | undefined;
  onAutoBiasChange: (v: string) => void;
}) {
  return (
    <>
      <div className="model-effort-divider" />
      <div className="agent-model-effort">
        <SegmentedSlider
          ariaLabel="Auto routing bias"
          value={(autoBias ?? "balanced") as "quality" | "balanced" | "economy"}
          onChange={(v) => onAutoBiasChange(v)}
          options={[
            {
              value: "economy",
              label: "Economy",
              title: "Prefer free and cheap models when they fit",
              color: "#22c55e",
            },
            {
              value: "balanced",
              label: "Balanced",
              title: "Provider preference, cost as a tiebreaker",
              color: "#3b82f6",
            },
            {
              value: "quality",
              label: "Quality",
              title: "Prefer the strongest model per provider",
              color: "#a78bfa",
            },
          ]}
        />
      </div>
    </>
  );
}

/** Harness effort SLIDER (every harness pane with tiers): persists a tier on
 *  the chat session; the backend applies it at spawn — claude `--effort`,
 *  omp/pi `--thinking`, kimi env override. "Default" passes no flag, so the
 *  CLI's own configured level stands (its tooltip names that level when the
 *  CLI publishes one). */
export function HarnessEffortFooter({
  harnessEffort,
  onHarnessEffortChange,
  paneEffort,
  tiers,
}: {
  harnessEffort: string | undefined;
  onHarnessEffortChange: ((v: string) => void) | undefined;
  paneEffort: string | null | undefined;
  tiers: string[];
}) {
  return (
    <>
      <div className="model-effort-divider" />
      <div className="agent-model-effort">
        <SegmentedSlider
          ariaLabel="Harness effort"
          value={(harnessEffort ?? "") as string}
          onChange={(v) => onHarnessEffortChange?.(v)}
          options={[
            {
              value: "",
              label: "Def",
              title: paneEffort
                ? `Use the CLI's own configured effort (currently ${paneEffort}) — no flag is passed`
                : "Use the CLI's own configured effort — no flag is passed",
              color: "var(--text-dim)",
            },
            ...tiers.map((t) => ({
              value: t,
              label: HARNESS_EFFORT_LABELS[t] ?? t,
              title: `${t} — applied at the next spawn`,
              color: HARNESS_EFFORT_COLORS[t] ?? "#ef4444",
            })),
          ]}
        />
      </div>
    </>
  );
}

/** Effort footer (provider + local panes): reasoning effort as an animated
 *  slider, strongest → provider default. */
export function ProviderEffortFooter({
  effort,
  onEffortChange,
}: {
  effort: string | undefined;
  onEffortChange: ((v: string) => void) | undefined;
}) {
  return (
    <>
      <div className="model-effort-divider" />
      <div className="agent-model-effort">
        <SegmentedSlider
          ariaLabel="Reasoning effort"
          value={(effort ?? "") as string}
          onChange={(v) => onEffortChange!(v)}
          options={[
            {
              value: "",
              label: EFFORT_LABELS[""],
              title: "Provider default reasoning effort",
              color: "var(--text-dim)",
            },
            {
              value: "low",
              label: EFFORT_LABELS.low,
              title: "Prefer low reasoning effort",
              color: "#22c55e",
            },
            {
              value: "medium",
              label: EFFORT_LABELS.medium,
              title: "Prefer medium reasoning effort",
              color: "#f59e0b",
            },
            {
              value: "high",
              label: EFFORT_LABELS.high,
              title: "Prefer high reasoning effort",
              color: "#ef4444",
            },
          ]}
        />
      </div>
    </>
  );
}

/** Advanced runtime settings SUB-MODAL — opened by a local row's gear.
 *  Portaled to <body> so the composer's stacking contexts (backdrop
 *  filters, popups) can't clip or trap it. */
export function GearSubModal({
  gearFor,
  gearDraft,
  setGearDraft,
  onClose,
  onLoadLocalModel,
  closePopup,
}: {
  gearFor: string;
  gearDraft: LlamaOverrides;
  setGearDraft: (o: LlamaOverrides) => void;
  onClose: () => void;
  onLoadLocalModel: (model: string, overrides: LlamaOverrides) => void;
  /** Also collapses the picker popup itself — the Apply is a committed pick. */
  closePopup: () => void;
}) {
  return createPortal(
    <div
      className="agent-model-gear-scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="agent-model-gear-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Advanced runtime settings — ${gearFor}`}
      >
        <div className="agent-model-gear-head">
          <span className="agent-model-gear-title" title={gearFor}>
            {shortModelName(gearFor)} — runtime settings
          </span>
          <button
            type="button"
            className="agent-model-gear-close"
            aria-label="Close advanced settings"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="agent-model-gear-body">
          <LlamaAdvancedFields overrides={gearDraft} onChange={setGearDraft} />
          <button
            type="button"
            className="model-effort-llama-apply"
            title="Persist these settings, load the model with them, and switch the chat to it"
            onClick={() => {
              onLoadLocalModel(gearFor, gearDraft);
              onClose();
              closePopup();
            }}
          >
            Load model
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
