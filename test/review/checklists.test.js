'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const C = require('../../src/main/services/review/checklists');

const note = (over) => ({ id: Math.random().toString(36), kind: 'element', action: 'fix', priority: 'normal', note: 'n', target: { selector: '.x' }, ...over });
const session = { id: 's', name: 'Home page', url: 'https://example.test/' };
const settings = { agency: { name: 'Acme' } };
const SECRET_INTERNAL = 'INTERNAL-ONLY-reviewer-gossip-7731';

function pack(annotations) { return C.buildClientPack({ session, annotations, settings }); }
function report(annotations) { return C.buildHtmlReport({ session, annotations, settings }); }
function rowCount(html) {
  const dom = new JSDOM(html);
  return dom.window.document.querySelectorAll('tbody tr').length;
}

test('CE-02: all-internal session produces an EMPTY client pack - no fallback to private notes', () => {
  const a = [note({ visibility: 'internal', note: SECRET_INTERNAL }), note({ visibility: 'internal', note: SECRET_INTERNAL + '2' })];
  const p = pack(a);
  assert.equal(p.noteCount, 0);
  assert.ok(!p.markdown.includes(SECRET_INTERNAL));
  assert.match(p.markdown, /Home page/);
  const r = report(a);
  assert.ok(!r.content.includes(SECRET_INTERNAL));
  assert.match(r.content, /0 findings/);
  assert.match(r.content, /No client-visible notes/);
});

test('CE-02: mixed session - rows AND counts come from the same client-visible list', () => {
  const a = [note({ visibility: 'internal', note: SECRET_INTERNAL }), note({ visibility: 'client', note: 'Visible to client' })];
  const p = pack(a);
  assert.equal(p.noteCount, 1);
  assert.ok(!p.markdown.includes(SECRET_INTERNAL));
  assert.match(p.markdown, /Visible to client/);
  assert.match(p.markdown, /\*\*Annotations:\*\* 1/);
  const r = report(a);
  assert.ok(!r.content.includes(SECRET_INTERNAL));
  assert.match(r.content, /1 finding\b/);
  assert.equal(rowCount(r.content), 1);
});

test('CE-02: all-client session lists everything, counts match rows', () => {
  const a = [note({ visibility: 'client', note: 'one' }), note({ visibility: 'client', note: 'two' }), note({ visibility: 'client', note: 'three' })];
  assert.equal(pack(a).noteCount, 3);
  const r = report(a);
  assert.match(r.content, /3 findings/);
  assert.equal(rowCount(r.content), 3);
});

test('CE-02: empty and missing annotation lists give a valid empty report', () => {
  for (const a of [[], null, undefined, 'x', {}]) {
    const p = pack(a);
    assert.equal(p.noteCount, 0);
    const r = report(a);
    assert.match(r.content, /^<!DOCTYPE html>/);
    assert.match(r.content, /0 findings/);
    assert.equal(rowCount(r.content), 1); // the single "No client-visible notes" row
  }
});

test('CE-02: legacy (missing/unknown) visibility is private by default; only explicit "client" is published', () => {
  const a = [
    note({ note: SECRET_INTERNAL + '-undef' }),
    note({ visibility: null, note: SECRET_INTERNAL + '-null' }),
    note({ visibility: 'Client', note: SECRET_INTERNAL + '-case' }),
    note({ visibility: 'public', note: SECRET_INTERNAL + '-public' }),
    note({ visibility: 'client', note: 'ok' }),
  ];
  const p = pack(a);
  assert.equal(p.noteCount, 1);
  assert.ok(!p.markdown.includes(SECRET_INTERNAL));
  assert.ok(!report(a).content.includes(SECRET_INTERNAL));
  assert.equal(C.clientVisibleAnnotations(a).length, 1);
});

test('CE-02: the input list is not mutated and null entries are tolerated', () => {
  const a = [null, undefined, 5, note({ visibility: 'client' })];
  const copy = a.slice();
  assert.equal(pack(a).noteCount, 1);
  assert.deepEqual(a, copy);
});

test('CE-04: hostile viewport / metadata fields cannot add elements, handlers or scripts', () => {
  const payload = '"><script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">';
  const a = [note({
    visibility: 'client',
    action: payload, priority: payload, note: payload,
    target: { selector: payload },
    viewport: { w: payload, h: payload },
  }), note({ visibility: 'client', viewport: { w: { toString: () => payload }, h: 10 } }),
  note({ visibility: 'client', viewport: { w: Infinity, h: NaN } }),
  note({ visibility: 'client', viewport: { w: 99999999, h: 5 } }),
  note({ visibility: 'client', viewport: { w: -3, h: 5 } }),
  note({ visibility: 'client', viewport: 'x' })];
  const html = report(a).content;
  assert.ok(!html.includes('<script'), 'no script tag text in output');
  assert.ok(!html.includes('<img'), 'no img tag text in output');
  const dom = new JSDOM(html, { runScripts: 'dangerously', resources: 'usable' });
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll('script, img, iframe, object, embed, link[rel=stylesheet]').length, 0);
  for (const el of doc.querySelectorAll('*')) {
    assert.ok(![...el.attributes].some((at) => /^on/i.test(at.name)), 'no inline handlers');
  }
  assert.equal(dom.window.__pwned, undefined);
  // viewport cells are plain text, empty when the dimensions are not valid
  const cells = [...doc.querySelectorAll('tbody tr')].map((tr) => tr.lastElementChild.textContent);
  assert.deepEqual(cells, ['', '', '', '', '', '']);
});

test('CE-04: valid numeric viewport is shown; report carries a restrictive CSP', () => {
  const html = report([note({ visibility: 'client', viewport: { w: 1280.4, h: 720 } })]).content;
  assert.match(html, /<td>1280×720<\/td>/);
  assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"/);
  assert.equal(C.viewportLabel({ w: 0, h: 5 }), '');
});

test('escapeHtml covers quotes and non-string input', () => {
  assert.equal(C.escapeHtml(`<a href="x" b='y'>&`), '&lt;a href=&quot;x&quot; b=&#39;y&#39;&gt;&amp;');
  assert.equal(C.escapeHtml(0), '0');
  assert.equal(C.escapeHtml(null), '');
});
