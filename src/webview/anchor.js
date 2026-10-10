// Braiwser — anchor.js
// Element identity & re-resolution utilities, shared by inspector/recorder/replay.
// Runs inside the guest page's world. Pure DOM, no IPC. Defensive everywhere.
//
// Identity rules (CE-12):
//   • An id is only used when it is unique in the element's tree. A duplicate id
//     never short-circuits the structural walk, on the target or any ancestor.
//   • Every selector cssPath() emits has been checked to resolve to exactly the
//     element it was built for; if no selector can be proven, it returns ''.
//   • resolve() never silently takes "the first of several" matches. Anything
//     that is not an exact, unique selector hit is a *suggestion*
//     (confidence:'suggested') and strict callers (replay, agents) ignore it.

'use strict';

const OVERLAY_Z = 2147483640;

// ---- robust CSS selector for an element ------------------------------------
// Test-friendly attributes preferred over brittle structural paths.
const STABLE_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'name', 'aria-label'];

// The tree a selector is evaluated in: the document, or the shadow root the
// element lives in.
function rootFor(el) {
  try {
    const r = el.getRootNode && el.getRootNode();
    if (r && typeof r.querySelectorAll === 'function') return r;
  } catch (_e) {
    /* ignore */
  }
  return document;
}

// True only if `selector` matches exactly one element in `el`'s tree and that
// element is `el`.
function resolvesUniquelyTo(selector, el) {
  try {
    const hits = rootFor(el).querySelectorAll(selector);
    return hits.length === 1 && hits[0] === el;
  } catch (_e) {
    return false; // invalid selector
  }
}

function typeIndex(node) {
  const parent = node.parentElement;
  if (!parent) return 0;
  const sameTag = Array.prototype.filter.call(parent.children, (c) => c.nodeName === node.nodeName);
  return sameTag.length > 1 ? sameTag.indexOf(node) + 1 : 0;
}

function childIndex(node) {
  const parent = node.parentElement;
  return parent ? Array.prototype.indexOf.call(parent.children, node) + 1 : 1;
}

function isUniqueId(node) {
  if (!node.id) return false;
  try {
    return rootFor(node).querySelectorAll('#' + cssEscape(node.id)).length === 1;
  } catch (_e) {
    return false;
  }
}

function cssPath(el) {
  try {
    if (!(el instanceof Element)) return '';
    // The document root and body have no ancestor chain to walk, and the loop
    // below stops before them — name them directly so page-level targets (audit
    // findings on <html>, say) still resolve and highlight.
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    const connected = el.isConnected !== false;
    // Accept a candidate only if it provably hits this element alone. A detached
    // element cannot be verified against the page, so its best-effort path is
    // returned as built.
    const accept = (sel) => (connected ? resolvesUniquelyTo(sel, el) : true);

    // Best path: a stable, test-oriented attribute that uniquely identifies it.
    for (const attr of STABLE_ATTRS) {
      const val = el.getAttribute && el.getAttribute(attr);
      if (!val) continue;
      const cand = `${el.nodeName.toLowerCase()}[${attr}="${cssEscapeAttr(val)}"]`;
      if (accept(cand)) return cand;
    }
    // Fast path: a stable id wins — but only when it really is unique.
    if (isUniqueId(el)) {
      const cand = '#' + cssEscape(el.id);
      if (accept(cand)) return cand;
    }

    // Structural path, anchored at the nearest ancestor with a unique id. A
    // duplicate id anywhere on the way is skipped and the walk continues.
    const parts = [];
    let node = el;
    while (
      node &&
      node.nodeType === 1 &&
      node !== document.body &&
      node !== document.documentElement
    ) {
      if (node !== el && isUniqueId(node)) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      let sel = node.nodeName.toLowerCase();
      const idx = typeIndex(node);
      if (idx) sel += ':nth-of-type(' + idx + ')';
      parts.unshift(sel);
      node = node.parentElement;
    }
    const path = parts.join(' > ');
    if (path && accept(path)) return path;

    // Last resort for oddities (namespaced nodes, odd markup): absolute
    // :nth-child chain from <html>, which is unique by construction.
    const abs = [];
    node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      abs.unshift(node.nodeName.toLowerCase() + ':nth-child(' + childIndex(node) + ')');
      node = node.parentElement;
    }
    if (node === document.documentElement) {
      const full = 'html > ' + abs.join(' > ');
      if (accept(full)) return full;
    }
    return connected ? '' : path;
  } catch (_e) {
    return '';
  }
}

