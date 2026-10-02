// Relay self-control: the page-side bridge that runs inside the MAIN window
// so the agent can drive Relay's own UI through the DOM instead of through
// pixels of a screenshot.
//
// Why this exists at all: Relay is a Tauri app, so its UI is React in a
// WebView2 — the same situation as the built-in browser pane, except the
// agent already KNOWS this DOM (it is our own code). That makes coordinate
// clicking not just unnecessary but wrong: a ref into the real DOM survives a
// layout shift, costs no pixel guessing, and is verifiable by reading the
// element back. Relay's advantage over a generic computer-use agent is
// exactly that its own UI is addressable.
//
// This script is injected on demand (NOT at document start — the main window
// loads once and stays, so there is no navigation race to lose) and answers a
// single request at a time.
//
// CONTRACT
//   window.__relay_selfui(requestId, op, argsJson) -> posts the result back
//
// Every op returns a plain object; the transport is
// `window.__TAURI_INTERNALS__.invoke('app_ui_result', ...)`, which exists in
// the main window because it is a normal Tauri webview. (The browser panes
// are raw WebView2 controllers and need the chrome.webview.postMessage
// bridge instead — that is why this file exists separately rather than
// reusing bridge_snapshot.js's transport.)
(function() {
    'use strict';

    // ---- Transport ------------------------------------------------------
    // Post a result back to Rust. Never throws into the page: a failed report
    // would leave the Rust side waiting out its full timeout for an answer
    // that already exists.
    function report(requestId, payload) {
        try {
            var invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
            if (typeof invoke !== 'function') {
                console.error('[relay selfui] no Tauri invoke available');
                return;
            }
            invoke('app_ui_result', {
                requestId: String(requestId),
                payload: payload,
            });
        } catch (e) {
            console.error('[relay selfui] report failed', e);
        }
    }

    // ---- Ref plumbing ---------------------------------------------------
    // Prefers the shared contract (injected alongside this file). Falls back
    // to a local copy so the bridge still works if the shared prelude has not
    // landed in this window yet — a degraded census beats a dead tool.
    function refs() {
        if (window.__relay_refs) return window.__relay_refs;
        var SELECTOR =
            'a[href], button, input, textarea, select, [role=button], [onclick]';
        function excluded(el) {
            if (!el || el.nodeType !== 1) return true;
            if (el.getAttribute && el.getAttribute('data-relay-overlay') !== null) return true;
            var r = el.getBoundingClientRect();
            return r.width === 0 || r.height === 0;
        }
        function all() {
            var out = [];
            var els = document.querySelectorAll(SELECTOR);
            for (var i = 0; i < els.length; i++) if (!excluded(els[i])) out.push(els[i]);
            return out;
        }
        function brief(el) {
            if (!el) return '';
            var s =
                el.getAttribute('aria-label') ||
                el.getAttribute('placeholder') ||
                el.getAttribute('title') ||
                el.textContent ||
                el.getAttribute('value') ||
                '';
            s = String(s).replace(/\s+/g, ' ').trim();
            return s.length > 60 ? s.slice(0, 59) + '…' : s;
        }
        return {
            SELECTOR: SELECTOR,
            all: all,
            brief: brief,
            isExcluded: excluded,
            byRef: function(r) {
                return document.querySelector('[data-relay-ref="' + r + '"]');
            },
            refOf: function(el) {
                var els = all();
                for (var i = 0; i < els.length; i++) if (els[i] === el) return i + 1;
                return 0;
            },
            tag: function() {
                var els = all();
                for (var i = 0; i < els.length; i++) {
                    els[i].setAttribute('data-relay-ref', String(i + 1));
                }
                return els.length;
            },
        };
    }

    // Elements the agent must never see or click.
    //
    // This is the self-control equivalent of "exclude the terminal from
    // screenshots" in Claude Code. Relay's own agent-facing chrome — the
    // composer's Send button, the Stop control, the approval dialog's
    // Approve/Deny buttons — is where the model's own leash lives. A snapshot
    // that offered a ref for "Stop" would hand a confused or injected model a
    // button that ends its own turn, and one that offered "Approve" would let
    // it approve itself. Both are marked `data-relay-agent-exclude` by the
    // frontend; this is the enforcement point.
    function isAgentExcluded(el) {
        if (el.closest && el.closest('[data-relay-agent-exclude]')) return true;
        return false;
    }

    function census(includeExcluded) {
        var R = refs();
        var els = R.all();
        var out = [];
        // Numbering runs over the FILTERED list so a ref never points at an
        // excluded element — the numbering and the census must agree or a ref
        // would silently mean something different from what it listed.
        var n = 0;
        for (var i = 0; i < els.length; i++) {
            if (!includeExcluded && isAgentExcluded(els[i])) continue;
            n++;
            els[i].setAttribute('data-relay-ref', String(n));
            out.push({ ref: n, el: els[i] });
        }
        return out;
    }

    function describe(el) {
        var R = refs();
        var t = (el.tagName || '?').toLowerCase();
        var label = R.brief(el);
        return t + (label ? ' "' + label + '"' : '');
    }

    function ok(text, extra) {
        var p = { ok: true, text: text };
        if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) p[k] = extra[k];
        return p;
    }

    function fail(text, code) {
        return { ok: false, text: text, code: code || 'app_ui_error' };
    }

    // ---- Ops ------------------------------------------------------------

    // `snapshot` — the observe read. One line per actionable element, no
    // page text: the same token-lean shape browser_observe uses, so the model
    // has one idea of what a census looks like across both surfaces.
    //
    // `query` filters the LISTING only. Numbering is unaffected, exactly as
    // in the browser pane — a filtered result's refs stay directly actionable.
    function opSnapshot(args) {
        var want = String(args.query || '').toLowerCase().trim();
        var items = census(false);
        var lines = [];
        var total = 0;
        for (var i = 0; i < items.length; i++) {
            var el = items[i].el;
            var R = refs();
            var label = R.brief(el);
            var hay = (
                label +
                ' ' +
                (el.getAttribute('id') || '') +
                ' ' +
                (el.getAttribute('placeholder') || '') +
                ' ' +
                (el.getAttribute('role') || '') +
                ' ' +
                (el.getAttribute('type') || '')
            ).toLowerCase();
            total++;
            if (want && hay.indexOf(want) === -1) continue;
            var t = (el.tagName || '?').toLowerCase();
            var extra = '';
            if (t === 'input' || t === 'textarea') {
                var ph = el.getAttribute('placeholder');
                var ty = el.getAttribute('type');
                if (ty) extra += ' type=' + ty;
                if (ph) extra += ' placeholder="' + ph + '"';
                var v = el.value;
                if (v) extra += ' value="' + String(v).slice(0, 40) + '"';
            }
            if (t === 'select') extra += ' (use app_select_option, not a click)';
            lines.push('  [' + items[i].ref + '] ' + t + ' "' + label + '"' + extra);
        }
        var head =
            'Relay app UI — ' + items.length + ' actionable element' +
            (items.length === 1 ? '' : 's') +
            (want ? ' matching "' + args.query + '"' : '') +
            '. Refs are numbered in document order and stay valid until the UI changes.';
        if (!lines.length) {
            return ok(
                want
                    ? head + '\n  (nothing matched — try app_snapshot with no query)'
                    : head + '\n  (nothing actionable — Relay may be mid-render, or the model wants a typed command instead of UI clicking)'
            );
        }
        return ok(head + '\n' + lines.join('\n'), { total: total, matched: lines.length });
    }

    // `click` — activate by ref. Resolves through the shared census so the ref
    // means what the last snapshot said it meant, or fails with a stale-ref
    // error the model can act on rather than silently clicking a shifted
    // layout.
    function opClick(args) {
        var r = Number(args.ref);
        if (!isFinite(r) || r < 1) return fail('app_click requires an integer "ref" from app_snapshot.', 'invalid_args');
        var items = census(false);
        var hit = null;
        for (var i = 0; i < items.length; i++) if (items[i].ref === r) hit = items[i].el;
        if (!hit) {
            return fail(
                'ERROR: ref ' + r + ' is stale — no such element in the current Relay UI (it may have been re-rendered). Call app_snapshot again for fresh refs.',
                'stale_ref'
            );
        }
        var what = describe(hit);
        hit.scrollIntoView({ block: 'center' });
        hit.click();
        return ok(
            'Clicked [' + r + '] ' + what + '. Call app_snapshot to see the resulting UI.',
            { ref: r, target: what }
        );
    }

    // `type` — set a field's value by ref through the NATIVE setter. A React
    // controlled input ignores a plain `.value =` write; going through the
    // prototype's setter is what makes it register, which is the single
    // biggest source of "I typed into it and nothing happened".
    function opType(args) {
        var r = Number(args.ref);
        var text = args.text === undefined || args.text === null ? '' : String(args.text);
        if (!isFinite(r) || r < 1) return fail('app_type requires an integer "ref" from app_snapshot.', 'invalid_args');
        var items = census(false);
        var hit = null;
        for (var i = 0; i < items.length; i++) if (items[i].ref === r) hit = items[i].el;
        if (!hit) {
            return fail(
                'ERROR: ref ' + r + ' is stale — no such element in the current Relay UI. Call app_snapshot again for fresh refs.',
                'stale_ref'
            );
        }
        var what = describe(hit);
        var isField =
            'value' in hit && typeof hit.value === 'string';
        hit.focus();
        if (isField) {
            var proto =
                hit.tagName === 'TEXTAREA'
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
            var desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set) desc.set.call(hit, text);
            else hit.value = text;
        } else {
            hit.textContent = text;
        }
        hit.dispatchEvent(new Event('input', { bubbles: true }));
        hit.dispatchEvent(new Event('change', { bubbles: true }));
        return ok(
            'Typed into [' + r + '] ' + what + '. Verify with app_snapshot if the field has a visible effect.',
            { ref: r, target: what }
        );
    }

    // `press_key` — dispatch a real key on the focused element. Some of
    // Relay's own widgets (the command palette, the settings search) are
    // keyboard-driven, and a click cannot reach them.
    function opPressKey(args) {
        var key = String(args.key || '').trim();
        if (!key) return fail('app_press_key requires a non-empty "key".', 'invalid_args');
        var el = document.activeElement;
        if (!el || el === document.body) {
            return fail(
                'ERROR: nothing is focused in the Relay UI. Focus a field first (app_type or app_click), then press a key.',
                'no_focus'
            );
        }
        var parts = key.split('+');
        var main = parts[parts.length - 1];
        var mods = parts.slice(0, -1);
        function init(e) {
            e.key = key;
            e.code = main;
            e.keyCode = main === 'Enter' ? 13 : main === 'Escape' ? 27 : 0;
            for (var i = 0; i < mods.length; i++) e[mods[i].toLowerCase() + 'Key'] = true;
        }
        try {
            el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: key, code: main }));
        } catch (e) {
            // Older-style construction for engines that reject the options bag.
        }
        if (main === 'Enter') {
            var form = el.form || el.closest && el.closest('form');
            if (form && typeof form.requestSubmit === 'function') {
                try { form.requestSubmit(); } catch (e) { /* let the keydown stand alone */ }
            }
        }
        if (main === 'Escape') el.blur();
        return ok('Pressed ' + key + ' on the focused ' + (el.tagName || '?').toLowerCase() + '.');
    }

    // `select_option` — the semantic dropdown action. Clicking a <select> in
    // any web UI opens a native popup the page cannot see, so the value never
    // changes; setting the option directly is the only reliable path.
    function opSelectOption(args) {
        var r = Number(args.ref);
        var want = String(args.value === undefined ? '' : args.value);
        var items = census(false);
        var hit = null;
        for (var i = 0; i < items.length; i++) if (items[i].ref === r) hit = items[i].el;
        if (!hit) return fail('ERROR: ref ' + r + ' is stale. Call app_snapshot again.', 'stale_ref');
        if (hit.tagName !== 'SELECT') {
            return fail(
                'app_select_option: ref ' + r + ' is a <' + (hit.tagName || '?').toLowerCase() + '>, not a <select>.',
                'wrong_element'
            );
        }
        var match = null;
        var available = [];
        for (var i = 0; i < hit.options.length; i++) {
            var o = hit.options[i];
            available.push((o.text || '').trim() + (o.value ? ' (' + o.value + ')' : ''));
            if (o.value === want || (o.text || '').trim() === want) { match = o; break; }
        }
        if (!match) {
            return fail(
                'app_select_option: "' + want + '" is not an option of ref ' + r + '. Available: ' + available.join(' | '),
                'no_such_option'
            );
        }
        hit.value = match.value;
        hit.dispatchEvent(new Event('input', { bubbles: true }));
        hit.dispatchEvent(new Event('change', { bubbles: true }));
        return ok('Selected "' + (match.text || '').trim() + '" in ref ' + r + '.');
    }

    // ---- Entry point ----------------------------------------------------
    var OPS = {
        snapshot: opSnapshot,
        click: opClick,
        type: opType,
        press_key: opPressKey,
        select_option: opSelectOption,
    };

    window.__relay_selfui = function(requestId, op, argsJson) {
        var args = {};
        try {
            args = argsJson ? JSON.parse(argsJson) : {};
        } catch (e) {
            report(requestId, fail('Self-UI bridge received malformed arguments.', 'invalid_args'));
            return;
        }
        var fn = OPS[op];
        if (!fn) {
            report(requestId, fail('Unknown self-UI op "' + op + '".', 'unknown_op'));
            return;
        }
        try {
            report(requestId, fn(args || {}));
        } catch (e) {
            report(
                requestId,
                fail('self-UI op "' + op + '" threw: ' + (e && e.message ? e.message : String(e)), 'threw')
            );
        }
    };
})();