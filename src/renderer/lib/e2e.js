// End-to-end self-test harness. Loaded only when CAOS_E2E=1.
// Drives the REAL app: navigates the webview to a fixture, exercises inspect /
// annotate / persist / restore / record / replay / dom-tree / export / AI, and
// reports pass/fail per check. Run with: CAOS_E2E=1 npx electron .
// Results print as a single `CAOS_E2E_REPORT {json}` line from the main process.

import { compositeAnnotations } from './screenshots.js';

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail: detail || '' });
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
    const onceChannel = (channel, timeout = 4000) => new Promise((res) => {
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

    // --- 2. Inspect → click element → fill popup → save → persist ---
    // Driven entirely with TRUSTED input (real mouse + keystrokes).
    I.setMode('inspect');
    check('inspect mode on', I.state.mode === 'inspect');
    const ctaRect = await guest(`(() => { const r = document.getElementById('cta').getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()`);
    await clickAt(ctaRect.x, ctaRect.y);
    await sleep(250);
    const popupShown = await guest("!!document.querySelector('[data-caos] textarea')");
    check('note popup opened on click', popupShown);

    const annMsg = onceChannel('caos:annotation', 3000);
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

    // --- 3. Restore pins ---
    I.refreshPins();
    await sleep(250);
    // Badges are the circular (border-radius:50%) data-caos divs.
    const pinCount = await guest("Array.from(document.querySelectorAll('div[data-caos]')).filter(d => d.style.borderRadius === '50%').length");
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
      const regionMsg = onceChannel('caos:annotation', 3000);
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
      const flatMsg = onceChannel('caos:annotation', 3000);
      const flatPopup = await guest("!!document.querySelector('[data-caos] textarea')");
      check('flat horizontal swipe registers', flatPopup);
      await clickSel('[data-caos] textarea');
      await typeText('Underline mark');
      await clickSel('[data-caos] [data-save]');
      const flatAnn = await flatMsg;
      const flatBox = flatAnn && flatAnn.target && flatAnn.target.box;
      check('thin region box padded to usable size', !!flatBox && flatBox.w >= 100 && flatBox.h >= 12, flatBox ? `${flatBox.w}x${flatBox.h}` : 'none');
      I.setMode('off');
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
      const layoutMsg = onceChannel('caos:annotation', 3000);
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
      const reorderMsg = onceChannel('caos:annotation', 3000);
      await clickSel('[data-caos-arrange="btn-down"]');
      const reorderAnn = await reorderMsg;
      check('reorder emitted an edit annotation', !!reorderAnn && reorderAnn.edit && reorderAnn.edit.type === 'reorder', reorderAnn && JSON.stringify((reorderAnn.edit || {}).details));
      const newOrder = await guest("(() => { const k = Array.from(document.querySelector('main').children).filter(c => !c.hasAttribute('data-caos')); return k[0] && k[0].id; })()");
      check('reorder moved the element in the DOM', newOrder === 'email', 'first child = ' + newOrder);

      // Resize #cta by dragging the SE handle with real input.
      await clickSel('#cta');
      await sleep(150);
      const w0 = await guest("document.getElementById('cta').getBoundingClientRect().width");
      const hpos = await guest("(() => { const h = document.querySelector('[data-caos-arrange=\\\"handle-se\\\"]'); if (!h) return null; return { x: Math.round(parseFloat(h.style.left)) + 5, y: Math.round(parseFloat(h.style.top)) + 5 }; })()");
      check('resize handle rendered', !!hpos, JSON.stringify(hpos));
      const resizeMsg = onceChannel('caos:annotation', 3000);
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
      const moveMsg = onceChannel('caos:annotation', 3000);
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

    // --- 4. DOM tree serializer ---
    const treeP = onceChannel('caos:dom-tree');
    wv.send('caos:request-dom-tree');
    const tree = await treeP;
    check('dom-tree returned', tree && tree.tag, tree && tree.tag);
    const flat = JSON.stringify(tree || {});
    check('dom-tree contains #cta', /"cta"/.test(flat));

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

    // --- 9. Replay report persisted (journeys-as-tests) ---
    const updated = await caos.recordings.get(recording.id);
    check('replay report persisted', updated && updated.lastRun && updated.lastRun.total >= 1, updated && updated.lastRun ? `${updated.lastRun.passed}/${updated.lastRun.total}` : 'no lastRun');

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
      const pins = await guest("Array.from(document.querySelectorAll('div[data-caos]')).filter(d => d.style.borderRadius === '50%').length");
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
      // Anchoring: a finding must carry a selector we can resolve back.
      const anchored = (report.findings || []).find((f) => f.target && f.target.selector);
      check('findings carry a resolvable anchor', !!anchored, anchored && anchored.target.selector);
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
      I.runCommand('panel.inspector');
      check('command switches the panel', I.state.activeTab === 'inspector');
      I.runCommand('panel.notes');
      check('command switches back', I.state.activeTab === 'notes');
      I.runCommand('mode.inspect');
      check('command toggles a review mode', I.state.mode === 'inspect');
      I.runCommand('mode.off');
      check('command exits the mode', I.state.mode === 'off');
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
