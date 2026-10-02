// The ONE definition of Relay's ref contract, shared by every surface that
// hands the model element references.
//
// Before this file, the contract was duplicated verbatim across three bridge
// files — bridge_snapshot.js, bridge_extract.js::tagInteractiveElements, and
// bridge_resolve.js — each carrying a "keep in exact sync" comment. That is
// three hand-maintained copies of a correctness-critical invariant: ref N
// must mean the SAME element on every read, or a click lands somewhere the
// model never asked for. A shared helper makes divergence impossible instead
// of merely discouraged.
//
// The contract, in one place:
//   * WHICH elements are targetable — a selector, plus the exclusions.
//   * HOW they are numbered — document order, 1-based, skipping nothing but
//     the exclusions. Numbering is stable until the DOM materially changes;
//     the model re-reads to refresh.
//   * HOW an element is described — the same brief() label derivation, so a
//     label in the snapshot and a label in the read cannot disagree.
//
// Installed as `window.__relay_refs` by the page-side prelude. Every consumer
// degrades safely: if the helper is absent (a page that navigated mid-inject,
// or an older cached bundle) each caller falls back to its own inline copy,
// so this is a de-duplication, never a new hard dependency.
(function() {
    if (window.__relay_refs) return;

    // The targetable set. Anchors with an href, the four form controls, and
    // anything that declares itself interactive through ARIA or an inline
    // onclick handler. Deliberately broad: a missed element is unreachable,
    // while a spurious one only costs the model a wasted click on something
    // that turns out to be inert.
    var SELECTOR =
        'a[href], button, input, textarea, select, [role=button], [onclick]';

    // Agent-facing overlay nodes (the visual-feedback cursor, ripples, carets,
    // highlights). They are injected BY Relay and are never page content —
    // letting them into the census would hand the model refs that click
    // Relay's own chrome, so they are excluded everywhere, in every surface.
    function isExcluded(el) {
        if (!el || el.nodeType !== 1) return true;
        if (el.getAttribute && el.getAttribute('data-relay-overlay') !== null) return true;
        // Zero-area elements are not clickable by a human and are usually
        // layout ghosts or a collapsed control's hidden twin.
        var r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return true;
        return false;
    }

    // Every targetable element on the page, in DOCUMENT ORDER. Document order
    // (not visual/z-order) is what makes a number mean the same thing across
    // reads: it does not change when the page is merely scrolled or restyled,
    // only when the DOM itself changes.
    function all() {
        var out = [];
        var els = document.querySelectorAll(SELECTOR);
        for (var i = 0; i < els.length; i++) {
            if (!isExcluded(els[i])) out.push(els[i]);
        }
        return out;
    }

    // The 1-based ref for an element, or 0 when it is not in the census.
    // Callers use the 0 case as their "this ref is stale" signal.
    function refOf(el) {
        var els = all();
        for (var i = 0; i < els.length; i++) {
            if (els[i] === el) return i + 1;
        }
        return 0;
    }

    // Resolve a ref back to its element. The single place the
    // `data-relay-ref` attribute is written, so the attribute name and the
    // numbering can never drift apart.
    function byRef(r) {
        return document.querySelector('[data-relay-ref="' + r + '"]');
    }

    // Tag the census in document order so refs survive a round trip through
    // the DOM (the snapshot's QUERY filter, `find`, and read all narrow the
    // LISTING but never the numbering).
    function tag() {
        var els = all();
        for (var i = 0; i < els.length; i++) {
            els[i].setAttribute('data-relay-ref', String(i + 1));
        }
        return els.length;
    }

    // Collapse an element to a short human label. Shared so the text the model
    // reads in a snapshot is the text it sees quoted back in an action result.
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

    window.__relay_refs = {
        SELECTOR: SELECTOR,
        all: all,
        refOf: refOf,
        byRef: byRef,
        tag: tag,
        brief: brief,
        isExcluded: isExcluded,
    };
})();