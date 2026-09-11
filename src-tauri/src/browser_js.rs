//! Injected-JavaScript builders for the browser pane: element resolution,
//! the action wrapper, click/type/scroll/hover/history/evaluate/snapshot,
//! form fill/select/press-key, and page diagnostics. Pure string builders —
//! extracted from browser.rs so the manager logic and the injected payloads
//! can be reviewed independently.
use crate::browser::{ActionOpts, BRIDGE_RESOLVE_JS, BRIDGE_SNAPSHOT_JS};

pub(crate) fn build_resolve_js(desc: &str, action: &str) -> String {
    let desc_js = serde_json::to_string(desc).unwrap_or_else(|_| "\"\"".to_string());
    let action_js = serde_json::to_string(action).unwrap_or_else(|_| "\"click\"".to_string());
    BRIDGE_RESOLVE_JS
        .replace("DESC_PLACEHOLDER", &desc_js)
        .replace("ACTION_PLACEHOLDER", &action_js)
}

/// Wrap an agentic action `body` (a JS block that `return`s a string OR a
/// Promise that resolves to a string) so it runs in the page and reports its
/// result — or an error message — back to the backend, keyed by `req_id`.
///
/// Transport (B-3): Windows panes are RAW WebView2 controllers — Tauri never
/// injects `__TAURI_INTERNALS__` there, so the old invoke-only wrapper
/// silently never reported and every action burned its 45 s timeout. The
/// wrapper now prefers `window.chrome.webview.postMessage` (WebView2's
/// native page→host bridge, handled by `attach_web_message_bridge`) and
/// falls back to Tauri IPC on tauri-managed panes (macOS/Linux). The
/// `nonce` must be echoed either way — pages in the pane are untrusted and
/// req ids are guessable.
///
/// The wrapper is promise-aware: if the body returns a thenable, the wrapper
/// awaits it before reporting. This lets the visual-feedback layer (Task 2)
/// run an async sequence (cursor tween → highlight → real click → pacing)
/// and only report once the whole chain resolves — the race guard that keeps
/// a tool result from being read before the on-screen action completes.
/// Synchronous bodies (the existing `click_js`/`type_js`/`scroll_js`) keep
/// working unchanged: their non-thenable return is reported immediately.
///
/// When `WATCH_MODE` is true the wrapper applies a `PANE_DELAY_MS` pacing
/// delay via setTimeout before calling `__report`, so a human watching can
/// follow the action at a comfortable pace. The delay gates the final report
/// (race guard): the caller reading the tool result knows the action AND
/// pacing both completed.
pub(crate) fn action_wrapper_js(req_id: u64, nonce: &str, body: &str, opts: &ActionOpts) -> String {
    let watch_mode = opts.watch_mode;
    let pane_delay_ms = opts.pane_delay_ms;
    format!(
        r#"(function() {{
    var WATCH_MODE = {watch_mode};
    var PANE_DELAY_MS = {pane_delay_ms};
    var __report = function(res) {{
        var args = {{
            reqId: {req_id},
            nonce: '{nonce}',
            result: res === undefined ? 'undefined' : String(res)
        }};
        try {{
            if (window.chrome && window.chrome.webview &&
                typeof window.chrome.webview.postMessage === 'function') {{
                args.__relay = 'action_result';
                args.cmd = 'browser_action_result';
                window.chrome.webview.postMessage(JSON.stringify(args));
                return;
            }}
        }} catch(e) {{}}
        try {{
            window.__TAURI_INTERNALS__.invoke('browser_action_result', args)
                .catch(function() {{}});
        }} catch(e) {{}}
    }};
    var __finish = function(res) {{
        // `sent` makes the report one-shot: a navigation committing during
        // the watch-mode pacing delay fires pagehide, which delivers the
        // result immediately instead of letting the (dying) context drop it
        // — the op used to burn its whole timeout in that race.
        var sent = false;
        var report = function() {{
            if (sent) return;
            sent = true;
            __report(res);
        }};
        if (WATCH_MODE) {{
            window.addEventListener('pagehide', report, {{ once: true }});
            setTimeout(report, PANE_DELAY_MS);
        }} else {{
            report();
        }}
    }};
    try {{
        var __result = (function() {{ {body} }})();
        if (__result && typeof __result.then === 'function') {{
            __result.then(
                function(v) {{ __finish(v); }},
                function(e) {{ __finish('ERROR: ' + (e && e.message ? e.message : e)); }}
            );
        }} else {{
            __finish(__result);
        }}
    }} catch(e) {{
        __finish('ERROR: ' + (e && e.message ? e.message : e));
    }}
}})();"#
    )
}

