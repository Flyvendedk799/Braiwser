// Shared environment flags. BRAIWSER_E2E is canonical; CAOS_E2E remains accepted
// during the rename alias period so older scripts and CI jobs keep working.
function isE2E() {
  return process.env.BRAIWSER_E2E === '1' || process.env.CAOS_E2E === '1';
}

module.exports = { isE2E };
