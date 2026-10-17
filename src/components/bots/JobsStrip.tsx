// JobsStrip — standing jobs of the selected bot. The Automations view stays
// the deep management surface; this strip is the bot's own short list, shown
// in the bot activity rail.

import { useEffect, useState } from "react";
import type { Automation } from "../../lib/ipc/automations";
import { relativeTime } from "../../lib/relativeTime";

export function JobsStrip({ jobs, onAdd }: { jobs: Automation[]; onAdd: () => void }) {
  const [, force] = useState(0);
  useEffect(() => {
    // Cron "next fire" lines are computed from the current clock; a slow tick
    // keeps them from freezing while the view stays open.
    const t = window.setInterval(() => force((n) => n + 1), 30000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <section className="bots-strip" aria-label="Standing jobs">
      <header className="bots-strip-head">
        <span>Standing jobs</span>
        <button type="button" onClick={onAdd}>
          Add job
        </button>
      </header>
      {jobs.length === 0 ? (
        <p className="bots-strip-empty">
          No standing jobs. Add one to have this bot do something on a schedule.
        </p>
      ) : (
        <ul className="bots-strip-list">
          {jobs.map((j) => (
            <li key={j.id} className="bots-job-row">
              <span className={`bots-rail-dot is-${j.enabled ? "idle" : "off"}`} aria-hidden="true" />
              <span className="bots-job-name">{j.name}</span>
              <code className="bots-job-schedule">{j.schedule || j.triggerType}</code>
              <span className="bots-job-when">
                {j.lastRunAt ? relativeTime(j.lastRunAt) : "never run"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
