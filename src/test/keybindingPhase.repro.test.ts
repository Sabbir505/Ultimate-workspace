// Repro: xterm's core keydown handler can stopPropagation() on the terminal's
// textarea before a window-level BUBBLE listener sees the event. The app's
// global shortcuts (focusPane1..6 etc.) are documented to work "from inside
// terminals too" (useKeybindings.ts L17-18), so the listener must be on the
// CAPTURE phase to run before xterm can swallow it.
//
// This test registers an xterm-stand-in listener on the textarea that calls
// stopPropagation(), then checks whether a window keydown listener fires.
// It fails for bubble-phase listeners and passes for capture-phase.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function fireKeyDown(target: HTMLElement, key: string) {
  const e = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
  });
  Object.defineProperty(e, "target", { value: target });
  target.dispatchEvent(e);
}

describe("window keydown phase vs xterm stopPropagation", () => {
  let textarea: HTMLTextAreaElement;

  beforeEach(() => {
    textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    document.body.appendChild(textarea);
    textarea.focus();
  });
  afterEach(() => {
    document.body.removeChild(textarea);
  });

  it("BUBBLE-phase window listener does NOT see a keydown that xterm stopPropagation'd", () => {
    // xterm stand-in: stops propagation on the textarea (bubble listener).
    const xtermStub = (e: KeyboardEvent) => e.stopPropagation();
    textarea.addEventListener("keydown", xtermStub);

    let seen = false;
    const onWindow = () => { seen = true; };
    window.addEventListener("keydown", onWindow); // bubble phase

    fireKeyDown(textarea, "1");
    window.removeEventListener("keydown", onWindow);
    textarea.removeEventListener("keydown", xtermStub);

    // This is the bug: the bubble window listener never fires because xterm
    // stopped propagation at the textarea. (If jsdom propagates anyway here,
    // the real WebView2/xterm pairing still does — see capture-phase test.)
    expect(seen).toBe(false);
  });

  it("CAPTURE-phase window listener DOES see the keydown even after xterm stopPropagation", () => {
    const xtermStub = (e: KeyboardEvent) => e.stopPropagation();
    textarea.addEventListener("keydown", xtermStub);

    let seen = false;
    const onWindow = () => { seen = true; };
    window.addEventListener("keydown", onWindow, true); // CAPTURE phase

    fireKeyDown(textarea, "1");
    window.removeEventListener("keydown", onWindow, true);
    textarea.removeEventListener("keydown", xtermStub);

    // Capture phase fires on the way DOWN to the target, before any
    // target/bubble listener — so xterm's stopPropagation can't block it.
    expect(seen).toBe(true);
  });
});
