// Settings → Local Models → Request Log. Retention for the captured bodies,
// plus the loopback gateway other apps point their base_url at.
//
// Kept on this tab rather than a new top-level category: it is the same
// subject (local models), and the gateway's default target is a local runtime.

import { useCallback, useEffect, useState } from "react";
import { Copy, Check, Eye, EyeOff } from "lucide-react";
import {
  gatewaySetDefaultTarget,
  gatewaySetRequireAuth,
  gatewayStatus,
  llmLogConfigGet,
  llmLogConfigSet,
  gatewayProbe,
} from "../../lib/ipc";
import type { GatewayStatus, LogConfig } from "../../types";
import { GlassSelect, type SelectOption } from "../common/GlassSelect";
import { ToggleSwitch } from "./ToggleSwitch";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="llm-log-field">
      <div className="llm-log-field-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="llm-log-field-control">{children}</div>
    </div>
  );
}

export function LogGatewayPanel() {
  const [cfg, setCfg] = useState<LogConfig | null>(null);
  const [gw, setGw] = useState<GatewayStatus | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reach, setReach] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const [c, g] = await Promise.all([llmLogConfigGet(), gatewayStatus()]);
    setCfg(c);
    setGw(g);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Probe each runtime so the user can tell "not running" from "misconfigured"
  // without leaving settings.
  useEffect(() => {
    if (!gw) return;
    void Promise.all(
      gw.knownTargets.map(async (t) => [t, await gatewayProbe(t)] as const),
    ).then((pairs) => setReach(Object.fromEntries(pairs)));
  }, [gw]);

  if (!cfg || !gw) return <div className="llm-log-loading">Loading…</div>;

  const targets: SelectOption<string>[] = [
    { value: "", label: "Automatic" },
    ...gw.knownTargets.map((t) => ({
      value: t,
      label: t,
      hint: reach[t] === undefined ? "" : reach[t] ? "reachable" : "not responding",
    })),
  ];

  return (
    <div className="llm-log-settings">
      <p className="llm-log-intro">
        Every local-model request is captured with its full request and response, then
        summarised into token counts and timings. Open the log from the sidebar footer.
      </p>

      <Field label="Record requests" hint="Turning this off stops new rows; existing ones are kept.">
        <ToggleSwitch
          checked={cfg.enabled}
          onChange={(v) => void llmLogConfigSet({ enabled: v }).then((c) => setCfg(c))}
        />
      </Field>

      <Field label="Keep requests for" hint="Older rows are pruned hourly.">
        <select
          className="llm-log-select"
          value={cfg.retentionDays}
          onChange={(e) =>
            void llmLogConfigSet({ retentionDays: Number(e.target.value) }).then((c) => setCfg(c))
          }
        >
          <option value={1}>1 day</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
      </Field>

      <Field label="Maximum rows" hint="The oldest are dropped first when this is exceeded.">
        <select
          className="llm-log-select"
          value={cfg.maxRows}
          onChange={(e) =>
            void llmLogConfigSet({ maxRows: Number(e.target.value) }).then((c) => setCfg(c))
          }
        >
          <option value={1000}>1,000</option>
          <option value={5000}>5,000</option>
          <option value={20000}>20,000</option>
        </select>
      </Field>

      <Field
        label="Maximum body size"
        hint="Larger responses are cut. Prompts and answers can be long."
      >
        <select
          className="llm-log-select"
          value={cfg.maxBodyKb}
          onChange={(e) =>
            void llmLogConfigSet({ maxBodyKb: Number(e.target.value) }).then((c) => setCfg(c))
          }
        >
          <option value={64}>64 KB</option>
          <option value={256}>256 KB</option>
          <option value={1024}>1 MB</option>
        </select>
      </Field>

      <hr className="llm-log-rule" />

      <h3 className="llm-log-heading">Gateway</h3>
      <p className="llm-log-intro">
        Other apps point their base URL here. Requests are forwarded to the runtime unchanged
        and recorded in the same log.
      </p>

      {gw.running ? (
        <Field label="Base URL">
          <div className="llm-log-token-row">
            <code className="llm-log-url">{`http://127.0.0.1:${gw.port}`}</code>
            <button
              type="button"
              className="llm-log-icon-btn"
              title="Copy base URL"
              onClick={() => {
                void navigator.clipboard?.writeText(`http://127.0.0.1:${gw.port}`).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                });
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        </Field>
      ) : (
        <p className="llm-log-warn">
          The gateway is not running. It starts with the app; if this persists, check the
          startup log.
        </p>
      )}

      <Field label="Default runtime" hint="Used when a request does not name one.">
        <GlassSelect<string>
          value={gw.defaultTarget ?? ""}
          options={targets}
          onChange={(v) => void gatewaySetDefaultTarget(v || null).then(load)}
          title="Default gateway runtime"
        />
      </Field>

      <Field
        label="Require a token"
        hint="Off means any local program can use your models and read your prompts."
      >
        <ToggleSwitch
          checked={gw.requireAuth}
          onChange={(v) => void gatewaySetRequireAuth(v).then(load)}
        />
      </Field>

      {gw.requireAuth && gw.token && (
        <Field label="Access token" hint="Rotates every time Relay starts.">
          <div className="llm-log-token-row">
            <code className="llm-log-token">{showToken ? gw.token : "•".repeat(24)}</code>
            <button
              type="button"
              className="llm-log-icon-btn"
              title={showToken ? "Hide" : "Show"}
              onClick={() => setShowToken((s) => !s)}
            >
              {showToken ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <button
              type="button"
              className="llm-log-icon-btn"
              title="Copy token"
              onClick={() => void navigator.clipboard?.writeText(gw.token)}
            >
              <Copy size={13} />
            </button>
          </div>
        </Field>
      )}
    </div>
  );
}
