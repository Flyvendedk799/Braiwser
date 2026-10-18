'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGuestViews } = require('../../src/main/services/browser/guest-views');
const { createElectronDriver } = require('../../src/main/services/browser/drivers/electron');
const { createDebuggerBroker } = require('../../src/main/services/browser/debugger-broker');
const { createFakeGuest } = require('./drivers/_fake-guest');

function fakeWindow(bounds) {
  const children = [];
  return {
    bounds,
    children,
    isDestroyed: () => false,
    getContentBounds: () => bounds,
    contentView: {
      addChildView(view) { children.push(view); },
      removeChildView(view) {
        const i = children.indexOf(view);
        if (i >= 0) children.splice(i, 1);
      },
    },
  };
}

class FakeView {
  constructor() {
    this.bounds = null;
    const wc = {
      closed: false,
      isDestroyed() { return this.closed; },
      close() { this.closed = true; },
      debugger: {},
      on() {},
      getURL: () => 'about:blank',
    };
    this.webContents = wc;
  }
  setBounds(bounds) { this.bounds = { ...bounds }; }
}

test('a main-owned view is added at zero size and placed only inside the window', () => {
  const win = fakeWindow({ width: 800, height: 600 });
  const host = createGuestViews({ getWindow: () => win, View: FakeView });
  const wc = host.create();
  assert.equal(win.children.length, 1);
  assert.deepEqual(win.children[0].bounds, { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(typeof wc.braiwserGuestViewId, 'string');
  const placed = host.place({ x: -20, y: 10, width: 5000, height: 100 });
  assert.equal(placed.placed, 1);
  assert.deepEqual(placed.bounds, { x: 0, y: 10, width: 800, height: 100 });
  host.closeAll();
  assert.equal(win.children.length, 0);
  assert.equal(wc.closed, true);
});

test('creating a view without a shell window is unavailable', () => {
  const host = createGuestViews({ getWindow: () => null, View: FakeView });
  assert.throws(() => host.create(), (err) => err.detail === 'NO_WINDOW');
});

test('the embedded driver newPage uses the installed guest factory', async () => {
  const guest = createFakeGuest({ html: '<!doctype html><html><body><button>Save</button></body></html>' });
  let created = 0;
  const driver = createElectronDriver({
    debuggerBroker: createDebuggerBroker(),
    createGuest: async () => { created += 1; return guest.wc; },
  });
  driver.registerGuest(createFakeGuest({ html: '<!doctype html><html><body></body></html>' }).wc);
  const session = await driver.open();
  const page = await session.newPage();
  assert.equal(created, 1);
  assert.equal(session.pages.has(page.pageId), true);
  await session.close();
});