function cssEscape(s) {
  try {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
  } catch (_e) {
    /* ignore */
  }
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

// Escape a value for use inside an [attr="..."] selector.
function cssEscapeAttr(s) {
  return String(s).replace(/(["\\])/g, '\\$1').replace(/\n/g, '\\a ');
}

// ---- describe an element into a portable target descriptor -----------------
function describe(el) {
  try {
    const r = el.getBoundingClientRect();
    let cs = {};
    try {
      cs = getComputedStyle(el);
    } catch (_e) {
      cs = {};
    }
    const text = ((el.innerText || el.textContent || '') + '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 120);
    const get = (name) => {
      try {
        return el.getAttribute ? el.getAttribute(name) : null;
      } catch (_e) {
        return null;
      }
    };
    return {
      selector: cssPath(el),
      tag: el.nodeName ? el.nodeName.toLowerCase() : '',
      id: el.id || null,
      classes: Array.prototype.slice.call(el.classList || []),
      text,
      attrs: {
        href: get('href'),
        src: get('src'),
        alt: get('alt'),
        role: get('role'),
        ariaLabel: get('aria-label'),
        testid: get('data-testid') || get('data-test') || get('data-cy') || get('data-qa'),
        name: get('name'),
      },
      box: {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      },
      style: {
        color: cs.color || '',
        background: cs.backgroundColor || '',
        font: cs.font || ((cs.fontSize || '') + ' ' + (cs.fontFamily || '')).trim(),
      },
    };
  } catch (_e) {
    return {
      selector: '',
      tag: '',
      id: null,
      classes: [],
      text: '',
      attrs: {},
      box: { x: 0, y: 0, w: 0, h: 0 },
      style: {},
    };
  }
}

// ---- re-resolve a stored target to a live Element --------------------------
function isOwn(el) {
  try {
    return !!(el && el.closest && el.closest('[data-caos], #__caos_root'));
  } catch (_e) {
    return false;
  }
}

function normText(el) {
  return ((el.innerText || el.textContent || '') + '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

// Result: { el, confidence, via, candidates, ambiguous }
//   confidence 'exact'     — the stored selector resolves to exactly one element
//   confidence 'suggested' — a best guess (text / coordinate / disambiguated
//                            selector); fine to *show*, never to act on unreviewed
//   el === null            — nothing trustworthy; `ambiguous` says several fit
function resolveDetailed(target) {
  const none = { el: null, confidence: null, via: null, candidates: 0, ambiguous: false };
  if (!target) return none;
  const wantedTag = target.tag ? String(target.tag).toLowerCase() : '';
  const wantedText = target.text ? String(target.text).trim().replace(/\s+/g, ' ') : '';
  let ambiguous = false;
  let candidates = 0;

  // 1) The stored selector.
  try {
    if (target.selector) {
      const hits = Array.prototype.filter.call(document.querySelectorAll(target.selector), (n) => !isOwn(n));
      candidates = hits.length;
      if (hits.length === 1) {
        const only = hits[0];
        // A selector can survive a rearrangement and now point at a different
        // element; a tag mismatch means it is stale, not exact.
        if (!wantedTag || only.nodeName.toLowerCase() === wantedTag) {
          return { el: only, confidence: 'exact', via: 'selector', candidates: 1, ambiguous: false };
        }
      } else if (hits.length > 1) {
        ambiguous = true;
        // Narrow by stored text — but that is a guess, so it is only a suggestion.
        if (wantedText) {
          const same = hits.filter((n) => normText(n) === wantedText);
          if (same.length === 1) {
            return { el: same[0], confidence: 'suggested', via: 'selector+text', candidates: hits.length, ambiguous: true };
          }
        }
      }
    }
  } catch (_e) {
    /* selector may be stale/invalid */
  }

  // 2) Match by tag + text content. Only a single match counts; "first of
  //    several" is exactly the silent mis-targeting this module must not do.
  try {
    if (wantedTag && wantedText && !ambiguous) {
      const all = Array.prototype.filter.call(document.getElementsByTagName(wantedTag), (n) => !isOwn(n));
      const exact = all.filter((c) => normText(c) === wantedText);
      if (exact.length === 1) {
        return { el: exact[0], confidence: 'suggested', via: 'text', candidates: 1, ambiguous: false };
      }
      if (exact.length > 1) {
        ambiguous = true;
        candidates = exact.length;
      } else {
        const partial = all.filter((c) => {
          const t = normText(c);
          return t && t.indexOf(wantedText) !== -1;
        });
        if (partial.length === 1) {
          return { el: partial[0], confidence: 'suggested', via: 'text', candidates: 1, ambiguous: false };
        }
        if (partial.length > 1) {
          ambiguous = true;
          candidates = partial.length;
        }
      }
    }
  } catch (_e) {
    /* ignore */
  }

  // 3) Nearest element to the stored box center. Only when nothing was
  //    ambiguous: an ambiguous target must be re-picked, not coordinate-guessed.
  try {
    if (target.box && !ambiguous) {
      const cx = target.box.x + target.box.w / 2;
      const cy = target.box.y + target.box.h / 2;
      const clampedX = Math.max(0, Math.min(window.innerWidth - 1, cx));
      const clampedY = Math.max(0, Math.min(window.innerHeight - 1, cy));
      const hit = document.elementFromPoint(clampedX, clampedY);
      if (hit && !isOwn(hit) && (!wantedTag || hit.nodeName.toLowerCase() === wantedTag)) {
        return { el: hit, confidence: 'suggested', via: 'coordinate', candidates: 1, ambiguous: false };
      }
    }
  } catch (_e) {
    /* ignore */
  }

  return { ...none, candidates, ambiguous };
}

// Back-compatible: returns an Element or null. Default (display) callers get
// suggestions too; `{ strict: true }` returns only an exact unique selector hit
// — what replay and any agent action must use.
function resolve(target, opts) {
  const r = resolveDetailed(target);
  if (!r.el) return null;
  if (opts && opts.strict && r.confidence !== 'exact') return null;
  return r.el;
}

// ---- transient highlight flash ---------------------------------------------
function highlight(el, opts) {
  try {
    const o = opts || {};
    const duration = typeof o.duration === 'number' ? o.duration : 1200;
    const color = o.color || '#5b8cff';
    const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : o.box;
    if (!r) return null;

    const box = document.createElement('div');
    box.setAttribute('data-caos', '');
    box.setAttribute('data-caos-flash', ''); // transient — lets tests/cleanup single these out
    box.style.cssText =
      'position:fixed;pointer-events:none;border:2px solid ' +
      color +
      ';background:' +
      hexToRgba(color, 0.16) +
      ';border-radius:4px;box-shadow:0 0 0 2px ' +
      hexToRgba(color, 0.35) +
      ',0 0 24px ' +
      hexToRgba(color, 0.45) +
      ';z-index:' +
      (OVERLAY_Z + 5) +
      ';transition:opacity .25s ease-out;opacity:1;';
    const left = ('left' in r ? r.left : r.x) || 0;
    const top = ('top' in r ? r.top : r.y) || 0;
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.width = (r.width != null ? r.width : r.w || 0) + 'px';
    box.style.height = (r.height != null ? r.height : r.h || 0) + 'px';
    document.documentElement.appendChild(box);

    setTimeout(() => {
      try {
        box.style.opacity = '0';
      } catch (_e) {
        /* ignore */
      }
    }, Math.max(0, duration - 250));
    setTimeout(() => {
      try {
        box.remove();
      } catch (_e) {
        /* ignore */
      }
    }, duration);
    return box;
  } catch (_e) {
    return null;
  }
}

function hexToRgba(hex, alpha) {
  try {
    let h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6) return hex;
    const n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  } catch (_e) {
    return hex;
  }
}

module.exports = { cssPath, describe, resolve, resolveDetailed, resolvesUniquelyTo, highlight };
