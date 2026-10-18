'use strict';
// CE-14..CE-17 and the node-limit performance guard for element export.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const dom = require('./_dom');

function load(html, opts) {
  const d = dom.install(html, opts);
  const w = d.window;
  w.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20, x: 0, y: 0 });
  return { d, w, doc: w.document, ee: require('../../src/webview/element-export') };
}

// Open the export on its own, the way the main-side exporter does (generic body).
function render(bundle) {
  const html = `<!doctype html><html><head><style>${bundle.css}</style></head><body>${bundle.html}</body></html>`;
  return new JSDOM(html).window;
}

// Give a <style> sheet a URL, the way <link rel=stylesheet href> sheets have one.
function setHref(sheet, href) {
  Object.defineProperty(sheet, 'href', { value: href, configurable: true });
}

test.afterEach(() => dom.uninstall());

// ---- CE-14 ---------------------------------------------------------------------------
test('a selected <img> root exports its own src and srcset assets', () => {
  const { doc, ee } = load('<body><img id="r" src="img/a.png" srcset="img/a.png 1x, img/a2x.png 2x" alt="a"></body>');
  const out = ee.collect(doc.getElementById('r'));
  const urls = out.assets.map((a) => a.url);
  assert.deepEqual(urls.sort(), ['https://example.test/page/img/a.png', 'https://example.test/page/img/a2x.png']);
  assert.ok(!out.html.includes('img/a'));
  assert.match(out.elementHtml, /src="__CAOS_ASSET_0__"/);
  assert.match(out.elementHtml, /srcset="__CAOS_ASSET_0__ 1x, __CAOS_ASSET_1__ 2x"/);
  assert.equal(out.assets[0].kind, 'image');
});

test('selected <video poster> and <source> roots export their assets', () => {
  const { doc, ee } = load('<body><video id="v" poster="p.jpg"><source src="m.mp4" type="video/mp4"></video><picture id="pic"><source id="s" srcset="s.webp 1x"><img src="fallback.png"></picture></body>');
  const v = ee.collect(doc.getElementById('v'));
  assert.deepEqual(v.assets.map((a) => a.url).sort(), ['https://example.test/page/m.mp4', 'https://example.test/page/p.jpg']);
  const s = ee.collect(doc.getElementById('s'));
  assert.deepEqual(s.assets.map((a) => a.url), ['https://example.test/page/s.webp']);
});

test('root, container and descendants yield the same asset inventory', () => {
  const { doc, ee } = load('<body><div id="c"><img src="a.png" srcset="a.png 1x, b.png 2x"><div style="background:url(bg.png)"></div></div></body>');
  const viaRoot = ee.collect(doc.querySelector('img'));
  const viaBox = ee.collect(doc.getElementById('c'));
  assert.deepEqual(viaRoot.assets.map((a) => a.url).sort(), ['https://example.test/page/a.png', 'https://example.test/page/b.png']);
  assert.deepEqual(
    viaBox.assets.map((a) => a.url).sort(),
    ['https://example.test/page/a.png', 'https://example.test/page/b.png', 'https://example.test/page/bg.png']
  );
});

test('srcset URLs with commas and fragment-only references are handled', () => {
  const { doc, ee } = load(`<body><img id="r" srcset="https://cdn.test/w_300,c_fill/a.jpg 300w, https://cdn.test/w_600,c_fill/a.jpg 600w">
    <svg><use id="u" href="#icon"></use><image id="im" href="pic.png"/></svg></body>`);
  const out = ee.collect(doc.getElementById('r'));
  assert.deepEqual(out.assets.map((a) => a.url), ['https://cdn.test/w_300,c_fill/a.jpg', 'https://cdn.test/w_600,c_fill/a.jpg']);
  const svg = ee.collect(doc.querySelector('svg'));
  assert.deepEqual(svg.assets.map((a) => a.url), ['https://example.test/page/pic.png']);
  assert.match(svg.elementHtml, /href="#icon"/);
});

// ---- CE-15 ---------------------------------------------------------------------------
test('ancestor-class selectors still apply when the element is opened on its own', () => {
  const { doc, ee } = load(`<html class="dark"><head><style>
      .page .panel .inner { padding: 37px; }
      .panel > .inner { margin-left: 5px; }
      html.dark .inner { color: rgb(1, 2, 3); }
      .panel { width: 300px; border: 9px solid red; color: rgb(9, 8, 7); }
      .unrelated { padding: 99px; }
    </style></head><body><div class="page"><section class="panel"><div class="inner" id="x">hi</div></section></div></body></html>`);
  const out = ee.collect(doc.getElementById('x'));
  assert.equal(out.meta.mode, 'rules');
  assert.ok(out.meta.ancestorContext >= 4);
  assert.ok(!out.css.includes('.unrelated'));
  const win = render(out);
  const inner = win.document.querySelector('.inner');
  const cs = win.getComputedStyle(inner);
  assert.equal(cs.paddingTop, '37px');
  assert.equal(cs.marginLeft, '5px');
  assert.equal(cs.color, 'rgb(1, 2, 3)'); // html.dark rewritten onto the html shell
  // The ancestor's own layout (width/border) described the ancestor, not the piece...
  const panel = win.document.querySelector('.panel');
  assert.notEqual(win.getComputedStyle(panel).width, '300px');
  // ...but what it passes down is kept.
  assert.equal(win.getComputedStyle(panel).color, 'rgb(9, 8, 7)');
});

