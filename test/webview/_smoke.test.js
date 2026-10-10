const test = require('node:test');
const assert = require('node:assert');
const { loadInspector } = require('./harness');
test('boots', async () => {
  const h = await loadInspector({ html: '<ul><li>A</li><li>B</li></ul>' });
  assert.ok(h.ipc.hasHandler('caos:set-mode'));
  assert.equal(h.ipc.sent('caos:ready').length, 1);
  h.dispose();
});
