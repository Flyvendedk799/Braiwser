// Turn a captured element (markup + the CSS that applies to it + its assets)
// into something you can open on its own:
//   • a single .html file, with every asset inlined as a data: URI — when it is
//     small enough to stay one file;
//   • a .zip (index.html / styles.css / assets/ / element.json / README.md) when
//     it carries real assets.
//
// Assets are fetched here rather than in the page: the main process has the
// session's cookies and no CORS to argue with.
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

async function fetchAssets(assets, log) {
  const { net } = require('electron');
  const out = [];
  let total = 0;
  for (let i = 0; i < assets.length && i < MAX_ASSETS; i++) {
    const a = assets[i];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await net.fetch(a.url, { signal: ctrl.signal, credentials: 'include' });
      clearTimeout(timer);
      if (!res.ok) {
        log.push('skipped ' + a.url + ' (HTTP ' + res.status + ')');
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_ASSET_BYTES) {
        log.push('skipped ' + a.url + ' (' + Math.round(buf.length / 1024) + ' KB, over the per-asset limit)');
        continue;
      }
      if (total + buf.length > MAX_TOTAL_BYTES) {
        log.push('skipped ' + a.url + ' (bundle size limit reached)');
        continue;
      }
      total += buf.length;
      out.push({ ...a, buf, mime: mimeFor(a.url, res.headers.get('content-type')), name: safeName(a.url, out.length) });
    } catch (err) {
      log.push('could not fetch ' + a.url + ' (' + ((err && err.message) || 'error') + ')');
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

function htmlDocument({ meta, css, context, surface, body }) {
  const title = meta.label + ' — ' + (meta.pageTitle || meta.sourceUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<!--
  ${escapeHtml(meta.label)} captured from ${escapeHtml(meta.sourceUrl)}
  ${meta.capturedAt} · ${meta.nodeCount} nodes · ${meta.box.w}×${meta.box.h}
  CSS capture mode: ${meta.mode}${meta.blockedSheets ? ' (' + meta.blockedSheets + ' stylesheet(s) unreadable — cross-origin)' : ''}
-->
<style>
/* The page's own surface and inherited typography, so the piece looks like it
   did in place rather than like unstyled markup. */
html { ${surface} }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 40px;
  ${context}
}
${css}
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
async function buildElementBundle(payload, format) {
  if (!payload || !payload.html) throw new Error('Nothing was captured for that element');
  const meta = payload.meta || {};
  const warnings = [];
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const { fetched, total } = assets.length ? await fetchAssets(assets, warnings) : { fetched: [], total: 0 };

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

module.exports = { buildElementBundle };