/// Legacy flat-text read JS (replaced by the readability-style bridge above,
/// but kept for the click_js / type_js tests that check the ref-tagging pattern).
/// The interactive-element ref scheme (data-relay-ref + non-zero-bounding-rect
/// guard) is preserved in the new bridge_extract.js.
#[allow(dead_code)]
pub(crate) const READ_PAGE_JS: &str = r#"
var sel = 'a[href], button, input, textarea, select, [role=button], [onclick]';
var els = Array.prototype.slice.call(document.querySelectorAll(sel));
var lines = [];
var i = 0;
els.forEach(function(el) {
    var r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    el.setAttribute('data-relay-ref', String(i));
    var tag = el.tagName.toLowerCase();
    var label = (el.innerText || el.value || el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') || el.getAttribute('name') || '')
        .trim().replace(/\s+/g, ' ').slice(0, 80);
    var extra = tag === 'a' ? (el.getAttribute('href') || '')
        : (el.getAttribute('type') || '');
    lines.push('[' + i + '] ' + tag + (extra ? '(' + extra + ')' : '') +
        (label ? ' ' + JSON.stringify(label) : ''));
    i++;
});
var text = (document.body ? document.body.innerText : '')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, 6000);
return 'URL: ' + location.href + '\nTITLE: ' + document.title +
    '\n\nINTERACTIVE ELEMENTS (ref | tag | label):\n' +
    (lines.length ? lines.join('\n') : '(none found)') +
    '\n\nPAGE TEXT:\n' + text;
"#;

/// Click the element tagged with `data-relay-ref="{r}"`. Returns a JS body
/// (for `action_wrapper_js`) that returns a PROMISE: it tweens the synthetic
/// cursor to the element, shows a ripple, THEN fires the real click — so a
/// human watching can follow the action, and the tool result is only reported
/// once the whole sequence (and the real DOM click) completes (Task #7 race
/// guard). The overlay primitives come from bridge_overlay.js (injected after
/// navigation + lazily by __relay_injectOverlay).
pub(crate) fn click_js(r: i64, narrate: Option<&str>) -> String {
    let narrate_js = match narrate {
        Some(t) => {
            let esc = serde_json::to_string(t).unwrap_or_else(|_| "null".to_string());
            format!("if (typeof __relay_narrate === 'function') __relay_narrate({esc});")
        }
        None => String::new(),
    };
    format!(
        r#"
{narrate_js}
var el = document.querySelector('[data-relay-ref="{r}"]');
if (!el) return 'ERROR: ref {r} is stale — no element with this ref on the current page. The page changed since the ref was assigned; re-read the page (read_page or find) to get fresh refs.';
function doClick() {{
    el.scrollIntoView({{block: 'center'}});
    el.click();
    return 'Clicked ref {r}. Current URL: ' + location.href + '. Call browser_read to see the resulting page.';
}}
// Graceful degradation: if the visual overlay isn't installed yet (page loaded
// before the post-nav injection fired, or the primitives got cleared), skip the
// cursor/ripple and just click. Functionality never depends on the visuals.
if (typeof __relay_tweenCursor !== 'function') {{ return doClick(); }}
var rect = el.getBoundingClientRect();
var cx = rect.left + rect.width / 2;
var cy = rect.top + rect.height / 2;
__relay_highlight(rect);
return __relay_tweenCursor(cx, cy, 150).then(function() {{
    __relay_showRipple(cx, cy);
    return doClick();
}}).then(function(msg) {{
    setTimeout(function() {{ __relay_fadeHighlight(); }}, 250);
    return msg;
}});
"#
    )
}

