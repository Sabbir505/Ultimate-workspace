// Temporary verification harness — exercises bridge_extract.js + readability
// in jsdom as the closest automated proxy to the real-site manual verification
// (which requires driving the live Tauri webview — not possible from here).
// Safe to delete after the task.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const repoRoot = path.resolve(__dirname, '..');
const readability = fs.readFileSync(path.join(repoRoot, 'src-tauri/src/bridge_readability.js'), 'utf8');
const bridge = fs.readFileSync(path.join(repoRoot, 'src-tauri/src/bridge_extract.js'), 'utf8');

function runBridge(html, mode, selector, onAccept) {
  const dom = new JSDOM(html, { url: 'https://example.com/article', runScripts: 'outside-only', pretendToBeVisual: true });
  const ctx = dom.getInternalVMContext();
  vm.runInContext(readability, ctx);
  if (onAccept && dom.window.document.getElementById('accept-btn')) {
    dom.window.document.getElementById('accept-btn').addEventListener('click', onAccept);
  }
  // Match build_extract_js: serde_json::to_string adds outer quotes; the Rust
  // code then strips them, injecting the *inner* escaped string into the already
  // quoted placeholder. Replicate that here.
  const inner = (s) => JSON.stringify(s).slice(1, -1);
  const body = bridge
    .replace('MODE_PLACEHOLDER', inner(mode))
    .replace('SELECTOR_PLACEHOLDER', inner(selector || ''));
  return JSON.parse(vm.runInContext(body, ctx));
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS:', name); }
  else { fail++; console.log('FAIL:', name, extra ? '-> ' + JSON.stringify(extra).slice(0, 200) : ''); }
}

// 1. Full article: boilerplate stripped, main content intact
const article = `<!DOCTYPE html><html><head><title>How Rust Does Memory</title>
<link rel="canonical" href="https://example.com/article/rust-mem">
<meta property="article:published_time" content="2026-07-25T10:00:00Z">
</head><body>
<nav><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li></ul></nav>
<header><div class="ad">BUY NOW</div></header>
<article>
<h1>How Rust Does Memory</h1>
<p>By Jane Doe</p>
<p>Rust uses an ownership model rather than a garbage collector. This is the core idea that makes memory safety possible without runtime overhead.</p>
<h2>Ownership Rules</h2>
<p>Each value has exactly one owner. When the owner goes out of scope, the value is dropped.</p>
<ul><li>Variable scope matters</li><li>No double free</li></ul>
</article>
<footer><nav><a href="/privacy">Privacy</a></nav>Copyright 2026</footer>
</body></html>`;
const r1 = runBridge(article, 'full', null);
check('full: title extracted', /memory/i.test(r1.title), r1.title);
check('full: canonical url', r1.canonicalUrl === 'https://example.com/article/rust-mem', r1.canonicalUrl);
check('full: published date', r1.publishedDate && r1.publishedDate.indexOf('2026-07-25') === 0, r1.publishedDate);
check('full: main content present', r1.markdown.indexOf('ownership model') !== -1);
check('full: h2 preserved', r1.markdown.indexOf('## Ownership Rules') !== -1);
check('full: list preserved', r1.markdown.indexOf('- Variable scope') !== -1);
check('full: ad stripped', r1.markdown.indexOf('BUY NOW') === -1);
check('full: footer stripped', r1.markdown.indexOf('Copyright 2026') === -1);
check('full: no failure reason', r1.failureReason === null, r1.failureReason);
// NOTE: jsdom has no layout engine — getBoundingClientRect returns 0x0 for
// every element, so the bridge's non-zero-rect guard (same guard the original
// READ_PAGE_JS used) filters all interactive elements out. In a real WebView2
// the guard works correctly. We verify the TAGGING logic fires instead: run
// against a doc where we monkeypatch getBoundingClientRect to return non-zero.
const tagDom = new JSDOM(article, { url: 'https://example.com/article', runScripts: 'outside-only', pretendToBeVisual: true });
const tagCtx = tagDom.getInternalVMContext();
vm.runInContext(readability, tagCtx);
// jsdom returns 0x0 rects; emulate a real browser by giving every element a
// non-zero rect so the visibility guard passes (real WebView2 has layout).
vm.runInContext('Element.prototype.getBoundingClientRect = function(){ return {width:100,height:20,top:0,left:0,right:100,bottom:20,x:0,y:0}; };', tagCtx);
let tagBody = bridge.replace('MODE_PLACEHOLDER', 'full').replace('SELECTOR_PLACEHOLDER', '');
const rTag = JSON.parse(vm.runInContext(tagBody, tagCtx));
check('full: elementRefs populated (click/type regression)', rTag.elementRefs && rTag.elementRefs.length > 0, rTag.elementRefs);
check('full: elementRefs include the Home link', rTag.elementRefs.some(e => e.tag === 'a' && (e.label || '').toLowerCase().indexOf('home') !== -1), rTag.elementRefs);

