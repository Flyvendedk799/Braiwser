// RF-07: number + unit come from one source, blur without edit sends no
// mutation, unit changes convert deliberately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, load, key } from './dom-env.mjs';

const { window, document } = setupDom();
const sp = await load('components/style-panel.js');
const { createStylePanel, parseLength, lengthSource, convertLength } = sp;

const computed = (over = {}) => ({
  'font-family': 'Arial, sans-serif', 'font-size': '32px', 'font-weight': '400', 'font-style': 'normal',
  'line-height': '40px', 'letter-spacing': '0px', 'text-align': 'left', 'text-transform': 'none',
  'text-decoration-line': 'none', color: 'rgb(0, 0, 0)', 'background-color': 'rgba(0, 0, 0, 0)', opacity: '1',
  'border-radius': '0px', 'border-width': '0px', 'border-color': 'rgb(0, 0, 0)', 'border-style': 'none',
  'padding-top': '16px', 'padding-right': '16px', 'padding-bottom': '16px', 'padding-left': '16px',
  'margin-top': '0px', 'margin-right': '0px', 'margin-bottom': '0px', 'margin-left': '0px',
  width: '500px', height: '120px', display: 'block', ...over,
});

function mount(infoOver = {}) {
  const applied = [];
  const panel = createStylePanel({
    apply: (patch, commit) => applied.push({ patch, commit }),
    selectParent() {}, reset() {}, copyCss() {}, exportElement() {}, setText() {},
  });
  document.body.appendChild(panel.root);
  panel.setStyle({
    selector: '#t', brief: { tag: 'h1' }, box: { w: 500, h: 120 }, editableText: false,
    inline: {}, pageFonts: [], pageColors: [], computed: computed(), ...infoOver,
  });
  return { panel, applied };
}

const rowNamed = (panel, name) =>
  Array.from(panel.root.querySelectorAll('.st-row')).find((r) => r.querySelector('.st-label').textContent === name);
const numIn = (panel, name) => rowNamed(panel, name).querySelector('.st-num');
const unitIn = (panel, name) => rowNamed(panel, name).querySelector('.st-unit');
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));

test('helpers: parseLength accepts supported inline lengths only', () => {
  assert.deepEqual(parseLength('2rem'), { value: 2, unit: 'rem' });
  assert.deepEqual(parseLength('50%'), { value: 50, unit: '%' });
  assert.deepEqual(parseLength('1.5em'), { value: 1.5, unit: 'em' });
  assert.deepEqual(parseLength('-.5px'), { value: -0.5, unit: 'px' });
  for (const bad of ['calc(1px + 2px)', '50vw', 'auto', '', null, undefined, '12']) assert.equal(parseLength(bad), null, String(bad));
});

test('helpers: lengthSource pairs number+unit from one source', () => {
  const c = { 'font-size': '32px', width: '500px' };
  assert.deepEqual(lengthSource('font-size', c, { 'font-size': '2rem' }), { value: 2, unit: 'rem', from: 'inline' });
  assert.deepEqual(lengthSource('width', c, { width: '50%' }), { value: 50, unit: '%', from: 'inline' });
  assert.deepEqual(lengthSource('width', c, {}), { value: 500, unit: 'px', from: 'computed' });
  // Unparseable inline (50vw): never combine its unit with the computed number.
  assert.deepEqual(lengthSource('width', c, { width: '50vw' }), { value: 500, unit: 'px', from: 'computed' });
});

test('regression: inline font-size:2rem (computed 32px) shows 2 rem, not 32 rem', () => {
  const { panel } = mount({ inline: { 'font-size': '2rem' } });
  assert.equal(numIn(panel, 'Size').value, '2');
  assert.equal(unitIn(panel, 'Size').value, 'rem');
});

test('regression: inline width:50% (computed 500px) shows 50 %, not 500 %', () => {
  const { panel } = mount({ inline: { width: '50%' } });
  assert.equal(numIn(panel, 'Width').value, '50');
  assert.equal(unitIn(panel, 'Width').value, '%');
});

test('computed-only values show px', () => {
  const { panel } = mount();
  assert.equal(numIn(panel, 'Size').value, '32');
  assert.equal(unitIn(panel, 'Size').value, 'px');
  assert.equal(numIn(panel, 'Width').value, '500');
});

