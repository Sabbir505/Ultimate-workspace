// Behavioural test for the Relay self-UI bridge (Phase 2).
//
// The Rust tests pin the bridge's *contract* (op names, CSP safety, the
// exclusion attribute, selector parity with the browser panes). They cannot
// run the JS. This does, against a real DOM — and it targets the three
// properties the design actually rests on, all of which are easy to get
// subtly wrong and impossible to notice without running them:
//
//   1. Ref numbering is document order and survives the actions.
//   2. The agent-exclusion filter runs BEFORE numbering, so a ref can never
//      silently point at Relay's own Stop button.
//   3. The native value setter is used, so a React-controlled input registers
//      the change instead of silently reverting.
//
// Run: node --experimental-vm-modules src-tauri/src/bridge_selfui.test.mjs
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const REFS_JS = readFileSync(new URL("./bridge_refs.js", import.meta.url), "utf8");
const SELFUI_JS = readFileSync(new URL("./bridge_selfui.js", import.meta.url), "utf8");

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

/// Boot a DOM with the bridges installed and a `__TAURI_INTERNALS__.invoke`
/// that captures what the bridge reports back — the same channel the Rust
/// side listens on.
function boot(bodyHtml) {
  const dom = new JSDOM(
    `<!doctype html><html><body>${bodyHtml}</body></html>`,
    { runScripts: "outside-only" },
  );
  const { window } = dom;
  const reports = [];
  // Tauri's IPC serialises arguments to JSON before the command sees them, so
  // the Rust side receives `payload` as a JSON *string*. Mirror that here
  // rather than handing the object straight through — the bridge builds a
  // plain object and Tauri does the encoding, and a harness that skipped that
  // step would not be testing the real wire shape.
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      if (cmd === "app_ui_result") {
        reports.push({
          requestId: args.requestId,
          payload:
            typeof args.payload === "string" ? args.payload : JSON.stringify(args.payload),
        });
      }
    },
  };
  window.eval(REFS_JS);
  window.eval(SELFUI_JS);

  // NOTE: these stubs are installed AFTER the bridge scripts are evaluated.
  // jsdom's `window.eval` re-binds the window globals, so a prototype or
  // document patch applied beforehand does not survive into the code the
  // bridge actually runs in.

  // jsdom performs no layout, so every getBoundingClientRect() returns zeros.
  // The bridge's census excludes zero-area elements — correctly: an element
  // with no box cannot be clicked by a human or by an agent, and
  // bridge_extract.js makes the same call in the browser pane. Without a
  // layout stub every element would therefore read as "not actionable" and
  // the tests would be measuring jsdom, not the bridge.
  //
  // The stub reports a real box for anything that is in the document and not
  // explicitly hidden, so the exclusion path stays reachable via the real
  // attribute and the real display checks.
  const stubLayout = () => {
    const proto = window.Element.prototype;
    proto.getBoundingClientRect = function () {
      const hidden =
        this.hasAttribute("hidden") ||
        this.getAttribute("aria-hidden") === "true" ||
        (this.style && this.style.display === "none");
      if (hidden) return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
      return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 };
    };
  };
  stubLayout();
  // Re-stub after any DOM change, since tests rebuild content.
  const observer = new window.MutationObserver(stubLayout);
  observer.observe(window.document.body, { childList: true, subtree: true, attributes: true });

  // jsdom implements neither scrolling nor focus management. The bridge calls
  // scrollIntoView before acting (so the element is on screen, as it would be
  // for a user) and reads document.activeElement for key dispatch, so both are
  // stubbed here — otherwise these tests would be measuring jsdom.
  window.Element.prototype.scrollIntoView = function () {
    this.setAttribute("data-scrolled-into-view", "1");
  };
  // Focus tracking lives on `window` rather than in a closure variable: the
  // bridge runs in jsdom's re-bound eval scope, which cannot see this
  // module's locals, but it CAN see window properties. Storing the focused
  // node on window is also the shape a real browser's document.activeElement
  // has — a single authoritative "what has focus" the bridge reads.
  //
  // The stubs go on the PROTOTYPE *and* are re-applied to each element
  // instance: jsdom installs `focus`/`blur` as own properties on every element,
  // which would shadow a prototype patch. A MutationObserver keeps new nodes
  // covered, so a test can add markup and focus it without surprises.
  window.__relayTestFocus = null;
  const applyFocusStubs = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.__relayFocusStubbed) continue;
      Object.defineProperty(el, "focus", {
        configurable: true,
        writable: true,
        value() {
          window.__relayTestFocus = this;
        },
      });
      Object.defineProperty(el, "blur", {
        configurable: true,
        writable: true,
        value() {
          if (window.__relayTestFocus === this) window.__relayTestFocus = null;
        },
      });
      el.__relayFocusStubbed = true;
    }
  };
  applyFocusStubs(window.document);
  new window.MutationObserver(() => applyFocusStubs(window.document)).observe(
    window.document.body,
    { childList: true, subtree: true },
  );
  Object.defineProperty(window.document, "activeElement", {
    configurable: true,
    get() {
      return window.__relayTestFocus || window.document.body;
    },
  });

  return {
    window,
    doc: window.document,
    reports,
    /** Simulate the user clicking away, leaving nothing focused. */
    resetFocus() {
      window.__relayTestFocus = null;
    },
    /** Send a request the way Rust does, and return the parsed reply. */
    call(op, args = {}) {
      const id = `t${reports.length}`;
      window.__relay_selfui(id, op, JSON.stringify(args));
      const last = reports[reports.length - 1];
      if (!last) throw new Error(`no report for ${op}`);
      return { id: last.requestId, ...JSON.parse(last.payload) };
    },
  };
}

