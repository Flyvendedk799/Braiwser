// Address-bar text -> navigable URL. Pure (no DOM, no window) so the rules are
// unit-testable and shared by the toolbar, the sidebar and Open File/Folder.
//
// Handles: full URLs, about:/data:/blob:/view-source:, Windows drive paths
// (C:\site\index.html), UNC paths (\\server\share\x.html), POSIX absolute
// paths, file: URLs, localhost / loopback / LAN hosts with ports
// (localhost:3000, 127.0.0.1:8080, [::1]:5173), bare domains and search text.

const SCHEME_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i;
const OPAQUE_SCHEME = /^(about|data|blob|view-source|file):/i;
const WINDOWS_DRIVE = /^[a-zA-Z]:([\\/]|$)/;
const UNC = /^(\\\\|\/\/)[^\\/]/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// Encode one path segment for a file: URL without mangling Unicode meaning:
// escape what URL syntax reserves, let encodeURIComponent handle the rest.
function encodeSegment(seg) {
  return encodeURIComponent(seg).replace(/%3A/gi, ':');
}

// A filesystem path -> file: URL. Accepts Windows drive, UNC and POSIX paths.
export function pathToFileUrl(p) {
  const raw = String(p || '');
  if (!raw) return '';
  if (UNC.test(raw)) {
    const parts = raw.replace(/^[\\/]{2}/, '').split(/[\\/]+/).filter((s, i) => i === 0 || s !== '');
    const host = parts.shift();
    return 'file://' + host + (parts.length ? '/' + parts.map(encodeSegment).join('/') : '/');
  }
  if (WINDOWS_DRIVE.test(raw)) {
    const drive = raw.slice(0, 2);
    const rest = raw.slice(2).split(/[\\/]+/).filter(Boolean);
    return 'file:///' + drive + (rest.length ? '/' + rest.map(encodeSegment).join('/') : '/');
  }
  const segs = raw.split(/[\\/]+/).filter(Boolean);
  return 'file:///' + segs.map(encodeSegment).join('/');
}

// The directory that contains a file path (either separator style). Returns
// the path itself for a root.
export function dirnameOf(p) {
  const raw = String(p || '');
  const trimmed = raw.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  if (i < 0) return raw;
  if (i === 0) return trimmed.slice(0, 1);
  if (i === 2 && /^[a-zA-Z]:$/.test(trimmed.slice(0, 2))) return trimmed.slice(0, 3);
  return trimmed.slice(0, i);
}

// host or host:port is a "local" target that speaks plain http.
function isLocalHost(host) {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '[::1]' || h.startsWith('[')) return true;
  if (IPV4.test(h)) return true;
  return false;
}

// Split "host[:port][/path?query#hash]" without assuming a scheme.
function splitHostPort(value) {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^\s/?#:]+)(?::(\d{1,5}))?([/?#].*)?$/.exec(value);
  if (!m) return null;
  return { host: m[1], port: m[2] || '', rest: m[3] || '' };
}

export function resolveAddress(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return '';

  // Windows drive path / UNC path must win over scheme detection (C:\ is not a scheme).
  if (WINDOWS_DRIVE.test(v) || UNC.test(v)) return pathToFileUrl(v);

  if (SCHEME_SLASHES.test(v)) return v;
  if (OPAQUE_SCHEME.test(v)) {
    // file:C:\x or file:/C:/x -> canonical file URL; the rest pass through.
    if (/^file:/i.test(v) && !/^file:\/\//i.test(v)) {
      const tail = v.slice(5).replace(/^\/+(?=[a-zA-Z]:)/, '');
      return pathToFileUrl(tail);
    }
    return v;
  }
  if (v.startsWith('/')) return pathToFileUrl(v);

  if (/\s/.test(v)) return searchUrl(v);

  // localhost / loopback / LAN hosts, with or without a port: plain http.
  const hp = splitHostPort(v);
  if (hp) {
    if (isLocalHost(hp.host)) return 'http://' + v;
    // host:port with a numeric port is an address, not a search ("myserver:8080").
    if (hp.port) return (hp.host.includes('.') ? 'https://' : 'http://') + v;
  }
  // bare domain: has a dot and a plausible suffix
  if (/^[^\s]+\.[^\s/?#:]{2,}(:\d{1,5})?([/?#].*)?$/.test(v)) return 'https://' + v;
  return searchUrl(v);
}

function searchUrl(text) {
  return 'https://www.google.com/search?q=' + encodeURIComponent(text);
}

// ---- Open File / Open Folder -> project location (MB-01) ---------------------
export function basenameOf(p) {
  if (!p) return 'Project';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

// Normalise the result of fs.openFile / fs.openDirectory into the project
// location the store expects: `path` is ALWAYS a directory (the agent hand-off
// writes into it and runs there), `entry` is the page that was actually opened.
//   kind 'file':   { path: <dir of file>, entry: <file>, name: <file name> }
//   kind 'folder': { path: <dir>, entry: <index html or undefined>, name: <dir name> }
export function localTarget(kind, res) {
  if (!res || !res.path) return null;
  if (kind === 'file') {
    return { name: basenameOf(res.path), path: dirnameOf(res.path), entry: res.path };
  }
  return { name: basenameOf(res.path), path: res.path, entry: res.entry || undefined };
}

// Does an existing project already represent this target? Legacy file projects
// stored the file itself in `path`; accept those too so they are not duplicated.
export function matchesLocalTarget(project, target) {
  if (!project || !target) return false;
  const same = (a, b) => String(a || '').replace(/[\\/]+$/, '') === String(b || '').replace(/[\\/]+$/, '');
  if (target.entry) {
    if (project.entry) return same(project.entry, target.entry);
    return same(project.path, target.entry) || (same(project.path, target.path) && !project.entry);
  }
  return same(project.path, target.path) && !project.entry;
}