/// Type `text` into the element tagged with `data-relay-ref="{r}"`. Returns a
/// JS body that returns a PROMISE: it tweens the cursor to the field, shows a
/// caret, then inserts the text CHARACTER BY CHARACTER (~14ms±6ms per char,
/// randomized) dispatching real keydown/keyup/input events per keystroke —
/// this is functionally required (not just visual) so React/Vue controlled
/// inputs register the change the same way a real user typing does. The tool
/// result reports only after the last keystroke (Task #7 race guard).
pub(crate) fn type_js(r: i64, text: &str, narrate: Option<&str>) -> String {
    let js_text = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string());
    let narrate_js = match narrate {
        Some(t) => {
            let esc = serde_json::to_string(t).unwrap_or_else(|_| "null".to_string());
            format!("if (typeof __relay_narrate === 'function') __relay_narrate({esc});")
        }
        None => String::new(),
    };
    format!(
        r#"
{narrate_js}
var el = document.querySelector('[data-relay-ref="{r}"]');
if (!el) return 'ERROR: ref {r} is stale — no element with this ref on the current page. The page changed since the ref was assigned; re-read the page (read_page or find) to get fresh refs.';
var text = {js_text};
function doTypePlain() {{
    el.focus();
    if ('value' in el && typeof el.value === 'string') {{ el.value = text; }} else {{ el.textContent = text; }}
    el.dispatchEvent(new Event('input', {{bubbles: true}}));
    el.dispatchEvent(new Event('change', {{bubbles: true}}));
    return 'Typed into ref {r}.';
}}
// Graceful degradation when the overlay primitives aren't installed yet.
if (typeof __relay_tweenCursor !== 'function') {{ return doTypePlain(); }}
var rect = el.getBoundingClientRect();
var cx = rect.left + rect.width / 2;
var cy = rect.top + rect.height / 2;
__relay_highlight(rect);
return __relay_tweenCursor(cx, cy, 150).then(function() {{
    el.focus();
    __relay_showCaret(cx + rect.width / 2 - 2, cy);
    var existing = ('value' in el && typeof el.value === 'string') ? el.value : '';
    var i = 0;
    function next() {{
        if (i >= text.length) {{
            el.dispatchEvent(new Event('input', {{bubbles: true}}));
            el.dispatchEvent(new Event('change', {{bubbles: true}}));
            __relay_hideCaret();
            setTimeout(function() {{ __relay_fadeHighlight(); }}, 200);
            return 'Typed into ref {r}.';
        }}
        var ch = text[i];
        try {{ el.dispatchEvent(new KeyboardEvent('keydown', {{key: ch, bubbles: true}})); }} catch(e) {{}}
        if ('value' in el && typeof el.value === 'string') {{
            el.value = existing + text.slice(0, i + 1);
        }} else {{
            el.textContent = existing + text.slice(0, i + 1);
        }}
        try {{ el.dispatchEvent(new KeyboardEvent('keyup', {{key: ch, bubbles: true}})); }} catch(e) {{}}
        el.dispatchEvent(new Event('input', {{bubbles: true}}));
        var r2 = el.getBoundingClientRect();
        __relay_showCaret(r2.left + Math.min(r2.width, 8), r2.top + r2.height / 2 - 9);
        i++;
        var delay = 8 + Math.random() * 12;
        return new Promise(function(resolve) {{ setTimeout(function() {{ resolve(next()); }}, delay); }});
    }}
    return next();
}});
"#
    )
}

pub(crate) fn scroll_js(dy: i64) -> String {
    format!(
        r#"
window.scrollBy(0, {dy});
return 'Scrolled by {dy}px. scrollY=' + Math.round(window.scrollY) +
    ' of ' + Math.round(document.body ? document.body.scrollHeight : 0) + '.';
"#
    )
}

/// Hover (dispatch true mouseover/mouseenter/mousemove) over the element tagged
/// with `data-relay-ref="{r}"`. Needed for CSS-`:hover` menus and dropdowns
/// that reveal on hover before a click is possible. Real MouseEvents with
/// `bubbles:true` are required so React/Vue `onMouseEnter` handlers fire the
/// same way they do for a real cursor. Returns a Promise like click_js (cursor
/// tween → hover events), degrading gracefully without the overlay.
pub(crate) fn hover_js(r: i64) -> String {
    format!(
        r#"
var el = document.querySelector('[data-relay-ref="{r}"]');
if (!el) return 'ERROR: ref {r} is stale — no element with this ref on the current page. The page changed since the ref was assigned; re-read the page (read_page or find) to get fresh refs.';
var rect = el.getBoundingClientRect();
var cx = Math.max(rect.left + Math.max(rect.width / 2, 1), 1);
var cy = Math.max(rect.top + Math.max(rect.height / 2, 1), 1);
function doHover() {{
    var opts = {{ bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }};
    // Real user hover emits mouseover (bubbles, target=el) then mouseenter
    // (non-bubbling, listens on ancestor) for each ancestor in the chain that
    // has a listener, plus a leading mousemove so CSS :hover (:hover applies
    // on any pointing-device movement over the element) activates.
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    try {{ el.dispatchEvent(new MouseEvent('mouseenter', opts)); }} catch(e) {{}}
    return 'Hovered ref {r}. Menus toggled by :hover should now be visible.';
}}
if (typeof __relay_tweenCursor !== 'function') {{ return doHover(); }}
__relay_highlight(rect);
return __relay_tweenCursor(cx, cy, 150).then(function() {{
    var msg = doHover();
    setTimeout(function() {{ __relay_fadeHighlight(); }}, 250);
    return msg;
}});
"#
    )
}

