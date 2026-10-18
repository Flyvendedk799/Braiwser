'use strict';
// CE-08: contrast compositing keeps accumulated alpha (source-over) and treats
// images/gradients as indeterminate.

const test = require('node:test');
const assert = require('node:assert/strict');
const dom = require('./_dom');
const audit = require('../../src/webview/audit');
const { blend, contrastRatio, effectiveBackground, parseColor } = audit.internals;

test.afterEach(() => dom.uninstall());

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('blend is source-over and keeps alpha', () => {
  const out = blend({ r: 0, g: 0, b: 0, a: 0.1 }, { r: 0, g: 0, b: 0, a: 0.1 });
  near(out.a, 0.19);
  const flat = blend(out, { r: 255, g: 255, b: 255, a: 1 });
  near(flat.r, 206.55);
  assert.equal(flat.a, 1);
});

test('parseColor handles slash alpha, percentages and transparent; unknown syntaxes are null', () => {
  assert.deepEqual(parseColor('rgb(0 0 0 / 10%)'), { r: 0, g: 0, b: 0, a: 0.1 });
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.equal(parseColor('transparent').a, 0);
  assert.equal(parseColor('color(srgb 0.1 0.2 0.3)'), null);
  assert.equal(parseColor('oklch(50% 0.1 20)'), null);
});

test('two 10% black layers over white = 206.55; reference ratios 1.565 and 13.418', () => {
  dom.install(`<body style="background:#fff"><div style="background:rgba(0,0,0,.1)"><p id="t" style="background:rgba(0,0,0,.1)">x</p></div></body>`);
  const bg = effectiveBackground(document.getElementById('t'));
  near(bg.r, 206.55);
  near(bg.g, 206.55);
  near(bg.b, 206.55);
  assert.equal(bg.a, 1);
  near(contrastRatio({ r: 255, g: 255, b: 255 }, bg), 1.565, 0.002);
  near(contrastRatio({ r: 0, g: 0, b: 0 }, bg), 13.418, 0.002);
});

test('transparent root terminates on the white canvas; opaque layer stops the walk', () => {
  dom.install(`<body><div style="background:rgb(10,20,30)"><p id="a" style="background:rgba(255,255,255,.5)">x</p></div><p id="b">y</p></body>`);
  const a = effectiveBackground(document.getElementById('a'));
  near(a.r, 132.5);
  near(a.g, 137.5);
  near(a.b, 142.5);
  const b = effectiveBackground(document.getElementById('b'));
  assert.deepEqual([b.r, b.g, b.b, b.a], [255, 255, 255, 1]);
});

test('background images and gradients are indeterminate, not a confident colour', () => {
  dom.install(`<body style="background:#fff"><div style="background-image:linear-gradient(red,blue)"><p id="g">x</p></div></body>`);
  const bg = effectiveBackground(document.getElementById('g'));
  assert.equal(bg.indeterminate, true);
  assert.equal(bg.reason, 'background-image');
});

test('an opaque layer above an image hides the image', () => {
  dom.install(`<body><div style="background-image:linear-gradient(red,blue)"><p id="g" style="background:#000">x</p></div></body>`);
  const bg = effectiveBackground(document.getElementById('g'));
  assert.equal(bg.indeterminate, undefined);
  assert.equal(bg.r, 0);
});

test('runAudit reports translucent-stack contrast correctly and counts indeterminate text', () => {
  dom.install(`<html lang="en"><head><title>t</title></head><body style="background:#fff">
    <main>
    <div style="background:rgba(0,0,0,.1)"><p id="low" style="background:rgba(0,0,0,.1);color:#fff;font-size:16px">low contrast</p></div>
    <div style="background-image:linear-gradient(red,blue)"><p id="grad" style="color:#fff">over gradient</p></div>
    </main></body></html>`);
  window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 20, right: 100, bottom: 20, x: 0, y: 0 });
  const report = audit.runAudit({});
  const contrast = report.findings.filter((f) => f.ruleId === 'contrast');
  assert.equal(contrast.length, 1);
  assert.equal(contrast[0].ratio, 1.57);
  assert.equal(report.contrastIndeterminate, 1);
});
