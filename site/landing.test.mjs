import { test, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import html from './index.html?raw';
import script from './src/main.js?raw';

function setup() {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  dom.window.eval(script);
  return dom;
}

test('the page shows real app captures, not hand-built mocks', () => {
  const dom = setup();
  const document = dom.window.document;
  const desktop = document.querySelector('.app-shot img');
  expect(desktop).not.toBeNull();
  expect(desktop.getAttribute('src')).toBe('./app-desktop.webp');
  expect(desktop.getAttribute('alt').length).toBeGreaterThan(40);
  expect(desktop.getAttribute('width')).toBe('1800');
  expect(desktop.getAttribute('height')).toBe('975');

  const mobile = document.querySelector('.phone-visual img');
  expect(mobile).not.toBeNull();
  expect(mobile.getAttribute('src')).toBe('./app-mobile.webp');
  expect(mobile.getAttribute('alt').length).toBeGreaterThan(40);
  expect(mobile.getAttribute('width')).toBe('1179');
  expect(mobile.getAttribute('height')).toBe('2556');

  // The page must not resurrect the invented project name the old mock used.
  expect(document.body.textContent).not.toMatch(/\borbit\b/i);
  dom.window.close();
});

test('page asserts the hero, the workspace, and the capability pillars', () => {
  const dom = setup();
  const document = dom.window.document;
  for (const text of [
    'One workspace.', 'Many minds.', 'One window. Your whole project.',
    'Session Mesh', 'Vault', 'Automations', 'Mobile', 'Claude Code', 'OpenCode',
  ]) {
    expect(document.body.textContent, text).toContain(text);
  }
  dom.window.close();
});

test('the page names every supported agent CLI and the built-in chat path', () => {
  const dom = setup();
  const document = dom.window.document;
  const agents = document.querySelector('.agent-names').textContent;
  for (const name of ['Claude Code', 'Kimi Code', 'OpenCode', 'Pi', 'Omp', 'CommandCode']) {
    expect(agents, name).toContain(name);
  }
  expect(document.body.textContent).toMatch(/built-in chat/i);
  dom.window.close();
});

test('every referenced icon resolves to a defined symbol', () => {
  const dom = setup();
  const document = dom.window.document;
  const defined = new Set([...document.querySelectorAll('symbol')].map((s) => `#${s.id}`));
  const used = [...document.querySelectorAll('use')].map((u) => u.getAttribute('href'));
  expect(used.length).toBeGreaterThan(0);
  for (const href of new Set(used)) expect(defined, href).toContain(href);
  dom.window.close();
});

test('navigation anchors resolve and downloads use the real release page', () => {
  const dom = setup();
  const document = dom.window.document;
  expect(document.querySelectorAll('h1').length).toBe(1);
  expect(document.querySelectorAll('details > summary').length).toBe(7);
  for (const link of document.querySelectorAll('a[href^="#"]')) {
    const hash = link.getAttribute('href');
    if (hash !== '#') expect(document.getElementById(hash.slice(1)), hash).not.toBeNull();
  }
  for (const link of document.querySelectorAll('a')) {
    if (link.textContent.includes('Get Relay')) {
      expect(link.href).toBe('https://github.com/Sabbir505/relay-releases/releases/latest');
    }
  }
  dom.window.close();
});
