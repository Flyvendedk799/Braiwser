// Tiny dependency-free JSON store. Two primitives:
//   • JsonCollection — an array of documents with id-based CRUD
//   • JsonDocument   — a single object (settings, secrets)
//
// Durability / integrity contract (audit MB-03/04/05):
//   • Writes are atomic: unique temp file → fsync → rename. The previous good
//     generation is kept as `<name>.json.bak` (hard-linked, so it costs nothing).
//   • Copy-on-write: every mutation is staged on a COPY, persisted, and only
//     then published to the in-memory cache. A failed write leaves the disk and
//     every later read exactly as they were; a rejected mutation can never be
//     resurrected by a later successful write.
//   • Compound operations (`transact`) stage several files, persist them in
//     order and restore the already-written ones if a later one fails.
//   • Only ENOENT means "new store". An unreadable or corrupt/wrong-shaped file
//     is NEVER overwritten: the store enters a read-only recovery state
//     (`status()`), reads fall back to the last-good backup (or empty), writes
//     throw a StoreError, and `recover()` quarantines the bad file explicitly.
//   • Revision check: the file's identity (mtime/size/inode) is compared to what
//     this process last read or wrote on every access. If another process
//     changed it, we reload before applying our mutation, so a second writer
//     cannot silently lose committed records (the app also holds Electron's
//     single-instance lock; this is the belt to that braces).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class StoreError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = code; // STORE_READ_ONLY | STORE_WRITE_FAILED | STORE_CONFLICT | STORE_CORRUPT | STORE_UNREADABLE
    Object.assign(this, extra);
  }
  // Plain, IPC-safe description (Electron only forwards `message` across
  // ipcMain.handle rejections, so the code is embedded in it too).
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, file: this.file };
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_e) { /* best effort */ }
}

// Windows can transiently refuse a rename (AV scanners, indexers).
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
function renameWithRetry(fsx, from, to) {
  let attempt = 0;
  for (;;) {
    try {
      fsx.renameSync(from, to);
      return;
    } catch (err) {
      attempt += 1;
      if (attempt >= 4 || !RETRY_CODES.has(err && err.code)) throw err;
      sleepSync(15 * attempt);
    }
  }
}