// ---------------------------------------------------------------------------
console.log("\nbridge_selfui — snapshot + numbering");

{
  const t = boot(`
    <button id="first">Save</button>
    <a href="/x">Link</a>
    <input id="field" placeholder="Name" />
    <select id="pick"><option value="a">Alpha</option><option value="b">Beta</option></select>
  `);
  const r = t.call("snapshot");
  check("snapshot succeeds", r.ok === true, r.text);
  check("lists every targetable element", r.text.includes("[1]") && r.text.includes("[4]"), r.text);
  check("numbers in document order", r.text.indexOf("Save") < r.text.indexOf("Link"));
  check("marks selects for the semantic action", r.text.includes("app_select_option"));
  check("reports the total", r.total === 4, `total=${r.total}`);
}

// ---------------------------------------------------------------------------
console.log("\nbridge_selfui — the agent-exclusion filter");

{
  // Mirrors the real markup: ChatComposer's Stop button and the approval
  // dialog both carry data-relay-agent-exclude.
  const t = boot(`
    <button id="stop" data-relay-agent-exclude>Stop</button>
    <div data-relay-agent-exclude>
      <button id="allow">Allow</button>
      <button id="deny">Deny</button>
    </div>
    <button id="legit">Open Settings</button>
  `);
  const r = t.call("snapshot");
  check("excluded chrome is absent from the listing", !r.text.includes("Allow") && !r.text.includes("Deny"));
  check("the stop button is absent", !r.text.includes("Stop"));
  check("non-excluded elements remain", r.text.includes("Open Settings"));

  // The critical invariant: the LEGIT element must be ref 1, not ref 4. If
  // exclusion ran after numbering, "Open Settings" would be ref 4 and a
  // model holding an earlier snapshot's refs would click the Stop button.
  check(
    "exclusion runs BEFORE numbering (legit button is ref 1)",
    r.text.includes("[1] button \"Open Settings\""),
    r.text
  );

  // And clicking a ref that points at excluded chrome must fail, not silently
  // hit whatever now occupies that index.
  const clicked = t.call("click", { ref: 2 });
  check("a ref cannot resolve into excluded chrome", clicked.ok === false, clicked.text);
}

// ---------------------------------------------------------------------------
console.log("\nbridge_selfui — click + stale refs");

{
  const t = boot(`
    <button id="a">Alpha</button>
    <button id="b">Beta</button>
  `);
  let clicked = "";
  t.doc.getElementById("b").addEventListener("click", () => (clicked = "b"));

  const r = t.call("click", { ref: 2 });
  check("click reports success", r.ok === true, r.text);
  check("click fired on the right element", clicked === "b");
  check("click echoes the target it hit", r.text.includes("Beta"), r.text);

  // Now the DOM shifts: "Alpha" leaves, so "Beta" — which the model may still
  // hold as ref 2 from the snapshot above — is renumbered to 1. A ref pointing
  // at a different element than the model chose is exactly the
  // "clicked the wrong thing" failure, so this must be an explicit error the
  // model can act on, never a silent hit on whatever moved into that slot.
  t.doc.getElementById("a").remove();
  const stale = t.call("click", { ref: 2 });
  check("a ref orphaned by a re-render is reported stale",
    stale.ok === false && stale.code === "stale_ref", stale.text);
  check("the stale error tells the model to re-read", /app_snapshot/.test(stale.text), stale.text);
}

// ---------------------------------------------------------------------------
console.log("\nbridge_selfui — type uses the native setter (React safety)");