test('focus + blur without editing sends NO mutation (rem, %, em, px, computed)', () => {
  const cases = [
    { inline: { 'font-size': '2rem' } },
    { inline: { width: '50%' } },
    { inline: { 'font-size': '1.5em', height: '10em' } },
    { inline: { width: '320px' } },
    { inline: {} },
    { inline: { width: 'calc(100% - 4rem)', 'font-size': '2vw' } },
  ];
  for (const c of cases) {
    const { panel, applied } = mount(c);
    for (const inp of Array.from(panel.root.querySelectorAll('.st-num'))) {
      inp.focus();
      fire(inp, 'blur');
      fire(inp, 'change');
    }
    assert.deepEqual(applied, [], 'no mutation for ' + JSON.stringify(c.inline));
  }
});

test('editing a rem value commits with the rem unit and scale', () => {
  const { panel, applied } = mount({ inline: { 'font-size': '2rem' } });
  const input = numIn(panel, 'Size');
  input.value = '3';
  fire(input, 'input');
  assert.deepEqual(applied.pop(), { patch: { 'font-size': '3rem' }, commit: false });
  fire(input, 'change');
  assert.deepEqual(applied.pop(), { patch: { 'font-size': '3rem' }, commit: true });
  fire(input, 'blur'); // change already committed; blur must not double-send
  assert.equal(applied.length, 0);
});

test('typing the original value back still commits the live preview it started', () => {
  const { panel, applied } = mount({ inline: { width: '50%' } });
  const input = numIn(panel, 'Width');
  input.value = '60';
  fire(input, 'input');
  input.value = '50';
  fire(input, 'input');
  applied.length = 0;
  fire(input, 'blur');
  assert.deepEqual(applied, [{ patch: { width: '50%' }, commit: true }]);
});

test('blur after a typed change (no change event) commits once', () => {
  const { panel, applied } = mount();
  const input = numIn(panel, 'Width');
  input.value = '640';
  fire(input, 'input');
  applied.length = 0;
  fire(input, 'blur');
  assert.deepEqual(applied, [{ patch: { width: '640px' }, commit: true }]);
});

test('unit change on an untouched value converts to the same rendered size', () => {
  const { panel, applied } = mount({
    inline: { 'font-size': '2rem' },
    metrics: { rootFontSize: 16, parentFontSize: 20, parentWidth: 1000, parentHeight: 600 },
  });
  const input = numIn(panel, 'Size');
  const unit = unitIn(panel, 'Size');
  unit.value = 'px';
  fire(unit, 'change');
  assert.equal(input.value, '32');
  assert.deepEqual(applied.pop(), { patch: { 'font-size': '32px' }, commit: true });
  unit.value = 'em'; // parent font-size 20px -> 32px = 1.6em
  fire(unit, 'change');
  assert.equal(input.value, '1.6');
  assert.deepEqual(applied.pop(), { patch: { 'font-size': '1.6em' }, commit: true });
});

test('width px -> % converts using the parent width', () => {
  const { panel, applied } = mount({ metrics: { parentWidth: 1000 } });
  const unit = unitIn(panel, 'Width');
  unit.value = '%';
  fire(unit, 'change');
  assert.equal(numIn(panel, 'Width').value, '50');
  assert.deepEqual(applied.pop(), { patch: { width: '50%' }, commit: true });
});

test('an unconvertible unit change does NOT relabel 500px as 500%', () => {
  const { panel, applied } = mount(); // no metrics: parent width unknown
  const unit = unitIn(panel, 'Width');
  unit.value = '%';
  fire(unit, 'change');
  assert.deepEqual(applied, [], 'nothing is sent');
  assert.equal(numIn(panel, 'Width').value, '', 'field cleared, waiting for a value in %');
  // leaving it empty must not clear the page's width either
  fire(numIn(panel, 'Width'), 'blur');
  assert.deepEqual(applied, []);
  // switching back restores the old number untouched
  unit.value = 'px';
  fire(unit, 'change');
  assert.equal(numIn(panel, 'Width').value, '500');
  assert.deepEqual(applied, []);
  // typing a value in the new unit applies it
  unit.value = '%';
  fire(unit, 'change');
  const input = numIn(panel, 'Width');
  input.value = '40';
  fire(input, 'input');
  fire(input, 'change');
  assert.deepEqual(applied.pop(), { patch: { width: '40%' }, commit: true });
});

test('a number the user just typed keeps its value when the unit changes (existing flow)', () => {
  const { panel, applied } = mount();
  const input = numIn(panel, 'Size');
  input.value = '2';
  fire(input, 'input');
  const unit = unitIn(panel, 'Size');
  unit.value = 'rem';
  fire(unit, 'change');
  assert.deepEqual(applied.pop(), { patch: { 'font-size': '2rem' }, commit: true });
});

