import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionController } from '../../../src/renderer/controllers/session-controller.js';
import { deferred, tick } from './fakes.mjs';

// A fake preload surface whose responses are released by the test.
function world() {
  const w = {
    calls: [],
    gates: {},
    notes: { S_A: [{ id: 'a1' }], S_B: [{ id: 'b1' }, { id: 'b2' }] },
    created: [],
    counts: [],
    shown: [],
    toasts: [],
    state: { currentSession: null, annotations: [], currentProject: { id: 'P' }, currentUrl: 'http://x/', currentTitle: 'T', sessionEpoch: 0 },
  };
  const gate = (key) => (w.gates[key] ? w.gates[key].promise : Promise.resolve());
  const api = {
    annotations: {
      bySession: async (id) => { w.calls.push(['bySession', id]); await gate('bySession:' + id); return (w.notes[id] || []).slice(); },
      bySessionUrl: async (id, url) => { w.calls.push(['bySessionUrl', id, url]); await gate('bySessionUrl:' + id); return (w.notes[id] || []).filter((n) => !n.url || n.url === url); },
      create: async (a) => { w.calls.push(['create', a.sessionId]); await gate('create:' + a.sessionId); const saved = { id: 'n' + (w.created.length + 1), ...a }; w.created.push(saved); (w.notes[a.sessionId] = w.notes[a.sessionId] || []).push(saved); return saved; },
    },
    sessions: {
      create: async (s) => { w.calls.push(['sessions.create']); await gate('sessions.create'); return { id: 'S_NEW' + w.calls.length, ...s }; },
      update: async (id, patch) => { w.calls.push(['sessions.update', id]); await gate('sessions.update'); return { id, ...patch }; },
    },
  };
  const ui = {
    setNotes: (list) => w.shown.push(list.map((n) => n.id)),
    sessionChanged: () => {},
    bumpCount: (id, d) => w.counts.push([id, d]),
    refreshSessions: async () => {},
    toast: (m) => w.toasts.push(m),
  };
  const c = createSessionController({ api, state: w.state, ui });
  const hold = (key) => { w.gates[key] = deferred(); return w.gates[key]; };
  return { w, c, hold };
}

test('RF-11: opening A then B while A\'s notes are still loading leaves B with B\'s notes', async () => {
  const { w, c, hold } = world();
  const gA = hold('bySession:S_A');
  const pA = c.open({ id: 'S_A' });
  const pB = c.open({ id: 'S_B' });
  await pB;
  assert.equal(w.state.currentSession.id, 'S_B');
  assert.deepEqual(w.state.annotations.map((n) => n.id), ['b1', 'b2']);
  gA.resolve(); // A's (slow) reply arrives last
  assert.equal(await pA, false, 'superseded');
  assert.equal(w.state.currentSession.id, 'S_B');
  assert.deepEqual(w.state.annotations.map((n) => n.id), ['b1', 'b2'], 'A\'s notes never replace B\'s');
});

test('RF-11: the session shows immediately with an EMPTY list, never the previous session\'s notes', async () => {
  const { w, c, hold } = world();
  await c.open({ id: 'S_A' });
  const g = hold('bySession:S_B');
  const p = c.open({ id: 'S_B' });
  assert.equal(w.state.currentSession.id, 'S_B');
  assert.deepEqual(w.state.annotations, []);
  g.resolve();
  await p;
  assert.equal(w.state.annotations.length, 2);
});

test('RF-11: a note saved for A after the user moved to B is stored for A and not shown in B', async () => {
  const { w, c, hold } = world();
  await c.open({ id: 'S_A' });
  const g = hold('create:S_A');
  const p = c.addNote({ id: 'S_A' }, { note: 'late', kind: 'element' });
  await c.open({ id: 'S_B' });
  g.resolve();
  const r = await p;
  assert.equal(r.displayed, false);
  assert.equal(r.saved.sessionId, 'S_A');
  assert.deepEqual(w.state.annotations.map((n) => n.id), ['b1', 'b2']);
  assert.deepEqual(w.counts, [['S_A', 1]], 'the count goes to the session that owns the note');
});

test('addNote in the current session appends and displays', async () => {
  const { w, c } = world();
  await c.open({ id: 'S_B' });
  const r = await c.addNote({ id: 'S_B' }, { note: 'x' });
  assert.equal(r.displayed, true);
  assert.equal(w.state.annotations.length, 3);
});

test('RF-11: concurrent captures share ONE "Quick notes" session create', async () => {
  const { w, c, hold } = world();
  const g = hold('sessions.create');
  const p1 = c.ensure();
  const p2 = c.ensure();
  g.resolve();
  const [s1, s2] = await Promise.all([p1, p2]);
  assert.equal(s1.id, s2.id);
  assert.equal(w.calls.filter(([n]) => n === 'sessions.create').length, 1);
  assert.equal(w.state.currentSession.id, s1.id);
});

test('RF-11: an ensure() that finishes after the user opened a session does not take over the screen', async () => {
  const { w, c, hold } = world();
  const g = hold('sessions.create');
  const p = c.ensure();
  await c.open({ id: 'S_B' });
  g.resolve();
  const created = await p;
  assert.ok(created.id.startsWith('S_NEW'));
  assert.equal(w.state.currentSession.id, 'S_B');
});

test('RF-11: title sync lands only on the session it was issued for', async () => {
  const { w, c, hold } = world();
  await c.open({ id: 'S_A', title: '' });
  w.state.currentTitle = 'Page A';
  const g = hold('sessions.update');
  const p = c.syncTitle();
  await c.open({ id: 'S_B', title: 'has one' });
  g.resolve();
  await p;
  assert.equal(w.state.currentSession.id, 'S_B');
  assert.equal(w.state.currentSession.title, 'has one');
});

test('RF-11: restored pins for A are never delivered after switching to B (or to another page)', async () => {
  const { w, c, hold } = world();
  await c.open({ id: 'S_A' });
  const g = hold('bySessionUrl:S_A');
  const delivered = [];
  let docValid = true;
  const p = c.restorePins({ session: { id: 'S_A' }, url: 'http://x/', stillValid: () => docValid, deliver: (a) => delivered.push(a) });
  await c.open({ id: 'S_B' });
  g.resolve();
  assert.equal(await p, false);
  assert.equal(delivered.length, 0);
  // same session, but the tab navigated meanwhile
  await c.open({ id: 'S_A' });
  const g2 = hold('bySessionUrl:S_A');
  const p2 = c.restorePins({ session: { id: 'S_A' }, url: 'http://x/', stillValid: () => docValid, deliver: (a) => delivered.push(a) });
  docValid = false;
  g2.resolve();
  assert.equal(await p2, false);
  // valid path numbers pins by the full list
  docValid = true;
  assert.equal(await c.restorePins({ session: { id: 'S_A' }, url: 'http://x/', stillValid: () => docValid, deliver: (a) => delivered.push(a) }), true);
  assert.equal(delivered[0][0].pinNum, 1);
});

test('close() invalidates loads in flight', async () => {
  const { w, c, hold } = world();
  const g = hold('bySession:S_A');
  const p = c.open({ id: 'S_A' });
  c.close();
  g.resolve();
  assert.equal(await p, false);
  assert.equal(w.state.currentSession, null);
  assert.deepEqual(w.state.annotations, []);
});
