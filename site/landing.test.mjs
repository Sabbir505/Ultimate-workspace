import { test } from 'vitest';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import html from './index.html?raw';
import script from './src/main.js?raw';

function setup() {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  dom.window.eval(script);
  return dom;
}

test('workspace tabs replace the panel and update accessibility state', () => {
  const dom = setup();
  const document = dom.window.document;
  const panel = document.querySelector('#demo-panel');
  for (const [id, text] of [['review', 'A second perspective'], ['models', 'Choose where'], ['build', 'CommandMenu.tsx']]) {
    document.querySelector(`#tab-${id}`).click();
    assert.match(panel.textContent, new RegExp(text));
    assert.equal(panel.getAttribute('aria-labelledby'), `tab-${id}`);
    assert.equal(document.querySelectorAll('[aria-selected="true"]').length, 1);
    assert.equal(document.querySelector(`#tab-${id}`).tabIndex, 0);
  }
  dom.window.close();
});

test('page asserts the redesigned hero, panes, and workspace content', () => {
  const dom = setup();
  const document = dom.window.document;
  for (const text of ['One workspace.', 'Many minds.', 'One project. Three perspectives.', 'Session Mesh', 'In the loop.', 'Claude Code', 'OpenCode']) {
    assert.ok(document.body.textContent.includes(text), text);
  }
  assert.deepEqual(
    [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent.trim()),
    ['Build together', 'Review changes', 'Run locally'],
  );
  dom.window.close();
});

test('arrow, Home, and End keys select tabs and move focus', () => {
  const dom = setup();
  const document = dom.window.document;
  let current = document.querySelector('#tab-build');
  for (const [key, expected] of [['ArrowLeft', 'models'], ['ArrowRight', 'build'], ['End', 'models'], ['Home', 'build'], ['ArrowRight', 'review']]) {
    current.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    current = document.querySelector(`#tab-${expected}`);
    assert.equal(document.activeElement, current);
    assert.equal(current.getAttribute('aria-selected'), 'true');
  }
  dom.window.close();
});

test('navigation anchors resolve and downloads use the real release page', () => {
  const dom = setup();
  const document = dom.window.document;
  assert.equal(document.querySelectorAll('h1').length, 1);
  assert.equal(document.querySelectorAll('details > summary').length, 5);
  for (const link of document.querySelectorAll('a[href^="#"]')) {
    const hash = link.getAttribute('href');
    if (hash !== '#') assert.ok(document.getElementById(hash.slice(1)), hash);
  }
  for (const link of document.querySelectorAll('a')) {
    if (link.textContent.includes('Get Relay')) {
      assert.equal(link.href, 'https://github.com/Sabbir505/Ultimate-workspace/releases/latest');
    }
  }
  dom.window.close();
});
