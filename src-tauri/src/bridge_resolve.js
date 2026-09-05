// Description -> element resolution for agent-driven click/type (Task #5).
// Injected via BrowserManager::run_action_for_pane, wrapped by
// action_wrapper_js so it can return a Promise (Task #2's visual layer relies
// on this). The body is template-interpolated: DESC and TEXT are JSON-escaped
// JS string literals substituted by the Rust side before injection.
//
// Resolution strategy (in priority order):
//   1. Try DESC as a CSS selector (document.querySelector). Exact, unambiguous.
//   2. Else match DESC (case-insensitive) against each interactive element's
//      visible label / aria-label / placeholder / name / id / textContent.
//      Exact match beats substring; shorter label wins (prefer "Login" over
//      "Login with Google" when the agent said "login"); interactive tag
//      preference breaks ties (button > input > a > [role=button] > select >
//      textarea).
// Returns a JSON string:
//   {"ok":true,"ref":N,"tag":"button","label":"Login","matchType":"exact","confidence":"exact"}
//   {"ok":false,"error":"not_found","desc":"...","suggestions":[{"ref":..,"tag":..,"label":..}, ...]}
(function() {
    var DESC = DESC_PLACEHOLDER;
    var ACTION = ACTION_PLACEHOLDER; // "click" | "type"

    // Same selector + overlay-exclusion as bridge_extract.js::tagInteractiveElements,
    // kept in sync so refs match across read_page and resolve.
    var sel = 'a[href], button, input, textarea, select, [role=button], [onclick]';
    var els = document.querySelectorAll(sel);
    var tagged = [];
    for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.getAttribute && el.getAttribute('data-relay-overlay') !== null) continue;
        var r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        el.setAttribute('data-relay-ref', String(tagged.length));
        var label = (el.innerText || el.textContent || el.value ||
            el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
            el.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 120);
        tagged.push({
            el: el,
            ref: tagged.length,
            tag: el.tagName.toLowerCase(),
            label: label,
            ariaLabel: el.getAttribute('aria-label') || '',
            placeholder: el.getAttribute('placeholder') || '',
            name: el.getAttribute('name') || '',
            id: el.id || '',
            type: el.getAttribute('type') || ''
        });
    }

    // 1. CSS selector attempt.
    var direct = null;
    try { direct = document.querySelector(DESC); } catch (e) { /* not a valid selector */ }
    if (direct) {
        // Find its ref (it may not be in the interactive set if it's e.g. a div
        // with onclick — but querySelector matched it, so tag it now).
        var refAttr = direct.getAttribute('data-relay-ref');
        if (refAttr === null) {
            direct.setAttribute('data-relay-ref', String(tagged.length));
            tagged.push({
                el: direct,
                ref: tagged.length,
                tag: direct.tagName.toLowerCase(),
                label: (direct.innerText || direct.textContent || '').trim().slice(0, 120),
                ariaLabel: direct.getAttribute('aria-label') || '',
                placeholder: '', name: direct.getAttribute('name') || '', id: direct.id || '', type: ''
            });
            refAttr = String(tagged.length - 1);
        }
        return JSON.stringify({
            ok: true, ref: parseInt(refAttr, 10),
            tag: direct.tagName.toLowerCase(),
            label: (direct.innerText || direct.textContent || '').trim().slice(0, 80),
            matchType: 'css', confidence: 'exact'
        });
    }

    // 2. Description match with scoring.
    var want = DESC.toLowerCase().trim();
    // Tag preference: lower = better.
    function tagRank(tag) {
        return tag === 'button' ? 0
            : tag === 'input' ? 1
            : tag === 'a' ? 2
            : tag === '[role=button]' ? 3
            : tag === 'select' ? 4
            : 5;
    }
    // For typing, prefer actual inputs/textareas over buttons/links.
    var best = null; // {entry, matchType, score}
    for (var i = 0; i < tagged.length; i++) {
        var e = tagged[i];
        var candidates = [e.label, e.ariaLabel, e.placeholder, e.name, e.id];
        var matched = false;
        var matchType = null;
        for (var c = 0; c < candidates.length; c++) {
            var cv = (candidates[c] || '').toLowerCase();
            if (!cv) continue;
            if (cv === want) { matched = true; matchType = 'exact'; break; }
            if (cv.indexOf(want) !== -1) { matched = true; matchType = 'substring'; }
        }
        if (!matched) continue;
        // Score: exact (0) beats substring (1); then shorter label wins; then
        // tag preference; for type, inputs/textareas get a bonus.
        var score = (matchType === 'exact' ? 0 : 1000) + e.label.length + tagRank(e.tag) * 10;
        if (ACTION === 'type') {
            var isInput = (e.tag === 'input' || e.tag === 'textarea');
            if (!isInput) score += 500; // penalize non-inputs for typing
        }
        if (best === null || score < best.score) {
            best = { entry: e, matchType: matchType, score: score };
        }
    }

    if (best) {
        var conf = best.matchType === 'exact' ? 'exact' : (best.score < 1100 ? 'high' : 'low');
        return JSON.stringify({
            ok: true, ref: best.entry.ref, tag: best.entry.tag,
            label: best.entry.label, matchType: best.matchType, confidence: conf
        });
    }

    // 3. Not found — return the top 10 closest elements so the agent can retry.
    var suggestions = [];
    // Sort by label length (shortest first) then tag preference, take 10.
    var sorted = tagged.slice().sort(function(a, b) {
        if (a.label.length !== b.label.length) return a.label.length - b.label.length;
        return tagRank(a.tag) - tagRank(b.tag);
    });
    for (var s = 0; s < sorted.length && suggestions.length < 10; s++) {
        if (!sorted[s].label && !sorted[s].ariaLabel && !sorted[s].placeholder) continue;
        suggestions.push({
            ref: sorted[s].ref,
            tag: sorted[s].tag,
            label: sorted[s].label,
            ariaLabel: sorted[s].ariaLabel || undefined,
            placeholder: sorted[s].placeholder || undefined
        });
    }
    return JSON.stringify({
        ok: false, error: 'not_found', desc: DESC, suggestions: suggestions
    });
})();