{
  const t = boot(`<input id="r" />`);
  const el = t.doc.getElementById("r");

  // React's value tracker works by defining an OWN `value` property on the
  // element instance, so a plain `el.value = x` updates only the tracker and
  // never the DOM. The fix every React-compatible setter uses — and the one
  // bridge_extract.js already uses for the browser pane — is to write through
  // the PROTOTYPE descriptor.
  //
  // So the invariant worth testing is precisely which setter gets called, not
  // what jsdom's internal value ends up being (jsdom does not route the
  // prototype setter back through an instance override, so an
  // assert-on-readiness check here would be testing jsdom, not the bridge).
  let instanceWrites = 0;
  let prototypeWrites = 0;
  const realValue = el.value;
  Object.defineProperty(el, "value", {
    configurable: true,
    get: () => realValue,
    set: () => {
      instanceWrites++;
    },
  });
  const protoDesc = Object.getOwnPropertyDescriptor(t.window.HTMLInputElement.prototype, "value");
  const originalProtoSet = protoDesc.set;
  Object.defineProperty(t.window.HTMLInputElement.prototype, "value", {
    configurable: true,
    get: protoDesc.get,
    set: function (v) {
      prototypeWrites++;
      return originalProtoSet.call(this, v);
    },
  });

  let sawInput = false;
  el.addEventListener("input", () => (sawInput = true));

  const r = t.call("type", { ref: 1, text: "hello" });
  check("type reports success", r.ok === true, r.text);
  check("the PROTOTYPE setter was used, not the instance property", prototypeWrites === 1,
    `prototype=${prototypeWrites} instance=${instanceWrites}`);
  check("the instance property was never written directly", instanceWrites === 0,
    `instance=${instanceWrites}`);
  check("an input event was dispatched", sawInput);

  // Typing must NOT submit: submission is app_press_key's deliberate job.
  check("typing does not submit the form", !/submitted/i.test(r.text), r.text);
}

// ---------------------------------------------------------------------------
console.log("\nbridge_selfui — select_option");

{
  const t = boot(`
    <select id="s">
      <option value="a">Alpha</option>
      <option value="b">Beta</option>
    </select>
  `);
  const el = t.doc.getElementById("s");

  const byValue = t.call("select_option", { ref: 1, value: "b" });
  check("selects by value", byValue.ok === true && el.value === "b", byValue.text);

  // Reset, then select by visible text — the model usually reads the label.
  el.value = "a";
  const byText = t.call("select_option", { ref: 1, value: "Beta" });
  check("selects by visible text", byText.ok === true && el.value === "b", byText.text);

  const bad = t.call("select_option", { ref: 1, value: "Gamma" });
  check("a bad value fails", bad.ok === false && bad.code === "no_such_option");
  check("the error lists the options", bad.text.includes("Alpha") && bad.text.includes("Beta"), bad.text);
}

// ---------------------------------------------------------------------------
console.log("\nbridge_selfui — press_key");

{
  const t = boot(`<input id="k" />`);
  const el = t.doc.getElementById("k");
  el.focus();
  let sawEnter = false;
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") sawEnter = true; });

  const r = t.call("press_key", { key: "Enter" });
  check("press_key succeeds on a focused element", r.ok === true, r.text);
  check("the key event was dispatched", sawEnter);

  // Nothing focused must be a clean refusal, not a key sprayed at <body>.
  t.resetFocus();
  const unfocused = t.call("press_key", { key: "Enter" });
  check("press_key refuses when nothing is focused", unfocused.ok === false && unfocused.code === "no_focus", unfocused.text);
}

// ---------------------------------------------------------------------------
console.log("\nbridge_selfui — argument handling");

{
  const t = boot(`<button>Go</button>`);
  const bad = t.call("click", { ref: "not a number" });
  check("a non-numeric ref is refused", bad.ok === false && bad.code === "invalid_args", bad.text);

  const unknown = t.call("delete_everything", {});
  check("an unknown op is refused", unknown.ok === false && unknown.code === "unknown_op");

  const badJson = t.call("snapshot");
  check("a valid op still works after malformed calls", badJson.ok === true);
}

// ---------------------------------------------------------------------------
console.log("\nbridge_selfui — query filter keeps numbering stable");

{
  const t = boot(`
    <button>Save</button>
    <button>Cancel</button>
    <button>Save As</button>
  `);
  const all = t.call("snapshot");
  const filtered = t.call("snapshot", { query: "Save" });

  // The whole economy of `query` rests on this: a filtered listing must
  // return refs that still mean what they meant in the unfiltered census.
  const refInBoth = /\[(\d+)\] button "Save"/.exec(filtered.text);
  check("query filters the listing", filtered.text.includes("Save") && !filtered.text.includes("Cancel"), filtered.text);
  check("query reports total vs matched separately", filtered.total === 3 && filtered.matched === 2,
    `total=${filtered.total} matched=${filtered.matched}`);
  check("both calls agree on ref 1", refInBoth && refInBoth[1] === "1", refInBoth && refInBoth[0]);
  check("unfiltered census is unchanged by a filtered call", all.matched === 3);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);