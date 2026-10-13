// Behavioural test for the browser-pane visual-overlay bridge
// (src-tauri/src/bridge_overlay.js).
//
// THE BUG: the script is installed with WebView2's
// AddScriptToExecuteOnDocumentCreated (and macOS's initialization_script),
// which runs BEFORE the parser has created an <html> element. Its eager
// install therefore hit `(document.head || document.documentElement)
// .appendChild(...)` with both null and threw
//   Uncaught TypeError: Cannot read properties of null (reading 'appendChild')
//     at injectStyle / __relay_injectOverlay
// In the pane that surfaced as login failures on real sites (LinkedIn's
// credential_page_library then threw a null-postMessage error in the same
// console), and it polluted the console ring buffer the agent reads.
//
// These tests run the actual JS against two document shapes:
//   1. a document-start sandbox where head AND documentElement are null —
//      evaluation must not throw, the install must DEFER, and the deferred
//      install must land once the root appears;
//   2. a real (jsdom) document — the overlay installs immediately, is
//      idempotent, and the narration primitive still works.
//
// Run: node src-tauri/src/bridge_overlay.test.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const OVERLAY_JS = readFileSync(new URL("./bridge_overlay.js", import.meta.url), "utf8");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/// A document shim that can start with NO root (the document-start shape
/// WebView2 fires init scripts against) and gain one later.
function documentStartShim() {
  const listeners = {};
  const appended = [];

  const fakeNode = (tag) => ({
    tagName: tag,
    id: "",
    textContent: "",
    style: {},
    classList: { add() {}, remove() {} },
    attrs: {},
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    appendChild(child) {
      appended.push(child);
      return child;
    },
  });

  let head = null;
  let documentElement = null;

  const doc = {
    get head() {
      return head;
    },
    get documentElement() {
      return documentElement;
    },
    readyState: "loading",
    // Real-DOM behaviour: appended elements are findable afterwards.
    getElementById: (id) => appended.find((el) => el.id === id) || null,
    createElement: (tag) => fakeNode(tag),
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
  };

  const timers = [];
  const window = {};
  const sandbox = {
    window,
    document: doc,
    setTimeout: (fn) => {
      timers.push(fn);
      return 0;
    },
  };
  window.setTimeout = sandbox.setTimeout;
  vm.createContext(sandbox);

  return {
    sandbox,
    timers,
    listeners,
    appended,
    get root() {
      return documentElement;
    },
    gainRoot() {
      documentElement = fakeNode();
      return documentElement;
    },
  };
}

// ---- Case 1: evaluated at document-created timing (no <html> yet) ----------
{
  const shim = documentStartShim();
  let threw = null;
  try {
    vm.runInContext(OVERLAY_JS, shim.sandbox);
  } catch (e) {
    threw = e;
  }
  check("evaluating at document-start does not throw", threw === null, threw && threw.message);

  const inject = shim.sandbox.window.__relay_injectOverlay;
  check("__relay_injectOverlay is defined", typeof inject === "function");

  if (typeof inject === "function") {
    let installThrew = null;
    let ret;
    try {
      ret = inject();
    } catch (e) {
      installThrew = e;
    }
    check("install call does not throw", installThrew === null, installThrew && installThrew.message);
    check("install reports not-ready (false) instead of pretending", ret === false, `got ${ret}`);
    check("nothing was appended yet", shim.appended.length === 0);

    const dcl = shim.listeners["DOMContentLoaded"] || [];
    const rsc = shim.listeners["readystatechange"] || [];
    check("deferred install is armed on DOMContentLoaded", dcl.length === 1);
    check("deferred install is armed on readystatechange (belt and braces)", rsc.length === 1);

    // Case 2: the parser creates <html> later — the deferred install lands.
    const root = shim.gainRoot();
    for (const fn of dcl) fn();
    const ids = shim.appended.map((el) => el.id).filter(Boolean);
    check("deferred install appends the overlay style", ids.includes("__relay_overlay_style"));
    check(
      "deferred install appends cursor/ripple/highlight/caret",
      ["__relay_cursor", "__relay_ripple", "__relay_highlight", "__relay_caret"].every((id) =>
        ids.includes(id),
      ),
      `appended: ${ids.join(", ")}`,
    );
    check("deferred install marked the flag", shim.sandbox.window.__relay_overlay_installed === true);
    check("install now succeeds", inject() === true);

    // The action primitives must degrade, not throw, with no live cursor.
    let tweenThrew = null;
    let tweenResolved = false;
    const tweened = shim.sandbox.window.__relay_tweenCursor(10, 20, 0);
    tweened.then(() => {
      tweenResolved = true;
    });
    // With the overlay installed the tween arms a timer; without one it
    // resolves straight away — both are fine, a throw is not.
    for (const fn of shim.timers.splice(0)) {
      try {
        fn();
      } catch (e) {
        tweenThrew = e;
      }
    }
    // Let the resolve() microtask land.
    await new Promise((r) => setTimeout(r, 0));
    check("tweenCursor resolves without throwing", tweenThrew === null, tweenThrew && tweenThrew.message);
    const narrateThrew = (() => {
      try {
        shim.sandbox.window.__relay_narrate("typing email");
        return null;
      } catch (e) {
        return e;
      }
    })();
    check("narrate does not throw once the root exists", narrateThrew === null, narrateThrew && narrateThrew.message);
    check(
      "narrate created its label",
      shim.appended.some((el) => el.id === "__relay_narration"),
    );
    check("tweenCursor returned a promise", typeof tweened?.then === "function");
    check("tweenCursor settled", tweenResolved === true);
  }
}

// ---- Case 3: a real document — immediate install + idempotency ------------
{
  const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`, {
    runScripts: "outside-only",
  });
  const { window } = dom;
  let threw = null;
  try {
    window.eval(OVERLAY_JS);
  } catch (e) {
    threw = e;
  }
  check("evaluating on a live document does not throw", threw === null, threw && threw.message);

  const doc = window.document;
  const cursor = doc.getElementById("__relay_cursor");
  check("cursor element is installed immediately", !!cursor);
  check("overlay elements are excluded from the a11y tree", cursor?.getAttribute("data-relay-overlay") === "");
  check("overlay style is installed", !!doc.getElementById("__relay_overlay_style"));
  check("install reports ready (true)", window.__relay_injectOverlay() === true);
  check(
    "install is idempotent (one style tag)",
    doc.querySelectorAll("#__relay_overlay_style").length === 1,
  );
  check(
    "idempotent re-install (one cursor)",
    doc.querySelectorAll("#__relay_cursor").length === 1,
  );

  let narrateThrew = null;
  try {
    window.__relay_narrate('typing credentials');
  } catch (e) {
    narrateThrew = e;
  }
  const narration = doc.getElementById("__relay_narration");
  check("narration label is created on a live document", !!narration && !narrateThrew, narrateThrew && narrateThrew.message);
  check("narration carries the agent text", narration?.textContent === "typing credentials");
  check("narration is agent-excluded from the a11y tree", narration?.getAttribute("data-relay-overlay") === "");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
