'use strict';
// CE-12: selectors are unique-or-empty; resolution never picks "first of many".

const test = require('node:test');
const assert = require('node:assert/strict');
const dom = require('./_dom');

test.afterEach(() => dom.uninstall());

function load(html) {
  dom.install(html);
  return require('../../src/webview/anchor');
}

test('duplicate ids on target and ancestors are skipped; path round-trips to the exact node', () => {
  const anchor = load(`<body>
    <div id="box"><button>First</button></div>
    <div id="box"><button id="go">Second</button></div>
    <div id="box"><span>pad</span><button id="go">Third</button></div>
  </body>`);
  const buttons = Array.from(document.querySelectorAll('button'));
  assert.equal(buttons.length, 3);
  for (const b of buttons) {
    const sel = anchor.cssPath(b);
    assert.ok(sel, 'selector emitted');
    const hits = document.querySelectorAll(sel);
    assert.equal(hits.length, 1, `${sel} must match once`);
    assert.equal(hits[0], b, `${sel} must resolve to the original node`);
    assert.equal(anchor.resolve({ selector: sel, tag: 'button', text: b.textContent }, { strict: true }), b);
  }
});

test('unique ids anchor the path; escaped identifiers round-trip', () => {
  const anchor = load(`<body><section id="a:b.c"><ul><li>x</li><li id="n 1">y</li><li>z</li></ul></section></body>`);
  for (const li of Array.from(document.querySelectorAll('li'))) {
    const sel = anchor.cssPath(li);
    assert.equal(document.querySelectorAll(sel).length, 1);
    assert.equal(document.querySelector(sel), li);
  }
  assert.match(anchor.cssPath(document.querySelectorAll('li')[0]), /^#a\\:b\\\.c/);
});

test('repeated siblings and duplicate stable attributes fall back to structure', () => {
  const anchor = load(`<body><div><i data-testid="t"></i><i data-testid="t"></i><i data-testid="u"></i></div></body>`);
  const els = Array.from(document.querySelectorAll('i'));
  assert.equal(anchor.cssPath(els[2]), 'i[data-testid="u"]');
  for (const e of els.slice(0, 2)) {
    const sel = anchor.cssPath(e);
    assert.equal(document.querySelector(sel), e);
    assert.equal(document.querySelectorAll(sel).length, 1);
  }
});

test('attribute values with quotes, backslashes and newlines stay unique and valid', () => {
  const anchor = load(`<body><a href="#" aria-label='say "hi"\\now'>1</a><a href="#">2</a></body>`);
  const a = document.querySelector('a');
  const sel = anchor.cssPath(a);
  assert.equal(document.querySelector(sel), a);
});

test('resolve never silently returns the first of several matches', () => {
  const anchor = load(`<body><p class="r">same</p><p class="r">same</p></body>`);
  const target = { selector: 'p.r', tag: 'p', text: 'same' };
  const detailed = anchor.resolveDetailed(target);
  assert.equal(detailed.el, null);
  assert.equal(detailed.ambiguous, true);
  assert.equal(anchor.resolve(target), null);
  assert.equal(anchor.resolve(target, { strict: true }), null);
});

test('ambiguous selector narrowed by text is only a suggestion', () => {
  const anchor = load(`<body><p class="r">one</p><p class="r">two</p></body>`);
  const target = { selector: 'p.r', tag: 'p', text: 'two' };
  const d = anchor.resolveDetailed(target);
  assert.equal(d.el, document.querySelectorAll('p')[1]);
  assert.equal(d.confidence, 'suggested');
  assert.equal(anchor.resolve(target, { strict: true }), null);
  assert.equal(anchor.resolve(target), d.el); // display callers may still use it
});

test('text and coordinate fallbacks are flagged suggested and refused when strict', () => {
  const anchor = load(`<body><button id="x">Pay now</button><button>Cancel</button></body>`);
  const byText = anchor.resolveDetailed({ selector: '#gone', tag: 'button', text: 'Pay now' });
  assert.equal(byText.confidence, 'suggested');
  assert.equal(byText.via, 'text');
  assert.equal(anchor.resolve({ selector: '#gone', tag: 'button', text: 'Pay now' }, { strict: true }), null);

  const exact = anchor.resolveDetailed({ selector: '#x', tag: 'button', text: 'Pay now' });
  assert.equal(exact.confidence, 'exact');
  assert.equal(anchor.resolve({ selector: '#x' }, { strict: true }), document.getElementById('x'));

  window.innerWidth = 800;
  window.innerHeight = 600;
  document.elementFromPoint = () => document.getElementById('x');
  const byBox = anchor.resolveDetailed({ selector: '#gone', box: { x: 0, y: 0, w: 10, h: 10 } });
  assert.equal(byBox.confidence, 'suggested');
  assert.equal(byBox.via, 'coordinate');
});

test('a text match shared by several elements is ambiguous, not first-wins', () => {
  const anchor = load(`<body><button>Save</button><button>Save</button></body>`);
  const d = anchor.resolveDetailed({ selector: '#gone', tag: 'button', text: 'Save' });
  assert.equal(d.el, null);
  assert.equal(d.ambiguous, true);
});

test('a stale selector whose element changed tag is not exact', () => {
  const anchor = load(`<body><div id="k">x</div></body>`);
  const d = anchor.resolveDetailed({ selector: '#k', tag: 'button', text: 'nope' });
  assert.notEqual(d.confidence, 'exact');
});

test('own-UI elements are never resolution candidates', () => {
  const anchor = load(`<body><div data-caos class="m">a</div><div class="m">a</div></body>`);
  const d = anchor.resolveDetailed({ selector: 'div.m', tag: 'div', text: 'a' });
  assert.equal(d.confidence, 'exact');
  assert.equal(d.el, document.querySelectorAll('div.m')[1]);
});