// 2. Cookie consent banner auto-dismissed
const banner = `<!DOCTYPE html><html><head><title>Cookies Galore</title></head><body>
<article><h1>Main Article Body</h1><p>This is the real article content that should survive extraction. ${'x'.repeat(300)}</p></article>
<div id="onetrust-banner-sdk" style="position:fixed;bottom:0;z-index:9999">
  <p>We use cookies. Accept all cookies to continue.</p>
  <button id="accept-btn">Accept all cookies</button>
  <button id="reject-btn">Reject all</button>
</div></body></html>`;
let clicked = false;
const r2 = runBridge(banner, 'full', '', () => { clicked = true; });
check('banner: accept button auto-clicked', clicked);
check('banner: article survives', r2.markdown.indexOf('real article content') !== -1);
check('banner: banner text stripped', r2.markdown.indexOf('Accept all cookies') === -1);

// 3. summary_only: smaller payload + outline. Use a LONG article so the
// 1500-char summary floor is genuinely smaller than the full extraction.
const longArticle = `<!DOCTYPE html><html><head><title>Big Doc</title></head><body>
<article>
<h1>Big Doc</h1>
<h2>Part One</h2><p>${'alpha '.repeat(400)}</p>
<h2>Part Two</h2><p>${'beta '.repeat(400)}</p>
<h2>Part Three</h2><p>${'gamma '.repeat(400)}</p>
</article></body></html>`;
const rFull = runBridge(longArticle, 'full', null);
const r3 = runBridge(longArticle, 'summary_only', null);
check('summary: has outline', r3.markdown.indexOf('Page Outline') !== -1);
check('summary: smaller than full', r3.markdown.length < rFull.markdown.length, { s: r3.markdown.length, f: rFull.markdown.length });

// 4. section mode: only content under a heading
const sectionDoc = `<!DOCTYPE html><html><head><title>Long Doc</title></head><body>
<article>
<h2>Installation</h2><p>Install with cargo. ${'a'.repeat(200)}</p>
<h2>Usage</h2><p>Use it like this. ${'b'.repeat(200)}</p>
<h2>Advanced</h2><p>Advanced topics ${'c'.repeat(200)}</p>
</article></body></html>`;
const r4 = runBridge(sectionDoc, 'section', 'Usage');
check('section: targeted content present', r4.markdown.indexOf('Use it like this') !== -1);
check('section: other sections excluded', r4.markdown.indexOf('Install with cargo') === -1 && r4.markdown.indexOf('Advanced topics') === -1);

// 5. Paywall detection
const paywall = `<!DOCTYPE html><html><head><title>Premium Story</title></head><body>
<article><h1>Premium Story</h1></article>
<div class="paywall-overlay"><p>Subscribe to continue reading this article.</p><button>Subscribe</button></div>
</body></html>`;
const r5 = runBridge(paywall, 'full', null);
check('paywall: failureReason set', r5.failureReason !== null, r5.failureReason);
check('paywall: reason is paywalled', r5.failureReason === 'paywalled', r5.failureReason);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
