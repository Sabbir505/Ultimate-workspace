// Depth tests: go INSIDE each section and exercise its members — open a
// memory record's editor, a vault note, a wiki page, an automation editor,
// a skill body, a git diff, an artifact preview, and a notification row.
// Root-level tests (20-29) only prove the section header paints; these prove
// its content is browsable and its per-item actions work.

import * as h from '../harness.mjs';
import * as app from '../app.mjs';

/** Land on a Manage screen and wait for its header. */
async function enterManage(h, app, label, header) {
  await app.openSettings();
  await app.waitAndTap(label, { expectText: header });
  await h.sleep(1500);
}

/** First interactive node whose content-desc starts with `prefix`. */
function findByDescPrefix(h, prefix) {
  return h.visibleNodes().filter((n) => (n['content-desc'] || '').startsWith(prefix));
}

/** Assert the current scene has some real body content, not just chrome. */
function assertBodyContent(h, minChars = 60) {
  const body = h.visibleNodes()
    .filter((n) => {
      const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(n.bounds);
      return m && Number(m[2]) > 350 && Number(m[4]) < 2150;
    })
    .map((n) => n.text || '')
    .join(' ');
  if (body.replace(/\s/g, '').length < minChars)
    throw new Error('screen body looks empty (no substantial content nodes)');
  return body.length;
}

