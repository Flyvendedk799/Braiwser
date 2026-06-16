// Tiny dependency-free JSON store. Two primitives:
//   • JsonCollection — an array of documents with id-based CRUD
//   • JsonDocument   — a single object (settings, secrets)
// Writes are atomic (write to .tmp, then rename) so a crash mid-write can't
// corrupt the file. An in-memory cache keeps reads cheap.
const fs = require('fs');
const path = require('path');

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

class JsonCollection {
  constructor(dir, name) {
    this.file = path.join(dir, name + '.json');
    this._cache = null;
  }
  _load() {
    if (this._cache) return this._cache;
    try {
      this._cache = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(this._cache)) this._cache = [];
    } catch {
      this._cache = [];
    }
    return this._cache;
  }
  _save() { atomicWrite(this.file, this._cache); }

  all() { return this._load().slice(); }
  find(pred) { return this._load().filter(pred); }
  get(id) { return this._load().find((x) => x.id === id) || null; }
  insert(doc) { this._load().push(doc); this._save(); return doc; }
  update(id, patch) {
    const list = this._load();
    const i = list.findIndex((x) => x.id === id);
    if (i === -1) return null;
    list[i] = { ...list[i], ...patch };
    this._save();
    return list[i];
  }
  remove(id) {
    const list = this._load();
    const i = list.findIndex((x) => x.id === id);
    if (i === -1) return false;
    list.splice(i, 1);
    this._save();
    return true;
  }
  removeWhere(pred) {
    this._cache = this._load().filter((x) => !pred(x));
    this._save();
  }
}

class JsonDocument {
  constructor(dir, name, defaults = {}) {
    this.file = path.join(dir, name + '.json');
    this.defaults = defaults;
    this._d = null;
  }
  data() {
    if (this._d) return this._d;
    try {
      this._d = { ...this.defaults, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch {
      this._d = { ...this.defaults };
    }
    return this._d;
  }
  _save() { atomicWrite(this.file, this._d); }
  merge(patch) { this._d = { ...this.data(), ...patch }; this._save(); return this._d; }
  set(k, v) { this.data()[k] = v; this._save(); return this._d; }
  unset(k) { delete this.data()[k]; this._save(); return this._d; }
}

module.exports = { JsonCollection, JsonDocument };
