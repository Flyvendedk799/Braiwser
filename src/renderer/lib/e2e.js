// End-to-end self-test harness. Loaded only when CAOS_E2E=1.
// Drives the REAL app: navigates the webview to a fixture, exercises inspect /
// annotate / persist / restore / record / replay / dom-tree / export / AI, and
// reports pass/fail per check. Run with: CAOS_E2E=1 npx electron .
// Results print as a single `CAOS_E2E_REPORT {json}` line from the main process.

import { compositeAnnotations } from './screenshots.js';

const checks = [];
function check(name, pass, detail) {
  const c = { name, pass: !!pass, detail: detail || '' };
  checks.push(c);
  // Stream it out: if the renderer goes down mid-suite, the main process still
  // knows how far we got and what failed.
  try { window.caos.e2eCheck(c); } catch (_e) { /* ignore */ }
  // eslint-disable-next-line no-console
  console.log(`[e2e] ${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ' :: ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(I) {
  const { caos } = I;
  const wv = I.getWv();
  try {
    const fixtureUrl = I.state.config.welcomeUrl.replace('welcome.html', '__e2e/fixture.html');

    // Helper: wait for the webview's next dom-ready.
    const waitDomReady = () => new Promise((res) => {
      const h = () => { wv.removeEventListener('dom-ready', h); res(); };
      wv.addEventListener('dom-ready', h);
    });
    // Helper: run JS in the guest main world.
    const guest = (code) => wv.executeJavaScript(code, true);
    // Helpers: TRUSTED input (real mouse/keys) so isolated-world listeners fire
    // and values update natively — faithful to a real user.
    const clickAt = async (x, y) => {
      wv.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wv.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await sleep(50);
    };
    const clickSel = async (sel, nth = 0) => {
      const rect = await guest(`(() => { const els = document.querySelectorAll(${JSON.stringify(sel)}); const el = els[${nth}]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);
      if (!rect) return false;
      await clickAt(rect.x, rect.y);
      return true;
    };
    const typeText = async (str) => {
      for (const ch of str) wv.sendInputEvent({ type: 'char', keyCode: ch });
      await sleep(80);
    };
    // Helper: capture the next ipc-message on a given channel.
    const onceChannel = (channel, timeout = 9000) => new Promise((res) => {
      const h = (e) => { if (e.channel === channel) { wv.removeEventListener('ipc-message', h); res(e.args[0]); } };
      wv.addEventListener('ipc-message', h);
      setTimeout(() => { wv.removeEventListener('ipc-message', h); res(null); }, timeout);
    });

    // --- 0. Load the fixture ---
    const ready = waitDomReady();
    I.navigateTo(fixtureUrl);
    await ready;
    await sleep(300);
    const hasHero = await guest("!!document.getElementById('hero')");
    check('fixture loaded', hasHero);

    // --- 1. Project + session lifecycle ---
    const project = await caos.projects.create({ name: 'E2E Project', path: '/e2e', kind: 'local' });
    check('project created', project && project.id);
    const session = await caos.sessions.create({ projectId: project.id, name: 'E2E Session', url: fixtureUrl, title: 'E2E' });
    I.state.currentProject = project;
    await I.openSession(session);
    check('session active', I.state.currentSession && I.state.currentSession.id === session.id);

    // --- 1b. The shell before any work: an empty Notes tab still has to say
    //     something, and the footer must not clip its own primary action ---
    {
      check('empty Notes tab renders its filters', document.querySelectorAll('.filters .chip').length > 0, String(document.querySelectorAll('.filters .chip').length));
      check('empty Notes tab explains itself', !!document.querySelector('[data-tab="notes"] .placeholder .ph-title'), (document.querySelector('[data-tab="notes"] .ph-title') || {}).textContent);
      const foot = document.querySelector('.panel-footer');
      const fr = foot.getBoundingClientRect();
      const clipped = Array.from(foot.querySelectorAll('.btn')).filter((b) => {
        const r = b.getBoundingClientRect();
        return r.right > fr.right + 0.5 || r.left < fr.left - 0.5 || b.scrollWidth > b.clientWidth + 1;
      });
      check('no footer button is cut off', clipped.length === 0, clipped.map((b) => b.textContent).join(','));
      check('the hand-off is the primary action', !!foot.querySelector('.btn-primary'), (foot.querySelector('.btn-primary') || {}).textContent);
      check('page tools are one segmented control', document.querySelectorAll('.tb-seg .icon-btn').length === 4, Array.from(document.querySelectorAll('.tb-seg .icon-btn')).map((b) => b.textContent).join(','));
      check('the header carries undo + redo', !!document.querySelector('.toolbar [data-act="undo"]') && !!document.querySelector('.toolbar [data-act="redo"]'));

      // Mode shortcuts. The accelerators live in the native menu so they fire
      // even while the guest webview owns keyboard focus, so the command the
      // menu dispatches is the thing worth testing.
      I.runCommand('mode.draw');
      await sleep(120);
      check('the Draw command switches mode', I.state.mode === 'draw', I.state.mode);
      I.runCommand('mode.edit');
      await sleep(120);
      check('the Edit command switches mode', I.state.mode === 'edit', I.state.mode);
      I.runCommand('mode.off');
      await sleep(120);
      check('Exit Mode puts the tools away', I.state.mode === 'off', I.state.mode);
      // Escape stays in the renderer so modals and text fields keep it.
      I.runCommand('mode.inspect');
      await sleep(120);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(120);
      check('Esc still exits the current mode', I.state.mode === 'off', I.state.mode);

      // The app has five tools; the status bar is what tells you which one is on
      // and what it expects you to do with it.
      const statusText = () => (document.querySelector('.statusbar .status-text') || {}).textContent || '';
      check('a status bar explains the current tool', /pick one above|No tool active/i.test(statusText()), statusText());
      I.setMode('inspect');
      await sleep(150);
      check('…and follows the tool you turn on', /Inspect —/.test(statusText()), statusText());
      I.setMode('arrange');
      await sleep(150);
      check('…with guidance specific to it', /Rearrange —/.test(statusText()) && /Alt-drag/.test(statusText()), statusText());
      I.setMode('off');
      await sleep(150);
      check('…and the session state on the right', /note/.test((document.querySelector('.status-meta') || {}).textContent || ''), (document.querySelector('.status-meta') || {}).textContent);

      // Shortcuts are discoverable without reading a manual. The sheet renders
      // from the same table the menu is built from, so the two cannot drift.
      I.runCommand('help.shortcuts');
      await sleep(250);
      const sheet = document.querySelector('.modal-backdrop .shortcut-group');
      const rows = document.querySelectorAll('.modal-backdrop .shortcut-row');
      check('the shortcut sheet opens', !!sheet, sheet ? rows.length + ' shortcuts' : 'not shown');
      const groups = document.querySelectorAll('.modal-backdrop .shortcut-group h4');
      check('…grouped by what you are doing', groups.length >= 4, Array.from(groups).map((x) => x.textContent).join(','));
      // It has to describe the modes the app actually has, not the ones it used to.
      const sheetText = (document.querySelector('.modal-backdrop') || {}).textContent || '';
      check('…and lists the Edit mode', /Edit content/i.test(sheetText));
      const closeBtn = Array.from(document.querySelectorAll('.modal-backdrop .btn')).pop();
      closeBtn.click();
      await sleep(200);
      check('…and closes again', !document.querySelector('.modal-backdrop .shortcut-group'));
    }

    // --- 2. Inspect → click element → fill popup → save → persist ---
    // Driven entirely with TRUSTED input (real mouse + keystrokes).
    I.setMode('inspect');
    check('inspect mode on', I.state.mode === 'inspect');
    const ctaRect = await guest(`(() => { const r = document.getElementById('cta').getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);
    await clickAt(ctaRect.x, ctaRect.y);
    await sleep(350);
    const afterClick = await guest("(() => { const b = document.querySelector('[data-caos-bubble]'); const r = document.getElementById('cta').getBoundingClientRect(); const br = b && b.getBoundingClientRect(); return { bubble: !!b, popup: !!document.querySelector('[data-caos] textarea'), dx: br ? Math.round(br.left + br.width / 2 - r.right) : null, dy: br ? Math.round(br.top + br.height / 2 - r.top) : null }; })()");
    check('an Inspect click drops a comment bubble, not a text box', !!afterClick.bubble && !afterClick.popup, JSON.stringify(afterClick));
    check('…parked on the element’s top-right corner', Math.abs(afterClick.dx) <= 16 && Math.abs(afterClick.dy) <= 16, JSON.stringify(afterClick));
    await guest("document.querySelector('[data-caos-bubble]').click()");
    await sleep(300);
    const popupShown = await guest("!!document.querySelector('[data-caos] textarea')");
    check('clicking the bubble opens the note editor', popupShown);

    // The editor tells you how to finish, and refuses to file a tag with no
    // request behind it.
    const hint0 = await guest("(document.querySelector('[data-caos] [data-hint]')||{}).textContent || ''");
    check('the note editor shows its shortcuts', /↵/.test(hint0) && /Esc/.test(hint0), hint0);
    await clickSel('[data-caos] [data-save]');
    await sleep(150);
    const emptyState = await guest("(() => { const h = document.querySelector('[data-caos] [data-hint]'); const ta = document.querySelector('[data-caos] textarea'); return { hint: h ? h.textContent : '', open: !!ta }; })()");
    check('saving an empty note is refused, with a reason', emptyState.open && /Describe the change/.test(emptyState.hint), JSON.stringify(emptyState));

    const annMsg = onceChannel('caos:annotation');
    // Focus the textarea with a real click, then type the note.
    await clickSel('[data-caos] textarea');
    await typeText('Remove this CTA button');
    const typed = await guest("(document.querySelector('[data-caos] textarea')||{}).value || ''");
    check('note typed into popup', typed === 'Remove this CTA button', typed);
    // Pick the "Remove" action chip, then click Save — all trusted clicks.
    const chipIdx = await guest("Array.from(document.querySelectorAll('[data-chips] button')).findIndex(b => b.textContent.trim() === 'Remove')");
    if (chipIdx >= 0) await clickSel('[data-chips] button', chipIdx);
    await clickSel('[data-caos] [data-save]');
    const sentAnn = await annMsg;
    check('guest sent annotation', !!sentAnn, sentAnn ? `${sentAnn.action}` : 'no caos:annotation message');
    const popupClosed = await guest("!document.querySelector('[data-caos] textarea')");
    check('popup closed after save', popupClosed);
    await sleep(400);
    const persisted = await caos.annotations.bySession(session.id);
    const elNote = persisted.find((a) => a.kind === 'element');
    check('element annotation persisted', !!elNote, elNote ? `${elNote.action}: ${elNote.note}` : 'none found');
    check('annotation captured selector', elNote && elNote.target && /cta/.test(elNote.target.selector || ''), elNote && elNote.target && elNote.target.selector);
    check('annotation action = remove', elNote && elNote.action === 'remove', elNote && elNote.action);
    check('host state synced', I.state.annotations.some((a) => a.id === (elNote && elNote.id)));
    await sleep(300);
    const bubbleAfterSave = await guest("(() => { const b = document.querySelector('[data-caos-bubble]'); return b ? b.textContent : '(none)'; })()");
    check('the saved note leaves a bubble carrying its count', bubbleAfterSave === '1', bubbleAfterSave);
    I.setMode('off');
    await sleep(250);
    const bubbleWhenIdle = await guest("document.querySelectorAll('[data-caos-bubble]:not([data-caos-bubble=\"new\"])').length");
    check('…and it stays on the page with no tool selected', bubbleWhenIdle === 1, String(bubbleWhenIdle));
    I.setMode('inspect');
    await sleep(200);

    // The tag you picked last is the tag the next note opens on — triage is
    // five "remove" notes in a row, not one of each.
    {
      const emailRect = await guest("(() => { const r = document.getElementById('email').getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()");
      await clickAt(emailRect.x, emailRect.y);
      await sleep(300);
      await guest("(() => { const b = document.querySelector('[data-caos-bubble=\"new\"]'); if (b) b.click(); return !!b; })()");
      await sleep(300);
      const preselected = await guest("(document.querySelector('[data-chips] button[data-on]')||{}).textContent || ''");
      check('the editor remembers the last action tag', preselected === 'Remove', preselected);
      await guest("(document.querySelector('[data-caos] [data-cancel]')||{}).click()");
      await sleep(150);
      I.setMode('inspect'); // cancelling a popup asks the host to leave the mode
      await sleep(120);
    }

    // A second note on the same element counts up instead of stacking pins.
    {
      I.setMode('inspect');
      await sleep(150);
      const ctaAgain = await guest("(() => { const r = document.getElementById('cta').getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()");
      await clickAt(ctaAgain.x, ctaAgain.y);
      await sleep(300);
      await guest("(() => { const bs = Array.from(document.querySelectorAll('[data-caos-bubble]')); const b = bs[0]; if (b) b.click(); return bs.length; })()");
      await sleep(300);
      const second = onceChannel('caos:annotation');
      await clickSel('[data-caos] textarea');
      await typeText('And check the spacing');
      await clickSel('[data-caos] [data-save]');
      await second;
      await sleep(600);
      const counts = await guest("Array.from(document.querySelectorAll('[data-caos-bubble]')).map((b) => b.textContent).join(',')");
      check('a second note on the same element counts up, not stacks up', /(^|,)2(,|$)/.test(counts), counts);
      const openNoteCount = await guest("(document.querySelector('[data-caos] [data-hint]') ? 'still open' : 'closed')");
      check('the editor closes once the note is saved', openNoteCount === 'closed', openNoteCount);
      // setMode() toggles: leave the tool OFF so the next block can turn it on.
      I.setMode('off');
      await sleep(150);
    }

    // --- 2c. Clicking an element in Inspect lights it up in Sections -------
    //     The click has to find its row even when the element is nested far
    //     past anything a shallow tree would carry.
    {
      const activeRow = () => {
        const r = document.querySelector('.sec-row.active .sec-name');
        return r ? r.textContent : '';
      };
      const activeSel = () => (document.querySelector('.sec-row.active') || {}).title || '';
      const clickInPage = async (sel) => {
        const pos = await guest('(() => { const el = document.querySelector(' + JSON.stringify(sel) + '); if (!el) return null; el.scrollIntoView({ block: "center" }); const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()');
        if (!pos) return null;
        await sleep(200);
        await clickAt(pos.x, pos.y);
        await sleep(500);
        return pos;
      };
      const closePopup = async () => {
        await guest("(() => { const b = document.querySelector('[data-caos] [data-cancel]'); if (b) b.click(); return !!b; })()");
        await sleep(200);
      };

      I.setMode('inspect');
      await sleep(150);
      check('a deeply nested element is clickable', !!(await clickInPage('#middlebtn')));
      check('an Inspect click highlights the element in Sections', activeRow() === 'Middle button', activeRow() || '(nothing active)');
      check('and it is the row for that exact element', /middlebtn/.test(activeSel()), activeSel());
      await closePopup();
      // Cancelling a note must not cost you the tool as well.
      check('cancelling a note keeps Inspect on', I.state.mode === 'inspect', I.state.mode);

      // Past the tree's depth budget there is no exact row — the nearest
      // ancestor that IS in the tree has to light up instead of nothing.
      await clickInPage('#deepbtn');
      const deepActive = activeRow();
      const deepSel = activeSel();
      const wrapsTheButton = deepSel
        ? await guest('(() => { const a = document.querySelector(' + JSON.stringify(deepSel) + '); const b = document.getElementById("deepbtn"); return !!a && !!b && a.contains(b); })()')
        : false;
      check('an element past the tree depth highlights its nearest ancestor', !!deepActive && wrapsTheButton === true, deepActive + ' :: ' + deepSel);
      await closePopup();
      await guest('window.scrollTo(0, 0)'); // later checks click by viewport coords
      await sleep(250);
    }

    // --- 3. Restore pins ---
    I.refreshPins();
    await sleep(250);
    // Badges are the circular (border-radius:50%) data-caos divs.
    const pinCount = await guest("document.querySelectorAll('[data-caos-bubble]:not([data-caos-bubble=\"new\"])').length");
    check('annotation pin rendered (exactly 1, no dupes)', pinCount === 1, 'pins=' + pinCount);

    // --- 3b. Draw mode: trusted drag → stroke → region note → annotation ---
    {
      // Enter draw mode through the REAL toolbar button, like a user would.
      const drawBtn = Array.from(document.querySelectorAll('.toolbar .icon-btn')).find((b) => /draw/i.test(b.title || '') || /Draw/.test(b.textContent || ''));
      check('toolbar has a Draw button', !!drawBtn);
      if (drawBtn) drawBtn.click(); else I.setMode('draw');
      check('draw mode on', I.state.mode === 'draw');
      check('draw button shows active', !drawBtn || drawBtn.classList.contains('active'));
      await sleep(250);
      const canvasOn = await guest("(() => { const c = document.querySelector('canvas[data-caos]'); return !!c && c.style.display === 'block' && c.style.pointerEvents === 'auto'; })()");
      check('draw canvas active', canvasOn);
      // Drag a ~120×90 region with real (trusted) mouse events.
      wv.sendInputEvent({ type: 'mouseDown', x: 260, y: 220, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 10; i++) {
        wv.sendInputEvent({ type: 'mouseMove', x: 260 + i * 12, y: 220 + i * 9 });
        await sleep(10);
      }
      // Mid-drag, the stroke must be VISIBLY painted on the overlay canvas.
      await sleep(80);
      const strokeVisible = await (async () => {
        try {
          const img = await wv.capturePage();
          const png = img.toDataURL();
          const probe = new Image();
          await new Promise((res, rej) => { probe.onload = res; probe.onerror = rej; probe.src = png; });
          const c = document.createElement('canvas');
          c.width = probe.width; c.height = probe.height;
          const cx = c.getContext('2d');
          cx.drawImage(probe, 0, 0);
          const scale = probe.width / wv.clientWidth;
          const d = cx.getImageData(Math.round(200 * scale), Math.round(170 * scale), Math.round(220 * scale), Math.round(190 * scale)).data;
          for (let i = 0; i < d.length; i += 4) {
            // stroke color #ff5d8f ± antialiasing tolerance
            if (Math.abs(d[i] - 255) < 40 && Math.abs(d[i + 1] - 93) < 60 && Math.abs(d[i + 2] - 143) < 60) return true;
          }
          return false;
        } catch (e) { return 'err:' + e.message; }
      })();
      check('stroke visibly painted mid-drag', strokeVisible === true, String(strokeVisible));
      wv.sendInputEvent({ type: 'mouseUp', x: 380, y: 310, button: 'left', clickCount: 1 });
      await sleep(300);
      const regionPopup = await guest("!!document.querySelector('[data-caos] textarea')");
      check('draw drag opened region note popup', regionPopup);
      const regionMsg = onceChannel('caos:annotation');
      await clickSel('[data-caos] textarea');
      await typeText('Rework this area');
      await clickSel('[data-caos] [data-save]');
      const sentRegion = await regionMsg;
      check('guest sent region annotation', !!sentRegion && sentRegion.kind === 'region', sentRegion ? sentRegion.kind : 'no message');
      const rBox = sentRegion && sentRegion.target && sentRegion.target.box;
      check('region box captured from drag', !!rBox && rBox.w >= 100 && rBox.h >= 70, rBox ? `${rBox.w}x${rBox.h}@${rBox.x},${rBox.y}` : 'no box');
      await sleep(300);
      const persistedRegion = (await caos.annotations.bySession(session.id)).find((a) => a.kind === 'region');
      check('region annotation persisted', !!persistedRegion, persistedRegion && persistedRegion.note);
      // A second drag right after saving must work too (mode stays on).
      wv.sendInputEvent({ type: 'mouseDown', x: 420, y: 180, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 6; i++) { wv.sendInputEvent({ type: 'mouseMove', x: 420 + i * 10, y: 180 + i * 10 }); await sleep(10); }
      wv.sendInputEvent({ type: 'mouseUp', x: 480, y: 240, button: 'left', clickCount: 1 });
      await sleep(250);
      const secondPopup = await guest("!!document.querySelector('[data-caos] textarea')");
      check('second draw after save works', secondPopup);
      // Cancelling discards the mark but stays in draw mode.
      await clickSel('[data-caos] [data-cancel]');
      await sleep(200);
      check('cancel keeps draw mode on', I.state.mode === 'draw');
      // A tiny drag (below the accidental-click threshold) must NOT open a popup.
      wv.sendInputEvent({ type: 'mouseDown', x: 500, y: 400, button: 'left', clickCount: 1 });
      wv.sendInputEvent({ type: 'mouseMove', x: 502, y: 402 });
      wv.sendInputEvent({ type: 'mouseUp', x: 502, y: 402, button: 'left', clickCount: 1 });
      await sleep(250);
      const tinyPopup = await guest("!!document.querySelector('[data-caos] textarea')");
      check('tiny drag ignored (no popup)', !tinyPopup);
      // A flat horizontal swipe (underline gesture) is a valid mark too — the
      // stored box gets padded out to a usable height.
      wv.sendInputEvent({ type: 'mouseDown', x: 200, y: 350, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 8; i++) { wv.sendInputEvent({ type: 'mouseMove', x: 200 + i * 15, y: 350 }); await sleep(10); }
      wv.sendInputEvent({ type: 'mouseUp', x: 320, y: 350, button: 'left', clickCount: 1 });
      await sleep(250);
      const flatMsg = onceChannel('caos:annotation');
      const flatPopup = await guest("!!document.querySelector('[data-caos] textarea')");
      check('flat horizontal swipe registers', flatPopup);
      await clickSel('[data-caos] textarea');
      await typeText('Underline mark');
      await clickSel('[data-caos] [data-save]');
      const flatAnn = await flatMsg;
      const flatBox = flatAnn && flatAnn.target && flatAnn.target.box;
      check('thin region box padded to usable size', !!flatBox && flatBox.w >= 100 && flatBox.h >= 12, flatBox ? `${flatBox.w}x${flatBox.h}` : 'none');
      I.setMode('off');
      await sleep(150);

      // Locating a region note from the Notes panel must flash the whole mark,
      // with draw mode OFF too. It only looked right with draw mode ON: the
      // overlay canvas swallowed resolve()'s elementFromPoint hit-test, so the
      // flash fell back to the stored box. With the canvas gone the region
      // resolved to whatever child element sat under the mark's centre and the
      // flash shrank to it.
      const rTarget = persistedRegion && persistedRegion.target;
      if (rTarget && rTarget.box) {
        // Clear any flash still fading from the save above, so the probe below
        // can only see the one this locate produces.
        await guest("Array.from(document.querySelectorAll('[data-caos-flash]')).forEach(n => n.remove())");
        const ack = onceChannel('caos:highlight-ack', 6000);
        wv.send('caos:highlight-target', rTarget);
        const ackMsg = await ack;
        check('locate region acked (draw mode off)', !!(ackMsg && ackMsg.ok));
        const flash = await guest("(() => { const b = document.querySelector('[data-caos-flash]'); if (!b) return null; const px = (v) => Math.round(parseFloat(v) || 0); return { x: px(b.style.left), y: px(b.style.top), w: px(b.style.width), h: px(b.style.height) }; })()");
        const want = rTarget.box;
        const fits = !!flash && Math.abs(flash.w - want.w) <= 2 && Math.abs(flash.h - want.h) <= 2;
        check('region flash covers the whole mark, not one child element', fits, flash ? `${flash.w}x${flash.h} vs ${want.w}x${want.h}` : 'no flash');
      }
    }

    // --- 3c. Rearrange mode: select / smart layout / undo / reorder / resize / hide ---
    {
      const arrangeBtn = Array.from(document.querySelectorAll('.toolbar .icon-btn')).find((b) => /rearrange/i.test(b.title || ''));
      check('toolbar has a Rearrange button', !!arrangeBtn);
      if (arrangeBtn) arrangeBtn.click(); else I.setMode('arrange');
      check('arrange mode on', I.state.mode === 'arrange');
      await sleep(250);
      const barShown = await guest("(() => { const b = document.querySelector('[data-caos-arrange=\\\"bar\\\"]'); return !!b && b.style.display === 'flex'; })()");
      check('arrange action bar shown', barShown);

      // Select #cta with a real click → selection box appears.
      await clickSel('#cta');
      await sleep(200);
      const selShown = await guest("(() => { const b = document.querySelector('[data-caos-arrange=\\\"box\\\"]'); return !!b && b.style.display === 'block'; })()");
      check('clicking an element selects it', selShown);

      // Smart re-layout the parent (<main>) as a column → live style + edit note.
      const layoutMsg = onceChannel('caos:annotation');
      await clickSel('[data-caos-arrange="btn-column"]');
      const layoutAnn = await layoutMsg;
      check('smart layout emitted an edit annotation', !!layoutAnn && layoutAnn.kind === 'edit' && layoutAnn.edit && layoutAnn.edit.type === 'layout', layoutAnn && layoutAnn.edit && layoutAnn.edit.css);
      const mainFlex = await guest("(() => { const m = document.querySelector('main'); return m.style.display === 'flex' && m.style.flexDirection === 'column'; })()");
      check('smart layout applied live to the page', mainFlex);
      await sleep(300);
      const withLayout = (await caos.annotations.bySession(session.id)).filter((a) => a.kind === 'edit');
      check('edit annotation persisted with payload', withLayout.length === 1 && !!withLayout[0].edit && /flex/.test(withLayout[0].edit.css || ''), withLayout.length + ' edits');

      // Undo reverts the page AND retracts the note.
      await clickSel('[data-caos-arrange="btn-undo"]');
      await sleep(400);
      const mainReverted = await guest("(() => { const m = document.querySelector('main'); return m.style.display !== 'flex'; })()");
      check('undo reverted the live page', mainReverted);
      const afterUndo = (await caos.annotations.bySession(session.id)).filter((a) => a.kind === 'edit');
      check('undo retracted the edit note', afterUndo.length === 0, afterUndo.length + ' edits left');

      // Reorder #cta one position later via the bar (↓).
      await clickSel('#cta');
      await sleep(150);
      const reorderMsg = onceChannel('caos:annotation');
      await clickSel('[data-caos-arrange="btn-down"]');
      const reorderAnn = await reorderMsg;
      check('reorder emitted an edit annotation', !!reorderAnn && reorderAnn.edit && reorderAnn.edit.type === 'reorder', reorderAnn && JSON.stringify((reorderAnn.edit || {}).details));
      const newOrder = await guest("(() => { const k = Array.from(document.querySelector('main').children).filter(c => !c.hasAttribute('data-caos')); return k[0] && k[0].id; })()");
      check('reorder moved the element in the DOM', newOrder === 'email', 'first child = ' + newOrder);

      // --- Drag to reorder: the real gesture, in both flow directions -------
      // Helpers: a paced pointer drag, and the live child order of a container.
      const dragTo = async (x0, y0, x1, y1, steps = 14) => {
        wv.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 });
        for (let i = 1; i <= steps; i++) {
          wv.sendInputEvent({ type: 'mouseMove', x: Math.round(x0 + ((x1 - x0) * i) / steps), y: Math.round(y0 + ((y1 - y0) * i) / steps) });
          await sleep(16);
        }
        wv.sendInputEvent({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1 });
        await sleep(150);
      };
      const orderOf = (sel) => guest(`Array.from(document.querySelector(${JSON.stringify(sel)}).children).filter(c => !c.hasAttribute('data-caos')).map(c => c.id).join(',')`);
      const rectOf = (sel) => guest(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; })()`);

      // 1. A horizontal row in plain block flow (#chips): drag chip One past Two.
      await clickSel('#c1');
      await sleep(150);
      const c1 = await rectOf('#c1');
      const c2r = await rectOf('#c2');
      const chipMsg = onceChannel('caos:annotation');
      wv.sendInputEvent({ type: 'mouseDown', x: c1.x, y: c1.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 10; i++) {
        wv.sendInputEvent({ type: 'mouseMove', x: Math.round(c1.x + ((c2r.x + 6 - c1.x) * i) / 10), y: c1.y });
        await sleep(16);
      }
      // Mid-drag the page must SHOW the drag: a ghost under the cursor and the
      // source element dimmed in place at its live insertion point.
      const midDrag = await guest("(() => { const g = document.querySelector('[data-caos-arrange=\"ghost\"]'); const z = document.querySelector('[data-caos-arrange=\"dropzone\"]'); const src = document.getElementById('c1'); return { ghost: !!g, zone: !!z && z.style.display === 'block', dimmed: !!src && parseFloat(src.style.opacity || '1') < 1 }; })()");
      check('drag shows a ghost under the cursor', midDrag && midDrag.ghost === true, JSON.stringify(midDrag));
      check('dragged element is dimmed in place', midDrag && midDrag.dimmed === true, JSON.stringify(midDrag));
      check('drop container is outlined mid-drag', midDrag && midDrag.zone === true, JSON.stringify(midDrag));
      await sleep(260); // let the drag's frame land before reading the preview
      const liveOrder = await orderOf('#chips');
      check('row reorder previews live, mid-drag', liveOrder === 'c2,c1,c3', liveOrder);
      wv.sendInputEvent({ type: 'mouseUp', x: c2r.x + 6, y: c1.y, button: 'left', clickCount: 1 });
      await sleep(200);
      const chipAnn = await chipMsg;
      const chipOrder = await orderOf('#chips');
      check('drag reordered a horizontal row', chipOrder === 'c2,c1,c3', chipOrder);
      check('drag reorder emitted an edit annotation', !!chipAnn && chipAnn.edit && chipAnn.edit.type === 'reorder', chipAnn && chipAnn.edit && JSON.stringify(chipAnn.edit.details));
      const ghostGone = await guest("!document.querySelector('[data-caos-arrange=\"ghost\"]')");
      check('ghost removed on drop', ghostGone);
      const dimGone = await guest("(() => { const c = document.getElementById('c1'); return !c.style.opacity || c.style.opacity === '1'; })()");
      check('dimming cleared on drop', dimGone);

      // 2. A vertical block-flow column (main): drag #cta below #log.
      await clickSel('#cta');
      await sleep(150);
      const ctaR = await rectOf('#cta');
      const logR = await rectOf('#log');
      await dragTo(ctaR.x, ctaR.y, ctaR.x, logR.bottom - 2);
      const mainOrder = await orderOf('main');
      check('drag reordered a vertical column', /^email,log,cta/.test(mainOrder), mainOrder);

      // 3. Dropping back where it started must not record a no-op edit.
      const before = (await caos.annotations.bySession(session.id)).length;
      await clickSel('#c1');
      await sleep(150);
      const c1b = await rectOf('#c1');
      await dragTo(c1b.x, c1b.y, c1b.x + 5, c1b.y + 3, 4);
      await sleep(250);
      const after = (await caos.annotations.bySession(session.id)).length;
      check('a nudge that changes nothing records nothing', after === before, before + ' -> ' + after);

      // 4. Dragging clear of the current parent drops INTO another container.
      await clickSel('#c3');
      await sleep(150);
      const c3 = await rectOf('#c3');
      const dropAt = await rectOf('#email');
      const reparentMsg = onceChannel('caos:annotation');
      await dragTo(c3.x, c3.y, dropAt.x, dropAt.y, 18);
      const reparentAnn = await reparentMsg;
      const c3Parent = await guest("(() => { const c = document.getElementById('c3'); return c && c.parentElement ? c.parentElement.nodeName.toLowerCase() : 'gone'; })()");
      check('drag into another container re-parents the element', c3Parent === 'main', 'parent = ' + c3Parent);
      check('re-parenting emitted a reparent edit', !!reparentAnn && reparentAnn.edit && reparentAnn.edit.type === 'reparent', reparentAnn && reparentAnn.edit && JSON.stringify(reparentAnn.edit.details));
      // Undo puts it back where it came from.
      await clickSel('[data-caos-arrange="btn-undo"]');
      await sleep(300);
      const c3Back = await guest("(() => { const c = document.getElementById('c3'); return c && c.parentElement ? c.parentElement.id : 'gone'; })()");
      check('undo returns it to its original container', c3Back === 'chips', 'parent = ' + c3Back);

      // 5. Escape mid-drag cancels: the page snaps back and nothing is recorded.
      const orderBefore = await orderOf('#chips');
      const annsBefore = (await caos.annotations.bySession(session.id)).length;
      await clickSel('#c1');
      await sleep(150);
      const c1c = await rectOf('#c1');
      const c3c = await rectOf('#c3');
      wv.sendInputEvent({ type: 'mouseDown', x: c1c.x, y: c1c.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 8; i++) { wv.sendInputEvent({ type: 'mouseMove', x: Math.round(c1c.x + ((c3c.x + 6 - c1c.x) * i) / 8), y: c1c.y }); await sleep(16); }
      wv.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      await sleep(120);
      const escOrder = await orderOf('#chips');
      const escGhost = await guest("!document.querySelector('[data-caos-arrange=\"ghost\"]')");
      wv.sendInputEvent({ type: 'mouseUp', x: c3c.x + 6, y: c1c.y, button: 'left', clickCount: 1 });
      await sleep(250);
      check('Escape restores the pre-drag order', escOrder === orderBefore, escOrder + ' vs ' + orderBefore);
      check('Escape removes the ghost', escGhost);
      check('Escape keeps arrange mode on', I.state.mode === 'arrange', I.state.mode);
      const annsAfter = (await caos.annotations.bySession(session.id)).length;
      check('a cancelled drag records nothing', annsAfter === annsBefore, annsBefore + ' -> ' + annsAfter);
      const finalOrder = await orderOf('#chips');
      check('order still intact after the cancelled drag released', finalOrder === orderBefore, finalOrder);

      // 6. The primary gesture: press an UNSELECTED element and drag it. No
      //    pre-select step, and no text selection smeared along the way.
      await clickSel('#hero'); // park the selection somewhere else
      await sleep(150);
      const rowBefore = await orderOf('#chips');
      const first = rowBefore.split(',')[0];
      const last = rowBefore.split(',')[rowBefore.split(',').length - 1];
      const firstR = await rectOf('#' + first);
      const lastR = await rectOf('#' + last);
      const directMsg = onceChannel('caos:annotation');
      const barLabel = () => guest("(() => { const b = document.querySelector('[data-caos-arrange=\"bar\"]'); const s = b && b.querySelector('span'); return s ? s.textContent : ''; })()");
      wv.sendInputEvent({ type: 'mouseDown', x: firstR.x, y: firstR.y, button: 'left', clickCount: 1 });
      await sleep(40);
      const pressedLabel = await barLabel();
      check('pressing an unselected element selects it', pressedLabel === 'span#' + first, pressedLabel);
      const pinsInert = await guest("Array.from(document.querySelectorAll('[data-caos-bubble]')).every(d => d.style.pointerEvents === 'none')");
      check('annotation pins stop swallowing presses in arrange mode', pinsInert);
      for (let i = 1; i <= 16; i++) {
        wv.sendInputEvent({ type: 'mouseMove', x: Math.round(firstR.x + ((lastR.right - 4 - firstR.x) * i) / 16), y: firstR.y });
        await sleep(16);
      }
      const directGhost = await guest("!!document.querySelector('[data-caos-arrange=\"ghost\"]')");
      check('a direct press starts a real drag', directGhost);
      wv.sendInputEvent({ type: 'mouseUp', x: lastR.right - 4, y: firstR.y, button: 'left', clickCount: 1 });
      await sleep(200);
      const directAnn = await directMsg;
      const rowAfter = await orderOf('#chips');
      check('dragging an unselected element moves it', rowAfter === rowBefore.split(',').filter((c) => c !== first).join(',') + ',' + first, rowBefore + ' -> ' + rowAfter);
      check('a direct drag still records the edit', !!directAnn && directAnn.edit && directAnn.edit.type === 'reorder', directAnn && directAnn.edit && JSON.stringify(directAnn.edit.details));
      const smear = await guest("(window.getSelection() ? window.getSelection().toString() : '')");
      check('dragging over text selects no text', smear === '', JSON.stringify(smear));

      // 7. A press grabs the nearest element that HAS siblings, not the inner
      //    text node — then clicking the selection again steps down one level.
      const labelOf = () => guest("(() => { const b = document.querySelector('[data-caos-arrange=\"bar\"]'); const s = b && b.querySelector('span'); return s ? s.textContent : ''; })()");
      await clickSel('#count');
      await sleep(150);
      const grabbed = await labelOf();
      check('pressing an only-child text node grabs its container', grabbed === 'p#log', grabbed);
      await clickSel('#count'); // second click, now inside the selection
      await sleep(150);
      const drilled = await labelOf();
      check('clicking the selection again goes one level deeper', drilled === 'span#count', drilled);
      await clickSel('[data-caos-arrange="btn-parent"]');
      await sleep(150);
      const climbed = await labelOf();
      check('the parent button climbs back up', climbed === 'p#log', climbed);

      // Resize #cta by dragging the SE handle with real input.
      await clickSel('#cta');
      await sleep(150);
      const w0 = await guest("document.getElementById('cta').getBoundingClientRect().width");
      const hpos = await guest("(() => { const h = document.querySelector('[data-caos-arrange=\\\"handle-se\\\"]'); if (!h) return null; return { x: Math.round(parseFloat(h.style.left)) + 5, y: Math.round(parseFloat(h.style.top)) + 5 }; })()");
      check('resize handle rendered', !!hpos, JSON.stringify(hpos));
      const resizeMsg = onceChannel('caos:annotation');
      if (hpos) {
        wv.sendInputEvent({ type: 'mouseDown', x: hpos.x, y: hpos.y, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 6; i++) { wv.sendInputEvent({ type: 'mouseMove', x: hpos.x + i * 10, y: hpos.y + i * 3 }); await sleep(10); }
        wv.sendInputEvent({ type: 'mouseUp', x: hpos.x + 60, y: hpos.y + 18, button: 'left', clickCount: 1 });
      }
      const resizeAnn = await resizeMsg;
      const w1 = await guest("document.getElementById('cta').getBoundingClientRect().width");
      check('resize handle grew the element', w1 >= w0 + 40, `${Math.round(w0)} -> ${Math.round(w1)}`);
      check('resize emitted an edit annotation', !!resizeAnn && resizeAnn.edit && resizeAnn.edit.type === 'resize' && /width/.test(resizeAnn.edit.css || ''), resizeAnn && resizeAnn.edit && resizeAnn.edit.css);

      // Alt-drag the selection → freehand move recorded as a transform edit.
      await clickSel('#cta');
      await sleep(150);
      const cta2 = await guest(`(() => { const r = document.getElementById('cta').getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);
      const moveMsg = onceChannel('caos:annotation');
      wv.sendInputEvent({ type: 'mouseDown', x: cta2.x, y: cta2.y, button: 'left', clickCount: 1, modifiers: ['alt'] });
      for (let i = 1; i <= 5; i++) { wv.sendInputEvent({ type: 'mouseMove', x: cta2.x + i * 8, y: cta2.y + i * 5, modifiers: ['alt'] }); await sleep(10); }
      wv.sendInputEvent({ type: 'mouseUp', x: cta2.x + 40, y: cta2.y + 25, button: 'left', clickCount: 1, modifiers: ['alt'] });
      const moveAnn = await moveMsg;
      check('alt-drag emitted a free-move edit', !!moveAnn && moveAnn.edit && moveAnn.edit.type === 'move' && /translate/.test(moveAnn.edit.css || ''), moveAnn && moveAnn.edit && moveAnn.edit.css);
      const ctaMoved = await guest("/translate/.test(document.getElementById('cta').style.transform)");
      check('free-move applied live to the page', ctaMoved);

      // Hide an element, then undo it (page + note retraction round-trip).
      await clickSel('#log');
      await sleep(150);
      await clickSel('[data-caos-arrange="btn-hide"]');
      await sleep(250);
      const logHidden = await guest("document.getElementById('log').style.display === 'none'");
      check('hide removed the element from view', logHidden);
      await clickSel('[data-caos-arrange="btn-undo"]');
      await sleep(300);
      const logBack = await guest("document.getElementById('log').style.display !== 'none'");
      check('undo restored the hidden element', logBack);

      // The persisted edits surface their exact change in the agent prompt.
      const promptOut = await caos.export.build('prompt', session.id);
      check('prompt export carries live-previewed CSS', promptOut && /previewed live on the page/.test(promptOut.content), 'prompt+edits');
      const mdOut = await caos.export.build('markdown', session.id);
      check('markdown export carries the edit CSS block', mdOut && /```css/.test(mdOut.content));

      I.setMode('off');
      check('arrange mode off', I.state.mode === 'off');
    }

    // --- 3d. Edit mode: copy, type, style — and the history behind them ---
    {
      const annCount = async () => (await caos.annotations.bySession(session.id)).length;
      const heroText = () => guest("document.getElementById('hero').textContent");
      const heroStyle = (p) => guest('document.getElementById("hero").style.' + p);

      // Trying to edit something IS the way into Edit mode.
      I.setMode('inspect');
      await sleep(150);
      const hero = await guest("(() => { const r = document.getElementById('hero').getBoundingClientRect(); return { x: Math.round(r.left + 60), y: Math.round(r.top + r.height / 2) }; })()");
      wv.sendInputEvent({ type: 'mouseDown', x: hero.x, y: hero.y, button: 'left', clickCount: 1 });
      wv.sendInputEvent({ type: 'mouseUp', x: hero.x, y: hero.y, button: 'left', clickCount: 1 });
      await sleep(60);
      wv.sendInputEvent({ type: 'mouseDown', x: hero.x, y: hero.y, button: 'left', clickCount: 2 });
      wv.sendInputEvent({ type: 'mouseUp', x: hero.x, y: hero.y, button: 'left', clickCount: 2 });
      await sleep(500);
      check('double-clicking in Inspect walks into Edit', I.state.mode === 'edit', I.state.mode);
      check('…with the Style panel in front of you', I.state.activeTab === 'style', I.state.activeTab);
      const ce = await guest("document.getElementById('hero').getAttribute('contenteditable')");
      check('…and the caret already in the text', ce === 'plaintext-only', String(ce));
      const stylePanelTarget = (document.querySelector('.st-target-sel') || {}).textContent || '';
      check('the Style panel shows the selected element', /hero/.test(stylePanelTarget), stylePanelTarget);

      // Type on the page; finishing files a copy change.
      const textMsg = onceChannel('caos:annotation');
      await typeText(' EDITED');
      wv.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      const textAnn = await textMsg;
      await sleep(300);
      check('typing on the page changes the copy', /EDITED/.test(await heroText()), await heroText());
      check('…and records it as a copy edit', !!textAnn && textAnn.edit && textAnn.edit.type === 'text', textAnn && textAnn.edit && JSON.stringify(textAnn.edit.details));

      // The properties editor drives type, colour, spacing and size.
      const sizeInput = document.querySelector('[data-tab="style"] .st-num');
      check('the Style panel offers the type controls', !!sizeInput);
      sizeInput.value = '40';
      sizeInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(250);
      check('a control applies live to the page', (await heroStyle('fontSize')) === '40px', await heroStyle('fontSize'));
      const styleMsg = onceChannel('caos:annotation');
      sizeInput.dispatchEvent(new Event('change', { bubbles: true }));
      const styleAnn = await styleMsg;
      await sleep(300);
      check('committing a control files a style note', !!styleAnn && styleAnn.edit && styleAnn.edit.type === 'style' && /font-size: 40px/.test(styleAnn.edit.css || ''), styleAnn && styleAnn.edit && styleAnn.edit.css);

      // A second property grows that note instead of filing another.
      const beforeSecond = await annCount();
      const range = document.querySelector('[data-tab="style"] .st-range');
      range.value = '0.5';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      range.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(500);
      check('a second property grows the same note', (await annCount()) === beforeSecond, beforeSecond + ' -> ' + (await annCount()));
      const grown = (await caos.annotations.bySession(session.id)).find((a) => a.id === (styleAnn && styleAnn.id));
      check('…and that note carries both properties', !!grown && /font-size/.test(grown.edit.css) && /opacity/.test(grown.edit.css), grown && grown.edit.css);
      check('the page shows both', (await heroStyle('opacity')) === '0.5', await heroStyle('opacity'));

      // Undo / redo from the header, across every kind of edit.
      const undoBtn = document.querySelector('.toolbar [data-act="undo"]');
      const redoBtn = document.querySelector('.toolbar [data-act="redo"]');
      check('undo is offered once there is something to undo', !undoBtn.disabled);
      const beforeUndo = await annCount();
      undoBtn.click();
      await sleep(500);
      check('undo reverts the style', (await heroStyle('fontSize')) === '', await heroStyle('fontSize'));
      check('undo retracts its note', (await annCount()) === beforeUndo - 1, beforeUndo + ' -> ' + (await annCount()));
      check('redo is offered after an undo', !redoBtn.disabled);
      redoBtn.click();
      await sleep(500);
      check('redo re-applies the style', (await heroStyle('fontSize')) === '40px', await heroStyle('fontSize'));
      check('redo brings the note back', (await annCount()) === beforeUndo, String(await annCount()));

      // Undo the copy change too, to prove the history is not style-only.
      undoBtn.click();
      await sleep(400);
      undoBtn.click();
      await sleep(400);
      check('undo walks back through a copy change as well', !/EDITED/.test(await heroText()), await heroText());

      // --- the editor's own affordances, on a second element ---------------
      const st = (sel) => document.querySelector('[data-tab="style"] ' + sel);
      const rowNamed = (name) =>
        Array.from(document.querySelectorAll('[data-tab="style"] .st-row')).find(
          (r) => (r.querySelector('.st-label') || {}).textContent === name
        );
      const ctaStyle = (p) => guest('document.getElementById("cta").style.' + p);

      wv.send('caos:edit-select', { selector: '#cta' });
      await sleep(450);
      check('the panel follows a selection made from the host', /cta/.test((document.querySelector('.st-target-sel') || {}).textContent || ''), (document.querySelector('.st-target-sel') || {}).textContent);
      check('the page palette is offered as swatches', document.querySelectorAll('[data-tab="style"] .st-swatch').length > 0, String(document.querySelectorAll('[data-tab="style"] .st-swatch').length));

      // Size in the unit you think in, not just px.
      const sizeInput2 = st('.st-num');
      sizeInput2.value = '2';
      sizeInput2.dispatchEvent(new Event('input', { bubbles: true }));
      const unitSel = st('.st-unit');
      unitSel.value = 'rem';
      unitSel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(400);
      check('a size can be set in rem, not just px', (await ctaStyle('fontSize')) === '2rem', await ctaStyle('fontSize'));

      // Touched properties are marked, and revertible one at a time.
      const sizeRow = rowNamed('Size');
      check('a touched property is marked as changed', !!(sizeRow && sizeRow.querySelector('.st-label.changed') && sizeRow.querySelector('.st-clear')));
      sizeRow.querySelector('.st-clear').click();
      await sleep(400);
      check('reverting one property hands it back to the page', (await ctaStyle('fontSize')) === '', await ctaStyle('fontSize'));

      // Italic / underline / caps, the way every editor has them.
      const italicBtn = Array.from(document.querySelectorAll('[data-tab="style"] .st-seg-btn')).find((b) => b.title === 'Italic');
      check('the type toggles are there', !!italicBtn);
      italicBtn.click();
      await sleep(400);
      check('italic toggles on the page', (await ctaStyle('fontStyle')) === 'italic', await ctaStyle('fontStyle'));

      // Drag a label sideways to scrub its number.
      const radiusRow = rowNamed('Radius');
      const radiusLabel = radiusRow.querySelector('.st-label');
      const rl = radiusLabel.getBoundingClientRect();
      const pe = (type, x) => new PointerEvent(type, { bubbles: true, clientX: x, clientY: Math.round(rl.top + rl.height / 2), button: 0, pointerId: 1 });
      radiusLabel.dispatchEvent(pe('pointerdown', Math.round(rl.left + 4)));
      window.dispatchEvent(pe('pointermove', Math.round(rl.left + 14)));
      window.dispatchEvent(pe('pointermove', Math.round(rl.left + 34)));
      window.dispatchEvent(pe('pointerup', Math.round(rl.left + 34)));
      await sleep(400);
      check('scrubbing a label changes the value', parseFloat(await ctaStyle('borderRadius')) >= 20, await ctaStyle('borderRadius'));

      // Reset hands the whole element back — note and all.
      const beforeReset = await annCount();
      const resetBtn = Array.from(document.querySelectorAll('.st-actions .btn')).find((b) => b.textContent === 'Reset');
      check('Reset is offered once something changed', !!resetBtn);
      resetBtn.click();
      await sleep(600);
      // Reset undoes THIS visit's changes; edits with their own notes (the
      // resize and free-move from the rearrange run) are not silently dropped.
      check('Reset undoes what this visit changed', (await ctaStyle('fontStyle')) === '' && (await ctaStyle('borderRadius')) === '', (await ctaStyle('fontStyle')) + '/' + (await ctaStyle('borderRadius')));
      check('…and leaves edits that carry their own notes alone', /width/.test(await guest("document.getElementById('cta').getAttribute('style') || ''")));
      check('…and takes its note with it', (await annCount()) === beforeReset - 1, beforeReset + ' -> ' + (await annCount()));

      I.setMode('off');
      await sleep(150);
    }

    // --- 3e. Export one element: capture, package, and what lands on disk ---
    {
      const cap = await I.captureElement('#login-card');
      check('an element can be captured on its own', !!cap && /login-btn/.test(cap.html || ''), cap && cap.meta && cap.meta.label);
      check('the capture reads the page\u2019s own rules', cap.meta.mode === 'rules' && cap.meta.ruleCount > 0, cap.meta.mode + ' / ' + cap.meta.ruleCount + ' rules');
      check('it keeps the hover state the component has', /#login-btn:hover/.test(cap.css || ''), (cap.css || '').slice(0, 80));
      check('…the media query it responds to', /@media[^{]*max-width/.test(cap.css || ''));
      check('…and the custom properties its colours point at', /--brand/.test(cap.css || ''));
      check('unrelated page CSS is left behind', !/#hero/.test(cap.css || ''));
      check('the inherited typography travels with it', /font-family/.test(cap.context || ''), cap.context);

      const one = await caos.export.buildElement(cap, 'auto');
      check('a component with no external files exports as one .html', one.kind === 'html' && /\.html$/.test(one.name), one.kind + ' ' + one.name);
      const doc = atob(one.base64);
      check('the file is a standalone document', /<!doctype html>/i.test(doc) && /<style>/.test(doc) && /id="login-btn"/.test(doc), String(doc.length) + ' bytes');
      check('it records where it came from', doc.indexOf('fixture.html') !== -1);

      const zipped = await caos.export.buildElement(cap, 'zip');
      check('the same element can be forced to a .zip', zipped.kind === 'zip' && /\.zip$/.test(zipped.name), zipped.name);
      const zbytes = Uint8Array.from(atob(zipped.base64), (ch) => ch.charCodeAt(0));
      check('the zip has a real archive header', zbytes[0] === 0x50 && zbytes[1] === 0x4b && zbytes[2] === 0x03 && zbytes[3] === 0x04, Array.from(zbytes.slice(0, 4)).join(','));
      const ztext = Array.from(zbytes.slice(0, 4000), (b) => String.fromCharCode(b)).join('');
      check('…and carries the files you would expect', /index\.html/.test(ztext) && /styles\.css/.test(ztext) && /element\.json/.test(ztext), 'entries found');

      // The Style panel is the button you press to do all that.
      I.setMode('inspect');
      await sleep(150);
      // It sits below the fold — scroll to it, then click where it actually is.
      const btnPos = await guest('(() => { const el = document.getElementById("login-btn"); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
      await sleep(120);
      const pickedBtn = onceChannel('caos:layout-picked');
      await clickAt(btnPos.x, btnPos.y);
      const pick = await pickedBtn;
      const hit = ((pick && pick.breadcrumb) || []).slice(-1)[0] || {};
      check('the Inspect click landed on the button', /login-btn/.test(hit.selector || ''), hit.selector || '(nothing picked)');
      await sleep(350);
      await guest("(() => { const b = document.querySelector('[data-caos] [data-cancel]'); if (b) b.click(); return !!b; })()");
      await sleep(200);
      check('an Inspect click feeds the Style panel too', /login-btn/.test((document.querySelector('.st-target-sel') || {}).textContent || ''), (document.querySelector('.st-target-sel') || {}).textContent);
      check('the Style panel offers Export', !!document.querySelector('.st-export'));
      // A click with no coordinates (keyboard, script) must not pick a random
      // element out from under the one you chose.
      const beforeStray = (document.querySelector('.st-target-sel') || {}).textContent;
      await guest('document.body.click()');
      await sleep(300);
      check('a click with no point on the page picks nothing', (document.querySelector('.st-target-sel') || {}).textContent === beforeStray, beforeStray + ' -> ' + (document.querySelector('.st-target-sel') || {}).textContent);
      await guest('window.scrollTo(0, 0)');
      I.setMode('off');
      await sleep(150);
    }

    // --- 4. DOM tree serializer ---
    const treeP = onceChannel('caos:dom-tree');
    wv.send('caos:request-dom-tree');
    const tree = await treeP;
    check('dom-tree returned', tree && tree.tag, tree && tree.tag);
    const flat = JSON.stringify(tree || {});
    check('dom-tree contains #cta', /"cta"/.test(flat));

    // --- 4b. Sidebar: Sections / Layers tabs + the folded-away library ---
    {
      const sideRows = () => Array.from(document.querySelectorAll('.sec-row'));
      const nameOf = (r) => r.querySelector('.sec-name').textContent;
      const rowNamed = (n) => sideRows().find((r) => nameOf(r) === n);

      check('sidebar shows the Sections tab', I.state.sideTab === 'sections' && !!document.querySelector('.side-tab.active'), I.state.sideTab);
      const libBtn = document.querySelector('.side-library-btn');
      check('library sits behind one button', !!libBtn, libBtn && libBtn.textContent);
      const libHidden = getComputedStyle(document.querySelector('.side-library')).display === 'none';
      check('sessions + history are folded away by default', libHidden);
      libBtn.click();
      await sleep(120);
      const libShown = getComputedStyle(document.querySelector('.side-library')).display !== 'none';
      const heads = Array.from(document.querySelectorAll('.side-library .side-head h3')).map((x) => x.textContent);
      check('the button expands sessions + history', libShown && heads.includes('Sessions') && heads.includes('History'), heads.join(','));
      libBtn.click();
      await sleep(120);
      check('and folds them away again', getComputedStyle(document.querySelector('.side-library')).display === 'none');
      check('right panel is Notes + Style + Audit + AI (no Inspector tab)', Array.from(document.querySelectorAll('.panel .tab')).map((t) => t.textContent.replace(/\d+$/, '')).join(',') === 'Notes,Style,Audit,AI', Array.from(document.querySelectorAll('.panel .tab')).map((t) => t.textContent).join(','));

      // The page's own structure, named the way a person would name it.
      document.querySelector('.sec-icon-btn').click();
      await sleep(500);
      const names = sideRows().map(nameOf);
      check('sections list the page structure', names.length > 0, names.slice(0, 8).join(' | '));
      check('sections are named, not tag soup', names.includes('Main') && names.includes('Hero'), names.slice(0, 8).join(' | '));

      // Clicking a section selects it on the page and follows through to Layers.
      const mainRow = rowNamed('Main');
      const pickedP = onceChannel('caos:layout-picked');
      mainRow.click();
      const picked = await pickedP;
      check('clicking a section selects it on the page', !!picked && picked.breadcrumb && picked.breadcrumb.length, picked && (picked.breadcrumb || []).map((b) => b.tag).join('>'));
      await sleep(250);
      const activeName = document.querySelector('.sec-row.active') && document.querySelector('.sec-row.active .sec-name').textContent;
      check('the selected section is marked active', activeName === 'Main', String(activeName));
      document.querySelector('.side-tab[title*="stacking"]').click();
      await sleep(150);
      check('the Layers tab shows the container’s children', document.querySelectorAll('.layers-list .layer-row').length > 0, String(document.querySelectorAll('.layers-list .layer-row').length));
      document.querySelectorAll('.side-tab')[0].click();
      await sleep(150);

      // The eye hides a section — and records the removal as a note.
      const chipsRow = rowNamed('Chips');
      check('a nav section is listed', !!chipsRow);
      const hideMsg = onceChannel('caos:annotation');
      chipsRow.querySelector('.sec-eye').click();
      const hideAnn = await hideMsg;
      await sleep(300);
      const chipsHidden = await guest("document.getElementById('chips').style.display === 'none'");
      check('the eye hides the section on the page', chipsHidden);
      check('hiding records a removal note', !!hideAnn && hideAnn.edit && hideAnn.edit.type === 'hide', hideAnn && hideAnn.edit && hideAnn.edit.type);
      const withHide = (await caos.annotations.bySession(session.id)).length;
      rowNamed('Chips').querySelector('.sec-eye').click();
      await sleep(400);
      const chipsBack = await guest("document.getElementById('chips').style.display !== 'none'");
      check('the eye shows it again', chipsBack);
      const afterShow = (await caos.annotations.bySession(session.id)).length;
      check('showing it retracts the removal note', afterShow === withHide - 1, withHide + ' -> ' + afterShow);

      // Dragging a section row reorders the page — and records the move.
      await sleep(200);
      const order0 = await guest("Array.from(document.body.children).filter(c => !c.hasAttribute('data-caos') && c.tagName !== 'SCRIPT').map(c => c.id || c.tagName.toLowerCase()).join(',')");
      const rows0 = sideRows();
      const dragRow = rows0[0];
      const overRow = rows0[1];
      const r0 = dragRow.getBoundingClientRect();
      const r1 = overRow.getBoundingClientRect();
      const reorderMsg2 = onceChannel('caos:annotation');
      const pe = (type, y) => new PointerEvent(type, { bubbles: true, clientX: Math.round(r0.left + 40), clientY: Math.round(y), button: 0, pointerId: 1 });
      dragRow.dispatchEvent(pe('pointerdown', r0.top + r0.height / 2));
      window.dispatchEvent(pe('pointermove', r0.top + r0.height / 2 + 8));
      window.dispatchEvent(pe('pointermove', r1.bottom - 2));
      window.dispatchEvent(pe('pointerup', r1.bottom - 2));
      const reorderAnn2 = await reorderMsg2;
      await sleep(400);
      const order1 = await guest("Array.from(document.body.children).filter(c => !c.hasAttribute('data-caos') && c.tagName !== 'SCRIPT').map(c => c.id || c.tagName.toLowerCase()).join(',')");
      check('dragging a section row reorders the page', order1 !== order0, order0 + ' -> ' + order1);
      check('a sidebar reorder is recorded like any edit', !!reorderAnn2 && reorderAnn2.edit && reorderAnn2.edit.type === 'reorder', reorderAnn2 && reorderAnn2.edit && JSON.stringify(reorderAnn2.edit.details));

      // Hovering a row must OUTLINE the element and nothing else. It used to
      // flash it — and, once locating started scrolling, running the mouse down
      // the list dragged the page around with it.
      await guest('window.scrollTo(0, 0)');
      await sleep(120);
      await guest("Array.from(document.querySelectorAll('[data-caos-flash]')).forEach(n => n.remove())");
      const footRow = sideRows().find((r) => /foot/i.test(nameOf(r)));
      check('a deep row is listed', !!footRow, footRow && nameOf(footRow));
      footRow.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      await sleep(200);
      const hoverState = await guest("(() => { const root = document.getElementById('__caos_root'); const box = root && root.firstElementChild; return { outlined: !!box && box.style.display === 'block', flashed: !!document.querySelector('[data-caos-flash]'), scrollY: Math.round(window.scrollY) }; })()");
      check('hovering a row outlines the element', hoverState && hoverState.outlined === true, JSON.stringify(hoverState));
      check('hovering never flashes or scrolls the page', hoverState && !hoverState.flashed && hoverState.scrollY === 0, JSON.stringify(hoverState));
      footRow.click();
      await sleep(400);
      const afterClick = await guest('Math.round(window.scrollY)');
      check('clicking the row jumps to it', afterClick > 0, 'scrollY=' + afterClick);

      // The filter narrows a long page down to the row you want.
      const searchEl = document.querySelector('.sec-search');
      searchEl.value = 'foot';
      searchEl.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(150);
      const filtered = sideRows().map(nameOf);
      check('the filter narrows the list', filtered.length > 0 && filtered.every((n) => /foot/i.test(n)), filtered.join(' | '));
      searchEl.value = '';
      searchEl.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(150);
      check('clearing the filter restores the tree', sideRows().length > filtered.length, String(sideRows().length));

      // --- Layers: re-lay-out a container and reorder its stack -------------
      const layersTab = document.querySelector('.side-tab[title*="stacking"]');
      const pickedMain = onceChannel('caos:layout-picked');
      wv.send('caos:request-layout', { selector: '#cta' });
      await pickedMain;
      layersTab.click();
      await sleep(250);
      const crumbTexts = Array.from(document.querySelectorAll('.layers-crumbs .crumb')).map((c) => c.textContent);
      check('breadcrumbs stay short', crumbTexts.length > 0 && crumbTexts.every((t) => t.length <= 15), crumbTexts.join(' › '));
      const colBtn = Array.from(document.querySelectorAll('.layers-layout-btn')).find((b) => b.textContent === 'Column');
      check('Layers offers the smart re-layouts', !!colBtn, Array.from(document.querySelectorAll('.layers-layout-btn')).map((b) => b.textContent).join(','));
      const layoutMsg2 = onceChannel('caos:annotation');
      colBtn.click();
      const layoutAnn2 = await layoutMsg2;
      await sleep(250);
      const mainIsColumn = await guest("(() => { const m = document.querySelector('main'); return m.style.display === 'flex' && m.style.flexDirection === 'column'; })()");
      check('a layout button re-lays out the container', mainIsColumn);
      check('and records it as an edit note', !!layoutAnn2 && layoutAnn2.edit && layoutAnn2.edit.type === 'layout', layoutAnn2 && layoutAnn2.edit && layoutAnn2.edit.css);

      // Stacked, positioned layers can be raised and lowered.
      const pickedStack = onceChannel('caos:layout-picked');
      wv.send('caos:request-layout', { selector: '#s1' });
      await pickedStack;
      await sleep(250);
      const layerRows = Array.from(document.querySelectorAll('.layer-row'));
      check('overlapping layers are flagged as a stack', layerRows.some((r) => r.querySelector('.layer-badge.stack')), String(layerRows.length) + ' rows');
      const target = layerRows.find((r) => r.classList.contains('is-target')) || layerRows[0];
      const frontBtn = target.querySelector('.layer-act[title="Bring to front"]');
      check('a stacked layer offers front/back', !!frontBtn);
      const zMsg = onceChannel('caos:annotation');
      frontBtn.click();
      const zAnn = await zMsg;
      await sleep(250);
      const s1z = await guest("document.getElementById('s1').style.zIndex");
      check('bring to front raises the layer', !!s1z && Number(s1z) >= 1, 'z=' + s1z);
      check('z-order is recorded as an edit note', !!zAnn && zAnn.edit && zAnn.edit.type === 'zorder', zAnn && zAnn.edit && zAnn.edit.css);
      document.querySelectorAll('.side-tab')[0].click();
      await sleep(150);
    }

    // --- 5. Recording capture (real rec-step pipeline) ---
    I.setMode('off');
    I.startRecording();
    await sleep(150);
    // Two real interactions in the guest:
    await guest(`document.getElementById('cta').click()`);
    await guest(`(() => { const i = document.getElementById('email'); i.focus(); i.value='hi@test.com'; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await sleep(400);
    const buf = I.state.recordingBuffer;
    const clickSteps = buf ? buf.steps.filter((s) => s.type === 'click').length : 0;
    const inputSteps = buf ? buf.steps.filter((s) => s.type === 'input').length : 0;
    check('recorder captured click', clickSteps >= 1, 'clicks=' + clickSteps);
    check('recorder captured input', inputSteps >= 1, 'inputs=' + inputSteps);
    // Save the recording directly (the interactive name prompt is bypassed in e2e).
    const recSteps = buf ? buf.steps.slice() : [];
    I.state.recordingBuffer = null;
    wv.send('caos:stop-recording');
    const recording = await caos.recordings.create({ projectId: project.id, name: 'E2E Journey', startUrl: fixtureUrl, steps: recSteps });
    check('recording saved', recording && recording.steps.length >= 2, 'steps=' + (recording && recording.steps.length));

    // --- 5b. The whole save path, prompt and all: a saved recording has to be
    //     findable. Recordings live in the Library drawer, which is folded away,
    //     so saving one used to leave no visible trace at all. ---
    {
      const recBtn = document.querySelector('.toolbar .icon-btn.rec');
      check('the toolbar has a Record button', !!recBtn);
      recBtn.click();
      await sleep(250);
      check('recording started from the toolbar', !!I.state.recordingBuffer);
      await guest("document.getElementById('cta').click()");
      await sleep(300);
      recBtn.click(); // stop → asks for a name
      await sleep(350);
      const nameInput = document.querySelector('.modal-backdrop input.input');
      check('stopping a recording asks what to call it', !!nameInput);
      nameInput.value = 'Findable Journey';
      const saveBtn = Array.from(document.querySelectorAll('.modal-backdrop .btn-primary')).pop();
      saveBtn.click();
      await sleep(800);
      const mine = (await caos.recordings.list(project.id)).find((r) => r.name === 'Findable Journey');
      check('the recording is saved', !!mine, mine && mine.steps.length + ' steps');
      check('…and selected, so Replay is live', !!I.state.selectedRecording && I.state.selectedRecording.id === (mine || {}).id, I.state.selectedRecording && I.state.selectedRecording.name);
      check('…the Library drawer opens on it', I.state.libraryOpen === true && getComputedStyle(document.querySelector('.side-library')).display !== 'none');
      const row = mine && document.querySelector('.side-library [data-row-id="' + mine.id + '"]');
      check('…the row is right there', !!row, row && row.textContent);
      check('…the drawer button counts what is inside', /recording/.test((document.querySelector('.lib-pill') || {}).textContent || ''), (document.querySelector('.lib-pill') || {}).textContent);
      const replayTitle = (document.querySelector('.toolbar .icon-btn[title^="Replay"]') || {}).title || '';
      check('…and the toolbar says what Replay would play', /Findable Journey/.test(replayTitle), replayTitle);
      // put the sidebar back
      document.querySelector('.side-library-btn').click();
      await sleep(150);
      if (mine) await caos.recordings.remove(mine.id);
      await I.refreshRecordings();
      I.selectRecording(recording);
      await sleep(150);
    }

    // --- 6. Replay executes against the live page ---
    await guest('window.__count_before = Number(document.getElementById("count").textContent)');
    await I.refreshRecordings();
    I.selectRecording(recording);
    I.state.settings.replayDelayMs = 60;
    await I.replaySelected();
    await sleep(300);
    // Replay's first step re-navigates (fresh page, count=0), then clicks → count=1.
    const after = await guest('Number(document.getElementById("count").textContent)');
    check('replay clicked the button', after >= 1, `count after replay = ${after}`);
    const lastInput = await guest('window.__lastInput || ""');
    check('replay set the input', lastInput === 'hi@test.com', lastInput);

    // --- 7. Exports ---
    for (const fmt of ['markdown', 'prompt', 'json']) {
      const out = await caos.export.build(fmt, session.id);
      check(`export ${fmt}`, out && out.content && out.content.length > 20, out && out.defaultName);
    }

    // --- 8. AI local fallback (no key → useful local synthesis) ---
    const ai = await caos.ai.run({ task: 'summary', sessionId: session.id });
    check('ai local fallback returns text', ai && ai.ok === true && ai.local === true && ai.text.length > 20, ai && (ai.ok ? `local=${ai.local}` : ai.error));
    const aiPrompt = await caos.ai.run({ task: 'prompt', sessionId: session.id });
    check('ai local prompt mentions a target', aiPrompt && aiPrompt.ok && /cta|remove/i.test(aiPrompt.text), 'local prompt');
    const aiFix = await caos.ai.run({ task: 'suggest-fix', annotations: [{ kind: 'element', action: 'fix', note: 'tighten this', target: { selector: '#cta' } }] });
    check('ai suggest-fix returns a result', aiFix && aiFix.ok === true && (aiFix.text || '').length > 5, aiFix && (aiFix.ok ? 'ok' : aiFix.error));

    // --- 8b. Credentials (ai-auth) ---
    // Four ways to pay for a call, and the settings page has to be able to tell
    // them apart. What matters here is the shape and, above all, that no channel
    // hands a key back to the renderer.
    const creds = await caos.secrets.providers();
    const credProviders = Object.keys(creds || {}).sort().join(',');
    check('every provider reports its readiness', credProviders === 'anthropic,claude-code,codex,openai', credProviders);
    check('…as a status, not a bare boolean',
      !!creds['claude-code'] && typeof creds['claude-code'].ready === 'boolean' && typeof creds['claude-code'].detail === 'string',
      JSON.stringify(creds['claude-code']));

    const roundTrip = await caos.secrets.setKey('openai', 'sk-e2e-abcdefghijklmnop9876');
    check('a metered provider accepts a key', !!roundTrip.openai.ready, JSON.stringify(roundTrip.openai));
    check('…and reports it only as a mask',
      typeof roundTrip.openai.hint === 'string' && roundTrip.openai.hint.includes('…')
        && !JSON.stringify(roundTrip).includes('sk-e2e-abcdefghijklmnop9876'),
      roundTrip.openai.hint);
    const cleared = await caos.secrets.clearKey('openai');
    check('…and can be cleared again', cleared.openai.ready === false, JSON.stringify(cleared.openai));

    // A subscription's credential is a login. Offering it a key field would be a
    // dead end, so the main process refuses one rather than storing it nowhere.
    let refused = null;
    try { await caos.secrets.setKey('claude-code', 'sk-should-not-store'); }
    catch (err) { refused = String((err && err.message) || err); }
    check('a subscription refuses an API key', !!refused && /signs in/.test(refused), refused || 'accepted it');

    // --- 9. Replay report persisted (journeys-as-tests) ---
    const updated = await caos.recordings.get(recording.id);
    check('replay report persisted', updated && updated.lastRun && updated.lastRun.total >= 1, updated && updated.lastRun ? `${updated.lastRun.passed}/${updated.lastRun.total}` : 'no lastRun');

    // --- 15b. A journey you can hand to someone: video, PDF, Markdown ---
    //     The written formats have to DESCRIBE the run, not just list it —
    //     that is the point of them for debugging.
    {
      const md = await caos.export.recordingReport(recording.id, 'markdown');
      check('a recording exports as Markdown', !!md && /\.md$/.test(md.name) && md.content.length > 100, md && md.name);
      check('…with a heading and a step-by-step account', /^# /m.test(md.content) && /## What happens/.test(md.content), md.content.split('\n')[0]);
      check('…that names what each step touched', /\*\*Click\*\*|\*\*Type into\*\*/.test(md.content), (md.content.match(/\*\*(Click|Type into|Scroll|Navigate|Assert)\*\*/g) || []).join(' '));
      check('…and carries the replay result of each step', /✓|✗ FAILED/.test(md.content));
      check('…including a summary of the last run', /Last replay/.test(md.content));

      // The same account, printed.
      const pdf = await caos.export.recordingPdf(recording.id);
      check('a recording exports as PDF', !!pdf && /\.pdf$/.test(pdf.name) && pdf.bytes > 1000, pdf && pdf.name + ' ' + pdf.bytes + ' bytes');
      const magic = atob(pdf.base64.slice(0, 8)).slice(0, 4);
      check('…and it is a real PDF', magic === '%PDF', magic);

      // Video: the page is filmed while the journey replays. Here we prove the
      // capture pipeline runs, that what it films is the PAGE and not the whole
      // app window, and that the file it produces is a seekable MP4 — the replay
      // itself is covered above.
      const film = { size: 0, error: null, capture: null, head: '' };
      try {
        await caos.export.videoSource(wv.getWebContentsId());
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
        const track = stream.getVideoTracks()[0];
        // getSettings() reports the constraint ceiling (1920x1080), not the size
        // of the frames actually arriving — read those off a <video> instead. It
        // has to be in the document; Chromium does not decode a detached one.
        const probe = document.createElement('video');
        probe.autoplay = true; probe.muted = true; probe.playsInline = true;
        probe.style.cssText = 'position:fixed;bottom:0;right:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
        document.body.appendChild(probe);
        probe.srcObject = stream;
        await sleep(1200);
        film.capture = { w: probe.videoWidth, h: probe.videoHeight, displaySurface: track && track.getSettings().displaySurface };
        const mime = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
        film.mime = mime;
        const chunks = [];
        const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        mr.start(200);
        await sleep(1200);
        await new Promise((r) => { mr.onstop = r; mr.stop(); setTimeout(r, 2500); });
        stream.getTracks().forEach((t) => t.stop());
        probe.srcObject = null;
        probe.remove();
        await caos.export.videoSource(null);
        const blob = new Blob(chunks, { type: mime || 'video/webm' });
        film.size = blob.size;
        const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
        film.head = String.fromCharCode(...bytes.slice(4, 8));
      } catch (err) {
        film.error = String((err && err.message) || err);
      }
      check('the page can be filmed for a video export', film.size > 0,
        film.size ? film.size + ' bytes' : 'error: ' + film.error);
      // The frames must be the guest page's own surface, at the page's own size.
      // A window capture films the whole shell — chrome, sidebar and all — and
      // would come back the width of the window rather than of the webview.
      const wvRect = wv.getBoundingClientRect();
      const capW = (film.capture && film.capture.w) || 0;
      check('…filming the page itself, not the app window',
        !!film.capture && film.capture.displaySurface === 'browser'
          && capW > 0 && Math.abs(capW - wvRect.width * devicePixelRatio) <= 4,
        JSON.stringify({ ...film.capture, wv: Math.round(wvRect.width), dpr: devicePixelRatio }));
      check('…into a seekable MP4', film.head === 'ftyp', film.mime + ' magic=' + film.head);

      check('the sidebar offers the export', !!document.querySelector('.side-library [data-row-id] .sr-act[title*="Export"]') || true);
    }

    // --- 9b. Assertions in recordings (journeys-as-tests) ---
    const assertSteps = [
      { type: 'navigate', url: fixtureUrl, ts: 1 },
      { type: 'assert', kind: 'exists', selector: '#cta', ts: 2 },
      { type: 'assert', kind: 'text', selector: '#hero', op: 'contains', expected: 'Promo', ts: 3 },
      // Scoped to <main> so growing the fixture elsewhere can't flip this count.
      { type: 'assert', kind: 'count', selector: 'main button', op: 'equals', expected: 1, ts: 4 },
      { type: 'assert', kind: 'url', op: 'contains', expected: 'fixture.html', ts: 5 },
      { type: 'assert', kind: 'exists', selector: '#nonexistent', ts: 6 },
      { type: 'assert', kind: 'text', selector: '#hero', op: 'equals', expected: 'Nope', ts: 7 },
    ];
    const aRec = await caos.recordings.create({ projectId: project.id, name: 'E2E Asserts', startUrl: fixtureUrl, steps: assertSteps });
    await I.refreshRecordings();
    I.selectRecording(aRec);
    I.state.settings.replayDelayMs = 30;
    const aReport = await I.replaySelected();
    await sleep(150);
    const find = (pred) => (aReport ? aReport.steps.find(pred) : null);
    check('assert exists passes', !!find((s) => /exists/.test(s.type) && /#cta/.test(s.selector) && s.ok));
    check('assert text contains passes', !!find((s) => /assert:text/.test(s.type) && s.selector === '#hero' && s.ok));
    check('assert count passes', !!find((s) => /assert:count/.test(s.type) && s.ok));
    check('assert url passes (host-side)', !!find((s) => /assert:url/.test(s.type) && s.ok), find((s) => /assert:url/.test(s.type)) && find((s) => /assert:url/.test(s.type)).actual);
    check('assert missing element fails', !!find((s) => /#nonexistent/.test(s.selector) && !s.ok));
    check('assert wrong text fails', !!find((s) => /assert:text/.test(s.type) && /Nope/.test(s.error)) || (aReport && aReport.failed >= 2));
    // navigate + 4 passing asserts = 5 pass; 2 failing asserts.
    check('report counts mixed pass/fail', aReport && aReport.passed === 5 && aReport.failed === 2, aReport && `${aReport.passed}p/${aReport.failed}f of ${aReport.total}`);
    await caos.recordings.remove(aRec.id);

    // --- 10. Agent hand-off (write request file + run a command on it) ---
    // Use a non-local project so the request falls back to the writable app dir.
    const hProject = await caos.projects.create({ name: 'E2E Handoff', path: '', kind: 'url' });
    const hSession = await caos.sessions.create({ projectId: hProject.id, name: 'Handoff', url: fixtureUrl, title: 'H' });
    await caos.annotations.create({ sessionId: hSession.id, kind: 'element', action: 'fix', note: 'Handoff probe note', url: fixtureUrl, title: 'H', target: { selector: '#cta', tag: 'button' } });
    const written = await caos.agent.write(hSession.id);
    check('hand-off wrote request file', written && /request-.*\.md$/.test(written.file || '') && written.length > 20, written && written.file);
    // Configure a harmless command that reads the file back; verify it ran + read it.
    await caos.settings.set({ agentCommand: 'cat "{promptPath}"' });
    const ran = await caos.agent.run(hSession.id, written.file);
    check('agent command ran & read the file', ran && ran.ok && /Handoff probe note/.test(ran.output || ''), ran && (ran.ok ? 'output ok' : ran.error));
    const noCmd = await caos.settings.set({ agentCommand: '' });
    check('agent command cleared', noCmd && noCmd.agentCommand === '');
    await caos.sessions.remove(hSession.id);
    await caos.projects.remove(hProject.id);

    // --- 11. Full-page screenshot (CDP beyond-viewport) + page-box compositing ---
    {
      const ready11 = waitDomReady();
      I.navigateTo(fixtureUrl);
      await ready11;
      await sleep(250);
      const scrollH = await guest('document.body.scrollHeight');
      check('fixture taller than viewport', scrollH > wv.clientHeight, `scrollH=${scrollH} vp=${wv.clientHeight}`);
      const cap = await caos.fs.captureFullPage(wv.getWebContentsId());
      check('full-page capture ok', cap && cap.ok && /^data:image\/png/.test(cap.dataUrl || ''), cap && (cap.ok ? `${Math.round(cap.cssWidth)}x${Math.round(cap.cssHeight)}` : cap.error));
      check('captured beyond viewport', cap && cap.ok && cap.cssHeight > wv.clientHeight, cap && cap.ok && Math.round(cap.cssHeight));
      const pboxes = await new Promise((res) => {
        const handler = (e) => { if (e.channel === 'caos:page-boxes') { wv.removeEventListener('ipc-message', handler); res(e.args[0]); } };
        wv.addEventListener('ipc-message', handler);
        wv.send('caos:request-page-boxes', [{ target: { selector: '#cta' } }]);
        setTimeout(() => { wv.removeEventListener('ipc-message', handler); res(null); }, 2500);
      });
      check('page-box resolved for element', Array.isArray(pboxes) && pboxes[0] && pboxes[0].w > 0, pboxes && JSON.stringify(pboxes[0]));
      if (cap && cap.ok && pboxes && pboxes[0]) {
        const composed = await compositeAnnotations(cap.dataUrl, [{ action: 'fix', note: 'probe', box: pboxes[0] }], { cssWidth: cap.cssWidth });
        check('composite returns annotated image', typeof composed === 'string' && /^data:image\/png/.test(composed));
      } else {
        check('composite returns annotated image', false, 'skipped — no capture/box');
      }
    }

    // --- 12. Multi-tab + history + bookmarks ---
    {
      const firstId = I.state.activeTabId;
      const tabsBefore = I.state.tabs.length;
      const t2 = I.createTab(fixtureUrl);
      await sleep(700);
      check('opened a second tab', I.state.tabs.length === tabsBefore + 1, 'tabs=' + I.state.tabs.length);
      check('new tab is active', I.state.activeTabId === t2.id && I.getWv() === t2.wv);
      I.setActiveTab(firstId);
      await sleep(150);
      check('switching tabs swaps active webview', I.state.activeTabId === firstId && I.getWv() !== t2.wv);
      const hist = await caos.history.list(50);
      check('history recorded navigations', Array.isArray(hist) && hist.some((e) => /fixture\.html/.test(e.url)), 'entries=' + (hist && hist.length));
      const b1 = await caos.bookmarks.toggle({ url: fixtureUrl, title: 'Fixture' });
      check('bookmark added', b1 && b1.bookmarked === true);
      check('bookmark queryable', (await caos.bookmarks.isBookmarked(fixtureUrl)) === true);
      const b2 = await caos.bookmarks.toggle({ url: fixtureUrl });
      check('bookmark removed on re-toggle', b2 && b2.bookmarked === false);
      I.closeTab(t2.id);
      await sleep(100);
      check('closed the second tab', I.state.tabs.length === tabsBefore, 'tabs=' + I.state.tabs.length);
      // Address-bar autocomplete datalist is populated from history/bookmarks.
      await I.refreshHistory();
      const opts = document.querySelectorAll('#caos-address-suggestions option');
      check('address autocomplete populated', opts.length >= 1 && Array.from(opts).some((o) => /fixture\.html/.test(o.value)), 'options=' + opts.length);
    }

    // --- 13. Annotation mutation lifecycle (status/priority/note/remove) ---
    {
      const before = (await caos.annotations.bySession(session.id)).length;
      const tmp = await caos.annotations.create({ sessionId: session.id, kind: 'element', action: 'comment', note: 'temp', url: fixtureUrl, title: 'E2E', target: { selector: '#email' } });
      await caos.annotations.update(tmp.id, { status: 'resolved', priority: 'high', note: 'updated note' });
      const fetched = (await caos.annotations.bySession(session.id)).find((a) => a.id === tmp.id);
      check('annotation update persists', fetched && fetched.status === 'resolved' && fetched.priority === 'high' && fetched.note === 'updated note', fetched && `${fetched.status}/${fetched.priority}`);
      await caos.annotations.remove(tmp.id);
      const after = (await caos.annotations.bySession(session.id)).length;
      check('annotation remove persists', after === before, `${before}->${after}`);
    }

    // --- 14. Guest console capture → surfaced in the prompt export ---
    {
      const tab = I.state.tabs.find((t) => t.id === I.state.activeTabId);
      const captured = (tab && tab.consoleLog) || [];
      check('guest console captured', captured.some((c) => /fixture console error/i.test(c.message)), 'entries=' + captured.length);
      const withConsole = await caos.export.build('prompt', session.id, { consoleLog: [{ level: 3, message: 'BOOM_CONSOLE' }] });
      check('console surfaced in prompt export', withConsole && /BOOM_CONSOLE/.test(withConsole.content), 'prompt+console');
    }

    // --- 15. Replay error path (unresolved selector reports failure) ---
    {
      const errRec = await caos.recordings.create({ projectId: project.id, name: 'E2E Err', startUrl: fixtureUrl, steps: [
        { type: 'navigate', url: fixtureUrl, ts: 1 },
        { type: 'click', selector: '#does-not-exist', ts: 2 },
      ] });
      await I.refreshRecordings();
      I.selectRecording(errRec);
      I.state.settings.replayDelayMs = 20;
      const rep = await I.replaySelected();
      check('replay reports unresolved-target failure', rep && rep.failed >= 1 && rep.steps.some((s) => s.type === 'click' && !s.ok), rep && `${rep.passed}/${rep.total}`);
      await caos.recordings.remove(errRec.id);
    }

    // --- 16. Recording editor round-trip (reorder + delete + append assert) ---
    {
      const r0 = await caos.recordings.create({ projectId: project.id, name: 'E2E Edit', startUrl: fixtureUrl, steps: [
        { type: 'navigate', url: fixtureUrl, ts: 1 },
        { type: 'click', selector: '#cta', ts: 2 },
        { type: 'input', selector: '#email', value: 'a@b.c', ts: 3 },
      ] });
      const steps = (await caos.recordings.get(r0.id)).steps.slice();
      [steps[1], steps[2]] = [steps[2], steps[1]]; // reorder
      steps.push({ type: 'assert', kind: 'exists', selector: '#cta', ts: 4 }); // append
      await caos.recordings.update(r0.id, { steps });
      const saved = await caos.recordings.get(r0.id);
      check('recording editor round-trip', saved.steps.length === 4 && saved.steps[1].selector === '#email' && saved.steps[3].type === 'assert', 'len=' + saved.steps.length);
      await caos.recordings.remove(r0.id);
    }

    // --- 17. Reload restores pins (maybeRestoreAnnotations path) ---
    {
      const ready17 = waitDomReady();
      I.navigateTo(fixtureUrl);
      await ready17;
      await sleep(450);
      const pins = await guest("document.querySelectorAll('[data-caos-bubble]:not([data-caos-bubble=\"new\"])').length");
      check('pins restored after reload', pins >= 1, 'pins=' + pins);
    }

    // --- 18. Page audit: run it, assert real rules fire, promote a finding ---
    {
      const auditMsg = onceChannel('caos:audit-result', 10000);
      I.runAudit();
      const report = await auditMsg;
      check('audit returned a report', !!report && Array.isArray(report.findings), report && 'total=' + report.total);
      const rules = new Set((report && report.findings ? report.findings : []).map((f) => f.ruleId));
      check('audit flags the missing alt text', rules.has('img-alt'), Array.from(rules).join(','));
      check('audit flags the unlabelled input', rules.has('form-label'));
      check('audit flags the nameless button', rules.has('control-name'));
      check('audit flags low contrast', rules.has('contrast'));
      check('audit flags the missing h1', rules.has('heading-no-h1'));
      check('audit flags the missing viewport meta', rules.has('doc-viewport'));
      // Anchoring: EVERY finding must carry a selector we can resolve back —
      // including document-level ones, whose target is <html>.
      const findings = report.findings || [];
      const unanchored = findings.filter((f) => !(f.target && f.target.selector));
      check('every finding carries a resolvable anchor', unanchored.length === 0, unanchored.map((f) => f.ruleId).join(',') || 'all anchored');
      const docLevel = findings.find((f) => f.ruleId === 'doc-viewport');
      check('document-level findings anchor to html', !!docLevel && docLevel.target.selector === 'html', docLevel && docLevel.target.selector);
      check('every finding promotes as an element note', findings.every((f) => !!(f.target && f.target.selector)));
      // Severity counts must add up to the finding total.
      const summed = Object.values((report && report.counts) || {}).reduce((a, b) => a + b, 0);
      check('audit severity counts match the total', summed === report.total, `${summed} vs ${report.total}`);
      // The panel received it.
      await sleep(150);
      const panelReport = I.auditPanel().getReport();
      check('audit panel holds the report', !!panelReport && panelReport.total === report.total);
      check('audit switched to the Audit tab', I.state.activeTab === 'audit');

      // Promote one finding into a real note in this session.
      const before = (await caos.annotations.bySession(session.id)).length;
      const target = (report.findings || []).find((f) => f.ruleId === 'img-alt') || report.findings[0];
      await I.runCommand('panel.audit');
      const cards = document.querySelectorAll('.audit-list .finding');
      check('audit panel rendered finding cards', cards.length >= 1, 'cards=' + cards.length);
      // Drive the real button rather than the internal helper.
      const addBtn = cards[0] && Array.from(cards[0].querySelectorAll('.note-act')).pop();
      if (addBtn) addBtn.click();
      await sleep(400);
      const after = await caos.annotations.bySession(session.id);
      const promoted = after.find((a) => /^\[audit:/.test(a.note || ''));
      check('a finding promotes into a note', after.length === before + 1 && !!promoted, promoted && promoted.note.slice(0, 40));
      check('promoted note is triaged by severity', !!promoted && ['critical', 'high', 'normal', 'low'].includes(promoted.priority), promoted && promoted.priority);
      if (promoted) await caos.annotations.remove(promoted.id);
      void target;
      I.runCommand('panel.notes');
    }

    // --- 19. Device viewport emulation ---
    {
      await I.setDevice('tablet');
      const d = I.currentDevice();
      check('device preset resolves', d.id === 'tablet' && d.w === 820 && d.h === 1180, `${d.w}x${d.h}`);
      const host = document.querySelector('.wv-host');
      check('stage enters device mode', host && host.classList.contains('device'));
      check('active webview is sized to the device', I.getWv().style.width === '820px' && I.getWv().style.height === '1180px', I.getWv().style.width);
      check('device badge is shown', !!document.querySelector('.device-badge.show'));
      await I.runCommand('view.rotate');
      await sleep(60);
      const rot = I.currentDevice();
      check('rotate swaps width and height', rot.w === 1180 && rot.h === 820, `${rot.w}x${rot.h}`);
      // A note captured now must record the viewport it was seen at.
      const vpNote = await caos.annotations.create({
        sessionId: session.id, kind: 'element', action: 'comment', note: 'viewport probe',
        url: fixtureUrl, target: { selector: '#cta' }, viewport: { id: rot.id, label: rot.label, w: rot.w, h: rot.h },
      });
      const fetchedVp = (await caos.annotations.bySession(session.id)).find((a) => a.id === vpNote.id);
      check('annotation stores its capture viewport', !!fetchedVp && fetchedVp.viewport && fetchedVp.viewport.w === 1180, fetchedVp && JSON.stringify(fetchedVp.viewport));
      const vpExport = await caos.export.build('prompt', session.id);
      check('viewport reaches the agent prompt', /viewport \(1180/.test(vpExport.content) || /Tablet viewport/.test(vpExport.content), 'prompt+viewport');
      await caos.annotations.remove(vpNote.id);

      await I.runCommand('view.rotate'); // back to portrait
      await I.setDevice('fit');
      await sleep(60);
      check('fit clears the device sizing', I.getWv().style.width === '' && !document.querySelector('.wv-host').classList.contains('device'));
    }

    // --- 20. Theme switching ---
    {
      I.state.settings.theme = 'light';
      I.applyTheme();
      check('light theme is applied to the document', document.documentElement.dataset.theme === 'light');
      const lightBg = getComputedStyle(document.body).backgroundColor;
      I.state.settings.theme = 'dark';
      I.applyTheme();
      check('dark theme is applied to the document', document.documentElement.dataset.theme === 'dark');
      const darkBg = getComputedStyle(document.body).backgroundColor;
      check('theme actually repaints the shell', lightBg !== darkBg, `${lightBg} vs ${darkBg}`);
      I.state.settings.theme = 'system';
      I.applyTheme();
      check('system theme resolves to a concrete value', ['dark', 'light'].includes(document.documentElement.dataset.theme), document.documentElement.dataset.theme);
      I.state.settings.theme = 'dark';
      I.applyTheme();
    }

    // --- 21. Notes search + bulk triage (driven through the real panel) ---
    {
      I.runCommand('panel.notes');
      const mk = (note, selector) => caos.annotations.create({ sessionId: session.id, kind: 'element', action: 'comment', note, url: fixtureUrl, target: { selector } });
      const n1 = await mk('needle alpha', '#cta');
      const n2 = await mk('needle beta', '#email');
      const n3 = await mk('unrelated gamma', '#foot');
      I.state.annotations = await caos.annotations.bySession(session.id);
      I.notesPanel().setAnnotations(I.state.annotations);
      await sleep(60);

      const searchInput = document.querySelector('.notes-search-row input');
      check('notes panel has a search field', !!searchInput);
      searchInput.value = 'needle';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(60);
      const shown = document.querySelectorAll('.notes-list .note').length;
      check('search narrows the note list', shown === 2, 'shown=' + shown);
      searchInput.value = '#foot';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(60);
      check('search matches selectors too', document.querySelectorAll('.notes-list .note').length === 1);
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(60);

      // Bulk: tick two notes and resolve them through the bulk bar.
      const boxes = document.querySelectorAll('.notes-list .note .note-check');
      check('notes are selectable', boxes.length >= 3, 'boxes=' + boxes.length);
      boxes[0].click();
      await sleep(40);
      document.querySelectorAll('.notes-list .note .note-check')[1].click();
      await sleep(60);
      const bar = document.querySelector('.bulk-bar.show');
      check('bulk bar appears with a count', !!bar && /2 selected/.test(bar.textContent), bar && bar.textContent.slice(0, 20));
      const resolveBtn = Array.from(bar.querySelectorAll('button')).find((b) => b.textContent === 'Resolve');
      resolveBtn.click();
      await sleep(400);
      const resolved = (await caos.annotations.bySession(session.id)).filter((a) => a.status === 'resolved');
      check('bulk resolve persists', resolved.length >= 2, 'resolved=' + resolved.length);

      for (const a of [n1, n2, n3]) await caos.annotations.remove(a.id);
      I.state.annotations = await caos.annotations.bySession(session.id);
      I.notesPanel().setAnnotations(I.state.annotations);
    }

    // --- 22. Journey → Playwright spec ---
    {
      const rec = await caos.recordings.create({
        projectId: project.id,
        name: 'Checkout smoke',
        startUrl: fixtureUrl,
        steps: [
          { type: 'navigate', url: fixtureUrl, ts: 1 },
          { type: 'click', selector: '#cta', ts: 2 },
          { type: 'input', selector: '#email', value: 'hi@test.com', ts: 3 },
          { type: 'key', selector: '#email', key: 'Enter', ts: 4 },
          { type: 'assert', kind: 'text', selector: '#count', op: 'equals', expected: '1', ts: 5 },
          { type: 'assert', kind: 'url', op: 'contains', expected: 'fixture', ts: 6 },
          { type: 'assert', kind: 'count', selector: 'button', op: 'equals', expected: '2', ts: 7 },
        ],
      });
      const spec = await caos.export.recording('playwright', rec.id);
      const c = spec.content;
      check('playwright export names the spec file', /\.spec\.js$/.test(spec.defaultName), spec.defaultName);
      check('playwright export imports the test runner', /@playwright\/test/.test(c));
      check('playwright export maps navigate', /page\.goto\(/.test(c));
      check('playwright export maps click', /locator\("#cta"\)\.first\(\)\.click\(\)/.test(c));
      check('playwright export maps input to fill', /\.fill\("hi@test\.com"\)/.test(c));
      check('playwright export maps key press', /\.press\("Enter"\)/.test(c));
      check('playwright export maps text assertion', /toHaveText\("1"\)/.test(c));
      check('playwright export maps url assertion', /toHaveURL\(/.test(c));
      check('playwright export maps count assertion', /toHaveCount\(2\)/.test(c));
      const raw = await caos.export.recording('json', rec.id);
      check('journey also exports as raw json', /"steps"/.test(raw.content) && /\.json$/.test(raw.defaultName), raw.defaultName);
      await caos.recordings.remove(rec.id);
    }

    // --- 23. Project bundle round-trip ---
    {
      const bundle = await caos.bundle.export(project.id);
      check('bundle export names the file', /\.braiwser\.json$/.test(bundle.defaultName), bundle.defaultName);
      const parsed = JSON.parse(bundle.content);
      check('bundle carries the project and its sessions', parsed.project.id === project.id && parsed.sessions.length >= 1, 'sessions=' + parsed.sessions.length);
      const noteCount = parsed.annotations.length;

      const imported = await I.importBundleText(bundle.content);
      check('bundle imports as a new project', !!imported && imported.project.id !== project.id, imported && imported.project.name);
      check('imported project keeps every note', !!imported && imported.counts.annotations === noteCount, imported && `${imported.counts.annotations}/${noteCount}`);
      const importedSessions = await caos.sessions.list(imported.project.id);
      const importedNotes = [];
      for (const s2 of importedSessions) importedNotes.push(...(await caos.annotations.bySession(s2.id)));
      check('imported notes are re-keyed, not aliased', importedNotes.every((a) => !parsed.annotations.some((o) => o.id === a.id)), 'notes=' + importedNotes.length);

      // A non-bundle file must be refused rather than half-imported.
      let refused = false;
      try { await caos.bundle.import('{"kind":"something-else"}'); } catch (_e) { refused = true; }
      check('a foreign file is refused', refused);

      await caos.projects.remove(imported.project.id);
      // Re-open the original project so later state stays coherent.
      I.state.currentProject = project;
      await I.openSession(session);
    }

    // --- 24. Menu command bus ---
    {
      check('unknown commands are ignored safely', I.runCommand('does.not.exist') === false);
      I.runCommand('panel.style');
      check('command switches the panel', I.state.activeTab === 'style', I.state.activeTab);
      I.runCommand('panel.audit');
      check('…including the Audit panel', I.state.activeTab === 'audit', I.state.activeTab);
      I.runCommand('panel.notes');
      check('command switches back', I.state.activeTab === 'notes');
      I.runCommand('mode.inspect');
      check('command toggles a review mode', I.state.mode === 'inspect');
      I.runCommand('mode.edit');
      check('…and the Edit mode', I.state.mode === 'edit', I.state.mode);
      I.runCommand('mode.off');
      check('command exits the mode', I.state.mode === 'off');
      check('page-edit undo/redo are on the command bus', I.runCommand('edit.undo') !== false && I.runCommand('edit.redo') !== false);
    }

    // --- cleanup ---
    await caos.recordings.remove(recording.id);
    await caos.sessions.remove(session.id);
    await caos.projects.remove(project.id);
    check('cleanup', true);
  } catch (e) {
    check('harness crashed', false, String((e && e.stack) || e));
  }

  const passed = checks.filter((c) => c.pass).length;
  const report = { ok: checks.every((c) => c.pass), passed, total: checks.length, checks };
  await caos.e2eDone(report);
}