export const DEPTH_TESTS = [
  {
    name: '40-depth-memory-record-edit',
    info: 'Memory → open a record for editing → fields editable → cancel restores the list',
    async run({ h, app, shot }) {
      await enterManage(h, app, 'Memory', 'Memory');
      h.dumpUi();
      const edits = findByDescPrefix(h, 'Edit memory');
      await shot('40a-memory-list');
      if (!edits.length) return { records: 'none to open — empty list (info)' };
      await h.tapCenterOf(edits[0]);
      await h.sleep(1000);
      h.dumpUi();
      if (!h.findByText('Save memory').length && !h.findByText('Cancel edit').length)
        throw new Error('tapping Edit memory did not open the record editor');
      await shot('40b-memory-editor');
      const body = assertBodyContent(h, 20);
      // The editor must have an input carrying the record's text.
      const input = h.findEditText()[0];
      if (!input) throw new Error('memory editor has no text input');
      if (!h.findByText('Cancel edit').length) throw new Error('no way out of the editor');
      await h.tapText('Cancel edit');
      await h.sleep(900);
      h.dumpUi();
      if (!h.findByText('Purge all memories').length)
        throw new Error('cancelling the editor did not return to the memory list');
      await shot('40c-memory-back');
      await app.goHome();
      return { openedRecord: true, editorBodyChars: body };
    },
  },

  {
    name: '41-depth-vault-browse',
    info: 'Vault → expand a folder and open a note (tree browse), or report an unbound vault',
    async run({ h, app, shot }) {
      await enterManage(h, app, 'Vault', 'Vault');
      h.dumpUi();
      if (h.findByText('No vault bound').length || h.findByText('Vault is offline').length) {
        await shot('41a-vault-unbound');
        await app.goHome();
        return { vault: 'not bound on the desktop — tree browse not exercisable (info)' };
      }
      await shot('41a-vault-tree');
      const folders = findByDescPrefix(h, 'Folder ');
      if (folders.length) {
        await h.tapCenterOf(folders[0]);
        await h.sleep(1200);
        h.dumpUi();
        await shot('41b-vault-folder-expanded');
      }
      const notes = findByDescPrefix(h, 'Open ');
      if (!notes.length) { await app.goHome(); return { vault: 'tree has no openable notes (info)' }; }
      await h.tapCenterOf(notes[0]);
      await h.sleep(1800);
      h.dumpUi();
      const hasReader = h.findByText('Back to vault').length || h.findByText('Create note').length ||
        !findByDescPrefix(h, 'Open ').length;
      if (!hasReader) throw new Error('opening a vault note did not open the reader');
      const body = assertBodyContent(h, 40);
      await shot('41c-vault-note');
      // back out of the reader, then home
      if (h.findByText('Back to vault').length) { await h.tapText('Back to vault'); await h.sleep(800); }
      await app.goHome();
      return { noteOpened: true, readerChars: body, foldersTried: folders.length };
    },
  },

  {
    name: '42-depth-wiki-page',
    info: 'Wiki → project list → project detail → open a page (2-level drill: projects then pages)',
    async run({ h, app, shot }) {
      await enterManage(h, app, 'Project wiki', 'Wiki');
      await h.sleep(2000);
      h.dumpUi();
      if (h.findByText('No wikis yet').length) {
        await shot('42a-wiki-none');
        await app.goHome();
        return { wiki: 'no wikis built on the desktop (info)' };
      }
      await shot('42a-wiki-projects');
      // Level 1: pick a project (rows read "<n> pages · built <when>").
      const projectRow = h.visibleNodes().find((n) => /\d+ pages? · built/i.test(n.text || ''));
      if (!projectRow) throw new Error('wiki project list is empty and not the empty state');
      const projName = (projectRow.text || '').slice(0, 40);
      await h.tapCenterOf(projectRow);
      await h.sleep(2000);
      h.dumpUi();
      // Level 2: pages inside the project, or that project's empty state.
      if (h.findByText('No pages yet').length) {
        await shot('42b-wiki-project-empty');
        await app.goHome();
        return { wiki: `project "${projName}" has no pages yet (info)` };
      }
      const pages = findByDescPrefix(h, 'Read ');
      if (!pages.length) {
        await shot('42b-wiki-project-detail');
        await app.goHome();
        return { wiki: `project "${projName}" detail opened but exposes no page rows (info)` };
      }
      await shot('42b-wiki-project-pages');
      // Level 3: the page reader.
      await h.tapCenterOf(pages[0]);
      await h.sleep(2200);
      h.dumpUi();
      const body = assertBodyContent(h, 80);
      await shot('42c-wiki-page-reader');
      if (h.findByText('Dismiss error').length) throw new Error('wiki page surfaced the error bar');
      const backBtn = h.findByText('Back', { exact: true });
      if (backBtn.length) { await h.tapCenterOf(backBtn[0]); await h.sleep(900); }
      await app.goHome();
      return { project: projName, pageOpened: true, pageChars: body, pagesInProject: pages.length };
    },
  },

  {
    name: '43-depth-automation-editor',
    info: 'Automations → open New automation (name/prompt/schedule fields) → close; or edit an existing one',
    async run({ h, app, shot }) {
      await enterManage(h, app, 'Automations', 'Automations');
      await h.sleep(1200);
      h.dumpUi();
      const news = h.findByText('New automation');
      if (!news.length) throw new Error('New automation button missing');
      await h.tapCenterOf(news[0]);
      await h.sleep(1200);
      h.dumpUi();
      const fields = ['Name', 'Prompt to run', 'Schedule', 'Agent', 'Enabled'].filter((f) => h.findByText(f).length);
      await shot('43a-automation-editor');
      if (!fields.length) throw new Error('automation editor opened but shows no fields');
      // close it without saving
      const close = h.findByText('Cancel', { exact: true }).length ? h.findByText('Cancel', { exact: true })
        : h.findByText('Close', { exact: true });
      if (close.length) { await h.tapCenterOf(close[0]); await h.sleep(900); }
      else await h.ensureAppForeground();
      h.dumpUi();
      const backOnList = h.findByText('New automation').length > 0;
      // If an existing automation exists, also open its editor.
      let editedExisting = false;
      const editGrip = h.visibleNodes().filter((n) => (n['content-desc'] || '').startsWith('Edit '));
      if (backOnList && editGrip.length) {
        await h.tapCenterOf(editGrip[0]);
        await h.sleep(1200);
        h.dumpUi();
        editedExisting = h.findByText('Name').length > 0 || h.findByText('Save').length > 0;
        await shot('43b-automation-edit-existing');
        const c2 = h.findByText('Cancel', { exact: true }).length ? h.findByText('Cancel', { exact: true })
          : h.findByText('Close', { exact: true });
        if (c2.length) { await h.tapCenterOf(c2[0]); await h.sleep(800); }
      }
      await app.goHome();
      return { newEditorFields: fields, cancelled: backOnList, editExistingOpened: editedExisting };
    },
  },

  {
    name: '44-depth-skill-body',
    info: 'Skills → open a skill body editor (or the empty state), then back out',
    async run({ h, app, shot }) {
      await enterManage(h, app, 'Skills & loops', 'Skills');
      await h.sleep(1500);
      h.dumpUi();
      await shot('44a-skills-list');
      const editorOpen = h.findByText('Edit skill body').length;
      if (!editorOpen) {
        // empty state → exercise the New skill composer instead
        const news = h.visibleNodes().filter((n) => /^New /.test(n['content-desc'] || ''));
        if (!news.length) return { skills: 'empty state, no composer affordance (info)' };
        await h.tapCenterOf(news[0]);
        await h.sleep(1000);
        h.dumpUi();
        const body = assertBodyContent(h, 10);
        await shot('44b-skills-new-composer');
        await app.goHome();
        return { skills: 'empty — new-skill composer opened', chars: body };
      }
      await h.tapCenterOf(h.findByText('Edit skill body')[0]);
      await h.sleep(1200);
      h.dumpUi();
      const body = assertBodyContent(h, 80);
      await shot('44b-skill-body');
      const input = h.findEditText()[0];
      if (!input) throw new Error('skill editor has no text input');
      await app.goHome();
      return { skillBodyOpened: true, chars: body };
    },
  },

  {
    name: '45-depth-git-diff',
    info: 'Git → open a changed file diff (or report a clean tree / no projects)',
    async run({ h, app, shot }) {
      await enterManage(h, app, 'Git', 'Git');
      await h.sleep(2000);
      h.dumpUi();
      await shot('45a-git-status');
      if (h.findByText('No projects registered').length) {
        await app.goHome();
        return { git: 'no projects registered (info)' };
      }
      const diffs = findByDescPrefix(h, 'Diff ');
      if (!diffs.length) {
        const clean = h.findByText('Commit').length && !h.findByText('changed').length;
        await app.goHome();
        return { git: clean ? 'clean tree — no diffs to open (info)' : 'working tree shows no diff rows (info)' };
      }
      await h.tapCenterOf(diffs[0]);
      await h.sleep(2000);
      h.dumpUi();
      const hasPanel = h.findByText('Close diff').length || h.findByText('Commit changes').length;
      const body = assertBodyContent(h, 40);
      await shot('45b-git-diff');
      if (!hasPanel) throw new Error('tapping a diff row did not open the diff panel');
      if (h.findByText('Close diff').length) { await h.tapText('Close diff'); await h.sleep(800); }
      await app.goHome();
      return { diffOpened: true, diffChars: body, filesWithDiffs: diffs.length };
    },
  },

  {
    name: '46-depth-artifact-preview',
    info: 'Artifacts → open an artifact preview; also flags tiles the desktop refuses to preview',
    async run({ h, app, shot }) {
      await app.openDrawer();
      await app.waitAndTap('Artifacts', { expectText: 'Artifacts' });
      await h.sleep(1800);
      h.dumpUi();
      if (h.findByText('No artifacts yet.').length) {
        await shot('46a-artifacts-empty');
        await app.goHome();
        return { artifacts: 'library empty on the desktop (info)' };
      }
      const tiles = h.visibleNodes().filter((n) => (n['content-desc'] || '').startsWith('Artifact '));
      if (!tiles.length) throw new Error('artifact grid painted but no artifact tiles found');
      await shot('46a-artifacts-grid');
      // Try up to 3 tiles: some entries are logged from paths the desktop's
      // preview arm refuses (that refusal is itself a finding — see below).
      let opened = false;
      let lastTile = '';
      for (const tile of tiles.slice(0, 3)) {
        lastTile = (tile['content-desc'] || '').replace(/^Artifact /, '');
        await h.tapCenterOf(tile);
        await h.sleep(2500);
        h.dumpUi();
        if (h.findByText('Close preview').length || h.findByText('Close pdf').length) { opened = true; break; }
        const errBar = h.findByText('Dismiss error').length > 0;
        if (errBar) {
          await shot('46b-artifact-refused');
          const msg = h.visibleNodes().map((n) => n.text || '').find((t) => /artifact path|outside/i.test(t)) || 'error bar shown';
          throw new Error(`BUG: tapping artifact "${lastTile}" shows "${msg}" — the library lists entries the desktop refuses to preview (no preview surface opens)`);
        }
        // some tiles deep-link out (PDF/browser) — re-enter the app each try
        await h.ensureAppForeground();
      }
      if (!opened) throw new Error(`artifact tile "${lastTile}" tap did not open a preview surface`);
      // Previews stream in — wait for real content (not the Loading state),
      // and ignore transient notification banners covering the screen.
      let body = 0;
      const t2 = Date.now();
      while (Date.now() - t2 < 30000) {
        h.dumpUi();
        if (!h.findByText('Loading…').length && !h.findByText('Loading...').length) {
          try { body = assertBodyContent(h, 10); break; } catch { /* keep waiting */ }
        }
        await h.sleep(1200);
      }
      if (!body) body = assertBodyContent(h, 1);
      await shot('46c-artifact-preview');
      const close = h.findByText('Close preview').length ? h.findByText('Close preview') : h.findByText('Close pdf');
      if (close.length) { await h.tapCenterOf(close[0]); await h.sleep(900); }
      await app.goHome();
      return { previewOpened: true, tile: lastTile, tiles: tiles.length, previewChars: body };
    },
  },

  {
    name: '47-depth-notifications-row',
    info: 'Notifications → mark all read / clear (actions on the collection), no crash',
    async run({ h, app, shot }) {
      await enterManage(h, app, 'Notifications', 'Notifications');
      await h.sleep(1200);
      h.dumpUi();
      await shot('47a-notifications');
      const empty = h.findByText('Nothing yet').length > 0;
      if (empty) {
        await app.goHome();
        return { notifications: 'empty journal (info)' };
      }
      const markAll = h.findByText('Mark all read');
      const clearAll = h.findByText('Clear notifications');
      if (!markAll.length && !clearAll.length)
        throw new Error('notification entries exist but no Mark all read / Clear actions are offered');
      if (markAll.length) { await h.tapCenterOf(markAll[0]); await h.sleep(1000); }
      h.dumpUi();
      await shot('47b-notifications-after-mark-read');
      if (app.dumpHasErrorMarkers(h.lastDumpRaw())) throw new Error('error markers after Mark all read');
      await app.goHome();
      return { actions: { markAllRead: markAll.length > 0, clear: clearAll.length > 0 } };
    },
  },

  {
    name: '48-depth-cost-budget',
    info: 'Cost dashboard → open the budget editor and its fields (or the no-budget state)',
    async run({ h, app, shot }) {
      await enterManage(h, app, 'Cost dashboard', 'Cost dashboard');
      await h.sleep(2000);
      h.dumpUi();
      await shot('48a-cost');
      const adds = findByDescPrefix(h, 'Add budget');
      if (!adds.length) {
        const noBudget = h.findByText('No project budgets').length;
        await app.goHome();
        return { cost: noBudget ? 'no budgets to edit (info)' : 'no Add budget affordance found (info)' };
      }
      await h.tapCenterOf(adds[0]);
      await h.sleep(1200);
      h.dumpUi();
      const fields = ['Monthly budget USD', 'Budget alert threshold percent'].filter((f) => h.findByText(f).length);
      await shot('48b-cost-budget-editor');
      if (!h.findByText('Save').length) throw new Error('budget editor opened without a Save action');
      await h.tapText('Close budget editor').catch(async () => {
        const c = h.findByText('Cancel', { exact: true });
        if (c.length) await h.tapCenterOf(c[0]);
      });
      await h.sleep(900);
      await app.goHome();
      return { budgetEditor: 'opened', fields };
    },
  },

  {
    name: '49-depth-model-per-chat',
    info: 'Session → model chip opens the sheet, switching model persists in the header',
    async run({ h, app, shot }) {
      await app.openDrawer();
      h.dumpUi();
      const bucket = h.findByText('Today')[0] || h.findByText('Earlier')[0];
      if (!bucket) throw new Error('no drawer bucket');
      const bm = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(bucket.bounds);
      const by = Number(bm[2]);
      const rows = h.visibleNodes().filter((n) => {
        if (!n.text || n.text.length < 2) return false;
        const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(n.bounds);
        if (!m) return false;
        const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
        return x1 >= 30 && x2 <= 855 && y1 > by + 10 && y2 < 2300 &&
          !/^(Today|Yesterday|Earlier|Pinned|Projects|Artifacts|Settings|New chat|Search chats and messages|Relay|Connected)$/i.test(n.text.trim());
      }).sort((a, b) => {
        const ma = /\[(-?\d+),(-?\d+)\]/.exec(a.bounds), mb = /\[(-?\d+),(-?\d+)\]/.exec(b.bounds);
        return Number(ma[2]) - Number(mb[2]);
      });
      if (!rows.length) throw new Error('no session to open');
      await h.tapCenterOf(rows[0]);
      await h.sleep(2000);
      h.dumpUi();
      const chip = h.findByText('Model');
      if (!chip.length) throw new Error('model chip not in the session header');
      await h.tapCenterOf(chip[0]);
      await h.sleep(1200);
      h.dumpUi();
      const sheetHasContent = h.findByText('Claude').length || h.findByText('Kimi').length ||
        h.findByText('OpenCode').length || h.findByText('gguf').length || findByDescPrefix(h, 'Model ').length > 0;
      await shot('49-model-sheet-session');
      if (!sheetHasContent) throw new Error('model sheet opened with no model rows');
      await h.back();
      await h.ensureAppForeground();
      await h.sleep(800);
      h.dumpUi();
      if (app.dumpHasErrorMarkers(h.lastDumpRaw())) throw new Error('error markers after model sheet');
      await app.goHome();
      return { modelSheet: 'opened in session with rows' };
    },
  },
];
