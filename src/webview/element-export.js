// element-export.js — lift one element off a page as something you can open on
// its own: its markup, the CSS that actually applies to it, the inherited
// typography it was sitting in, and every asset it references.
//
// Runs in the guest page's world. Pure DOM, no IPC, defensive everywhere: a
// page's stylesheets are frequently cross-origin and unreadable, so there are
// two capture modes —
//   • rules  — the real CSS rules that match (keeps hover states, media queries,
//              custom properties, keyframes and @font-face);
//   • inline — computed styles baked onto every node, used when the sheets are
//              locked away behind CORS. Looks right, loses interaction states.
'use strict';

const MAX_NODES = 4000; // a whole page pasted into "one element" is a mistake
const INHERITED = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'color',
  'text-align',
  'text-transform',
  'direction',
];

// Enough to make an isolated node look like it did on the page.
const INLINE_PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear',
  'box-sizing', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-self', 'gap',
  'flex-grow', 'flex-shrink', 'flex-basis', 'order',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
  'text-align', 'text-decoration-line', 'text-transform', 'white-space', 'word-break',
  'color', 'background-color', 'background-image', 'background-size', 'background-position',
  'background-repeat', 'border-radius', 'box-shadow', 'opacity', 'overflow', 'cursor',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-style', 'border-color', 'outline', 'transform', 'transition', 'list-style',
  'vertical-align', 'object-fit',
];

function isOwnNode(node) {
  try {
    return !!(node && node.hasAttribute && (node.hasAttribute('data-caos') || node.id === '__caos_root'));
  } catch (_e) {
    return false;
  }
}

// ---- assets -----------------------------------------------------------------
// Each asset becomes a token in the html/css, so the host can swap in a file
// path or a data URI without guessing at string matching.
function createAssetTable(baseUrl) {
  const byUrl = new Map();
  const list = [];
  return {
    list,
    token(raw, kind) {
      let abs;
      try {
        abs = new URL(String(raw).trim(), baseUrl).href;
      } catch (_e) {
        return null;
      }
      if (/^(data|blob|about|javascript):/i.test(abs)) return null;
      if (byUrl.has(abs)) return byUrl.get(abs).token;
      const token = '__CAOS_ASSET_' + list.length + '__';
      const entry = { token, url: abs, kind: kind || 'asset' };
      byUrl.set(abs, entry);
      list.push(entry);
      return token;
    },
  };
}

function tokenizeCssUrls(css, assets) {
  return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, q, raw) => {
    const token = assets.token(raw, 'css');
    return token ? 'url(' + token + ')' : whole;
  });
}

function tokenizeSrcset(value, assets) {
  return String(value)
    .split(',')
    .map((part) => {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) return part.trim();
      const token = assets.token(bits[0], 'image');
      if (token) bits[0] = token;
      return bits.join(' ');
    })
    .join(', ');
}

// ---- css rule extraction ------------------------------------------------------
function stripStatePseudos(selector) {
  // ".btn:hover::after" still belongs to ".btn" — match on the bare shape.
  return String(selector)
    .replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectCss(el, assets) {
  const nodes = [el].concat(Array.prototype.slice.call(el.querySelectorAll('*'))).filter((n) => !isOwnNode(n));
  const matches = (selector) => {
    const bare = stripStatePseudos(selector);
    if (!bare) return false;
    try {
      return nodes.some((n) => n.matches(bare));
    } catch (_e) {
      return false;
    }
  };

  const kept = [];
  const fontFaces = [];
  const keyframes = {};
  const vars = [];
  let blocked = 0;
  let seen = 0;

  const walk = (rules, out) => {
    for (const rule of rules) {
      seen++;
      try {
        // CSSStyleRule
        if (rule.selectorText != null && rule.style) {
          const parts = rule.selectorText.split(',').map((s) => s.trim()).filter(Boolean);
          // :root / html custom properties travel with the element — its colours
          // are probably var() references into them.
          if (parts.some((p) => /^(:root|html|body)$/.test(stripStatePseudos(p))) && /--[\w-]+\s*:/.test(rule.style.cssText)) {
            const custom = Array.prototype.filter
              .call(rule.style, (p) => p.indexOf('--') === 0)
              .map((p) => p + ': ' + rule.style.getPropertyValue(p) + ';')
              .join(' ');
            if (custom) vars.push(custom);
          }
          const keep = parts.filter(matches);
          if (keep.length) out.push(keep.join(', ') + ' { ' + rule.style.cssText + ' }');
          continue;
        }
        // @media / @supports / @layer — keep the wrapper only if something inside stuck
        if (rule.cssRules && (rule.conditionText != null || rule.media)) {
          const inner = [];
          walk(rule.cssRules, inner);
          if (inner.length) {
            const at = rule.media ? '@media ' + rule.media.mediaText : '@supports ' + rule.conditionText;
            out.push(at + ' {\n' + inner.join('\n') + '\n}');
          }
          continue;
        }
        if (rule.cssText && /^@font-face/i.test(rule.cssText)) {
          fontFaces.push(rule.cssText);
          continue;
        }
        if (rule.name && rule.cssRules && /keyframes/i.test(rule.cssText || '')) {
          keyframes[rule.name] = rule.cssText;
          continue;
        }
      } catch (_e) {
        /* a rule we cannot read is a rule we skip */
      }
    }
  };

  for (const sheet of Array.prototype.slice.call(document.styleSheets)) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch (_e) {
      rules = null;
    }
    if (!rules) {
      blocked++;
      continue;
    }
    if (sheet.ownerNode && isOwnNode(sheet.ownerNode)) continue;
    walk(rules, kept);
  }

  // Only the fonts and animations the kept rules actually call for.
  const keptText = kept.join('\n');
  const usedFonts = fontFaces.filter((face) => {
    const m = /font-family:\s*(['"]?)([^;'"]+)\1/i.exec(face);
    if (!m) return false;
    const name = m[2].trim();
    return keptText.indexOf(name) !== -1 || getComputedStyle(el).fontFamily.indexOf(name) !== -1;
  });
  const usedKeyframes = Object.keys(keyframes).filter((name) => new RegExp('\\b' + name.replace(/[^\w-]/g, '') + '\\b').test(keptText));

  const css = []
    .concat(vars.length ? [':root {\n  ' + vars.join('\n  ') + '\n}'] : [])
    .concat(usedFonts)
    .concat(usedKeyframes.map((k) => keyframes[k]))
    .concat(kept)
    .join('\n\n');

  return { css: tokenizeCssUrls(css, assets), blocked, seen, ruleCount: kept.length };
}

// ---- inline fallback -----------------------------------------------------------
function inlineComputed(source, clone, assets) {
  const src = [source].concat(Array.prototype.slice.call(source.querySelectorAll('*')));
  const dst = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));
  const n = Math.min(src.length, dst.length);
  for (let i = 0; i < n; i++) {
    let cs;
    try {
      cs = getComputedStyle(src[i]);
    } catch (_e) {
      continue;
    }
    const decls = [];
    for (const prop of INLINE_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (v && v !== 'auto' && v !== 'none' && v !== 'normal' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') {
        decls.push(prop + ': ' + (prop.indexOf('background') === 0 ? tokenizeCssUrls(v, assets) : v));
      }
    }
    if (decls.length) dst[i].setAttribute('style', decls.join('; ') + ';');
  }
}