test('the element alone is still available without ancestor shells', () => {
  const { doc, ee } = load('<body><style>b { font-weight: 700; }</style><div class="a"><b id="x">hi</b></div></body>');
  const out = ee.collect(doc.getElementById('x'));
  assert.equal(out.elementHtml, '<b id="x">hi</b>');
  assert.ok(out.html.includes('class="a"'));
  assert.ok(out.html.includes('data-caos-export-body'));
});

test('custom properties set on ancestors are baked from the computed value', () => {
  const { w, doc, ee } = load('<body><div style="--accent: tomato"><b id="x" class="chip">hi</b></div><style>.chip{color:var(--accent)}</style></body>');
  // jsdom does not inherit custom properties; emulate the browser's resolved value.
  const real = w.getComputedStyle.bind(w);
  const target = doc.getElementById('x');
  globalThis.getComputedStyle = (el, ...a) => {
    const cs = real(el, ...a);
    if (el !== target) return cs;
    return new Proxy(cs, { get: (t, p) => (p === 'getPropertyValue' ? (n) => (n === '--accent' ? 'tomato' : t.getPropertyValue(n)) : typeof t[p] === 'function' ? t[p].bind(t) : t[p]) });
  };
  const out = ee.collect(target);
  assert.match(out.css, /:root \{ --accent: tomato; \}/);
});

// ---- CE-16 ---------------------------------------------------------------------------
test('stylesheet-relative URLs resolve against the sheet, not the document', () => {
  const { doc, ee } = load(`<head><style id="s">.tile { background: url(../img/tile.png); }
    @font-face { font-family: Foo; src: url(fonts/foo.woff2); }
    .abs { background: url(https://cdn.test/abs.png); }
    .q { background: url("sprite.png?v=3#x"); }</style></head>
    <body><div id="r" class="tile"><i class="abs"></i><i class="q"></i></div></body>`, { url: 'https://example.test/page/index.html' });
  setHref(doc.getElementById('s').sheet, 'https://example.test/static/styles/site.css');
  const out = ee.collect(doc.getElementById('r'));
  const urls = out.assets.map((a) => a.url);
  assert.ok(urls.includes('https://example.test/static/img/tile.png'), urls.join());
  assert.ok(urls.includes('https://cdn.test/abs.png'));
  assert.ok(urls.includes('https://example.test/static/styles/sprite.png?v=3#x'));
  assert.ok(!urls.includes('https://example.test/img/tile.png'));
});

test('@import chains keep the imported sheet as the base, recursively', () => {
  const { doc, ee } = load(`<head><style id="s">@import url("sub/inner.css"); .top { background: url(top.png); }</style></head>
    <body><div id="r" class="top"><i class="deep"></i><i class="deeper"></i></div></body>`);
  const outer = doc.getElementById('s').sheet;
  setHref(outer, 'https://example.test/static/css/main.css');
  const importRule = outer.cssRules[0];
  const inner = importRule.styleSheet;
  inner.insertRule('.deep { background: url(i.png); }', 0);
  setHref(inner, 'https://example.test/static/css/sub/inner.css');
  // a second level: inner imports ../lib/l2.css
  const l2 = new (inner.constructor)();
  l2.insertRule('.deeper { background: url(l2.png); }', 0);
  setHref(l2, 'https://example.test/static/css/lib/l2.css');
  inner.insertRule('@import url("../lib/l2.css");', 0);
  Object.defineProperty(inner.cssRules[0], 'styleSheet', { value: l2 });
  const out = ee.collect(doc.getElementById('r'));
  const urls = out.assets.map((a) => a.url).sort();
  assert.deepEqual(urls, [
    'https://example.test/static/css/lib/l2.png',
    'https://example.test/static/css/sub/i.png',
    'https://example.test/static/css/top.png',
  ].sort());
});

test('inline <style> honours <base href>; relative inline style attributes too', () => {
  const { doc, ee } = load(`<head><base href="https://cdn.test/base/dir/"><style>.t { background: url(img/t.png); }</style></head>
    <body><div id="r" class="t" style="mask-image: url(m.svg)"></div></body>`);
  const out = ee.collect(doc.getElementById('r'));
  const urls = out.assets.map((a) => a.url).sort();
  assert.deepEqual(urls, ['https://cdn.test/base/dir/img/t.png', 'https://cdn.test/base/dir/m.svg']);
});

