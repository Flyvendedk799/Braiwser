// Settings: local-first truthfulness (sync / team / billing / SSO / integrations),
// accurate account-data scope, labelled fields, and the nested sign-in dialog
// closing on its own Escape (RF-10 in the real consumer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, load, key, click, tick, settle } from './dom-env.mjs';

const { document } = setupDom();
const { openSettingsModal, LOCAL_ONLY_FEATURES, scopeFromInventory, describeDeleteResult, describeLicense } = await load('components/settings-modal.js');
const { modalDepth } = await load('lib/dom.js');

const settings = () => ({ theme: 'dark', aiProvider: 'claude-code', profile: {}, models: {}, availableThemes: [], modelChoices: {}, personas: [], sync: { accountEmail: '' } });
const providers = () => ({ 'claude-code': { ready: false }, anthropic: { ready: false }, codex: { ready: false }, openai: { ready: false } });

function open(over = {}) {
  const calls = [];
  const actions = {
    setSettings: async (p) => { calls.push(['set', p]); return null; },
    setKey: async () => providers(), clearKey: async () => providers(), refreshProviders: async () => providers(),
    claudeLoginStart: async () => {}, claudeLoginFinish: async () => ({ status: providers() }), claudeDisconnect: async () => providers(),
    syncSignIn: async (e) => { calls.push(['signIn', e]); return { ok: true }; }, syncSignOut: async () => { calls.push(['signOut']); },
    ...over,
  };
  openSettingsModal({ settings: settings(), providers: providers(), actions });
  return { calls, card: () => document.querySelector('.modal-card') };
}

async function closeAll() {
  for (const b of Array.from(document.querySelectorAll('.modal-backdrop'))) {
    const x = b.querySelector('.modal-x');
    if (x) x.click();
  }
  await tick(250);
}

test('cloud sync is labelled local-only/experimental with no implied sign-in', async () => {
  const { card } = open();
  await settle();
  const text = card().textContent;
  assert.match(text, /Cloud sync — local only, experimental/);
  assert.match(text, /Nothing is uploaded, nothing syncs between devices, and this is not a backup/);
  const labels = Array.from(card().querySelectorAll('button')).map((b) => b.textContent.trim());
  assert.ok(labels.includes('Save email'));
  assert.ok(labels.includes('Clear'));
  assert.ok(!labels.includes('Sign in'), 'no plain "Sign in" for a feature with no service behind it');
  assert.ok(!labels.includes('Sign out'));
  await closeAll();
});

test('saving the sync email says it stays on this device', async () => {
  const { card, calls } = open();
  await settle();
  const input = card().querySelector('input[type="email"]');
  input.value = 'me@example.com';
  click(Array.from(card().querySelectorAll('button')).find((b) => b.textContent === 'Save email'));
  await tick(5);
  assert.deepEqual(calls.find((c) => c[0] === 'signIn'), ['signIn', 'me@example.com']);
  assert.ok(Array.from(document.querySelectorAll('.toast-msg')).some((t) => /saved on this device — nothing is uploaded/.test(t.textContent)));
  await closeAll();
});

test('team / billing / SSO / integrations are listed as not connected', async () => {
  const { card } = open();
  await settle();
  const items = Array.from(card().querySelectorAll('.status-item'));
  assert.equal(items.length, LOCAL_ONLY_FEATURES.length);
  const byName = Object.fromEntries(items.map((i) => [i.querySelector('.status-name').textContent, i.textContent]));
  assert.match(byName['Billing and seats'], /Not connected.*No payment is taken/);
  assert.match(byName['Enterprise SSO / SCIM'], /Not available.*not implemented/);
  assert.match(byName['Team invitations'], /No invitation is sent/);
  assert.match(byName['Integrations'], /nothing is delivered automatically/);
  assert.match(card().textContent, /License keys are checked on this device\. Braiwser does not take payments/);
  await closeAll();
});

const INVENTORY = {
  collections: [
    { id: 'projects', label: 'Projects', count: 2, exported: true, erased: true },
    { id: 'annotations', label: 'Notes', count: 5, exported: true, erased: true },
  ],
  settings: [{ id: 'profile', exported: true, erased: true, hasValue: true }],
  license: { exported: 'tier and activation date only (never the key)', erased: true },
  secretFiles: ['credentials.json', 'machine.key'],
  notCovered: ['Files you exported or saved elsewhere.', 'Cookies held by the embedded browser.'],
  total: 7,
};

test('account-data section appears only when export/delete are wired', async () => {
  const h1 = open();
  await settle();
  assert.equal(h1.card().textContent.includes('Your data on this device'), false);
  await closeAll();

  const h2 = open({ exportAccountData: async () => {}, deleteAccountData: async () => ({ ok: true }) });
  await settle();
  const t = h2.card().textContent;
  assert.match(t, /Your data on this device/);
  assert.match(t, /Not covered by either:.*Files you exported or saved elsewhere/);
  assert.doesNotMatch(t, /does NOT remove: .*projects/i, 'no stale claim that projects are kept');
  await closeAll();
});

test('the inventory from the main process drives the scope text', async () => {
  const { card } = open({ exportAccountData: async () => {}, dataInventory: async () => INVENTORY });
  await settle();
  await tick(5);
  const t = card().textContent;
  assert.match(t, /Export includes: Projects \(2\); Notes \(5\); personal settings; license: tier and activation date only/);
  assert.match(t, /Delete erases: Projects \(2\); Notes \(5\); personal settings; the Pro license; stored credentials and key files \(credentials\.json, machine\.key\)/);
  assert.match(t, /Cookies held by the embedded browser/);
  await closeAll();
});

