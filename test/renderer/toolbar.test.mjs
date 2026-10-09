// Toolbar: failures in controller actions are visible, toggles expose state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, load, click, tick, key } from './dom-env.mjs';

const { document } = setupDom();
const { createToolbar } = await load('components/toolbar.js');

const toasts = () => Array.from(document.querySelectorAll('.toast-msg')).map((t) => t.textContent);

function mount(over = {}) {
  const calls = [];
  const tb = createToolbar({
    navigate: (u) => calls.push(['navigate', u]), toggleBookmark() {}, undo() {}, redo() {}, back() {}, forward() {}, reload() {},
    toggleMode: (m) => calls.push(['mode', m]), toggleRecord() {}, replay() {}, runAudit() {}, openDeviceMenu() {}, screenshot() {},
    openAi() {}, openSettings() {}, openFile() {}, openFolder() {},
    ...over,
  });
  document.body.appendChild(tb.root);
  return { tb, calls };
}

test('a rejected async action surfaces as an error toast, not a silent rejection', async () => {
  const { tb } = mount({ runAudit: async () => { throw new Error('guest did not answer'); } });
  click(tb.root.querySelector('[data-act="audit"]'));
  await tick(5);
  assert.ok(toasts().includes('Run audit failed: guest did not answer'), toasts().join('|'));
});

test('a synchronous throw is reported too', async () => {
  const { tb } = mount({ openFile: () => { throw new Error('dialog unavailable'); } });
  click(Array.from(tb.root.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'Open a local file'));
  await tick(5);
  assert.ok(toasts().includes('Open file failed: dialog unavailable'), toasts().join('|'));
});

test('address bar navigation failures are reported', async () => {
  const { tb } = mount({ navigate: async () => { throw new Error('bad address'); } });
  const input = tb.root.querySelector('.address input');
  input.value = 'nope';
  key(input, 'Enter');
  await tick(5);
  assert.ok(toasts().includes('Navigate failed: bad address'), toasts().join('|'));
  assert.equal(input.getAttribute('aria-label'), 'Address');
});

test('healthy actions still run, with the event argument', () => {
  const { tb, calls } = mount();
  click(tb.root.querySelector('[data-act="inspect"]'));
  assert.deepEqual(calls, [['mode', 'inspect']]);
});

test('mode buttons expose aria-pressed', () => {
  const { tb } = mount();
  tb.update({ mode: 'edit', recording: false, canGoBack: false, canGoForward: false });
  const pressed = (act) => tb.root.querySelector(`[data-act="${act}"]`).getAttribute('aria-pressed');
  assert.equal(pressed('edit'), 'true');
  assert.equal(pressed('inspect'), 'false');
  tb.update({ mode: 'inspect', recording: true });
  assert.equal(pressed('inspect'), 'true');
  assert.equal(pressed('record'), 'true');
});

test('missing optional actions do not throw on click', () => {
  const tb = createToolbar({ navigate() {}, toggleMode() {} });
  document.body.appendChild(tb.root);
  assert.doesNotThrow(() => click(tb.root.querySelector('[data-act="audit"]')));
});
