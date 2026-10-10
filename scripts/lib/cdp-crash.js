// Deliberately crashes the app's main renderer, from OUTSIDE the app, over the
// Chrome DevTools Protocol. This is the "intentional renderer crash" used to prove
// that the e2e gate goes red when a renderer dies mid-suite; it works for the dev
// tree and for a packaged build because it needs no cooperation from the app beyond
// the standard --remote-debugging-port switch.
//
//   const { port } = await freePort();  // pass --remote-debugging-port=<port> to the app
//   await crashRenderer({ port, delayMs: 5000 });
const net = require('net');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve({ port }));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`DevTools endpoint answered ${res.status}`);
  return res.json();
}

// The shell window, not a guest <webview> page.
function pickShellTarget(targets) {
  return targets.find((t) => t.type === 'page' && /renderer[\\/]+index\.html/.test(t.url || ''))
    || targets.find((t) => t.type === 'page' && !/^https?:/.test(t.url || '') && t.webSocketDebuggerUrl);
}

async function waitForShell(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const target = pickShellTarget(await listTargets(port));
      if (target && target.webSocketDebuggerUrl) return target;
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw new Error(`The app's DevTools endpoint on port ${port} never offered a shell page${lastError ? ` (${lastError.message})` : ''}`);
}

function sendCrash(wsUrl) {
  if (typeof WebSocket === 'undefined') throw new Error('This Node.js has no global WebSocket (need Node 22+) to inject the crash');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (_e) { /* ignore */ } resolve('sent'); }, 3000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Page.crash' })));
    // The page dying closes the socket, which is the expected outcome.
    ws.addEventListener('close', () => { clearTimeout(timer); resolve('closed'); });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error((e && e.message) || 'DevTools socket error')); });
  });
}

async function crashRenderer({ port, delayMs = 5000, waitMs = 90000, log = () => {} }) {
  const target = await waitForShell(port, waitMs);
  log(`shell page found (${target.url}); crashing it in ${delayMs}ms`);
  await sleep(delayMs);
  await sendCrash(target.webSocketDebuggerUrl);
  log('Page.crash sent');
}

module.exports = { freePort, crashRenderer, pickShellTarget };
