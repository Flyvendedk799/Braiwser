// Turn a captured element (markup + the CSS that applies to it + its assets)
// into something you can open on its own:
//   • a single .html file, with every asset inlined as a data: URI — when it is
//     small enough to stay one file;
//   • a .zip (index.html / styles.css / assets/ / element.json / README.md) when
//     it carries real assets.
//
// Assets are fetched here rather than in the page (no CORS to argue with) - but
// with NO credentials, only over http(s), and never into the private network
// (see "safe asset fetching" below).
const zlib = require('zlib');

const MAX_ASSETS = 40;
const MAX_ASSET_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_BYTES = 14 * 1024 * 1024;
const INLINE_BUDGET = 1.5 * 1024 * 1024; // beyond this a single file stops being sane
const FETCH_TIMEOUT_MS = 8000;

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', json: 'application/json', css: 'text/css',
};

function extOf(url) {
  try {
    const p = new URL(url).pathname;
    const m = /\.([a-z0-9]+)$/i.exec(p);
    return m ? m[1].toLowerCase() : '';
  } catch (_e) {
    return '';
  }
}

function mimeFor(url, headerType) {
  if (headerType && headerType !== 'application/octet-stream') return String(headerType).split(';')[0].trim();
  return MIME[extOf(url)] || 'application/octet-stream';
}

function safeName(url, index) {
  let base = 'asset-' + index;
  try {
    const p = decodeURIComponent(new URL(url).pathname);
    const last = p.split('/').filter(Boolean).pop();
    if (last) base = last.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
  } catch (_e) {
    /* keep the fallback */
  }
  if (!/\.[a-z0-9]+$/i.test(base)) {
    const ext = extOf(url);
    if (ext) base += '.' + ext;
  }
  return index + '-' + base;
}

// ---- safe asset fetching ---------------------------------------------------------
// The page that supplied the asset list is untrusted: every URL is validated here, in
// the privileged main process, before anything is requested.
//   - only http(s) is fetched; data: URIs are decoded locally; file:, ftp:, blob:,
//     javascript: and every other scheme is refused;
//   - no credentials, cookies or auth are forwarded (credentials: 'omit');
//   - redirects are followed manually (max MAX_REDIRECTS), each hop re-validated;
//   - private / loopback / link-local / metadata targets are refused unless they are
//     the very host the captured page was served from (reviewing a local dev server
//     must keep working) - link-local is refused even then;
//   - one deadline covers headers AND the body read; the body is streamed with
//     cumulative per-asset and total byte limits and cancelled the moment one is hit.
const net = require('net');
const dns = require('dns');

const MAX_REDIRECTS = 5;
const TOTAL_DEADLINE_MS = 60000;
const PRIVATE_SUFFIXES = ['.local', '.localdomain', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];

function ipv4Class(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'invalid';
  const [a, b] = p;
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'linklocal';
  if (a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0 && p[2] === 0) || (a === 198 && (b === 18 || b === 19))) return 'private';
  if (a >= 224) return 'private'; // multicast, reserved, broadcast
  return 'public';
}

