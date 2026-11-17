// Braiwser — semantic-locator.js
// A durable, reviewable name for the element a recorded step touched:
//
//   { by: 'testId', value }            a developer-owned test id
//   { by: 'role', role, name }         an accessible role + accessible name
//
// This is the same closed vocabulary workflow plans use (workflow-core.js
// `target`), and it is computed with the SAME in-page probe the agent runtime
// observes with (probe.js `describe` / `assertFacts`). A locator recorded here
// therefore resolves at run time to exactly what the recorder saw, or the run
// refuses; nothing is guessed on either side.
//
// Honesty rules:
//   * A locator is returned only when it matches exactly ONE element in the
//     document at capture time. Two "Delete" buttons yield no locator, not the
//     first one.
//   * Action steps (click / input / key) must resolve to an element the runtime
//     can act on (kind 'interactable'). A click on a <span> inside a button is
//     recorded against the button; a click on a bare <div> gets no locator.
//   * Assertion targets may be any element with a test id, or any element with
//     a real (non-generic) role and a non-empty name.
//   * Names come from labels and attributes via the probe; field VALUES are
//     never read.

'use strict';

const probe = require('./probe');

const TEST_ID_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa'];
const MAX_LEN = 200; // workflow-core `short`
const MAX_CLIMB = 4;

function testIdOf(el) {
  for (const name of TEST_ID_ATTRS) {
    let v = null;
    try { v = el.getAttribute(name); } catch (_e) { v = null; }
    if (typeof v === 'string' && v && v.length <= MAX_LEN) return v;
  }
  return null;
}

function unique(target) {
  try {
    const facts = probe.run('assertFacts', { target });
    return !!facts && facts.matchCount === 1;
  } catch (_e) {
    return false;
  }
}

function describe(el) {
  try {
    return probe.run('describe', { el });
  } catch (_e) {
    return null;
  }
}

// One element, no climbing. `actionable` requires something the runtime can act on.
function locatorAt(el, actionable) {
  const d = describe(el);
  if (!d || !d.connected) return null;
  const interactable = d.kind === 'interactable';
  if (actionable && !interactable) return null;
  const testId = testIdOf(el);
  if (testId) {
    const t = { by: 'testId', value: testId };
    if (unique(t)) return t;
  }
  const role = typeof d.role === 'string' ? d.role : '';
  const name = typeof d.name === 'string' ? d.name.replace(/\s+/g, ' ').trim() : '';
  if (role && role !== 'generic' && name && name.length <= MAX_LEN && role.length <= MAX_LEN) {
    const t = { by: 'role', role, name };
    if (unique(t)) return t;
  }
  return null;
}

// locatorFor(el, { action })
//   action:true  - click / input / key: climbs to the nearest actionable ancestor
//   action:false - assertion target: the element itself only
// Returns a locator object or null. Never throws.
function locatorFor(el, opts) {
  const action = !opts || opts.action !== false;
  try {
    if (!el || el.nodeType !== 1) return null;
    let cur = el;
    for (let hop = 0; cur && cur.nodeType === 1 && hop <= (action ? MAX_CLIMB : 0); hop++) {
      const found = locatorAt(cur, action);
      if (found) return found;
      // An actionable element that could not be named uniquely ends the climb:
      // its ancestor would be a different control.
      if (action) {
        const d = describe(cur);
        if (d && d.connected && d.kind === 'interactable') return null;
      }
      cur = cur.parentElement;
    }
  } catch (_e) {
    /* a locator is optional; recording must never break the page */
  }
  return null;
}

module.exports = { locatorFor };