// ---- CE-17 ---------------------------------------------------------------------------
test('inline fallback keeps styles on the right nodes when scripts/own UI are removed', () => {
  const { doc, ee } = load(`<body><div id="r">
      <script>var a = 1;</script>
      <span id="red" style="color: red">hi</span>
      <div data-caos id="ui" style="color: blue">ui</div>
      <span id="gone" style="display: none">x</span>
      <script type="application/json">{}</script>
      <b id="last" style="font-weight: 700">z</b>
    </div></body>`);
  const out = ee.collect(doc.getElementById('r'));
  assert.equal(out.meta.mode, 'inline');
  const clone = new JSDOM(`<body>${out.html}</body>`).window.document;
  assert.equal(clone.querySelector('script'), null);
  assert.equal(clone.querySelector('[data-caos]'), null);
  const red = clone.querySelector('span:not([style*="display: none"])');
  assert.match(red.getAttribute('style'), /color: (red|rgb\(255, 0, 0\))/);
  assert.doesNotMatch(red.getAttribute('style'), /blue/);
  const hidden = Array.from(clone.querySelectorAll('span')).find((s) => s.textContent === 'x');
  assert.match(hidden.getAttribute('style'), /display: none/); // intentionally retained
  assert.match(clone.querySelector('b').getAttribute('style'), /font-weight: 700/);
});

test('zero margin/padding that cancel UA defaults are kept in inline mode', () => {
  const { doc, ee } = load('<body><ul id="r" style="padding: 0; margin: 0"><li>a</li></ul></body>');
  const out = ee.collect(doc.getElementById('r'));
  assert.match(out.html, /padding-left: 0px/);
});

// ---- node limits / honest truncation -------------------------------------------------------
test('over-limit subtrees are cut BEFORE cloning and flagged truncated', () => {
  const { w, doc, ee } = load('<body><div id="r"></div></body>');
  const root = doc.getElementById('r');
  const frag = doc.createDocumentFragment();
  for (let i = 0; i < ee.MAX_NODES + 1500; i++) {
    const s = doc.createElement('span');
    s.textContent = 'n' + i;
    frag.appendChild(s);
  }
  root.appendChild(frag);

  const proto = w.Node.prototype;
  const origClone = proto.cloneNode;
  let clones = 0;
  proto.cloneNode = function counted(deep) {
    clones++;
    assert.ok(!deep, 'never a deep clone of an unbounded subtree');
    return origClone.call(this, deep);
  };
  const origQsa = w.Element.prototype.querySelectorAll;
  w.Element.prototype.querySelectorAll = function guarded(sel) {
    assert.ok(!(this === root && sel === '*'), 'no full-subtree enumeration');
    return origQsa.call(this, sel);
  };
  let out;
  try {
    out = ee.collect(root);
  } finally {
    proto.cloneNode = origClone;
    w.Element.prototype.querySelectorAll = origQsa;
  }
  assert.equal(out.truncated, true);
  assert.equal(out.meta.truncated, true);
  assert.equal(out.meta.truncatedReason, 'node-limit');
  assert.equal(out.meta.nodeCount, ee.MAX_NODES);
  assert.ok(out.meta.warnings.some((m) => /more than/.test(m)));
  assert.ok(clones <= ee.MAX_NODES * 2 + 10, 'clone work stays proportional to the budget: ' + clones);
  const cloned = new JSDOM(`<body>${out.html}</body>`).window.document.querySelectorAll('span').length;
  assert.equal(cloned, ee.MAX_NODES - 1);
});

test('under-limit exports are not flagged', () => {
  const { doc, ee } = load('<body><div id="r"><p>a</p><p>b</p></div></body>');
  const out = ee.collect(doc.getElementById('r'));
  assert.equal(out.truncated, false);
  assert.equal(out.meta.nodeCount, 3);
});

// ---- hygiene -------------------------------------------------------------------------------------
test('a password field’s value attribute is not carried into the export', () => {
  const { doc, ee } = load('<body><form id="r"><input type="password" value="hunter2-secret"><input type="text" value="ok"></form></body>');
  const out = ee.collect(doc.getElementById('r'));
  assert.ok(!out.html.includes('hunter2-secret'));
  assert.ok(out.html.includes('value="ok"'));
});

test('own UI, contenteditable and editing outline never leak into the export', () => {
  const { doc, ee } = load('<body><div id="r" contenteditable="true" style="outline: 2px solid red; color: green"><span data-caos>ui</span>text</div></body>');
  const out = ee.collect(doc.getElementById('r'));
  assert.ok(!out.html.includes('contenteditable'));
  assert.ok(!out.html.includes('data-caos>'));
  assert.ok(!/outline/.test(out.elementHtml));
});
