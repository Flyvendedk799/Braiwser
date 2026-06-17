// Shared text helpers for exporters.

// Truncate to `max` chars with an ellipsis. Identical behaviour previously
// duplicated in the markdown and prompt exporters.
function truncate(str, max) {
  const s = String(str == null ? '' : str);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

module.exports = { truncate };