function expandIpv6(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // an embedded dotted quad (::ffff:1.2.3.4) becomes two hextets
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const q = m[2].split('.').map(Number);
    if (q.length !== 4 || q.some((n) => n > 255)) return null;
    s = m[1] + ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = head.concat(new Array(fill).fill('0'), tail).map((h) => parseInt(h || '0', 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function ipClass(ip) {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Class(ip);
  if (v !== 6) return 'invalid';
  const g = expandIpv6(ip);
  if (!g) return 'invalid';
  if (g.every((x, i) => (i === 7 ? x === 1 : x === 0))) return 'loopback';
  if (g.every((x) => x === 0)) return 'private';
  // IPv4-mapped / compatible: classify the embedded address
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    return ipv4Class([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.'));
  }
  if ((g[0] & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return 'linklocal';
  if ((g[0] & 0xff00) === 0xff00) return 'private'; // multicast
  return 'public';
}

function hostnameClass(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!h) return 'invalid';
  if (net.isIP(h)) return ipClass(h);
  if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
  if (!h.includes('.') || PRIVATE_SUFFIXES.some((s) => h.endsWith(s))) return 'private';
  return null; // a public-looking name: resolve it and classify the addresses
}

function pageHostOf(sourceUrl) {
  try { return new URL(sourceUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch (_e) { return ''; }
}

async function defaultResolve(hostname) {
  const list = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return list.map((x) => x.address);
}

// Throws Error(reason) when the target may not be requested.
async function assertFetchableTarget(urlString, { pageHost = '', resolveHost = defaultResolve } = {}) {
  let u;
  try { u = new URL(urlString); } catch (_e) { throw new Error('not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`scheme ${u.protocol} is not allowed`);
  if (u.username || u.password) throw new Error('URLs with embedded credentials are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  let cls = hostnameClass(host);
  if (cls === 'invalid') throw new Error('invalid host');
  if (cls === null) {
    let addrs;
    try { addrs = await resolveHost(host); } catch (_e) { throw new Error('host could not be resolved'); }
    if (!Array.isArray(addrs) || !addrs.length) throw new Error('host could not be resolved');
    const classes = addrs.map(ipClass);
    cls = classes.includes('linklocal') ? 'linklocal' : classes.find((c) => c !== 'public') || 'public';
  }
  if (cls === 'public') return u;
  if (cls === 'linklocal') throw new Error('link-local / metadata addresses are blocked');
  if (host === pageHost) return u; // the dev server the page itself came from
  throw new Error('private-network target is blocked');
}

// A promise that rejects as soon as `signal` aborts (reads on a stalled stream never
// settle by themselves).
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error('timed out'));
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(new Error('timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

class LimitError extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}

// Stream the body, enforcing `limit` bytes cumulatively. Cancels the reader at the limit.
async function readBounded(res, limit, signal) {
  const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new LimitError('limit');
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await abortable(res.arrayBuffer(), signal));
    if (buf.length > limit) throw new LimitError('limit');
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      const chunk = Buffer.from(value.buffer ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value);
      size += chunk.length;
      if (size > limit) throw new LimitError('limit');
      chunks.push(chunk);
    }
  } catch (err) {
    try { await Promise.race([reader.cancel(), new Promise((r) => setTimeout(r, 250))]); } catch (_e) { /* best effort */ }
    throw err;
  }
  return Buffer.concat(chunks, size);
}

function decodeDataUri(uri, limit) {
  const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(uri);
  if (!m) throw new Error('malformed data: URI');
  if (m[3].length > limit * 2) throw new LimitError('limit');
  let buf;
  try {
    buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  } catch (_e) {
    throw new Error('malformed data: URI');
  }
  if (buf.length > limit) throw new LimitError('limit');
  return { buf, mime: (m[1] || 'text/plain').split(';')[0].trim() || 'text/plain' };
}

function cancelBody(res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') {
      const p = res.body.cancel();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (_e) { /* ignore */ }
}

// Fetch one http(s) asset: manual redirects, validated hops, one deadline over everything.
async function fetchOne(url, { fetchImpl, pageHost, resolveHost, limit, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res = null;
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      await abortable(assertFetchableTarget(current, { pageHost, resolveHost }), ctrl.signal);
      res = await abortable(Promise.resolve(fetchImpl(current, {
        signal: ctrl.signal,
        credentials: 'omit',
        redirect: 'manual',
        bypassCustomProtocolHandlers: true,
        headers: { accept: '*/*' },
      })), ctrl.signal);
      const redirected = res.status >= 300 && res.status < 400;
      if (!redirected && res.type !== 'opaqueredirect') break;
      const location = redirected && res.headers && res.headers.get ? res.headers.get('location') : null;
      cancelBody(res);
      if (!location) throw new Error('redirect could not be validated');
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
      current = new URL(location, current).href;
    }
    if (!res.ok) {
      cancelBody(res);
      const err = new Error('HTTP ' + res.status);
      err.http = true;
      throw err;
    }
    const buf = await readBounded(res, limit, ctrl.signal);
    return { buf, mime: res.headers && res.headers.get ? res.headers.get('content-type') : '' };
  } finally {
    clearTimeout(timer);
    // Anything still running (a body that never ended, a pending request) stops here.
    ctrl.abort();
  }
}

// deps (all optional, for tests): { fetchImpl, now, timeoutMs, sourceUrl, resolveHost }
async function fetchAssets(assets, log, deps = {}) {
  const fetchImpl = deps.fetchImpl || ((u, o) => require('electron').net.fetch(u, o));
  const now = deps.now || Date.now;
  const timeoutMs = deps.timeoutMs || FETCH_TIMEOUT_MS;
  const pageHost = pageHostOf(deps.sourceUrl);
  const resolveHost = deps.resolveHost || defaultResolve;
  const startedAt = now();
  const out = [];
  let total = 0;
  for (let i = 0; i < assets.length && i < MAX_ASSETS; i++) {
    const a = assets[i];
    if (!a || typeof a.url !== 'string' || typeof a.token !== 'string') {
      log.push('skipped a malformed asset entry');
      continue;
    }
    if (now() - startedAt > TOTAL_DEADLINE_MS) {
      log.push('skipped ' + a.url + ' (export time limit reached)');
      continue;
    }
    // The per-asset limit, tightened by whatever budget the bundle has left.
    const limit = Math.min(MAX_ASSET_BYTES, MAX_TOTAL_BYTES - total);
    try {
      let got;
      if (/^data:/i.test(a.url)) {
        got = decodeDataUri(a.url, limit);
      } else {
        got = await fetchOne(a.url, { fetchImpl, pageHost, resolveHost, limit, timeoutMs });
        got.mime = mimeFor(a.url, got.mime);
      }
      total += got.buf.length;
      out.push({ ...a, buf: got.buf, mime: got.mime, name: safeName(a.url, out.length) });
    } catch (err) {
      if (err instanceof LimitError) {
        log.push('skipped ' + a.url + (limit < MAX_ASSET_BYTES ? ' (bundle size limit reached)' : ' (over the per-asset limit)'));
      } else if (err && err.http) {
        log.push('skipped ' + a.url + ' (' + err.message + ')');
      } else {
        log.push('could not fetch ' + a.url + ' (' + ((err && err.message) || 'error') + ')');
      }
    }
  }
  if (assets.length > MAX_ASSETS) log.push('only the first ' + MAX_ASSETS + ' assets were fetched');
  return { fetched: out, total };
}

function replaceTokens(text, fetched, resolve) {
  let out = String(text || '');
  for (const a of fetched) out = out.split(a.token).join(resolve(a));
  // Anything we could not fetch keeps pointing at the live site.
  return out;
}

function stripUnfetched(text, assets, fetched) {
  const got = new Set(fetched.map((a) => a.token));
  let out = String(text || '');
  for (const a of assets) if (!got.has(a.token)) out = out.split(a.token).join(a.url);
  return out;
}

// CSS text that came from the captured page must not be able to close the <style>
// element it is embedded in (or open an HTML comment) and smuggle markup out.
function cssSafe(text) {
  return String(text == null ? '' : text)
    .replace(/<\/(style)/gi, (_m, tag) => '<\\/' + tag)
    .replace(/<!--/g, () => '<\\!--');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Exports are inert reference documents: no scripts, no forms, no embedded frames,
// even if hostile markup survived capture. Styles and media may still load.
const EXPORT_CSP = "default-src 'none'; img-src data: file: http: https:; font-src data: file: http: https:; " +
  "media-src data: file: http: https:; style-src 'unsafe-inline' file: http: https:; base-uri 'none'; form-action 'none'";

function htmlDocument({ meta, css, context, surface, body }) {
  const title = meta.label + ' — ' + (meta.pageTitle || meta.sourceUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">
<title>${escapeHtml(title)}</title>
<!--
  ${escapeHtml(meta.label)} captured from ${escapeHtml(meta.sourceUrl)}
  ${escapeHtml(meta.capturedAt)} · ${num(meta.nodeCount)} nodes · ${num(meta.box && meta.box.w)}×${num(meta.box && meta.box.h)}
  CSS capture mode: ${escapeHtml(meta.mode)}${meta.blockedSheets ? ' (' + num(meta.blockedSheets) + ' stylesheet(s) unreadable — cross-origin)' : ''}
-->
<style>
/* The page's own surface and inherited typography, so the piece looks like it
   did in place rather than like unstyled markup. */
html { ${cssSafe(surface)} }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 40px;
  ${cssSafe(context)}
}
${cssSafe(css)}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function escapeHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function readme(meta, warnings) {
  return `# ${meta.label}

Captured from ${meta.sourceUrl}
${meta.capturedAt}

- Element: \`${meta.selector || meta.label}\`
- Rendered size: ${meta.box.w}×${meta.box.h}
- Nodes: ${meta.nodeCount}
- CSS capture: **${meta.mode}**${
    meta.mode === 'rules'
      ? ' — the page\'s own rules that match this element, including hover states, media queries, custom properties, @font-face and keyframes.'
      : ' — computed styles baked onto each node, because the page\'s stylesheets could not be read (cross-origin). Interaction states and media queries are NOT included.'
  }
${meta.blockedSheets ? '- ' + meta.blockedSheets + ' stylesheet(s) were unreadable (cross-origin).\n' : ''}
## Files

- \`index.html\` — open this
- \`styles.css\` — the captured CSS
- \`assets/\` — images and fonts it references
- \`element.json\` — the capture manifest

${warnings.length ? '## Warnings\n\n' + warnings.map((w) => '- ' + w).join('\n') + '\n' : ''}
> Captured for reference and iteration. Respect the source site's licence and
> trademarks before shipping any of it.
`;
}

// ---- a small store/deflate zip writer (no dependencies) ------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(chunks), centralBuf, end]);
}

// ---- entry point ----------------------------------------------------------------
// payload: what the guest collected. format: 'auto' | 'html' | 'zip'
// returns { kind:'html'|'zip', name, base64, meta, warnings }
async function buildElementBundle(payload, format, deps = {}) {
  if (!payload || !payload.html) throw new Error('Nothing was captured for that element');
  const meta = payload.meta || {};
  const warnings = [];
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const { fetched, total } = assets.length ? await fetchAssets(assets, warnings, { sourceUrl: meta.sourceUrl, ...deps }) : { fetched: [], total: 0 };

  const wantZip = format === 'zip' || (format !== 'html' && (fetched.length > 0 && total > INLINE_BUDGET));
  const slug = meta.slug || 'element';

  if (!wantZip) {
    // One file: assets ride along as data: URIs.
    const resolve = (a) => 'data:' + a.mime + ';base64,' + a.buf.toString('base64');
    const html = stripUnfetched(replaceTokens(payload.html, fetched, resolve), assets, fetched);
    const css = stripUnfetched(replaceTokens(payload.css, fetched, resolve), assets, fetched);
    const doc = htmlDocument({ meta, css, context: payload.context || '', surface: payload.surface || '', body: html });
    return {
      kind: 'html',
      name: slug + '.html',
      base64: Buffer.from(doc, 'utf8').toString('base64'),
      meta: { ...meta, assets: fetched.length, bytes: Buffer.byteLength(doc) },
      warnings,
    };
  }

  const resolve = (a) => 'assets/' + a.name;
  const html = stripUnfetched(replaceTokens(payload.html, fetched, resolve), assets, fetched);
  const css = stripUnfetched(replaceTokens(payload.css, fetched, resolve), assets, fetched);
  const doc = htmlDocument({ meta, css: '@import url("styles.css");', context: payload.context || '', surface: payload.surface || '', body: html });
  const manifest = {
    ...meta,
    assets: fetched.map((a) => ({ file: 'assets/' + a.name, from: a.url, kind: a.kind, bytes: a.buf.length })),
    warnings,
  };
  const files = [
    { name: 'index.html', data: doc },
    { name: 'styles.css', data: css },
    { name: 'element.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'README.md', data: readme(meta, warnings) },
  ].concat(fetched.map((a) => ({ name: 'assets/' + a.name, data: a.buf })));

  const buf = zip(files);
  return {
    kind: 'zip',
    name: slug + '.zip',
    base64: buf.toString('base64'),
    meta: { ...meta, assets: fetched.length, bytes: buf.length },
    warnings,
  };
}

module.exports = { buildElementBundle, fetchAssets, assertFetchableTarget, ipClass };
