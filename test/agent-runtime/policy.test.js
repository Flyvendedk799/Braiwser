'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPolicy, isPrivateHost } = require('../../src/main/services/browser/policy');
const { tmp, ui, mcp } = require('./helpers');

const mk = (clock) => createPolicy({ clock: clock || { now: () => Date.now() } });
const grantFor = (policy, principal, req = {}) => policy.createGrant(req, principal, { sessionId: 's1' });
const uiGrant = (policy, req = {}) => grantFor(policy, ui, { allowedOrigins: ['https://app.test'], toolClasses: ['observe', 'navigate', 'interact', 'submit'], ...req });

test('private and local hosts are recognised in every spelling', () => {
  for (const h of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.5.5', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '[::1]', '[::]', '[fc00::1]', '[fe80::1]', '[::ffff:7f00:1]', '[::ffff:10.0.0.1]', 'intranet', 'printer.local', 'db.internal', 'metadata.google.internal']) {
    assert.equal(isPrivateHost(h), true, h);
  }
  for (const h of ['example.com', '93.184.216.34', '8.8.8.8', 'sub.example.org', '172.32.0.1', '[2606:4700:4700::1111]']) assert.equal(isPrivateHost(h), false, h);
});

test('default-deny destinations: file, data, javascript, blob, credentials, private network', () => {
  const p = mk(); const g = uiGrant(p);
  for (const url of ['file:///etc/passwd', 'file:///C:/Windows/win.ini', 'data:text/html,<script>1</script>', 'javascript:alert(1)', 'blob:https://app.test/x', 'ftp://app.test/', 'chrome://settings', 'view-source:https://app.test/',
    'about:srcdoc', 'https://user:pw@app.test/', 'http://localhost:3000/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data', 'http://192.168.0.1/', 'http://app.test/', 'https://evil.test/', 'https://app.test.evil.test/', 'not a url', '', 'https://' + 'a'.repeat(3000)]) {
    assert.equal(p.checkDestination(g, url).allowed, false, url);
  }
  assert.equal(p.checkDestination(g, 'https://app.test/any/path?x=1').allowed, true);
  assert.equal(p.checkDestination(g, 'about:blank').allowed, true);
  assert.equal(p.checkDestination(g, 5).allowed, false);
});

test('local servers need the exact origin AND port to be named', () => {
  const p = mk();
  const g = uiGrant(p, { allowedOrigins: ['http://localhost:3000'] });
  assert.equal(p.checkDestination(g, 'http://localhost:3000/app').allowed, true);
  assert.equal(p.checkDestination(g, 'http://localhost:3001/app').allowed, false);
  assert.equal(p.checkDestination(g, 'http://localhost/').allowed, false);
  assert.equal(p.checkDestination(g, 'http://127.0.0.1:3000/').allowed, false); // a different name is a different origin
  assert.equal(p.checkDestination(g, 'https://localhost:3000/').allowed, false);
});

test('wildcards never cover the apex, other schemes, or private hosts', () => {
  const p = mk();
  const g = uiGrant(p, { allowedOrigins: ['https://*.example.com'] });
  assert.equal(p.checkDestination(g, 'https://a.example.com/').allowed, true);
  assert.equal(p.checkDestination(g, 'https://example.com/').allowed, false);
  assert.equal(p.checkDestination(g, 'http://a.example.com/').allowed, false);
  assert.equal(p.checkDestination(g, 'https://a.example.com.evil.test/').allowed, false);
  assert.throws(() => uiGrant(p, { allowedOrigins: ['http://*.localhost'] }), (e) => e.publicError.code === 'DENIED');
});