function tmpName(file) {
  return `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

// Standalone atomic write (used by schema/meta). Throws a StoreError.
function atomicWriteFile(file, data, fsx = fs) {
  const tmp = tmpName(file);
  let fd;
  try {
    fd = fsx.openSync(tmp, 'wx');
    fsx.writeFileSync(fd, JSON.stringify(data, null, 2));
    fsx.fsyncSync(fd); // flush to disk before the rename so a crash can't tear it
    fsx.closeSync(fd);
    fd = undefined;
    renameWithRetry(fsx, tmp, file);
  } catch (err) {
    try { if (fd !== undefined) fsx.closeSync(fd); } catch (_e) { /* ignore */ }
    try { fsx.unlinkSync(tmp); } catch (_e) { /* ignore */ }
    throw new StoreError('STORE_WRITE_FAILED', `Failed to persist ${path.basename(file)}: ${err.message}`, { file, cause: err });
  }
}

// Remove temp files abandoned by a crashed writer (older than `maxAgeMs`).
function cleanupStaleTmp(dir, maxAgeMs = 60 * 1000, fsx = fs) {
  let removed = 0;
  try {
    for (const name of fsx.readdirSync(dir)) {
      if (!/\.json(?:\.[0-9a-f]+)?\.[0-9a-f]+\.tmp$/.test(name) && !/\.json\.tmp$/.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (Date.now() - fsx.statSync(full).mtimeMs > maxAgeMs) { fsx.unlinkSync(full); removed += 1; }
      } catch (_e) { /* ignore */ }
    }
  } catch (_e) { /* ignore */ }
  return removed;
}

// ---------------------------------------------------------------- base file
class JsonFile {
  constructor(dir, name, opts = {}) {
    this.dir = dir;
    this.name = name;
    this.file = path.join(dir, name + '.json');
    this.bakFile = this.file + '.bak';
    this.fs = opts.fs || fs;
    this._cache = null; // published, immutable-by-convention state
    this._sig = undefined; // file identity at last read/write ('absent' if none)
    this._state = { status: 'ok' };
    this.externalChanges = 0; // times another writer changed the file under us
  }

  // --- hooks for subclasses -------------------------------------------------
  _empty() { throw new Error('abstract'); }
  _validate(_parsed) { throw new Error('abstract'); }
  _fromParsed(parsed) { return parsed; }

  // --- file identity --------------------------------------------------------
  _stat() {
    try {
      const st = this.fs.statSync(this.file);
      return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch (err) {
      if (err && err.code === 'ENOENT') return 'absent';
      throw err;
    }
  }

  _readParsed(file) {
    const text = this.fs.readFileSync(file, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const e = new Error(`invalid JSON (${err.message})`);
      e.code = 'EJSONPARSE';
      throw e;
    }
    const problem = this._validate(parsed);
    if (problem) {
      const e = new Error(problem);
      e.code = 'ESHAPE';
      throw e;
    }
    return parsed;
  }

  // Loads (or refreshes) the cache. Never throws for read problems: it records
  // them in `_state` instead and falls back to a safe read value.
  _load() {
    let sig;
    try {
      sig = this._stat();
    } catch (err) {
      return this._enterUnreadable(err);
    }
    if (this._cache !== null && sig === this._sig) return this._cache;
    if (this._cache !== null && this._sig !== undefined) this.externalChanges += 1;

    if (sig === 'absent') {
      this._cache = this._empty();
      this._sig = sig;
      this._state = { status: 'ok' };
      return this._cache;
    }

    let parsed;
    try {
      parsed = this._readParsed(this.file);
    } catch (err) {
      if (err && (err.code === 'EJSONPARSE' || err.code === 'ESHAPE')) return this._enterCorrupt(err, sig);
      return this._enterUnreadable(err);
    }
    this._cache = this._fromParsed(parsed);
    this._sig = sig;
    this._state = { status: 'ok' };
    return this._cache;
  }

  _enterUnreadable(err) {
    // Transient errors must not poison the store: don't cache, so the next call
    // re-reads. Writes are blocked while we can't see the real contents.
    this._state = {
      status: 'unreadable',
      error: { code: 'STORE_UNREADABLE', message: `${path.basename(this.file)} could not be read: ${err.message}`, errno: err.code },
    };
    this._sig = undefined;
    return this._cache !== null ? this._cache : this._empty();
  }

  _enterCorrupt(err, sig) {
    let fromBackup = null;
    try { fromBackup = this._fromParsed(this._readParsed(this.bakFile)); } catch (_e) { /* no usable backup */ }
    this._state = {
      status: 'corrupt',
      backupAvailable: fromBackup !== null,
      error: { code: 'STORE_CORRUPT', message: `${path.basename(this.file)} is damaged: ${err.message}` },
    };
    this._cache = fromBackup !== null ? fromBackup : this._empty();
    this._sig = sig; // the damaged file's identity; a later fix re-triggers load
    return this._cache;
  }

  // --- status ---------------------------------------------------------------
  status() {
    this._load();
    const s = this._state;
    return {
      name: this.name,
      file: this.file,
      ok: s.status === 'ok',
      state: s.status,
      readOnly: s.status !== 'ok',
      error: s.error || null,
      backupAvailable: s.status === 'corrupt' ? !!s.backupAvailable : this._hasBackup(),
      externalChanges: this.externalChanges,
    };
  }

  _hasBackup() {
    try { return this.fs.existsSync(this.bakFile); } catch (_e) { return false; }
  }

  _assertWritable() {
    this._load();
    if (this._state.status !== 'ok') {
      throw new StoreError(
        'STORE_READ_ONLY',
        `[STORE_READ_ONLY] Changes were not saved: ${this._state.error.message}. ` +
          'The original file has been kept untouched. Restore it or use recovery to continue.',
        { file: this.file, state: this._state.status }
      );
    }
  }

  // Explicit recovery. The damaged file is quarantined (renamed, never deleted).
  //   mode 'backup' (default when available): continue from the last-good backup
  //   mode 'empty': start this file fresh
  recover(mode) {
    this._load();
    if (this._state.status === 'ok') return { recovered: false, reason: 'already-ok' };
    if (this._state.status === 'unreadable') {
      // Nothing we can safely do: the file may be perfectly fine but locked.
      return { recovered: false, reason: 'unreadable', error: this._state.error };
    }
    const useBackup = (mode || (this._state.backupAvailable ? 'backup' : 'empty')) === 'backup';
    if (useBackup && !this._state.backupAvailable) {
      return { recovered: false, reason: 'no-backup' };
    }
    const next = useBackup ? this._cache : this._empty();
    const quarantine = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    this.fs.renameSync(this.file, quarantine);
    this._sig = 'absent';
    this._cache = this._empty();
    this._state = { status: 'ok' };
    this._write(next);
    this._cache = next;
    this._sig = this._stat();
    return { recovered: true, quarantined: quarantine, from: useBackup ? 'backup' : 'empty' };
  }

  // --- persistence ----------------------------------------------------------
  // Writes `next` to disk atomically. Does NOT touch the cache (callers publish
  // after every file of a transaction succeeded).
  _write(next, { backup = true } = {}) {
    const fsx = this.fs;
    const current = this._stat(); // may throw → caller treats as write failure
    if (this._sig !== undefined && current !== this._sig) {
      throw new StoreError('STORE_CONFLICT', `${path.basename(this.file)} changed on disk while saving`, { file: this.file });
    }
    const tmp = tmpName(this.file);
    let fd;
    try {
      fd = fsx.openSync(tmp, 'wx');
      fsx.writeFileSync(fd, JSON.stringify(next, null, 2));
      fsx.fsyncSync(fd);
      fsx.closeSync(fd);
      fd = undefined;
      if (backup && current !== 'absent') this._rotateBackup();
      renameWithRetry(fsx, tmp, this.file);
    } catch (err) {
      try { if (fd !== undefined) fsx.closeSync(fd); } catch (_e) { /* ignore */ }
      try { fsx.unlinkSync(tmp); } catch (_e) { /* ignore */ }
      throw new StoreError('STORE_WRITE_FAILED', `Failed to persist ${path.basename(this.file)}: ${err.message}`, { file: this.file, cause: err });
    }
    if (process.platform !== 'win32') {
      try { const d = fsx.openSync(this.dir, 'r'); try { fsx.fsyncSync(d); } finally { fsx.closeSync(d); } } catch (_e) { /* best effort */ }
    }
    try { this._sig = this._stat(); } catch (_e) { this._sig = undefined; }
  }

  // Keep the generation we're about to replace. A hard link is instant and
  // leaves the old inode alive after the rename; fall back to a copy.
  _rotateBackup() {
    const fsx = this.fs;
    try { fsx.unlinkSync(this.bakFile); } catch (_e) { /* none yet */ }
    try {
      fsx.linkSync(this.file, this.bakFile);
    } catch (_e) {
      try { fsx.copyFileSync(this.file, this.bakFile); } catch (_e2) { /* backups are best effort */ }
    }
  }

  removeBackup() {
    try { this.fs.unlinkSync(this.bakFile); } catch (_e) { /* ignore */ }
  }

  // Run `fn(stage)` against a staged copy and commit it (single file).
  _tx(fn) { return transact([this], (tx) => fn(tx(this))); }
}

// ---------------------------------------------------------------- staging
class StagedCollection {
  constructor(store, base) {
    this.store = store;
    this.base = base;
    this.list = base.slice();
    this.dirty = false;
  }
  all() { return this.list.slice(); }
  find(pred) { return this.list.filter(pred); }
  get(id) { return this.list.find((x) => x.id === id) || null; }
  insert(doc) { this.list.push(doc); this.dirty = true; return doc; }
  insertMany(docs) { for (const d of docs) this.list.push(d); if (docs.length) this.dirty = true; return docs; }
  update(id, patch) {
    const i = this.list.findIndex((x) => x.id === id);
    if (i === -1) return null;
    this.list[i] = { ...this.list[i], ...patch };
    this.dirty = true;
    return this.list[i];
  }
  // patches: [{ id, patch }] — one pass, one write.
  updateMany(patches) {
    const index = new Map(this.list.map((x, i) => [x.id, i]));
    let n = 0;
    for (const { id, patch } of patches) {
      const i = index.get(id);
      if (i === undefined) continue;
      this.list[i] = { ...this.list[i], ...patch };
      n += 1;
    }
    if (n) this.dirty = true;
    return n;
  }
  replaceDoc(id, doc) {
    const i = this.list.findIndex((x) => x.id === id);
    if (i === -1) return null;
    this.list[i] = doc;
    this.dirty = true;
    return doc;
  }
  remove(id) {
    const i = this.list.findIndex((x) => x.id === id);
    if (i === -1) return false;
    this.list.splice(i, 1);
    this.dirty = true;
    return true;
  }
  removeWhere(pred) {
    const next = this.list.filter((x) => !pred(x));
    const removed = this.list.length - next.length;
    if (removed) { this.list = next; this.dirty = true; }
    return removed;
  }
  replaceAll(list) { this.list = list.slice(); this.dirty = true; }
  _next() { return this.list; }
}

class StagedDocument {
  constructor(store, base) {
    this.store = store;
    this.base = base;
    this.d = { ...base };
    this.dirty = false;
  }
  data() { return this.d; }
  merge(patch) { this.d = { ...this.d, ...patch }; this.dirty = true; return this.d; }
  set(k, v) { this.d = { ...this.d, [k]: v }; this.dirty = true; return this.d; }
  unset(k) { const { [k]: _gone, ...rest } = this.d; this.d = rest; this.dirty = true; return this.d; }
  _next() { return this.d; }
}

// Stage several stores, run `fn(tx)` (synchronous), then persist every dirty
// one in order. If a later write fails, the earlier ones are restored and the
// caches stay untouched, so the visible state never diverges from the disk.
// A concurrent external writer is detected before the first byte is written and
// the whole function is simply re-run against the fresh state.
function transact(stores, fn) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const staged = new Map();
    for (const s of stores) {
      s._assertWritable();
      const base = s._load();
      staged.set(s, s instanceof JsonDocument ? new StagedDocument(s, base) : new StagedCollection(s, base));
    }
    const tx = (store) => {
      const st = staged.get(store);
      if (!st) throw new Error('store not part of this transaction');
      return st;
    };
    const result = fn(tx);

    const dirty = [...staged.values()].filter((st) => st.dirty);
    const done = [];
    try {
      for (const st of dirty) {
        st.store._write(st._next());
        done.push(st);
      }
    } catch (err) {
      // Roll back files that were already replaced.
      let rollbackFailed = false;
      for (const st of done.reverse()) {
        try {
          st.store._sig = st.store._stat();
          st.store._write(st.base, { backup: false });
        } catch (_e) {
          rollbackFailed = true;
          st.store._sig = undefined;
          st.store._cache = null; // force a reload from whatever is on disk
        }
      }
      if (err instanceof StoreError && err.code === 'STORE_CONFLICT' && done.length === 0) {
        lastErr = err;
        for (const st of staged.values()) { st.store._cache = null; st.store._sig = undefined; }
        continue; // re-run against fresh state
      }
      if (rollbackFailed && err instanceof StoreError) err.message += ' (rollback of earlier files also failed; state will be reloaded from disk)';
      throw err;
    }
    for (const st of dirty) st.store._cache = st._next();
    return result;
  }
  throw lastErr;
}

// ---------------------------------------------------------------- collection
class JsonCollection extends JsonFile {
  _empty() { return []; }
  _validate(parsed) {
    if (!Array.isArray(parsed)) return 'expected a JSON array';
    const bad = parsed.findIndex((x) => !isPlainObject(x));
    if (bad !== -1) return `entry ${bad} is not an object`;
    return null;
  }

  all() { return this._load().slice(); }
  find(pred) { return this._load().filter(pred); }
  get(id) { return this._load().find((x) => x.id === id) || null; }
  insert(doc) { return this._tx((s) => s.insert(doc)); }
  insertMany(docs) { return this._tx((s) => s.insertMany(docs)); }
  update(id, patch) { return this._tx((s) => s.update(id, patch)); }
  updateMany(patches) { return this._tx((s) => s.updateMany(patches)); }
  replaceDoc(id, doc) { return this._tx((s) => s.replaceDoc(id, doc)); }
  remove(id) { return this._tx((s) => s.remove(id)); }
  removeWhere(pred) { return this._tx((s) => s.removeWhere(pred)); }
  // Replace the whole collection (one write). Optionally without a backup so a
  // scrubbed file doesn't leave its un-scrubbed predecessor lying around.
  replaceAll(list, { backup = true } = {}) {
    this._assertWritable();
    this._load();
    const next = list.slice();
    this._write(next, { backup });
    if (!backup) this.removeBackup();
    this._cache = next;
  }
}

// ------------------------------------------------------------------ document
class JsonDocument extends JsonFile {
  constructor(dir, name, defaults = {}, opts = {}) {
    super(dir, name, opts);
    this.defaults = defaults;
  }
  _empty() { return { ...this.defaults }; }
  _validate(parsed) { return isPlainObject(parsed) ? null : 'expected a JSON object'; }
  _fromParsed(parsed) { return { ...this.defaults, ...parsed }; }

  data() { return this._load(); }
  merge(patch) { return this._tx((s) => s.merge(patch)); }
  set(k, v) { return this._tx((s) => s.set(k, v)); }
  unset(k) { return this._tx((s) => s.unset(k)); }
}

module.exports = { JsonCollection, JsonDocument, JsonFile, StoreError, atomicWriteFile, cleanupStaleTmp, transact };
