'use strict';
// Static LOCAL fixture server for the agent-driver tests and `cli.js run-fixture`.
// Binds 127.0.0.1 on an ephemeral port only. Never proxies or fetches anything.
//
//   const srv = await startFixtureServer();           // { origin, port, close() }
//   const other = await startFixtureServer();          // a second origin => cross-origin frames
//
// Special routes:
//   /files/report.txt   attachment download (small)
//   /files/big.bin      attachment download (2 MiB)
//   /hang               never answers (navigation timeout / cancel tests)
//   /redirect?to=URL    302 to URL (redirect-hop policy tests)
// The returned handle exposes `requests` (paths served) for "this request never arrived" assertions.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

function startFixtureServer(options) {
  const o = options || {};
  const dir = o.dir || __dirname;
  const root = path.resolve(dir);
  const hangs = new Set();
  const requests = []; // every path this server was asked for (tests assert blocked requests never arrive)
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/files/report.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' });
      res.end('quarterly numbers\n');
      return;
    }
    if (url.pathname === '/files/big.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="big.bin"' });
      res.end(Buffer.alloc(2 * 1024 * 1024));
      return;
    }
    if (url.pathname === '/redirect') { res.writeHead(302, { location: url.searchParams.get('to') || '/' }); res.end(); return; }
    if (url.pathname === '/hang') { hangs.add(res); res.on('close', () => hangs.delete(res)); return; }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'task.html';
    const file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        requests,
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          for (const r of hangs) { try { r.destroy(); } catch (_e) { /* ignore */ } }
          server.closeAllConnections && server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

module.exports = { startFixtureServer };
