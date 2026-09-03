// Compact interactive snapshot + element search (Phase 1 agent core).
//
// Injected via BrowserManager::run_action_for_pane and wrapped by
// action_wrapper_js. Placeholders are template-interpolated by the Rust side
// as JSON-escaped JS string literals:
//   QUERY  — case-insensitive substring filter ("find" mode); empty = list all.
//
// Ref contract: tags interactive elements with `data-conduit-ref` in document
// order using the SAME selector + overlay exclusion as bridge_extract.js and
// bridge_resolve.js, so ref numbers are identical across read_page,
// snapshot, find, and click/type/hover for a given page state — and stay
// stable until the DOM materially changes (the agent re-reads to refresh).
//
// Output is token-lean: one line per element, ~`[N] role "label" attrs`, no
// JSON trees, no coordinates, form state compressed to `value=`/`checked`/
// `disabled` markers. Selects list their first options inline so the agent
// can call select_option without a second read.

(function() {
    var QUERY = QUERY_PLACEHOLDER;

    // Keep in exact sync with bridge_extract.js::tagInteractiveElements and
    // bridge_resolve.js — one selector, one numbering.
    var sel = 'a[href], button, input, textarea, select, [role=button], [onclick]';
    var els = document.querySelectorAll(sel);
    var want = QUERY.toLowerCase().trim();
    var lines = [];
    var listed = 0;
    var MAX_LIST = 250;
    var total = 0;

    function brief(s, n) {
        s = (s || '').replace(/\s+/g, ' ').trim();
        return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }

    for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.getAttribute && el.getAttribute('data-conduit-overlay') !== null) continue;
        var r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        el.setAttribute('data-conduit-ref', String(total));
        var ref = total++;

        var tag = el.tagName.toLowerCase();
        var role = el.getAttribute('role') || tag;
        var label = brief(
            el.getAttribute('aria-label') || el.innerText || el.textContent ||
            el.value || el.getAttribute('placeholder') || el.getAttribute('name') || '',
            60);
        var parts = ['[' + ref + ']', role];
        if (label) parts.push(JSON.stringify(label));

        if (tag === 'a') {
            var href = el.getAttribute('href') || '';
            if (href) parts.push(brief(href, 60));
        }
        if (tag === 'input' || tag === 'textarea') {
            var type = el.getAttribute('type');
            if (type && type !== 'text') parts.push('type=' + type);
            if ('value' in el && el.value) parts.push('value=' + JSON.stringify(brief(el.value, 40)));
            if (el.getAttribute('placeholder')) parts.push('ph=' + JSON.stringify(brief(el.getAttribute('placeholder'), 30)));
            if (el.required) parts.push('required');
        }
        if (tag === 'select') {
            var opts = el.options || [];
            var names = [];
            for (var o = 0; o < opts.length && names.length < 5; o++) names.push(brief(opts[o].text, 24));
            parts.push('options=[' + names.join('|') + (opts.length > 5 ? '|…' : '') + ']');
            if (el.selectedIndex >= 0 && opts[el.selectedIndex]) {
                parts.push('selected=' + JSON.stringify(brief(opts[el.selectedIndex].text, 30)));
            }
        }
        if (el.getAttribute('aria-checked') === 'true' || el.checked === true) parts.push('checked');
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
        if (el.id) parts.push('#' + el.id);

        // find mode: filter by query across label/role/id/value (still tag
        // EVERY element so refs stay consistent with the unfiltered view).
        if (want) {
            var hay = (label + ' ' + role + ' ' + (el.id || '') + ' ' +
                (el.getAttribute('placeholder') || '') + ' ' +
                ('value' in el ? el.value || '' : '')).toLowerCase();
            if (hay.indexOf(want) === -1) continue;
        }
        if (listed < MAX_LIST) {
            lines.push(parts.join(' '));
            listed++;
        }
    }

    var header = 'PAGE ' + location.href + (document.title ? ' — ' + brief(document.title, 80) : '');
    if (want) header = 'FOUND ' + listed + ' of ' + total + ' interactive elements for ' + JSON.stringify(QUERY) + '\n' + header;
    else header += '\n' + total + ' interactive elements';
    if (total > listed) header += ' (showing first ' + listed + ')';

    return header + '\n' + (lines.length ? lines.join('\n') : '(none)');
})();