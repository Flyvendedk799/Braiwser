#!/usr/bin/env node
// Newline-delimited JSON relay between a trusted supervisor (OpenBot) and this container's loopback
// proxy gateway. It lets the supervisor reach the gateway over the same process channel it already uses
// for MCP, so the gateway never listens on a routable address and no port is published.
//
//   in : {"id":"1","method":"GET","path":"/proxy/v1/sessions/bs_x/frame?pageId=pg_y","body":{...}}
//   out: {"id":"1","status":200,"body":{...}}
//
// The shared secret comes from the supervisor's environment and is attached here, never echoed back.
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';

const config = JSON.parse(process.env.BRAIWSER_RELAY_CONFIG || '{}');
if (typeof config.ownerFile !== 'string' || typeof config.token !== 'string' || config.token.length < 32) {
  process.stderr.write('Relay configuration is incomplete.\n');
  process.exit(2);
}
const PATH = /^\/proxy\/v1\/(?:sessions|handoffs)\/[A-Za-z0-9_-]{1,80}(?:\/[a-z]+)?(?:\?pageId=[A-Za-z0-9_.:-]{1,160})?$/;
const MAX_REQUEST = 64 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;

function gatewayUrl() {
  const descriptor = JSON.parse(fs.readFileSync(config.ownerFile, 'utf8'));
  const url = new URL(descriptor.baseUrl);
  if (url.hostname !== '127.0.0.1') throw new Error('Gateway descriptor is not loopback.');
  return url;
}

function forward({ method, path, body }) {
  return new Promise((resolve) => {
    let url;
    try { url = gatewayUrl(); } catch { resolve({ status: 503, body: { ok: false, error: { code: 'VIEWER_UNREACHABLE', message: 'gateway is not running' } } }); return; }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: url.hostname, port: url.port, method, path, timeout: 12000, headers: {
      host: url.host, authorization: `Bearer ${config.token}`,
      ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (chunk) => { size += chunk.length; if (size > MAX_RESPONSE) req.destroy(new Error('too large')); else chunks.push(chunk); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }); }
        catch { resolve({ status: 502, body: { ok: false, error: { code: 'INTERNAL', message: 'invalid gateway response' } } }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 503, body: { ok: false, error: { code: 'VIEWER_UNREACHABLE', message: 'gateway request failed' } } }));
    if (payload) req.write(payload);
    req.end();
  });
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = 0;
lines.on('line', async (line) => {
  let request;
  try {
    if (Buffer.byteLength(line) > MAX_REQUEST) throw new Error('too large');
    request = JSON.parse(line);
  } catch { return; }
  const id = typeof request?.id === 'string' ? request.id.slice(0, 80) : null;
  if (!id) return;
  const respond = (status, body) => process.stdout.write(`${JSON.stringify({ id, status, body })}\n`);
  if (!['GET', 'POST'].includes(request.method) || typeof request.path !== 'string' || !PATH.test(request.path)) {
    respond(400, { ok: false, error: { code: 'ACCESS_REVOKED', message: 'request rejected' } }); return;
  }
  if (pending >= 8) { respond(429, { ok: false, error: { code: 'CONTROL_BUSY', message: 'too many requests' } }); return; }
  pending += 1;
  try { const result = await forward(request); respond(result.status, result.body); } finally { pending -= 1; }
});
lines.on('close', () => process.exit(0));
