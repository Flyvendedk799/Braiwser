'use strict';
const { z } = require('zod');

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/, 'Invalid identifier');

// Typed, classified failure the registry and MCP adapter can map to a public
// error without leaking stacks. `details` is bounded structured context.
class RegistryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    this.details = details;
  }
}

module.exports = { id, RegistryError };
