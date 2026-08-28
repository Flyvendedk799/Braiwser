// Braiwser — anchor.js
// Element identity & re-resolution utilities, shared by inspector/recorder/replay.
// Runs inside the guest page's world. Pure DOM, no IPC. Defensive everywhere.

'use strict';

const OVERLAY_Z = 2147483640;

// ---- robust CSS selector for an element ------------------------------------
// Test-friendly attributes preferred over brittle structural paths.
const STABLE_ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'name', 'aria-label'];

function cssPath(el) {
  try {
    if (!(el instanceof Element)) return '';
    // Best path: a stable, test-oriented attribute that uniquely identifies it.
    for (const attr of STABLE_ATTRS) {
      const val = el.getAttribute && el.getAttribute(attr);
      if (!val) continue;
      const cand = `${el.nodeName.toLowerCase()}[${attr}="${cssEscapeAttr(val)}"]`;
      try { if (document.querySelectorAll(cand).length === 1) return cand; } catch (_e) { /* invalid */ }
    }
    // Fast path: a stable id wins outright.
    if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) {
      return '#' + cssEscape(el.id);
    }
    const parts = [];
    let node = el;
    while (
      node &&
      node.nodeType === 1 &&
      node !== document.body &&
      node !== document.documentElement
    ) {
      let sel = node.nodeName.toLowerCase();
      if (node.id) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(
          parent.children,
          (c) => c.nodeName.toLowerCase() === sel
        );
        if (sameTag.length > 1) {
          sel += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
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
  return String(s).replace(/(["\\])/g, '\\$1');
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
function resolve(target) {
  if (!target) return null;

  // 1) Direct selector match.
  try {
    if (target.selector) {
      const found = document.querySelector(target.selector);
      if (found) return found;
    }
  } catch (_e) {
    /* selector may be stale/invalid */
  }

  // 2) Match by tag + text content.
  try {
    if (target.tag && target.text) {
      const wanted = target.text.trim();
      const candidates = document.getElementsByTagName(target.tag);
      let best = null;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const t = ((c.innerText || c.textContent || '') + '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 120);
        if (t === wanted) return c;
        if (!best && t && wanted && t.indexOf(wanted) !== -1) best = c;
      }
      if (best) return best;
    }
  } catch (_e) {
    /* ignore */
  }

  // 3) Nearest element to the stored box center.
  try {
    if (target.box) {
      const cx = target.box.x + target.box.w / 2;
      const cy = target.box.y + target.box.h / 2;
      const clampedX = Math.max(0, Math.min(window.innerWidth - 1, cx));
      const clampedY = Math.max(0, Math.min(window.innerHeight - 1, cy));
      const hit = document.elementFromPoint(clampedX, clampedY);
      if (hit && !(hit.closest && hit.closest('[data-caos]'))) return hit;
    }
  } catch (_e) {
    /* ignore */
  }

  return null;
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

module.exports = { cssPath, describe, resolve, highlight };