test('file: only inside a canonical granted root; traversal and symlinks fail', (t) => {
  const p = mk();
  const root = fs.realpathSync(tmp()); const outside = fs.realpathSync(tmp());
  fs.writeFileSync(path.join(root, 'index.html'), '<p>ok</p>');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'a.html'), 'a');
  fs.writeFileSync(path.join(outside, 'secret.html'), 'secret');
  const g = uiGrant(p, { allowedRoots: [root] });
  const url = (f) => require('node:url').pathToFileURL(f).href;
  assert.equal(p.checkDestination(g, url(path.join(root, 'index.html'))).allowed, true);
  assert.equal(p.checkDestination(g, url(path.join(root, 'sub', 'a.html'))).allowed, true);
  assert.equal(p.checkDestination(g, url(path.join(outside, 'secret.html'))).allowed, false);
  assert.equal(p.checkDestination(g, url(path.join(root, '..', path.basename(outside), 'secret.html'))).allowed, false);
  assert.equal(p.checkDestination(g, url(path.join(root, 'missing.html'))).allowed, false);
  assert.equal(p.checkDestination(g, 'file://server/share/x.html').allowed, false);
  // no root granted => file: is denied even for existing files
  assert.equal(p.checkDestination(uiGrant(p), url(path.join(root, 'index.html'))).allowed, false);
  // a sibling dir sharing a prefix is not inside the root
  const sibling = root + '-evil'; fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, 'x.html'), 'x');
  assert.equal(p.checkDestination(g, url(path.join(sibling, 'x.html'))).allowed, false);
  fs.rmSync(sibling, { recursive: true, force: true });
  // symlink escape
  try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction'); } catch { t.diagnostic('symlink creation unavailable'); return; }
  assert.equal(p.checkDestination(g, url(path.join(root, 'link', 'secret.html'))).allowed, false);
  assert.throws(() => uiGrant(p, { allowedRoots: ['relative/path'] }));
  assert.throws(() => uiGrant(p, { allowedRoots: [path.join(root, 'nope')] }));
});

test('DNS-aware check refuses a public name that resolves to a private address', async () => {
  const lookup = async (host) => (host === 'rebind.app.test' ? [{ address: '10.0.0.5' }] : [{ address: '93.184.216.34' }]);
  const p = createPolicy({ lookup });
  const g = uiGrant(p, { allowedOrigins: ['https://rebind.app.test', 'https://app.test'] });
  assert.equal((await p.checkDestinationResolved(g, 'https://rebind.app.test/')).allowed, false);
  assert.equal((await p.checkDestinationResolved(g, 'https://app.test/')).allowed, true);
  const failing = createPolicy({ lookup: async () => { throw new Error('nx'); } });
  assert.equal((await failing.checkDestinationResolved(uiGrant(failing), 'https://app.test/')).allowed, false);
});

test('a non-UI principal only receives the intersection of request and scopes', () => {
  const p = mk();
  const agent = mcp('agent', ['class:observe', 'class:navigate', 'origin:https://app.test', 'budget:maxActions=3']);
  const g = grantFor(p, agent, { allowedOrigins: ['https://app.test', 'https://evil.test'], toolClasses: ['observe', 'interact', 'submit'] });
  assert.deepEqual(g.toolClasses, ['observe']);
  assert.deepEqual(g.allowedOrigins, ['https://app.test']);
  assert.equal(g.budgets.maxActions, 3);
  assert.equal(p.checkDestination(g, 'https://evil.test/').allowed, false);
  assert.throws(() => grantFor(p, mcp('nobody', []), { toolClasses: ['interact'] }), (e) => e.publicError.code === 'DENIED');
  assert.throws(() => grantFor(p, agent, { toolClasses: ['interact'] }), (e) => e.publicError.code === 'DENIED');
  // a request cannot self-grant trusted fixture mode
  assert.equal(grantFor(p, agent, { trustedFixture: true }).trustedFixture, false);
  assert.equal(grantFor(p, ui, { trustedFixture: true }).trustedFixture, true);
  assert.throws(() => grantFor(p, agent, { approved: true }), /unknown field/);
});

