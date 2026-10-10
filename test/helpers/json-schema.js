'use strict';
// A deliberately small JSON-Schema validator for the keywords the published
// Braiwser schemas use (no dependency). It FAILS on any keyword it does not
// implement, so a schema can't silently grow constraints the tests don't check.
//
//   type (string | string[]), const, enum, required, properties, items,
//   anyOf, minimum, maximum, minLength, maxLength, maxItems, minItems
//   + annotation keywords: $schema $id title description
//
// validate(schema, value) -> string[] of "path: problem" (empty => valid)

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description']);
const IMPLEMENTED = new Set(['type', 'const', 'enum', 'required', 'properties', 'items', 'anyOf', 'minimum', 'maximum',
  'minLength', 'maxLength', 'maxItems', 'minItems']);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want, v) {
  const t = typeOf(v);
  return t === want || (want === 'number' && t === 'integer');
}

function check(schema, value, path, errors) {
  for (const key of Object.keys(schema)) {
    if (!IMPLEMENTED.has(key) && !ANNOTATIONS.has(key)) throw new Error(`validator does not implement "${key}" at ${path || '(root)'}`);
  }
  const at = path || '(root)';
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) { errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(value)}`); return; }
  }
  if ('const' in schema && value !== schema.const) errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required || []) if (!(r in value)) errors.push(`${at}: missing required "${r}"`);
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in value) check(sub, value[k], path ? `${path}.${k}` : k, errors);
    }
  }
  if (schema.anyOf) {
    const results = schema.anyOf.map((sub) => { const e = []; check(sub, value, path, e); return e; });
    if (!results.some((e) => e.length === 0)) errors.push(`${at}: matches none of anyOf (${results.map((e) => e[0]).join(' / ')})`);
  }
}

function validate(schema, value) {
  const errors = [];
  check(schema, value, '', errors);
  return errors;
}

module.exports = { validate };
