// "Now reading" bar for TTS playback — a compact transport that appears while
// something is being read aloud, in the chat's bottom-right corner.
//
// It lives at the app-shell level (App.tsx) rather than inside ChatView because
// playback is global: a text artifact opened from the tools pane is read through
// the same player, and the controls must stay reachable there too. That also
// means its icons come from lib/icons rather than ActivitySteps — pulling that
// module (react-markdown, katex, highlight.js) into the entry chunk for four
// small glyphs would undo a deliberate bundle split.
import { NextIcon, PauseIcon, PlayIcon, PrevIcon, SpeakerIcon, StopIcon } from "../../lib/icons";
import { ttsPlayer } from "../../lib/tts";
import { useTtsStore } from "../../state/tts";

export function TtsPlayerBar() {
  const phase = useTtsStore((s) => s.phase);
  const label = useTtsStore((s) => s.label);
  const index = useTtsStore((s) => s.index);
  const total = useTtsStore((s) => s.total);
  const error = useTtsStore((s) => s.error);

  if (phase === "idle" && !error) return null;

  const loading = phase === "loading";
  const playing = phase === "playing";

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
              {loading ? "Preparing…" : (label ?? "Reading")}
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