/// Drive the webview's real history stack and report the resulting URL. Unlike
/// `self.eval(...)` (fire-and-forget), this uses the awaited `run_action` bridge
/// so the tool result carries whether navigation actually left the page and the
/// new URL. `direction` is "back" | "forward". history.go(-1)/go(1) fire the
/// same `popstate`/`browser:navigated` bookkeeping as a real browser button.
pub(crate) fn history_js(direction: &str) -> String {
    let go = if direction == "forward" { "history.go(1)" } else { "history.go(-1)" };
    format!(
        r#"
var before = location.href;
{go};
return 'Navigating {direction} from ' + before + '. New URL (after settle): ' + location.href + '.';
"#
    )
}

/// Evaluate arbitrary JS in the page and return a JSON-serialized result. The
/// expression may reference the live DOM; `new Function('return (<expr>);')`
/// lets a bare expression (e.g. `document.title`) or a statement block both
/// work, and JSON.stringify preserves the value's real shape (numbers, strings,
/// arrays, plain objects) instead of string-coercing it. Functions, undefined,
/// and circular structures are turned into readable markers. Cross-origin and
/// untrusted-page caveats apply: this runs in the pane's own origin.
pub(crate) fn evaluate_js(expression: &str) -> String {
    let expr_js = serde_json::to_string(expression).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"
var __expr = {expr_js};
var __replacer = function(k, v) {{
    if (typeof v === 'function') return '[Function]';
    if (typeof v === 'undefined') return '[undefined]';
    if (v && typeof v === 'object') {{
        try {{ JSON.stringify(v); return v; }} catch (e) {{ return '[circular]'; }}
    }}
    return v;
}};
try {{
    var __fn = new Function('return (' + __expr + ');');
    var __value = __fn.call(window);
    if (typeof __value === 'undefined') return '[undefined]';
    return JSON.stringify(__value, __replacer);
}} catch (e) {{
    return 'ERROR: ' + e.message;
}}
"#
    )
}

/// Compact interactive snapshot (`include_snapshot` on action results, and the
/// `find` tool when a query is given). The QUERY placeholder is the
/// JSON-escaped filter string ("" lists everything).
pub(crate) fn snapshot_js(query: Option<&str>) -> String {
    let q = serde_json::to_string(query.unwrap_or("")).unwrap_or_else(|_| "\"\"".to_string());
    BRIDGE_SNAPSHOT_JS.replace("QUERY_PLACEHOLDER", &q)
}

/// Set form-field values DIRECTLY by ref (no per-keystroke typing) — the fast
/// path for forms. `fields` is a JSON array `[{"ref": 2, "text": "a@b.c"}, …]`
/// (already validated/clamped by the MCP layer). Uses the native value setter
/// so React/Vue controlled inputs register the change, then fires
/// input+change. Returns per-field results so a partial failure is visible.
pub(crate) fn fill_form_js(fields: &str) -> String {
    format!(
        r#"
var fields = {fields};
var results = [];
function setDirect(el, text) {{
    var isValue = ('value' in el && typeof el.value === 'string');
    el.focus();
    if (isValue) {{
        // React-controlled inputs ignore direct .value writes unless the
        // NATIVE setter is used — this is the standard workaround.
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) {{ desc.set.call(el, text); }} else {{ el.value = text; }}
    }} else {{
        el.textContent = text;
    }}
    el.dispatchEvent(new Event('input', {{bubbles: true}}));
    el.dispatchEvent(new Event('change', {{bubbles: true}}));
    el.blur();
}}
for (var i = 0; i < fields.length; i++) {{
    var f = fields[i];
    var el = document.querySelector('[data-relay-ref="' + f.ref + '"]');
    if (!el) {{ results.push({{ ref: f.ref, ok: false, error: 'stale — no element with this ref on the current page; re-read to get fresh refs' }}); continue; }}
    try {{
        setDirect(el, String(f.text == null ? '' : f.text));
        results.push({{ ref: f.ref, ok: true }});
    }} catch (e) {{
        results.push({{ ref: f.ref, ok: false, error: String(e && e.message ? e.message : e) }});
    }}
}}
var failed = results.filter(function(r) {{ return !r.ok; }}).length;
return 'fill_form: ' + (results.length - failed) + '/' + results.length + ' fields set' + (failed ? ' — ' + failed + ' failed (stale refs re-read needed)' : '') + '. ' + JSON.stringify(results);
"#
    )
}

