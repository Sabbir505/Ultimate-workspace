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
  toastError,
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

  // A failed write leaves the panel showing a value the backend rejected —
  // re-fetch the live config and surface the error instead.
  const onWriteFailed = useCallback((what: string, err: unknown) => {
    toastError(`Couldn't change ${what}`, err);
    void load().catch(() => {});
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
        Local-model requests are captured with their full request and response, then
        summarised into token counts and timings. Open the log from the sidebar footer.
      </p>

      <Field label="Record requests" hint="Turning this off stops new rows; existing ones are kept.">
        <ToggleSwitch
          checked={cfg.enabled}
          onChange={(v) =>
            void llmLogConfigSet({ enabled: v })
              .then((c) => setCfg(c))
              .catch((err) => onWriteFailed("the request-log setting", err))
          }
        />
      </Field>

      <Field label="Keep requests for" hint="Older rows are pruned hourly.">
        <GlassSelect<string>
          className="llm-log-select"
          ariaLabel="Keep requests for"
          value={String(cfg.retentionDays)}
          options={[
            { value: "1", label: "1 day" },
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
          ]}
          onChange={(v) =>
            void llmLogConfigSet({ retentionDays: Number(v) })
              .then((c) => setCfg(c))
              .catch((err) => onWriteFailed("the retention setting", err))
          }
        />
      </Field>

      <Field label="Maximum rows" hint="The oldest are dropped first.">
        <GlassSelect<string>
          className="llm-log-select"
          ariaLabel="Maximum rows"
          value={String(cfg.maxRows)}
          options={[
            { value: "1000", label: "1,000" },
            { value: "5000", label: "5,000" },
            { value: "20000", label: "20,000" },
          ]}
          onChange={(v) =>
            void llmLogConfigSet({ maxRows: Number(v) })
              .then((c) => setCfg(c))
              .catch((err) => onWriteFailed("the row limit", err))
          }
        />
      </Field>

      <Field
        label="Maximum body size"
        hint="Larger responses are cut."
      >
        <GlassSelect<string>
          className="llm-log-select"
          ariaLabel="Maximum body size"
          value={String(cfg.maxBodyKb)}
          options={[
            { value: "64", label: "64 KB" },
            { value: "256", label: "256 KB" },
            { value: "1024", label: "1 MB" },
          ]}
          onChange={(v) =>
            void llmLogConfigSet({ maxBodyKb: Number(v) })
              .then((c) => setCfg(c))
              .catch((err) => onWriteFailed("the body-size limit", err))
          }
        />
      </Field>

      <hr className="llm-log-rule" />

      <h3 className="llm-log-heading">Gateway</h3>
      <p className="llm-log-intro">
        Other apps point their base URL here; requests are forwarded unchanged and
        recorded in the same log.
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
          The gateway is not running — it starts with the app. If this persists,
          check the startup log.
        </p>
      )}

      <Field label="Default runtime" hint="Used when a request does not name one.">
        <GlassSelect<string>
          value={gw.defaultTarget ?? ""}
          options={targets}
          onChange={(v) =>
            void gatewaySetDefaultTarget(v || null)
              .then(load)
              .catch((err) => onWriteFailed("the default gateway runtime", err))
          }
          title="Default gateway runtime"
        />
      </Field>

      <Field
        label="Require a token"
        hint="Off means any local program can use your models and read your prompts."
      >
        <ToggleSwitch
          checked={gw.requireAuth}
          onChange={(v) =>
            void gatewaySetRequireAuth(v)
              .then(load)
              .catch((err) => onWriteFailed("the gateway token requirement", err))
          }
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
