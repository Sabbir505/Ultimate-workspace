// Shared editor for the per-model llama-server runtime overrides — the
// LM Studio ("Bionic") runtime-settings analog. One source of truth for the
// field set, used by BOTH surfaces: the settings Local Models panel (edits
// the persisted `localModels.overrides` blob directly) and the composer's
// model menu (edits a draft, applied via "Apply & reload"). State-less: the
// caller owns the object.
import type { LlamaOverrides } from "../../lib/ipc";

interface Props {
  overrides: LlamaOverrides;
  onChange: (next: LlamaOverrides) => void;
  /** "menu" = compact grid for the composer submenu (hides the ctx field —
   *  the slider right below owns context there). "panel" = full grid. */
  variant?: "panel" | "menu";
}

const KV_OPTIONS = ["", "f16", "q8_0", "q4_0"];

/** One numeric override. Empty string = auto (undefined) — typing clears. */
function NumField({
  label,
  value,
  onChange,
  step,
  title,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  step?: string | number;
  title?: string;
}) {
  return (
    <label className="llama-field" title={title}>
      <span className="llama-field-label">{label}</span>
      <input
        type="number"
        value={value ?? ""}
        placeholder="auto"
        step={step}
        title={title}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") return onChange(undefined);
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : undefined);
        }}
      />
    </label>
  );
}

export function LlamaAdvancedFields({ overrides, onChange, variant = "panel" }: Props) {
  const patch = (p: Partial<LlamaOverrides>) => onChange({ ...overrides, ...p });

  return (
    <div className={`llama-advanced llama-advanced-${variant}`}>
      <div className="llama-advanced-grid">
        <NumField label="GPU layers" title="--n-gpu-layers — how many transformer layers offload to the GPU. Auto starts from the last successful count." value={overrides.ngl} onChange={(v) => patch({ ngl: v })} />
        {variant === "panel" && (
          <NumField label="Context" title="-c — context window in tokens. Auto tiers by model size." value={overrides.ctx} onChange={(v) => patch({ ctx: v })} />
        )}
        <label className="llama-field" title="--flash-attn — faster attention + required for quantized V cache. Some builds don't support it: the model fails to start with an unrecognized-argument error. Opt-in.">
          <span className="llama-field-label">Flash Attention</span>
          <input
            type="checkbox"
            checked={overrides.flashAttn === true}
            onChange={(e) => patch({ flashAttn: e.target.checked ? true : undefined })}
          />
        </label>
        <label className="llama-field" title="--cache-type-k — KV-cache quantization. q8_0 halves KV memory, q4_0 quarters it (some quality loss). V cache follows when Flash Attention is on.">
          <span className="llama-field-label">KV cache</span>
          <select
            value={overrides.kvCache ?? ""}
            onChange={(e) => patch({ kvCache: e.target.value || undefined })}
          >
            {KV_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o === "" ? "auto (f16)" : o}
              </option>
            ))}
          </select>
        </label>
        <NumField label="Threads" title="--threads — CPU threads." value={overrides.threads} onChange={(v) => patch({ threads: v })} />
        <NumField label="Batch" title="--batch — logical batch size." value={overrides.batch} onChange={(v) => patch({ batch: v })} />
        <NumField label="uBatch" title="--ubatch — physical batch size." value={overrides.ubatch} onChange={(v) => patch({ ubatch: v })} />
        <NumField label="Parallel" title="--parallel — concurrent request slots." value={overrides.parallel} onChange={(v) => patch({ parallel: v })} />
        <NumField label="Seed" title="--seed — fixed RNG seed for reproducible sampling." value={overrides.seed} onChange={(v) => patch({ seed: v })} />
      </div>
      <div className="llama-advanced-sub">Sampling defaults (per-request values still win)</div>
      <div className="llama-advanced-grid">
        <NumField label="Temp" step="0.05" value={overrides.temp} onChange={(v) => patch({ temp: v })} />
        <NumField label="Top-p" step="0.05" value={overrides.topP} onChange={(v) => patch({ topP: v })} />
        <NumField label="Top-k" value={overrides.topK} onChange={(v) => patch({ topK: v })} />
        <NumField label="Min-p" step="0.01" value={overrides.minP} onChange={(v) => patch({ minP: v })} />
        <NumField label="Repeat penalty" step="0.05" value={overrides.repeatPenalty} onChange={(v) => patch({ repeatPenalty: v })} />
      </div>
      <label className="llama-field llama-field-wide" title="Raw llama-server flags, split on whitespace and appended verbatim — the escape hatch for anything not surfaced above.">
        <span className="llama-field-label">Extra args</span>
        <input
          type="text"
          value={overrides.extraArgs ?? ""}
          placeholder="e.g. --rope-freq-base 10000"
          spellCheck={false}
          onChange={(e) => patch({ extraArgs: e.target.value.trim() ? e.target.value : undefined })}
        />
      </label>
      <label className="llama-field llama-field-check" title="--no-mmap — load the whole model into RAM instead of memory-mapping (slower start, more stable low-RAM inference).">
        <input
          type="checkbox"
          checked={overrides.noMmap === true}
          onChange={(e) => patch({ noMmap: e.target.checked ? true : undefined })}
        />
        <span className="llama-field-label">No mmap (load fully into RAM)</span>
      </label>
      {overrides.lastGoodNgl != null && (
        <div className="llama-advanced-note">
          Last good: {overrides.lastGoodNgl} GPU layers (auto-recorded — restarts start there)
        </div>
      )}
    </div>
  );
}