// ---- markup --------------------------------------------------------------------
function cleanClone(el, assets) {
  const clone = el.cloneNode(true);
  try {
    Array.prototype.slice.call(clone.querySelectorAll('[data-caos], #__caos_root, script')).forEach((n) => n.remove());
    Array.prototype.slice.call(clone.querySelectorAll('[contenteditable]')).forEach((n) => n.removeAttribute('contenteditable'));
    clone.removeAttribute('contenteditable');
    // our own editing outline is not part of the component
    ['outline', 'outline-offset', 'user-select', 'opacity'].forEach((p) => clone.style && clone.style.removeProperty(p));
    if (clone.getAttribute && clone.getAttribute('style') === '') clone.removeAttribute('style');
  } catch (_e) {
    /* ignore */
  }
  // Point every asset reference at a token.
  try {
    Array.prototype.slice.call(clone.querySelectorAll('[src]')).forEach((n) => {
      const t = assets.token(n.getAttribute('src'), n.nodeName.toLowerCase() === 'img' ? 'image' : 'asset');
      if (t) n.setAttribute('src', t);
    });
    Array.prototype.slice.call(clone.querySelectorAll('[srcset]')).forEach((n) => {
      n.setAttribute('srcset', tokenizeSrcset(n.getAttribute('srcset'), assets));
    });
    Array.prototype.slice.call(clone.querySelectorAll('[poster]')).forEach((n) => {
      const t = assets.token(n.getAttribute('poster'), 'image');
      if (t) n.setAttribute('poster', t);
    });
    Array.prototype.slice.call(clone.querySelectorAll('[style*="url("]')).forEach((n) => {
      n.setAttribute('style', tokenizeCssUrls(n.getAttribute('style'), assets));
    });
    if (clone.getAttribute && /url\(/.test(clone.getAttribute('style') || '')) {
      clone.setAttribute('style', tokenizeCssUrls(clone.getAttribute('style'), assets));
    }
  } catch (_e) {
    /* ignore */
  }
  return clone;
}

function label(el) {
  let s = el.nodeName.toLowerCase();
  if (el.id) s += '#' + el.id;
  else if (el.classList && el.classList.length) s += '.' + el.classList[0];
  return s;
}

function slug(el) {
  const raw = (el.id || (el.classList && el.classList[0]) || el.nodeName.toLowerCase() || 'element')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return raw.slice(0, 40) || 'element';
}

// ---- entry point ----------------------------------------------------------------
function collect(el, opts) {
  if (!el || el.nodeType !== 1) return null;
  const options = opts || {};
  const assets = createAssetTable(document.baseURI || location.href);
  const nodeCount = 1 + el.querySelectorAll('*').length;
  const clone = cleanClone(el, assets);

  let mode = 'rules';
  let out = { css: '', blocked: 0, ruleCount: 0 };
  if (nodeCount <= MAX_NODES) out = collectCss(el, assets);
  if (!out.ruleCount) {
    mode = 'inline';
    inlineComputed(el, clone, assets);
  }

  // The typography and background it was sitting in — without this a button
  // lifted off a dark page opens as black text on white.
  const cs = getComputedStyle(el);
  const bodyCs = getComputedStyle(document.body);
  const context = INHERITED.map((p) => p + ': ' + cs.getPropertyValue(p) + ';').join(' ');
  const surface =
    'background: ' +
    (bodyCs.backgroundColor && bodyCs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? bodyCs.backgroundColor : '#ffffff') +
    ';';

  const r = el.getBoundingClientRect();
  return {
    html: clone.outerHTML,
    css: out.css,
    context,
    surface,
    assets: assets.list.map((a) => ({ token: a.token, url: a.url, kind: a.kind })),
    meta: {
      label: label(el),
      slug: slug(el),
      selector: options.selector || '',
      sourceUrl: location.href,
      pageTitle: document.title || '',
      tag: el.nodeName.toLowerCase(),
      box: { w: Math.round(r.width), h: Math.round(r.height) },
      nodeCount,
      mode,
      blockedSheets: out.blocked,
      ruleCount: out.ruleCount,
      capturedAt: new Date().toISOString(),
    },
  };
}

module.exports = { collect };