test('grants expire, bind to their principal, and can be revoked', () => {
  let now = 1_000_000;
  const p = mk({ now: () => now });
  const g = grantFor(p, ui, { toolClasses: ['observe'], expiresAt: new Date(now + 1000).toISOString() });
  p.assertActive(g, ui);
  assert.throws(() => p.assertActive(g, mcp('other')), /does not belong/);
  p.assertClass(g, 'observe');
  assert.throws(() => p.assertClass(g, 'interact'), /not granted/);
  assert.throws(() => p.assertClass(g, 'teleport'), /unknown tool class/);
  now += 1001;
  assert.throws(() => p.assertActive(g, ui), /expired/);
  const g2 = grantFor(p, ui, { toolClasses: ['observe'] });
  p.revokeGrant(g2);
  assert.throws(() => p.assertActive(g2, ui), /revoked/);
  assert.throws(() => grantFor(p, ui, { expiresAt: new Date(now - 5).toISOString() }), /expired/);
});

test('budgets are enforced per grant', () => {
  const p = mk(); const g = uiGrant(p, { budgets: { maxActions: 2, maxObservations: 1 } });
  p.spend(g, 'actions'); p.spend(g, 'actions');
  assert.throws(() => p.spend(g, 'actions'), /budget exhausted/);
  p.spend(g, 'observations');
  assert.throws(() => p.spend(g, 'observations'));
  assert.deepEqual(p.budgetUsage(g).actions, 2);
});

test('secret targets: fill into password / OTP / payment fields is rejected', () => {
  const p = mk(); const g = uiGrant(p);
  const fill = { kind: 'fill', ref: 'r', text: 'x' };
  for (const target of [{ role: 'textbox', name: 'Email', traits: ['password'] }, { role: 'textbox', name: 'Code', traits: ['otp'] }, { role: 'textbox', name: 'x', traits: ['payment'] },
    { role: 'textbox', name: 'Password' }, { role: 'textbox', name: 'One-time code' }, { role: 'textbox', name: 'Card number' }, { role: 'textbox', name: 'CVV' }, { role: 'textbox', name: 'Adgangskode' },
    { role: 'textbox', name: 'x', traits: ['autocomplete:current-password'] }]) {
    assert.throws(() => p.authorizeAction({ grant: g, principal: ui, action: fill, target }), (e) => e.code === 'SECRET_FIELD', JSON.stringify(target));
  }
  assert.equal(p.authorizeAction({ grant: g, principal: ui, action: fill, target: { role: 'textbox', name: 'Display name' } }).toolClass, 'interact');
});

test('unknown and write-like actions fail closed or require approval', () => {
  const p = mk(); const g = uiGrant(p);
  assert.throws(() => p.authorizeAction({ grant: g, principal: ui, action: { kind: 'evaluate' }, target: {} }), (e) => e.publicError.code === 'UNSUPPORTED');
  assert.throws(() => p.authorizeAction({ grant: g, principal: ui, action: { kind: 'click', ref: 'r' }, target: { role: 'button', name: 'Upload', traits: ['file-input'] } }), (e) => e.publicError.code === 'UNSUPPORTED');
  const click = (name, traits) => p.authorizeAction({ grant: g, principal: ui, action: { kind: 'click', ref: 'r' }, target: { role: 'button', name, traits } });
  assert.deepEqual([click('Next').toolClass, click('Next').needsApproval], ['interact', false]);
  for (const name of ['Pay now', 'Delete account', 'Send', 'Submit order', 'Slet', 'Place order']) assert.deepEqual([click(name).toolClass, click(name).needsApproval], ['submit', true], name);
  assert.equal(click('Innocent label', ['submit']).needsApproval, true);
  assert.equal(p.authorizeAction({ grant: g, principal: ui, action: { kind: 'press', ref: 'r', key: 'Enter' }, target: { role: 'textbox', name: 'q' } }).needsApproval, true);
  assert.equal(p.authorizeAction({ grant: g, principal: ui, action: { kind: 'press', ref: 'r', key: 'Tab' }, target: { role: 'textbox', name: 'q' } }).needsApproval, false);
  // without the submit class the write-like action is denied outright
  const lowly = grantFor(p, ui, { allowedOrigins: ['https://app.test'], toolClasses: ['observe', 'interact'] });
  assert.throws(() => p.authorizeAction({ grant: lowly, principal: ui, action: { kind: 'click', ref: 'r' }, target: { role: 'button', name: 'Pay now' } }), /not granted/);
  // a trusted fixture grant (ui-only) skips the approval, not the class check
  const fx = grantFor(p, ui, { allowedOrigins: ['https://app.test'], toolClasses: ['observe', 'interact', 'submit'], trustedFixture: true });
  assert.equal(p.authorizeAction({ grant: fx, principal: ui, action: { kind: 'click', ref: 'r' }, target: { role: 'button', name: 'Pay now' } }).needsApproval, false);
});

