// The hands-free loop's read-aloud handoff: the answer landed (waiting) and
// the TTS store now decides what the loop does. The failure this covers —
// "the answer is here but nothing reads it aloud" — was the loop stranding
// in "waiting" (or silently resuming) whenever a read ended without ever
// sounding: no voice model installed, a failed synthesis, or the auto-read
// call skipped entirely.
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toggleRecording = vi.fn();
const cancelRecording = vi.fn();
const sendMessage = vi.fn(async () => {});
let onExtendedSilence: (() => void) | undefined;

vi.mock("../lib/voiceDictationCore", () => ({
  useVoiceDictationCore: (params: { onExtendedSilence?: () => void }) => {
    onExtendedSilence = params.onExtendedSilence;
    return { recording: false, transcribing: false, toggleRecording, cancelRecording };
  },
}));

vi.mock("../lib/voiceActivity", () => ({
  VoiceActivityGate: class {},
  // The barge-in watcher must never open a real mic in tests; a promise that
  // never settles keeps the armed watcher inert.
  startMicLevelFeed: vi.fn(() => new Promise<() => void>(() => {})),
}));

vi.mock("../lib/tts", () => ({
  ttsPlayer: { stop: vi.fn(), pause: vi.fn(), resume: vi.fn() },
}));

vi.mock("../state/chat", () => ({
  useChatStore: {
    getState: () => ({
      activeChatSessionId: "s1",
      sendMessage,
      cancelStream: vi.fn(),
    }),
  },
}));

import { VoiceLoopController } from "../hooks/useVoiceLoop";
import { ttsPlayer } from "../lib/tts";
import { useTtsStore } from "../state/tts";
import {
  notifyVoiceTurnComplete,
  requestVoiceLoopStop,
  useVoiceLoopStore,
} from "../state/voiceLoop";

function renderController() {
  render(<VoiceLoopController />);
}

describe("voice loop read-aloud handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceLoopStore.setState({ mode: "off", phase: "idle", transcript: "", level: 0, error: null });
    useTtsStore.setState({ phase: "idle", key: null, error: null });
  });

  it("a read that dies before sounding returns the loop to listening and says why", () => {
    renderController();
    act(() => {
      useVoiceLoopStore.getState().setMode("handsfree");
      useVoiceLoopStore.getState().set({ phase: "waiting" });
    });
    // The read attempt begins, then resolveSettings finds no model and lands
    // the store back on idle with the engine's own error.
    act(() => {
      useTtsStore.getState().set({ phase: "loading" });
    });
    act(() => {
      useTtsStore.getState().set({
        phase: "idle",
        error: "No voice model installed — add one in Settings → Local Models → Speech",
      });
    });
    expect(useVoiceLoopStore.getState().phase).toBe("listening");
    expect(useVoiceLoopStore.getState().error).toContain("No voice model installed");
    expect(toggleRecording).toHaveBeenCalled();
  });

  it("a read that starts sounding flips waiting to speaking", () => {
    renderController();
    act(() => {
      useVoiceLoopStore.getState().setMode("handsfree");
      useVoiceLoopStore.getState().set({ phase: "waiting" });
    });
    act(() => {
      useTtsStore.getState().set({ phase: "buffering" });
    });
    expect(useVoiceLoopStore.getState().phase).toBe("speaking");
  });

  it("a finished read hands the floor back to the listener", () => {
    renderController();
    act(() => {
      useVoiceLoopStore.getState().setMode("handsfree");
      useVoiceLoopStore.getState().set({ phase: "waiting" });
      useTtsStore.getState().set({ phase: "playing" });
    });
    expect(useVoiceLoopStore.getState().phase).toBe("speaking");
    act(() => {
      useTtsStore.getState().set({ phase: "idle" });
    });
    expect(useVoiceLoopStore.getState().phase).toBe("listening");
    expect(toggleRecording).toHaveBeenCalled();
  });

  it("a turn whose read never starts still resumes the mic after the grace beat", async () => {
    vi.useFakeTimers();
    try {
      renderController();
      // The loop sends a turn: capture → silence → yield. The mock chat store
      // records it; the loop lands in "waiting" with the session latched.
      act(() => {
        useVoiceLoopStore.getState().setMode("handsfree");
        useVoiceLoopStore.getState().set({ phase: "listening", transcript: "hello there" });
      });
      await act(async () => {
        onExtendedSilence?.();
      });
      expect(sendMessage).toHaveBeenCalledWith("hello there");
      expect(useVoiceLoopStore.getState().phase).toBe("waiting");

      // The turn persists (autoReadFinishedTurn fires the notification), but
      // no read is ever started and the TTS store never leaves idle — the
      // grace beat is the only thing that can free the loop.
      act(() => {
        notifyVoiceTurnComplete("s1");
      });
      expect(useVoiceLoopStore.getState().phase).toBe("waiting");
      await act(async () => {
        vi.advanceTimersByTime(1500);
      });
      expect(useVoiceLoopStore.getState().phase).toBe("listening");
      expect(toggleRecording).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("exiting hands-free mid-read stops playback and never strands the phase", () => {
    renderController();
    act(() => {
      useVoiceLoopStore.getState().setMode("handsfree");
      useVoiceLoopStore.getState().set({ phase: "waiting" });
      useTtsStore.getState().set({ phase: "playing" });
    });
    expect(useVoiceLoopStore.getState().phase).toBe("speaking");
    // The toggle's off branch: stop request first, then the mode flip.
    act(() => {
      requestVoiceLoopStop();
      useVoiceLoopStore.getState().setMode("off");
    });
    // The player was told to stop; when the store settles on idle (which the
    // real stop() does synchronously) the loop must be idle regardless of the
    // mode having gone off in between — not stuck in "speaking".
    expect(ttsPlayer.stop).toHaveBeenCalled();
    act(() => {
      useTtsStore.getState().set({ phase: "idle" });
    });
    expect(useVoiceLoopStore.getState().phase).toBe("idle");
    expect(useVoiceLoopStore.getState().mode).toBe("off");
  });
});
