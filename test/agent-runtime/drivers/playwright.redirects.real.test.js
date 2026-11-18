'use strict';
// REAL headless Chromium against LOCAL servers (127.0.0.1 / localhost, ephemeral ports).
//
// capabilities.requestInterception claims that EVERY redirect hop is checked by open({ requestFilter }) before
// it is sent. Each test below redirects from a granted origin to a server outside the grant and asserts that
// the foreign server recorded ZERO requests. Skips (with the reason) when Chromium is not installed.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { browserAvailable, OFFSCREEN, sleep, waitFor } = require('./_env');
const { createPlaywrightDriver } = require('../../../src/main/services/browser/drivers/playwright');

// A tiny scriptable origin. Records method, host, path, body and cookies of everything it is asked for.
//   /redirect?to=URL[&code=302]   redirect (sets cookie hop=1)
//   /page?html=...                the given markup
//   /worker.js?f=URL              a worker script that fetches URL
//   /sw.js?f=URL                  a service worker that fetches URL on activate
//   anything else                 200 text/plain
function startServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push({ method: req.method, host: req.headers.host, path: url.pathname, body, cookie: req.headers.cookie || '' });
      const q = (k) => url.searchParams.get(k) || '';
      if (url.pathname === '/redirect') {
        res.writeHead(Number(q('code')) || 302, { location: q('to'), 'set-cookie': 'hop=1; Path=/' });
        res.end();
        return;
      }
      if (url.pathname === '/page') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(q('html') || '<h1>page</h1>'); return; }
      if (url.pathname === '/worker.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(`fetch(${JSON.stringify(q('f'))}).then(() => 'ok', () => 'blocked').then((r) => { if (self.postMessage) self.postMessage(r); });`);
        return;
      }
      if (url.pathname === '/sw.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => { e.waitUntil(fetch(${JSON.stringify(q('f'))}).then(() => 'ok', () => 'blocked').then((r) => fetch('/sw-done?r=' + r))); });`);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      res.end('ok');
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        requests, port,
        origin: `http://127.0.0.1:${port}`,
        alias: `http://localhost:${port}`, // same server, another SITE: a frame from here is out-of-process
        paths: () => requests.map((r) => r.path),
        close: () => new Promise((done) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}

let avail = { ok: false, reason: 'not probed' };
test.before(async () => { avail = await browserAvailable('headless'); });

// granted = the whole `a` server under both of its names; `b` is outside the grant.
function guarded(name, fn) {
  test(name, async (t) => {
    if (!avail.ok) { t.skip(avail.reason); return; }
    const a = await startServer();
    const b = await startServer();
    const seen = [];
    const allowed = (url) => url.startsWith(`${a.origin}/`) || url.startsWith(`${a.alias}/`);
    const session = await createPlaywrightDriver().open({ mode: 'headless', window: OFFSCREEN, enforceRedirectHops: true,
      requestFilter: (url, info) => { seen.push({ url, ...info }); return allowed(url) ? 'allow' : 'block'; } });
    const page = session.pages.values().next().value;
    const redirect = (to, { base = a.origin, code } = {}) => `${base}/redirect?to=${encodeURIComponent(to)}${code ? `&code=${code}` : ''}`;
    const html = (markup, base = a.origin) => `${base}/page?html=${encodeURIComponent(markup)}`;
    try {
      await fn({ a, b, session, page, seen, redirect, html });
    } finally {
      await session.close().catch(() => {});
      await a.close();
      await b.close();
    }
  });
}

guarded('redirect hops: a navigation redirected to a foreign origin never reaches it and is reported as failed', async ({ a, b, page, session, seen, redirect }) => {
  const nav = await page.navigate(redirect(`${b.origin}/landing`));
  assert.equal(nav.outcome, 'failed');
  assert.equal(nav.error, 'ERR_BLOCKED_BY_CLIENT');
  assert.deepEqual(b.requests, [], 'the foreign server recorded zero requests');
  assert.deepEqual(a.paths(), ['/redirect'], 'the granted hop was sent exactly once');
  assert.ok(!page.url().startsWith(b.origin), 'the page did not arrive at the foreign origin');
  const hop = seen.find((s) => s.url === `${b.origin}/landing`);
  assert.deepEqual([hop.redirect, hop.navigation], [true, true], 'the filter was asked about the hop itself, as a navigation redirect');
  assert.ok(session.requestGuard.stats.blockedHops >= 1);

  // every status that carries a Location is a hop
  for (const code of [301, 303, 307, 308]) {
    const again = await page.navigate(redirect(`${b.origin}/landing-${code}`, { code }));
    assert.equal(again.outcome, 'failed', `status ${code}`);
  }
  // a chain is checked hop by hop: granted -> granted -> foreign stops at the last one
  const chain = await page.navigate(redirect(redirect(`${b.origin}/end-of-chain`, { base: a.alias })));
  assert.equal(chain.outcome, 'failed');
  assert.deepEqual(b.requests, []);
  assert.ok(a.requests.some((r) => r.host.startsWith('localhost:') && r.path === '/redirect'), 'the granted middle hop was followed');
});

guarded('redirect hops: a redirect that stays inside the grant still works (cookies from the hop, one request per hop)', async ({ a, b, page, session, redirect }) => {
  const nav = await page.navigate(redirect(`${a.origin}/page`));
  assert.deepEqual([nav.outcome, nav.status], ['ready', 200]);
  assert.equal(page.url(), `${a.origin}/page`);
  assert.deepEqual(a.paths(), ['/redirect', '/page'], 'no hop was fetched twice');
  assert.equal(a.requests[1].cookie, 'hop=1', 'the cookie set on the redirect response was stored and sent on the next hop');
  assert.ok(session.requestGuard.stats.hops >= 1);
  assert.equal(session.requestGuard.stats.blocked, 0);
  assert.deepEqual(b.requests, []);
});

guarded('redirect hops: a POST redirected with 307 keeps its method and body inside the grant and is stopped outside it', async ({ a, b, page, redirect, html }) => {
  const form = (action, id) => `<form method="post" action="${action}"><input name="k" value="v"><button id="${id}">go</button></form>`;
  await page.navigate(html(form(redirect(`${a.origin}/landed`, { code: 307 }), 'inside')));
  await page._raw.click('#inside');
  await waitFor(() => a.requests.some((r) => r.path === '/landed'));
  const landed = a.requests.find((r) => r.path === '/landed');
  assert.deepEqual([landed.method, landed.body, landed.cookie], ['POST', 'k=v', 'hop=1']);
  assert.equal(a.requests.filter((r) => r.method === 'POST' && r.path === '/redirect').length, 1, 'the POST was sent once, not replayed');

  await page.navigate(html(form(redirect(`${b.origin}/landed`, { code: 307 }), 'outside')));
  const posts = a.requests.filter((r) => r.method === 'POST' && r.path === '/redirect').length;
  await page._raw.click('#outside');
  await waitFor(() => a.requests.filter((r) => r.method === 'POST' && r.path === '/redirect').length === posts + 1);
  await sleep(300);
  assert.deepEqual(b.requests, [], 'the form body never reached the foreign origin');
  assert.equal(page.url(), 'about:blank', 'the blocked navigation is reported as the error document, not as a destination');
});

guarded('redirect hops: subresources (img, fetch) redirected to a foreign origin never reach it', async ({ a, b, page, seen, redirect, html }) => {
  const markup = `<img id="i" src="${redirect(`${b.origin}/pixel`)}">
<script>
  window.results = {};
  document.getElementById('i').onerror = () => { window.results.img = 'blocked'; };
  document.getElementById('i').onload = () => { window.results.img = 'loaded'; };
  fetch(${JSON.stringify(redirect(`${b.origin}/data`))}).then(() => 'ok', () => 'blocked').then((r) => { window.results.fetch = r; });
</script>`;
  assert.equal((await page.navigate(html(markup))).outcome, 'ready');
  const results = await waitFor(async () => {
    const r = await page._raw.evaluate(() => window.results);
    return r.img && r.fetch ? r : null;
  });
  assert.deepEqual(results, { img: 'blocked', fetch: 'blocked' });
  assert.deepEqual(b.requests, []);
  assert.equal(a.requests.filter((r) => r.path === '/redirect').length, 2);
  assert.ok(seen.some((s) => s.url === `${b.origin}/pixel` && s.navigation === false), 'the image hop was put to the filter');
  assert.ok(seen.some((s) => s.url === `${b.origin}/data`), 'the fetch hop was put to the filter');
});

guarded('redirect hops: frames, including out-of-process frames and their own subresources', async ({ a, b, page, redirect, html }) => {
  // top (127.0.0.1) > frame (localhost: another site, its own process) > img redirected to the foreign origin
  //                 > frame whose own navigation is redirected to the foreign origin
  const inner = html(`<h2>inner</h2><img src="${redirect(`${b.origin}/inner-pixel`, { base: a.alias })}">`, a.alias);
  const markup = `<iframe id="oop" src="${inner}"></iframe><iframe id="red" src="${redirect(`${b.origin}/framed`)}"></iframe>`;
  assert.equal((await page.navigate(html(markup))).outcome, 'ready');
  await waitFor(() => a.requests.filter((r) => r.path === '/redirect').length === 2);
  await sleep(300);
  assert.deepEqual(b.requests, []);
  assert.ok(a.requests.some((r) => r.host.startsWith('localhost:') && r.path === '/page'), 'the granted cross-site frame itself loaded');
  assert.ok(!page._raw.frames().some((f) => f.url().startsWith(b.origin)), 'no frame arrived at the foreign origin');
});

guarded('redirect hops: a popup whose first navigation is redirected to a foreign origin never reaches it', async ({ a, b, page, session, redirect, html }) => {
  await page.navigate(html(`<a id="open" target="_blank" href="${redirect(`${b.origin}/popup-landing`)}">open</a>`));
  await page._raw.click('#open');
  await waitFor(() => session.pages.size === 2);
  await waitFor(() => a.requests.some((r) => r.path === '/redirect'));
  await sleep(300);
  assert.deepEqual(b.requests, []);
  const popup = [...session.pages.values()].find((p) => p !== page);
  assert.ok(!popup.url().startsWith(b.origin));
});

guarded('redirect hops: dedicated, shared and service workers', async ({ a, b, page, redirect, html }) => {
  const viaRedirect = (path, base) => redirect(`${b.origin}/${path}`, { base });
  const markup = `<script>
  window.results = {};
  const w = new Worker('/worker.js?f=' + encodeURIComponent(${JSON.stringify(viaRedirect('from-worker', a.alias))}));
  w.onmessage = (e) => { window.results.worker = e.data; };
  new SharedWorker('/worker.js?f=' + encodeURIComponent(${JSON.stringify(viaRedirect('from-shared-worker', a.alias))}));
  navigator.serviceWorker.register('/sw.js?f=' + encodeURIComponent(${JSON.stringify(viaRedirect('from-service-worker', a.alias))}));
</script>`;
  // localhost is a secure context, which service workers need
  assert.equal((await page.navigate(html(markup, a.alias))).outcome, 'ready');
  await waitFor(() => a.requests.filter((r) => r.path === '/redirect').length === 3 && a.requests.some((r) => r.path === '/sw-done'), { timeoutMs: 8000 });
  assert.equal(await waitFor(() => page._raw.evaluate(() => window.results.worker)), 'blocked');
  await sleep(200);
  assert.deepEqual(b.requests, [], 'no worker reached the foreign origin through a redirect');
});

test('redirect hops: a throwing filter blocks the hop (fail closed), and no filter means no guard', async (t) => {
  if (!avail.ok) { t.skip(avail.reason); return; }
  const a = await startServer();
  const b = await startServer();
  const driver = createPlaywrightDriver();
  const failing = await driver.open({ mode: 'headless', window: OFFSCREEN, enforceRedirectHops: true,
    requestFilter: (url) => { if (url.startsWith(b.origin)) throw new Error('boom'); return 'allow'; } });
  try {
    const nav = await failing.pages.values().next().value.navigate(`${a.origin}/redirect?to=${encodeURIComponent(`${b.origin}/x`)}`);
    assert.equal(nav.outcome, 'failed');
    assert.deepEqual(b.requests, []);
  } finally { await failing.close(); }

  const unguarded = await driver.open({ mode: 'headless', window: OFFSCREEN });
  try {
    assert.equal(unguarded.requestGuard, null, 'without a filter there is no policy to apply and nothing is intercepted');
    const nav = await unguarded.pages.values().next().value.navigate(`${a.origin}/redirect?to=${encodeURIComponent(`${b.origin}/page`)}`);
    assert.equal(nav.outcome, 'ready');
    assert.equal(b.requests.length, 1);
  } finally { await unguarded.close(); await a.close(); await b.close(); }
});

// An embedder that drives this driver directly (SandboxOS's Browser does) passes a block-everything filter as a
// default and then decides every request in its OWN route on the session's context, including sending a request
// somewhere else. The browser-level hop guard must not be switched on behind its back: it cannot be overridden by a
// route, so it would block every page. It is opt-in, and the broker opts in.
test('an embedder\'s own route still decides when it passes a default-deny filter without opting into the hop guard', async (t) => {
  if (!avail.ok) { t.skip(avail.reason); return; }
  const a = await startServer();
  const b = await startServer();
  const session = await createPlaywrightDriver().open({ mode: 'headless', window: OFFSCREEN, requestFilter: () => 'block' });
  try {
    assert.equal(session.requestGuard, null, 'no browser-level guard unless asked for');
    // The embedder's policy: allow `a`, and serve anything addressed to a made-up name from `a` as well.
    await session._context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(`${a.origin}/`)) return route.continue();
      if (url.startsWith('http://my-machine.test/')) return route.continue({ url: url.replace('http://my-machine.test', a.origin) });
      return route.abort('blockedbyclient');
    });
    const page = session.pages.values().next().value;
    const direct = await page.navigate(`${a.origin}/page?html=${encodeURIComponent('<h1>direct</h1>')}`);
    assert.equal(direct.outcome, 'ready', JSON.stringify(direct));
    assert.equal(await page._raw.textContent('h1'), 'direct');
    const rewritten = await page.navigate(`http://my-machine.test/page?html=${encodeURIComponent('<h1>rewritten</h1>')}`);
    assert.equal(rewritten.outcome, 'ready', JSON.stringify(rewritten));
    assert.equal(await page._raw.textContent('h1'), 'rewritten');
    // The embedder's own refusals still hold.
    await page.navigate(`${b.origin}/page`).catch(() => null);
    assert.equal(b.requests.length, 0);
  } finally { await session.close(); await a.close(); await b.close(); }
});