const bound = (o = {}) => ({ principalId: 'mcp-1', runId: 'run_1', sessionId: 's1', pageId: 'p1', documentEpoch: 4, digest: 'd'.repeat(64), destination: 'https://app.test/', ...o });

test('approvals: server-held, UI-decided, one-use, fully bound', () => {
  let now = 1000; const p = mk({ now: () => now });
  const req = p.requestApproval(bound(), { action: 'click (submit)', target: 'button "Pay"', destination: 'https://app.test/pay?token=abc' });
  assert.equal(req.status, 'pending'); assert.ok(!JSON.stringify(req.summary).includes('abc'));
  assert.throws(() => p.consumeApproval(req.approvalId, bound()), /pending/);
  assert.throws(() => p.decide(req.approvalId, 'allow', mcp('mcp-1')), /trusted UI/);
  assert.throws(() => p.decide(req.approvalId, 'allow', { kind: 'skill', id: 'x' }), /trusted UI/);
  assert.equal(p.decide(req.approvalId, 'allow', ui).status, 'allowed');
  for (const field of ['principalId', 'runId', 'sessionId', 'pageId', 'documentEpoch', 'digest', 'destination']) {
    const wrong = field === 'documentEpoch' ? 5 : 'other';
    assert.throws(() => p.consumeApproval(req.approvalId, bound({ [field]: wrong })), /does not match/, field);
  }
  assert.equal(p.consumeApproval(req.approvalId, bound()), true);
  assert.throws(() => p.consumeApproval(req.approvalId, bound()), /used/); // replay
  assert.throws(() => p.consumeApproval('apr_unknown', bound()), /unknown approval/);
});

test('approvals expire, can be denied, and are revoked with the session', () => {
  let now = 1000; const p = createPolicy({ clock: { now: () => now }, approvalTtlMs: 100 });
  const a = p.requestApproval(bound()); p.decide(a.approvalId, 'allow', ui);
  now += 101;
  assert.throws(() => p.consumeApproval(a.approvalId, bound()), /expired/);
  const b = p.requestApproval(bound()); p.decide(b.approvalId, 'deny', ui);
  assert.throws(() => p.consumeApproval(b.approvalId, bound()), /denied/);
  const c = p.requestApproval(bound()); p.decide(c.approvalId, 'allow', ui);
  const d = p.requestApproval(bound({ sessionId: 'other' }));
  assert.equal(p.revokeApprovals({ sessionId: 's1' }), 1);
  assert.throws(() => p.consumeApproval(c.approvalId, bound()), /revoked/);
  assert.equal(p.approvalState(d.approvalId).status, 'pending');
  assert.equal(p.listApprovals({ principal: mcp('someone-else') }).length, 0);
  assert.equal(p.listApprovals({ principal: ui }).length, 1);
  assert.throws(() => p.decide(d.approvalId, 'maybe', ui));
});

test('requestFilter exposes the same decision for request-level drivers', () => {
  const p = mk(); const g = uiGrant(p);
  const f = p.requestFilter(g);
  assert.equal(f('https://app.test/x'), 'allow');
  assert.equal(f('https://tracker.test/x'), 'block');
  assert.equal(f('http://169.254.169.254/'), 'block');
});