/// Select an `<option>` in a `<select>` by value OR visible text, using the
/// native setter + input/change events so React/Vue wrappers fire. Dropdowns
/// are the classic a11y-click failure mode (Invariant Labs) — this is the
/// direct semantic action.
pub(crate) fn select_option_js(r: i64, value: &str) -> String {
    let val = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"
var el = document.querySelector('[data-relay-ref="{r}"]');
if (!el) return 'ERROR: ref {r} is stale — no element with this ref on the current page. Re-read the page (read_page or find) to get fresh refs.';
if (el.tagName !== 'SELECT') return 'ERROR: ref {r} is a ' + el.tagName.toLowerCase() + ', not a <select>.';
var want = {val};
var match = null;
for (var i = 0; i < el.options.length; i++) {{
    var opt = el.options[i];
    if (opt.value === want || (opt.text || '').trim() === want) {{ match = opt; break; }}
}}
if (!match) {{
    for (var j = 0; j < el.options.length; j++) {{
        var opt2 = el.options[j];
        if ((opt2.text || '').toLowerCase().indexOf(want.toLowerCase()) !== -1) {{ match = opt2; break; }}
    }}
}}
if (!match) {{
    var avail = [];
    for (var k = 0; k < el.options.length && k < 12; k++) avail.push(el.options[k].text);
    return 'ERROR: no option matching ' + JSON.stringify(want) + '. Available: ' + JSON.stringify(avail);
}}
var proto = HTMLSelectElement.prototype;
var desc = Object.getOwnPropertyDescriptor(proto, 'value');
if (desc && desc.set) {{ desc.set.call(el, match.value); }} else {{ el.value = match.value; }}
el.dispatchEvent(new Event('input', {{bubbles: true}}));
el.dispatchEvent(new Event('change', {{bubbles: true}}));
return 'Selected ' + JSON.stringify(match.text || match.value) + ' in ref {r}.';
"#
    )
}

/// Press a key on the currently-focused element (or body). Synthetic
/// keydown/keypress/keyup don't trigger browser DEFAULT actions (Enter won't
/// submit a form by itself), so an Enter on a form control explicitly calls
/// form.requestSubmit() — guarded, and only when the form has no submit-on
/// Enter conflict. Escape blurs (closes lightweight menus).
pub(crate) fn press_key_js(key: &str) -> String {
    let k = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"
var key = {k};
var target = document.activeElement || document.body;
var o = {{ key: key, code: key, bubbles: true, cancelable: true }};
// Common aliases → KeyboardEvent.code values (code matters to some apps).
var codes = {{ Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Backspace: 'Backspace', Delete: 'Delete', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End' }};
if (codes[key]) o.code = codes[key];
target.dispatchEvent(new KeyboardEvent('keydown', o));
try {{ target.dispatchEvent(new KeyboardEvent('keypress', o)); }} catch (e) {{}}
target.dispatchEvent(new KeyboardEvent('keyup', o));
var extra = '';
if (key === 'Enter' && target.tagName === 'INPUT') {{
    var form = target.form;
    if (form) {{
        try {{ if (typeof form.requestSubmit === 'function') {{ form.requestSubmit(); extra = ' (form submitted)'; }} }} catch (e) {{}}
    }}
}}
if (key === 'Escape' && typeof target.blur === 'function') {{ try {{ target.blur(); }} catch (e) {{}} }}
return 'Pressed ' + JSON.stringify(key) + ' on ' + target.tagName.toLowerCase() + (target.id ? '#' + target.id : '') + extra + '.';
"#
    )
}

/// Read the diagnostics ring buffer (`console` | `network`) incrementally:
/// entries with seq > `since`, plus the latest seq so the agent can resume.
pub(crate) fn diag_read_js(kind: &str, since: u64) -> String {
    format!(
        r#"
var diag = window.__relayDiag;
if (!diag) return JSON.stringify({{ entries: [], latest: 0, installed: false }});
var since = {since};
var arr = diag.{kind} || [];
var out = [];
for (var i = 0; i < arr.length; i++) {{ if (arr[i].seq > since) out.push(arr[i]); }}
return JSON.stringify({{ entries: out, latest: diag.seq, installed: true }});
"#
    )
}

/// DOM-stability probe for `wait_for: stable` — readyState complete AND no DOM
/// mutation in the last ~600ms (via the diagnostics MutationObserver). When
/// the diag layer isn't installed (pre-injection page), lastMutation stays 0
/// and the probe degrades to the readyState check.
pub fn stable_check_js() -> String {
    r#"
var diag = window.__relayDiag;
var quiet = !diag || (Date.now() - diag.lastMutation) > 600;
return JSON.stringify({ stable: document.readyState === 'complete' && quiet });
"#
    .to_string()
}
