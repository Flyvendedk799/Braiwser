// browser_visit / browser_read against the REAL broker over the FakeDriver: one step from an address to the page as
// text, through the same destination policy, budgets and ledger as any navigation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { connect } from './_harness.mjs';

const require = createRequire(import.meta.url);
const { createBroker } = require('../../../src/main/services/browser/broker.js');
const { createFakeDriver } = require('../fake-driver.js');
const { tmp, mcp, cleanup } = require('../helpers.js');
const registry = require('../../../src/main/services/automation/skill-registry.js');

after(() => cleanup());

const SCOPES = ['class:observe', 'class:navigate', 'class:interact', 'origin:https://app.test'];
const GRANT = { allowedOrigins: ['https://app.test'], toolClasses: ['observe', 'navigate', 'interact'] };

async function rig() {
  const fake = createFakeDriver();
  const broker = createBroker({ dataDir: tmp(), drivers: { playwright: fake.driver }, featureFlag: true,
    skills: registry.createBrokerSkills({ loadRecording: () => null }), appVersion: 'test' });
  const h = await connect(broker, mcp('agent', SCOPES));
  const s = await h.ok('browser_session_open', { driver: 'playwright', mode: 'headless', grant: GRANT });
  return { fake, broker, h, page: { sessionId: s.sessionId, pageId: s.pageId } };
}

test('visit goes to an address and returns the page as text in one call', async () => {
  const { fake, broker, h, page } = await rig();
  const v = await h.ok('browser_visit', { ...page, url: 'https://app.test/', operationId: 'visit-1' });
  assert.ok(['verified', 'dispatched'].includes(v.receipt.status));
  assert.equal(v.page.url, 'https://app.test/');
  assert.equal(v.page.trust, 'untrusted-page');
  assert.equal(v.page.offset, 0);
  assert.ok(v.page.text.includes('Preview'), v.page.text);
  assert.ok(v.page.totalChars >= v.page.text.length);
  // It is an ordinary navigation: recorded like one.
  assert.ok(fake.world.inputLog.some((e) => e.kind === 'navigate' && e.operationId === 'visit-1'));
  // The same operation id returns the recorded navigation, not a second one.
  await h.ok('browser_visit', { ...page, url: 'https://app.test/', operationId: 'visit-1' });
  assert.equal(fake.world.inputLog.filter((e) => e.operationId === 'visit-1').length, 1);
  await h.close(); await broker.close();
});

test('visit is refused outside the grant, before any navigation', async () => {
  const { fake, broker, h, page } = await rig();
  const before = fake.world.inputLog.length;
  const r = await h.call('browser_visit', { ...page, url: 'https://elsewhere.test/', operationId: 'visit-out' });
  assert.equal(r.structuredContent.ok, false);
  assert.match(JSON.stringify(r.structuredContent.error), /destination not allowed/);
  assert.equal(fake.world.inputLog.length, before);
  await h.close(); await broker.close();
});

test('read returns the current page in parts', async () => {
  const { broker, h, page } = await rig();
  await h.ok('browser_visit', { ...page, url: 'https://app.test/', operationId: 'visit-2' });
  const all = await h.ok('browser_read', { ...page, maxChars: 40000 });
  assert.equal(all.nextOffset, null);
  const first = await h.ok('browser_read', { ...page, maxChars: 200 });
  assert.equal(first.text, all.text.slice(0, 200));
  if (all.totalChars > 200) {
    assert.equal(first.nextOffset, 200);
    const second = await h.ok('browser_read', { ...page, offset: 200, maxChars: 200 });
    assert.equal(second.text, all.text.slice(200, 400));
  }
  const past = await h.ok('browser_read', { ...page, offset: all.totalChars + 10, maxChars: 200 });
  assert.equal(past.text, '');
  assert.equal(past.nextOffset, null);
  await h.close(); await broker.close();
});

test('read and visit refuse malformed input before touching the page', async () => {
  const { broker, h, page } = await rig();
  for (const [name, args] of [
    ['browser_read', { ...page, maxChars: 10 }],
    ['browser_read', { ...page, offset: -1 }],
    ['browser_visit', { ...page, url: 'javascript:alert(1)', operationId: 'bad-1' }],
    ['browser_visit', { ...page, url: 'https://app.test/' }],
  ]) {
    const r = await h.call(name, args);
    assert.ok(r.isError || r.structuredContent?.ok === false, `${name} ${JSON.stringify(args)}`);
  }
  await h.close(); await broker.close();
});
