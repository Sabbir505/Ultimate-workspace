// Visual feedback overlay for agent-driven browser actions (Task #2 / #7).
// Injected into the pane's webview via eval (alongside bridge_extract.js and
// the pushState monkey-patch). All overlay elements carry `data-conduit-overlay`
// so bridge_extract.js::tagInteractiveElements excludes them from the
// accessibility tree (they must never appear as targetable page content).
//
// This file DEFINES the overlay primitives + injection; the actual action
// bodies (click/type) that sequence them live in click_js()/type_js() in
// browser.rs, which call these globals. Everything here is idempotent:
// __conduit_injectOverlay() is a no-op if the overlay already exists, and is
// called lazily by every action so a fresh page load (which clears injected
// DOM) re-installs it.

(function() {
    if (window.__conduit_overlay_installed) return;

    var STYLE_ID = '__conduit_overlay_style';
    var CURSOR_ID = '__conduit_cursor';
    var RIPPLE_ID = '__conduit_ripple';
    var HIGHLIGHT_ID = '__conduit_highlight';
    var CARET_ID = '__conduit_caret';

    // Accent glow token — matches the app's pane-state glow (global.css
    // --accent-glow: terracotta rgba(193,95,60,..)). Kept inline so the overlay
    // works on arbitrary external pages that don't load the app's CSS.
    var ACCENT = 'rgba(193, 95, 60, 1)';
    var ACCENT_SOFT = 'rgba(193, 95, 60, 0.35)';

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.setAttribute('data-conduit-overlay', '');
        style.textContent = [
            '#' + CURSOR_ID + ' {',
            '  position: fixed; left: 0; top: 0; width: 18px; height: 18px;',
            '  pointer-events: none; z-index: 2147483647;',
            '  margin-left: -2px; margin-top: -2px; opacity: 0;',
            '  transition: opacity 0.15s ease-out;',
            '  background: ' + ACCENT + ';',
            '  border: 2px solid #fff; border-radius: 50%;',
            '  box-shadow: 0 1px 4px rgba(0,0,0,0.4), 0 0 8px ' + ACCENT_SOFT + ';',
            '}',
            '#' + CURSOR_ID + '.__conduit_visible { opacity: 1; }',
            '#' + RIPPLE_ID + ' {',
            '  position: fixed; pointer-events: none; z-index: 2147483647;',
            '  width: 20px; height: 20px; border-radius: 50%;',
            '  border: 2px solid ' + ACCENT + ';',
            '  background: ' + ACCENT_SOFT + ';',
            '  transform: translate(-50%, -50%) scale(0); opacity: 0;',
            '}',
            '#' + HIGHLIGHT_ID + ' {',
            '  position: fixed; pointer-events: none; z-index: 2147483646;',
            '  border-radius: 4px; border: 2px solid ' + ACCENT + ';',
            '  box-shadow: 0 0 12px 0 ' + ACCENT_SOFT + ';',
            '  opacity: 0; transition: opacity 0.12s ease-out;',
            '}',
            '#' + HIGHLIGHT_ID + '.__conduit_visible { opacity: 1; }',
            '#' + CARET_ID + ' {',
            '  position: fixed; pointer-events: none; z-index: 2147483647;',
            '  width: 2px; height: 18px; background: ' + ACCENT + ';',
            '  animation: __conduit_blink 1s steps(2, start) infinite;',
            '  opacity: 0;',
            '}',
            '#' + CARET_ID + '.__conduit_visible { opacity: 1; }',
            '@keyframes __conduit_blink { to { visibility: hidden; } }'
        ].join('\n');
        (document.head || document.documentElement).appendChild(style);
    }

    function ensureEl(id, extraAttrs) {
        var el = document.getElementById(id);
        if (el) return el;
        el = document.createElement('div');
        el.id = id;
        el.setAttribute('data-conduit-overlay', '');
        if (extraAttrs) extraAttrs(el);
        document.documentElement.appendChild(el);
        return el;
    }

    // Public: install the overlay (idempotent). Called after navigation and
    // lazily by every action body.
    window.__conduit_injectOverlay = function() {
        injectStyle();
        ensureEl(CURSOR_ID);
        ensureEl(RIPPLE_ID);
        ensureEl(HIGHLIGHT_ID);
        ensureEl(CARET_ID);
        window.__conduit_overlay_installed = true;
    };

    // Public: tween the cursor from its last position to (x,y) over durationMs.
    // Returns a Promise that resolves when the tween completes (so the caller
    // fires the real action only after the cursor has arrived — the race guard).
    window.__conduit_tweenCursor = function(toX, toY, durationMs) {
        return new Promise(function(resolve) {
            window.__conduit_injectOverlay();
            var cursor = document.getElementById(CURSOR_ID);
            if (!cursor) { resolve(); return; }
            var fromX = parseFloat(cursor.style.left) || toX;
            var fromY = parseFloat(cursor.style.top) || toY;
            cursor.classList.add('__conduit_visible');
            cursor.style.transition = 'left ' + durationMs + 'ms cubic-bezier(0.22,1,0.36,1), top ' + durationMs + 'ms cubic-bezier(0.22,1,0.36,1), opacity 0.15s ease-out';
            // Force a reflow so the transition picks up the new target.
            // eslint-disable-next-line no-unused-expressions
            cursor.offsetWidth;
            cursor.style.left = toX + 'px';
            cursor.style.top = toY + 'px';
            setTimeout(resolve, durationMs);
        });
    };

    // Public: show an expanding ripple at (x,y), ~300ms scale+fade.
    window.__conduit_showRipple = function(x, y) {
        window.__conduit_injectOverlay();
        var ripple = document.getElementById(RIPPLE_ID);
        if (!ripple) return;
        ripple.style.left = x + 'px';
        ripple.style.top = y + 'px';
        ripple.style.transition = 'none';
        ripple.style.transform = 'translate(-50%, -50%) scale(0.2)';
        ripple.style.opacity = '1';
        // eslint-disable-next-line no-unused-expressions
        ripple.offsetWidth; // reflow
        ripple.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-out';
        ripple.style.transform = 'translate(-50%, -50%) scale(1.6)';
        ripple.style.opacity = '0';
    };

    // Public: outline a target element's rect (pre-action highlight).
    window.__conduit_highlight = function(rect) {
        window.__conduit_injectOverlay();
        var hl = document.getElementById(HIGHLIGHT_ID);
        if (!hl) return;
        hl.style.left = (rect.x - 2) + 'px';
        hl.style.top = (rect.y - 2) + 'px';
        hl.style.width = (rect.width + 4) + 'px';
        hl.style.height = (rect.height + 4) + 'px';
        hl.classList.add('__conduit_visible');
    };

    window.__conduit_fadeHighlight = function() {
        var hl = document.getElementById(HIGHLIGHT_ID);
        if (hl) hl.classList.remove('__conduit_visible');
    };

    // Public: show/hide the synthetic caret at (x,y) during typing.
    window.__conduit_showCaret = function(x, y) {
        window.__conduit_injectOverlay();
        var caret = document.getElementById(CARET_ID);
        if (!caret) return;
        caret.style.left = x + 'px';
        caret.style.top = y + 'px';
        caret.classList.add('__conduit_visible');
    };
    window.__conduit_hideCaret = function() {
        var caret = document.getElementById(CARET_ID);
        if (caret) caret.classList.remove('__conduit_visible');
    };

    window.__conduit_overlay_installed = false;
    // Install immediately on injection; navigation re-injection re-runs this.
    window.__conduit_injectOverlay();
})();