test('deleting needs a confirmation that names what is erased and what is not covered', async () => {
  const deleted = [];
  const { card } = open({ deleteAccountData: async () => { deleted.push(1); return { ok: true, deleted: {}, remaining: {}, errors: [], notCovered: [] }; }, dataInventory: async () => INVENTORY });
  await settle();
  await tick(5);
  click(Array.from(card().querySelectorAll('button')).find((b) => /Delete account data/.test(b.textContent)));
  await settle();
  const dialogs = document.querySelectorAll('.modal-card');
  assert.equal(dialogs.length, 2);
  assert.match(dialogs[1].textContent, /permanently erases Projects \(2\); Notes \(5\)/);
  assert.match(dialogs[1].textContent, /does not cover: Files you exported/);
  assert.equal(deleted.length, 0, 'nothing deleted before confirming');
  key(document.activeElement, 'Escape'); // cancels the confirm only
  await tick(5);
  assert.equal(modalDepth(), 1);
  assert.equal(deleted.length, 0);
  await closeAll();
});

test('a partial erase is reported as partial: remaining, problems and not-covered are shown', async () => {
  const { card } = open({
    dataInventory: async () => INVENTORY,
    deleteAccountData: async () => ({
      ok: false, deleted: { projects: 1, annotations: 3 }, remaining: { annotations: 2 },
      errors: ['credentials.json: EBUSY', 'not erased - Notes: 2'], notCovered: ['Cookies held by the embedded browser.'],
    }),
  });
  await settle();
  await tick(5);
  click(Array.from(card().querySelectorAll('button')).find((b) => /Delete account data/.test(b.textContent)));
  await settle();
  // confirm
  const confirm = Array.from(document.querySelectorAll('.modal-footer button')).find((b) => b.textContent === 'Delete account data');
  click(confirm);
  await tick(10);
  const box = card().querySelector('.data-result');
  assert.ok(box.classList.contains('is-partial'));
  assert.match(box.textContent, /Not everything was erased\. Projects \(1\), Notes \(3\)/);
  assert.match(box.textContent, /Still present: Notes \(2\)/);
  assert.match(box.textContent, /Problems: credentials\.json: EBUSY/);
  assert.match(box.textContent, /Not covered, still yours to remove: Cookies held by the embedded browser/);
  assert.ok(Array.from(document.querySelectorAll('.toast-msg')).some((t) => /Some data could not be erased/.test(t.textContent)));
  assert.ok(!Array.from(document.querySelectorAll('.toast-msg')).some((t) => /Account data erased/.test(t.textContent)));
  await closeAll();
});

test('a clean erase still states what it cannot cover', () => {
  const d = describeDeleteResult({ ok: true, deleted: { projects: 2 }, remaining: { projects: 0 }, errors: [], notCovered: ['Cookies.'] }, INVENTORY);
  assert.equal(d.ok, true);
  assert.deepEqual(d.erased, ['Projects (2)']);
  assert.deepEqual(d.notCovered, ['Cookies.']);
  // ok:true but leftovers is NOT ok
  assert.equal(describeDeleteResult({ ok: true, remaining: { projects: 1 } }, INVENTORY).ok, false);
  assert.equal(describeDeleteResult(null).ok, false);
});

test('scopeFromInventory falls back to the conservative description', () => {
  const s = scopeFromInventory(null);
  assert.ok(s.notCovered.length >= 4);
});

test('license text: honest about a free/dev build, a bad key and Pro', () => {
  assert.match(describeLicense({ pro: false, build: { channel: 'dev', enforced: false, proUnlockedForAll: true } }), /dev build: Pro features are unlocked for everyone and no license is needed/);
  assert.match(describeLicense({ pro: false, build: { channel: 'release', enforced: true, proUnlockedForAll: false } }), /^Free tier active/);
  assert.match(describeLicense({ pro: false, error: 'bad signature', build: { proUnlockedForAll: true } }), /not valid \(bad signature\)/);
  assert.equal(describeLicense({ pro: true, tier: 'team', build: {} }), 'Pro active (team)');
  assert.match(describeLicense(null), /Free tier/);
});

test('settings shows the build status from licenseStatus()', async () => {
  const { card } = open({ licenseStatus: async () => ({ tier: 'free', pro: false, build: { channel: 'dev', enforced: false, proUnlockedForAll: true } }) });
  await settle();
  await tick(5);
  assert.match(card().textContent, /Pro features are unlocked for everyone/);
  await closeAll();
});

test('fields are labelled: the label points at its input', async () => {
  const { card } = open();
  await settle();
  const label = Array.from(card().querySelectorAll('label.field-label')).find((l) => l.textContent === 'Profile name');
  assert.ok(label.htmlFor);
  assert.equal(document.getElementById(label.htmlFor).type, 'text');
  const group = Array.from(card().querySelectorAll('label.field-label')).find((l) => l.textContent === 'AI Provider');
  const grouped = document.getElementById(group.id.replace('label', 'label')); // label exists
  assert.ok(grouped);
  assert.ok(card().querySelector('[aria-labelledby="' + group.id + '"]'));
  await closeAll();
});

test('the Claude sign-in code dialog sits over Settings: Escape closes only it', async () => {
  const { card } = open();
  await settle();
  click(Array.from(card().querySelectorAll('button')).find((b) => b.textContent === 'Sign in with Claude'));
  await settle();
  assert.equal(modalDepth(), 2);
  assert.ok(document.querySelector('input[placeholder="Paste the code from the browser"]'));
  key(document.activeElement, 'Escape');
  assert.equal(modalDepth(), 1, 'Settings stays open');
  assert.ok(card().textContent.includes('Profile and Settings'));
  await closeAll();
});