test('convertLength: rem/em/%/px relationships; null when a base is missing', () => {
  const base = { root: 16, em: 20, percent: 800 };
  assert.equal(convertLength(2, 'rem', 'px', base), 32);
  assert.equal(convertLength(32, 'px', 'rem', base), 2);
  assert.equal(convertLength(40, 'px', 'em', base), 2);
  assert.equal(convertLength(50, '%', 'px', base), 400);
  assert.equal(convertLength(400, 'px', '%', base), 50);
  assert.equal(convertLength(1, 'em', 'rem', base), 1.25);
  assert.equal(convertLength(10, 'px', '%', { root: 16, em: 16, percent: null }), null);
});

test('padding/margin boxes: blur without edit sends nothing; a relative page value is disclosed', () => {
  const { panel, applied } = mount({ inline: { 'padding-top': '1rem' } });
  const inputs = Array.from(panel.root.querySelectorAll('.st-side .st-num'));
  assert.equal(inputs.length, 8);
  inputs.forEach((i) => { i.focus(); fire(i, 'blur'); });
  assert.deepEqual(applied, []);
  const padTop = panel.root.querySelector('.st-side .st-num');
  assert.match(padTop.title, /Page CSS: 1rem/);
  padTop.value = '24';
  fire(padTop, 'blur');
  assert.deepEqual(applied, [{ patch: { 'padding-top': '24px' }, commit: true }]);
});

test('scrubbing commits through the same bookkeeping', () => {
  const { panel, applied } = mount();
  const label = rowNamed(panel, 'Radius').querySelector('.st-label');
  const ev = (type, x) => new window.MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
  label.dispatchEvent(ev('pointerdown', 0));
  window.dispatchEvent(ev('pointermove', 10));
  window.dispatchEvent(ev('pointerup', 10));
  const last = applied[applied.length - 1];
  assert.deepEqual(last, { patch: { 'border-radius': '10px' }, commit: true });
  assert.ok(applied.slice(0, -1).every((a) => a.commit === false));
  key(document.body, 'x');
});

// ---- guest `specified` payload (inspector engineer) -------------------------------
const spec = (o) => ({ computed: '', computedPx: null, ...o });

test('specified: inline rem pair is used (2 rem), computed px is ignored', () => {
  const { panel, applied } = mount({ specified: { 'font-size': spec({ source: 'inline', raw: '2rem', value: 2, unit: 'rem', computedPx: 32 }) } });
  assert.equal(numIn(panel, 'Size').value, '2');
  assert.equal(unitIn(panel, 'Size').value, 'rem');
  numIn(panel, 'Size').focus();
  fire(numIn(panel, 'Size'), 'blur');
  assert.deepEqual(applied, []);
});

test('specified: computed source shows computed px', () => {
  const { panel } = mount({ specified: { width: spec({ source: 'computed', raw: '500px', value: 500, unit: 'px', computedPx: 500 }) } });
  assert.equal(numIn(panel, 'Width').value, '500');
  assert.equal(unitIn(panel, 'Width').value, 'px');
});

test('specified: unsupported inline (calc / vw) falls back to computed px with a note, and blur is silent', () => {
  const { panel, applied } = mount({
    inline: { width: 'calc(100% - 4rem)' },
    specified: { width: spec({ source: 'inline', raw: 'calc(100% - 4rem)', value: null, unit: null, unsupported: true, computedPx: 500 }) },
  });
  assert.equal(numIn(panel, 'Width').value, '500');
  assert.equal(unitIn(panel, 'Width').value, 'px');
  assert.match(numIn(panel, 'Width').title, /calc\(100% - 4rem\)/);
  fire(numIn(panel, 'Width'), 'blur');
  assert.deepEqual(applied, []);
});

test('specified wins over a conflicting inline map; !important is disclosed', () => {
  const { panel } = mount({
    inline: { width: '10px' },
    inlinePriority: { width: 'important' },
    specified: { width: spec({ source: 'inline', raw: '50%', value: 50, unit: '%', computedPx: 500 }) },
  });
  assert.equal(numIn(panel, 'Width').value, '50');
  assert.equal(unitIn(panel, 'Width').value, '%');
  assert.match(numIn(panel, 'Width').title, /!important/);
});

test('lengthSource handles specified entries directly', () => {
  assert.deepEqual(lengthSource('height', {}, {}, { height: spec({ source: 'inline', value: 0, unit: '', raw: '0' }) }), { value: 0, unit: 'px', from: 'inline' });
  assert.deepEqual(lengthSource('height', { height: '120px' }, {}, { height: spec({ source: 'inline', value: 3, unit: 'vh', raw: '3vh', computedPx: 120 }) }), { value: 120, unit: 'px', from: 'computed' });
});
