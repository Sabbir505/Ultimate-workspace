// Bridge extraction JS — injected into the active page webview via eval.
// Preceded at injection time by readability.js (vendored) which defines
// window.Readability. This file is the action body: it hardens the page
// (consent banners), tags interactive elements, runs Readability, converts
// the article content to Markdown, and returns structured JSON.
//
// The `mode` and `selector` variables are template-interpolated by the
// Rust side (JSON-escaped for safety) before injection.

(function() {
    var MODE = "MODE_PLACEHOLDER";
    var SELECTOR = "SELECTOR_PLACEHOLDER";

    // ---- helper: is the element visible? ----
    function isVisible(el) {
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    // ---- 1. Consent/cookie banner dismissal ----
    function dismissBanners() {
        // Candidate patterns: fixed/sticky overlays, dialogs, known consent IDs/classes.
        var candidates = [];
        // Fixed/sticky elements (computed style)
        var all = document.querySelectorAll('*');
        var checked = 0;
        var MAX_CHECK = 800;
        for (var i = 0; i < all.length && checked < MAX_CHECK; i++) {
            checked++;
            var el = all[i];
            try {
                var style = window.getComputedStyle(el);
                var pos = style.position;
                var id = (el.id || '').toLowerCase();
                var cls = (el.className && typeof el.className === 'string' ? el.className : '').toLowerCase();
                var role = (el.getAttribute('role') || '').toLowerCase();
                var zIndex = parseInt(style.zIndex) || 0;

                var isBanner = false;
                if ((pos === 'fixed' || pos === 'sticky') && zIndex >= 100) isBanner = true;
                if (role === 'dialog' || role === 'alertdialog') isBanner = true;
                if (id && (id.indexOf('cookie') !== -1 || id.indexOf('consent') !== -1 || id.indexOf('onetrust') !== -1 || id.indexOf('cmp') !== -1)) isBanner = true;
                if (cls && (cls.indexOf('cookie-banner') !== -1 || cls.indexOf('cookie-notice') !== -1 || cls.indexOf('consent-banner') !== -1 || cls.indexOf('cc-window') !== -1 || cls.indexOf('qc-cmp') !== -1)) isBanner = true;
                if (id && id.indexOf('gdpr') !== -1) isBanner = true;

                if (isBanner) {
                    candidates.push(el);
                    if (candidates.length >= 8) break;
                }
            } catch(e) {}
        }

        var consentRegex = /\b(accept all cookies|accept all|i agree|agree to all|got it|allow all|accept cookies|accept & close|ok\b|allow essential|consent|agree and|accept and)\b/i;
        var rejectRegex = /\b(reject all|decline|necessary only|only necessary|manage|settings|customize)\b/i;

        for (var b = 0; b < candidates.length; b++) {
            var banner = candidates[b];
            var text = (banner.innerText || banner.textContent || '').toLowerCase();
            if (text.length < 10) {
                // Small overlay — likely not a consent banner; remove if fixed overlay with no content.
                if (text.trim().length < 10) {
                    try { banner.remove(); } catch(e) {}
                }
                continue;
            }

            // Find buttons inside the banner
            var buttons = banner.querySelectorAll('button, a[role=button], [role=button], input[type=button], input[type=submit]');
            var clicked = false;

            // Try accept-pattern buttons first
            for (var j = 0; j < buttons.length; j++) {
                var btn = buttons[j];
                var btnText = (btn.innerText || btn.textContent || btn.value || '').trim();
                if (btnText && consentRegex.test(btnText)) {
                    try {
                        btn.click();
                        clicked = true;
                        break;
                    } catch(e) {}
                }
            }

            // If no accept button, try reject/decline as fallback (gets rid of the banner)
            if (!clicked) {
                for (var j = 0; j < buttons.length; j++) {
                    var btn2 = buttons[j];
                    var btnText2 = (btn2.innerText || btn2.textContent || btn2.value || '').trim();
                    if (btnText2 && rejectRegex.test(btnText2)) {
                        try {
                            btn2.click();
                            clicked = true;
                            break;
                        } catch(e) {}
                    }
                }
            }

            // If no button found, remove the banner from the DOM
            if (!clicked) {
                try { banner.remove(); } catch(e) {}
            }
        }
    }

    // ---- 2. Interactive element tagging (preserves browser_click/browser_type) ----
    // Tags every visible interactive element with a `data-relay-ref` and
    // returns a structured record. In `interactive` mode the record carries the
    // full accessibility fields (role, aria-label, form-field state, rect); in
    // the readability modes only the minimal ref/tag/label/href quadruple is
    // emitted (the extras default to null and are omitted by serde at the
    // Rust boundary). Overlay elements injected by the visual-feedback layer
    // carry `data-relay-overlay` and are explicitly excluded so they never
    // appear as targetable page content.
    function tagInteractiveElements() {
        var sel = 'a[href], button, input, textarea, select, [role=button], [onclick]';
        var els = document.querySelectorAll(sel);
        var refs = [];
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            // Skip our own visual-feedback overlay elements — they must never
            // be targetable or appear in the interactive read output.
            if (el.getAttribute && el.getAttribute('data-relay-overlay') !== null) continue;
            var r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            el.setAttribute('data-relay-ref', String(refs.length));
            var tag = el.tagName.toLowerCase();
            var label = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') ||
                el.getAttribute('placeholder') || el.getAttribute('name') || '')
                .trim().replace(/\s+/g, ' ').slice(0, 80);
            var href = tag === 'a' ? (el.getAttribute('href') || '') : null;
            var role = el.getAttribute('role') || el.tagName.toLowerCase() || null;
            var ariaLabel = el.getAttribute('aria-label') || null;
            var name = el.getAttribute('name') || null;
            var id = el.id || null;
            var value = ('value' in el && typeof el.value === 'string') ? (el.value || '') : null;
            var placeholder = el.getAttribute('placeholder') || null;
            var checked = ('checked' in el) ? !!el.checked : null;
            var disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';
            var type = el.getAttribute('type') || null;
            var rect = {
                x: Math.round(r.left),
                y: Math.round(r.top),
                width: Math.round(r.width),
                height: Math.round(r.height)
            };
            refs.push({
                ref: refs.length,
                tag: tag,
                label: label,
                href: href,
                role: role,
                ariaLabel: ariaLabel,
                name: name,
                id: id,
                value: value,
                placeholder: placeholder,
                checked: checked,
                disabled: disabled,
                type: type,
                rect: rect
            });
        }
        return refs;
    }

    // ---- 3. HTML to Markdown converter ----
    function htmlToMarkdown(html) {
        // Use a temporary DOM element to parse the HTML string
        var div = document.createElement('div');
        div.innerHTML = html;
        return nodeToMarkdown(div);
    }

    function nodeToMarkdown(node) {
        var out = '';
        var child = node.firstChild;
        while (child) {
            out += processNode(child);
            child = child.nextSibling;
        }
        return out;
    }

    function processNode(node) {
        if (node.nodeType === 3) { // Text node
            var t = node.textContent || '';
            // Collapse whitespace but preserve single spaces
            return t.replace(/\s+/g, ' ');
        }
        if (node.nodeType !== 1) return ''; // Element node only
        var tag = node.tagName ? node.tagName.toLowerCase() : '';
        var inner = nodeToMarkdown(node);
        switch (tag) {
            case 'h1': return '\n\n# ' + inner.trim() + '\n\n';
            case 'h2': return '\n\n## ' + inner.trim() + '\n\n';
            case 'h3': return '\n\n### ' + inner.trim() + '\n\n';
            case 'h4': return '\n\n#### ' + inner.trim() + '\n\n';
            case 'h5': return '\n\n##### ' + inner.trim() + '\n\n';
            case 'h6': return '\n\n###### ' + inner.trim() + '\n\n';
            case 'p': return '\n\n' + inner.trim() + '\n\n';
            case 'br': return '\n';
            case 'hr': return '\n\n---\n\n';
            case 'ul':
            case 'ol': {
                var items = node.children;
                var result = '\n';
                var idx = 1;
                for (var i = 0; i < items.length; i++) {
                    var li = items[i];
                    if (li.tagName && li.tagName.toLowerCase() === 'li') {
                        var liText = nodeToMarkdown(li).trim();
                        if (tag === 'ol') {
                            result += (idx++) + '. ' + liText + '\n';
                        } else {
                            result += '- ' + liText + '\n';
                        }
                    }
                }
                return result + '\n';
            }
            case 'li': return inner; // handled by ul/ol
            case 'blockquote': return '\n\n> ' + inner.trim().replace(/\n/g, '\n> ') + '\n\n';
            case 'pre': {
                var code = '';
                var codeEl = node.querySelector('code');
                if (codeEl) {
                    code = codeEl.textContent || '';
                } else {
                    code = node.textContent || '';
                }
                return '\n\n```\n' + code.trim() + '\n```\n\n';
            }
            case 'code':
                if (node.parentNode && node.parentNode.tagName && node.parentNode.tagName.toLowerCase() === 'pre') {
                    return inner; // handled by pre
                }
                return '`' + inner.trim() + '`';
            case 'a': {
                var href = node.getAttribute('href') || '';
                var text = inner.trim() || href;
                if (href && !href.startsWith('#')) {
                    return '[' + text + '](' + href + ')';
                }
                return text;
            }
            case 'img': {
                var alt = node.getAttribute('alt') || '';
                var src = node.getAttribute('src') || '';
                if (src) return '![' + alt + '](' + src + ')';
                return '';
            }
            case 'strong':
            case 'b': return '**' + inner.trim() + '**';
            case 'em':
            case 'i': return '*' + inner.trim() + '*';
            case 'table': return tableToMarkdown(node);
            case 'thead':
            case 'tbody':
            case 'tfoot': return inner;
            case 'tr': return '|' + inner.trim() + '|\n';
            case 'th':
            case 'td': return inner.trim() + '|';
            case 'figure':
            case 'figcaption': return inner;
            case 'span':
            case 'div':
            case 'section':
            case 'article':
            case 'main':
            case 'header':
            case 'footer':
            case 'nav':
            case 'aside':
            default:
                return inner;
        }
    }

    function tableToMarkdown(table) {
        var rows = table.querySelectorAll('tr');
        if (rows.length === 0) return '';
        var result = '\n';
        var colCount = 0;
        // Count max columns
        for (var i = 0; i < rows.length; i++) {
            var cells = rows[i].querySelectorAll('th, td');
            if (cells.length > colCount) colCount = cells.length;
        }
        for (var r = 0; r < rows.length; r++) {
            var cells = rows[r].querySelectorAll('th, td');
            result += '|';
            for (var c = 0; c < colCount; c++) {
                if (c < cells.length) {
                    result += ' ' + (cells[c].textContent || '').trim().replace(/\|/g, '\\|') + ' |';
                } else {
                    result += '  |';
                }
            }
            result += '\n';
            // Header separator after first row
            if (r === 0) {
                result += '|';
                for (var s = 0; s < colCount; s++) {
                    result += ' --- |';
                }
                result += '\n';
            }
        }
        return result + '\n';
    }

    // ---- 4. Metadata extraction ----
    function getMeta(name) {
        var el = document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]');
        return el ? (el.getAttribute('content') || '') : '';
    }

    function getLinkRel(rel) {
        var el = document.querySelector('link[rel="' + rel + '"]');
        return el ? (el.getAttribute('href') || '') : '';
    }

    function getPublishedDate() {
        // Try meta tags first
        var d = getMeta('article:published_time') || getMeta('article:published_time') || '';
        if (d) return d;
        // Try time element in article
        var timeEl = document.querySelector('article time[datetime], [itemprop="datePublished"]');
        if (timeEl) {
            var dt = timeEl.getAttribute('datetime') || timeEl.getAttribute('content') || '';
            if (dt) return dt;
        }
        return '';
    }

    // ---- 5. Paywall / login detection ----
    function detectFailure(extractedMarkdown) {
        var bodyText = ((document.body && (document.body.innerText || document.body.textContent)) || '').toLowerCase();
        var metaRobots = (getMeta('robots') || '').toLowerCase();
        var hasNoIndex = metaRobots.indexOf('noindex') !== -1;

        // Paywall patterns
        var paywallPatterns = [
            /\bsubscribe to continue\b/i,
            /\byou'?ve reached your (free|article) limit\b/i,
            /\bunlock this article\b/i,
            /\bpremium (article|content)\b/i,
            /\bstart your (free )?trial\b/i,
            /\bget unlimited access\b/i,
            /\bview our subscription options\b/i,
            /\bthis article is reserved for subscribers\b/i
        ];

        // Login patterns
        var loginPatterns = [
            /\bsign in to continue\b/i,
            /\blog in to (continue|read|view)\b/i,
            /\bplease (sign|log) in\b/i,
            /\bcreate (a|an|your) (free )?account\b/i
        ];

        var paywallOverlay = document.querySelector('[class*=paywall], [id*=paywall], [class*=subscribe-wall], [class*=meter], [id*=gate]');
        var loginForm = document.querySelector('form[action*=login], form[action*=signin], form[action*=auth]');

        var strippedMarkdown = (extractedMarkdown || '').replace(/[#*\[\]`\-\s\n]/g, '');
        var isShort = strippedMarkdown.length < 200;

        if (isShort) {
            for (var p = 0; p < paywallPatterns.length; p++) {
                if (paywallPatterns[p].test(bodyText)) return 'paywalled';
            }
            for (var l = 0; l < loginPatterns.length; l++) {
                if (loginPatterns[l].test(bodyText)) return 'login_required';
            }
            if (loginForm && hasNoIndex) return 'login_required';
            if (paywallOverlay && isShort) return 'paywalled';
            if (hasNoIndex && isShort) return 'blocked';
            // Extraction simply produced nothing useful
            return 'extraction_failed';
        }

        return null;
    }

    // ---- 6. Section extraction ----
    function extractSection(selector) {
        // If it looks like a CSS selector with # or . or >, use querySelector
        if (/[#\.\[\]>,:+~]/.test(selector)) {
            var el = document.querySelector(selector);
            if (el) return htmlToMarkdown(el.innerHTML || '');
            return '';
        }

        // Otherwise, treat it as heading text: find the heading whose text matches
        var headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
        var foundIdx = -1;
        var foundLevel = 0;
        var lowerSelector = selector.toLowerCase();
        for (var i = 0; i < headings.length; i++) {
            var h = headings[i];
            var hText = (h.textContent || '').trim().toLowerCase();
            if (hText.indexOf(lowerSelector) !== -1) {
                foundIdx = i;
                foundLevel = parseInt(h.tagName.charAt(1));
                break;
            }
        }
        if (foundIdx < 0) return '';

        // Collect content from this heading until the next same-or-higher-level heading
        var content = '';
        var h = headings[foundIdx];
        content += h.outerHTML;
        var next = h.nextElementSibling;
        while (next) {
            if (next.tagName && /^H[1-6]$/.test(next.tagName)) {
                var nextLevel = parseInt(next.tagName.charAt(1));
                if (nextLevel <= foundLevel) break;
            }
            content += next.outerHTML || next.textContent || '';
            next = next.nextElementSibling;
        }
        return htmlToMarkdown(content);
    }

    // ---- 7. Headings-only summary ----
    function extractHeadings() {
        var headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
        var lines = [];
        for (var i = 0; i < headings.length; i++) {
            var h = headings[i];
            var level = parseInt(h.tagName.charAt(1));
            var text = (h.textContent || '').trim().replace(/\s+/g, ' ');
            if (text) {
                lines.push({ level: level, text: text });
            }
        }
        return lines;
    }

    // ---- Main extraction ----
    function extract() {
        // Step 1: dismiss consent banners (mutates live DOM)
        dismissBanners();

        // Step 2: tag interactive elements (for click/type)
        var elementRefs = tagInteractiveElements();

        var mode = MODE;

        // Interactive mode short-circuits: the payload is the accessibility
        // tree (elementRefs with roles/labels/form-state/rects), not page
        // content. Skip Readability + markdown entirely — this is for an agent
        // locating and interacting with elements, not research reading.
        if (mode === 'interactive') {
            return JSON.stringify({
                markdown: '',
                title: document.title || '',
                url: location.href,
                canonicalUrl: location.href,
                publishedDate: null,
                byline: null,
                mode: mode,
                failureReason: null,
                elementRefs: elementRefs
            });
        }

        // Step 3: run Readability
        var article = null;
        var readabilityMarkdown = '';
        try {
            var reader = new Readability(document.cloneNode(true));
            article = reader.parse();
        } catch(e) {
            // Readability threw — fall back to raw body
        }

        // Step 4: collect metadata
        var title = document.title || '';
        var url = location.href;
        var canonicalUrl = getLinkRel('canonical') || url;
        var publishedDate = getPublishedDate();
        var byline = article ? (article.byline || '') : '';

        // Step 5: build markdown based on mode
        var markdown = '';

        if (mode === 'section' && SELECTOR) {
            markdown = extractSection(SELECTOR);
            if (!markdown) {
                markdown = '';
            }
        } else if (mode === 'summary_only') {
            // Headings structure + first ~1500 chars of body markdown
            var headings = extractHeadings();
            var toc = '';
            for (var i = 0; i < headings.length; i++) {
                var h = headings[i];
                toc += '#'.repeat(h.level) + ' ' + h.text + '\n';
            }
            var bodyMd = '';
            if (article && article.content) {
                bodyMd = htmlToMarkdown(article.content);
            } else if (document.body) {
                bodyMd = htmlToMarkdown(document.body.innerHTML);
            }
            var firstChars = bodyMd.replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
            markdown = '## Page Outline\n\n' + toc + '\n## Content Preview (first ~1500 chars)\n\n' + firstChars;
        } else {
            // full mode
            if (article && article.content) {
                markdown = htmlToMarkdown(article.content);
                title = article.title || title;
                byline = article.byline || '';
                publishedDate = article.publishedTime || publishedDate;
            } else if (document.body) {
                // Readability failed — fall back to body text truncated
                markdown = ((document.body && (document.body.innerText || document.body.textContent)) || '').replace(/\n{3,}/g, '\n\n').trim();
            }
        }

        // Step 6: detect failure
        var failureReason = null;
        if (mode === 'full' && markdown.length < 200) {
            failureReason = detectFailure(markdown);
        }

        // Step 7: trim markdown to a reasonable cap (50k chars)
        var MAX_MD = 50000;
        if (markdown.length > MAX_MD) {
            markdown = markdown.slice(0, MAX_MD) + '\n\n[...truncated]';
        }

        return JSON.stringify({
            markdown: markdown,
            title: title,
            url: url,
            canonicalUrl: canonicalUrl,
            publishedDate: publishedDate,
            byline: byline,
            mode: mode,
            failureReason: failureReason,
            elementRefs: elementRefs
        });
    }

    return extract();
})();