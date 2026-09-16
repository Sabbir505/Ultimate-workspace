// "Now reading" bar for TTS playback — a compact transport that appears while
// something is being read aloud, in the chat's bottom-right corner.
//
// It lives at the app-shell level (App.tsx) rather than inside ChatView because
// playback is global: a text artifact opened from the tools pane is read through
// the same player, and the controls must stay reachable there too. That also
// means its icons come from lib/icons rather than ActivitySteps — pulling that
// module (react-markdown, katex, highlight.js) into the entry chunk for four
// small glyphs would undo a deliberate bundle split.
import { ChevronDown, ChevronUp } from "lucide-react";
import { NextIcon, PauseIcon, PlayIcon, PrevIcon, SpeakerIcon, StopIcon } from "../../lib/icons";
import { ttsPlayer } from "../../lib/tts";
import { useTtsStore } from "../../state/tts";

/** Rate steps: quarter-turns between half and double — enough spread to feel
 *  responsive, coarse enough to hit from the arrows without hunting. */
const RATE_MIN = 0.5;
const RATE_MAX = 2;
const RATE_STEP = 0.25;

function formatRate(rate: number): string {
  return `${Number.isInteger(rate) ? rate : rate.toFixed(2).replace(/0$/, "")}×`;
}

export function TtsPlayerBar() {
  const phase = useTtsStore((s) => s.phase);
  const label = useTtsStore((s) => s.label);
  const index = useTtsStore((s) => s.index);
  const total = useTtsStore((s) => s.total);
  const error = useTtsStore((s) => s.error);
  const rate = useTtsStore((s) => s.rate);

  if (phase === "idle" && !error) return null;

  const loading = phase === "loading";
  // Buffering keeps the transport live: the read is parked on the engine
  // between sentences, so pause/skip/stop all still mean something.
  const buffering = phase === "buffering";
  const playing = phase === "playing" || buffering;
  const stepRate = (delta: number) =>
    ttsPlayer.setRate(Math.round((rate + delta) * 100) / 100);

  return (
    <div className="tts-bar" role="status" aria-live="polite">
      <span className={`tts-bar-icon${playing ? " reading" : ""}`} aria-hidden="true">
        <SpeakerIcon />
      </span>
      <span className="tts-bar-label">
        {error ? (
          <span className="tts-bar-error">{error}</span>
        ) : (
          <>
            <span className="tts-bar-title">
              {loading
                ? "Preparing…"
                : buffering
                  ? "Buffering…"
                  : (label ?? "Reading")}
            </span>
            {total > 1 && (
              <span className="tts-bar-progress">
                {Math.min(index, total)} / {total}
              </span>
            )}
          </>
        )}
      </span>
      <span className="tts-bar-controls">
        {!error && (
          <>
            {/* Sentence-level navigation: a mispronounced clause or a
                code-heavy stretch is easy to step over without losing the
                thread of a long answer. */}
            <button
              type="button"
              className="tts-bar-btn"
              title="Previous sentence"
              aria-label="Previous sentence"
              disabled={loading || index <= 1}
              onClick={() => ttsPlayer.prev()}
            >
              <PrevIcon />
            </button>
            <button
              type="button"
              className="tts-bar-btn"
              title={playing ? "Pause" : "Resume"}
              aria-label={playing ? "Pause read-aloud" : "Resume read-aloud"}
              disabled={loading}
              onClick={() => (playing ? ttsPlayer.pause() : ttsPlayer.resume())}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button
              type="button"
              className="tts-bar-btn"
              title="Next sentence"
              aria-label="Next sentence"
              disabled={loading || index >= total}
              onClick={() => ttsPlayer.next()}
            >
              <NextIcon />
            </button>
            {/* Live speed: arrows nudge the playback-rate multiplier in
                quarter steps and are audible on the sentence already
                sounding — no replay, no re-synthesis. */}
            <span className="tts-bar-speed">
              <button
                type="button"
                className="tts-bar-btn"
                title="Slower"
                aria-label="Read slower"
                disabled={loading || rate <= RATE_MIN}
                onClick={() => stepRate(-RATE_STEP)}
              >
                <ChevronDown size={14} strokeWidth={2} />
              </button>
              <span className="tts-bar-rate" title="Playback speed">
                {formatRate(rate)}
              </span>
              <button
                type="button"
                className="tts-bar-btn"
                title="Faster"
                aria-label="Read faster"
                disabled={loading || rate >= RATE_MAX}
                onClick={() => stepRate(RATE_STEP)}
              >
                <ChevronUp size={14} strokeWidth={2} />
              </button>
            </span>
          </>
        )}
        <button
          type="button"
          className="tts-bar-btn"
          title="Stop"
          aria-label="Stop read-aloud"
          onClick={() => ttsPlayer.stop()}
        >
          <StopIcon />
        </button>
      </span>
    </div>
  );
}
