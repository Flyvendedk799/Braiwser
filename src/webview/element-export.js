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
//
// collect(el, { selector }) returns (all of it plain, structured-clone-safe data):
//
//   html         the element's markup INSIDE a chain of attribute-only "shells"
//                for its ancestors (html/body become <div data-caos-export-html>
//                / <div data-caos-export-body>), so descendant / child / theme-class
//                selectors still apply when it is opened on its own (CE-15)
//   elementHtml  the element's markup alone, no ancestor shells
//   css          kept rules. Selectors that began at html/body/:root are rewritten
//                onto the shells; rules that only match an ancestor are reduced to
//                inheritable + custom-property declarations
//   context      inherited typography of the element (declarations for <body>)
//   surface      page background declaration for <html>
//   assets       [{ token, url, kind }] - `__CAOS_ASSET_n__` tokens appear in html,
//                elementHtml and css; url is absolute and was resolved against the
//                owning stylesheet / document base / <base> (CE-14, CE-16)
//   truncated    true when the node budget stopped the capture early
//   meta         { label, slug, selector, sourceUrl, pageTitle, tag, box,
//                  nodeCount        elements actually captured,
//                  nodeLimit        the budget,
//                  truncated, truncatedReason,
//                  mode             'rules' | 'inline',
//                  blockedSheets, ruleCount, cssTruncated,
//                  ancestorContext  number of ancestor shells,
//                  warnings[]       fidelity caveats the exporter should surface,
//                  capturedAt }
'use strict';

const MAX_NODES = 4000; // a whole page pasted into "one element" is a mistake
const MAX_ANCESTORS = 24; // nearest ancestors kept as selector context
const MAX_RULES = 30000; // style rules inspected across all sheets
const MAX_CSS_CHARS = 1500000;
const MAX_TEXT_CHARS = 2000000; // text carried by the captured subtree
const MAX_IMPORT_DEPTH = 8;

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

// Declarations that flow down to descendants. A rule that matches only an
// ancestor shell is reduced to these (plus custom properties): its layout
// properties (width, padding, display …) described the ancestor, not the piece.
const INHERITABLE_PROPS = new Set([
  'color', 'cursor', 'direction', 'font', 'letter-spacing', 'line-height', 'list-style',
  'list-style-type', 'list-style-position', 'quotes', 'tab-size', 'text-align', 'text-indent',
  'text-transform', 'text-shadow', 'text-rendering', 'visibility', 'white-space', 'word-break',
  'word-spacing', 'overflow-wrap', 'hyphens', 'writing-mode', 'fill', 'stroke', 'color-scheme',
  'accent-color', 'caret-color', 'font-kerning', 'font-stretch', 'font-variant',
  'font-feature-settings', '-webkit-font-smoothing',
]);

// Enough to make an isolated node look like it did on the page.
const INLINE_PROPS = [
  'display', 'visibility', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear',
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
// Values that mean "nothing set" for most properties — dropped to keep the
// markup small — except where the value itself is meaningful. `display:none`
// hides a node; a zero margin/padding/border cancels a UA default; `visibility`
// and `position:static` are cheap and explicit.
const NOOP_VALUES = new Set(['auto', 'none', 'normal', '0px', 'rgba(0, 0, 0, 0)']);
const KEEP_NONE = new Set(['display']);
const KEEP_ZERO = /^(margin|padding|border-(top|right|bottom|left)-width|min-width|min-height|top|right|bottom|left|gap)/;

function isOwnNode(node) {
  try {
    return !!(node && node.hasAttribute && (node.hasAttribute('data-caos') || node.id === '__caos_root'));
  } catch (_e) {
    return false;
  }
}

// ---- secrets ----------------------------------------------------------------------
// A password field's value attribute has no place in a lifted-out component.
let isSecretField = () => false;
try {
  isSecretField = require('./secret-field').isSecretField;
} catch (_e) {
  isSecretField = (el) => {
    try { return String(el.type || '').toLowerCase() === 'password'; } catch (_e2) { return false; }
  };
}

// ---- assets -----------------------------------------------------------------------
// Each asset becomes a token in the html/css, so the host can swap in a file
// path or a data URI without guessing at string matching.
function createAssetTable(baseUrl) {
  const byUrl = new Map();
  const list = [];
  return {
    list,
    baseUrl,
    // `base` overrides the document base: a stylesheet's own URL, for CSS.
    token(raw, kind, base) {
      const text = String(raw == null ? '' : raw).trim();
      if (!text || text.charAt(0) === '#') return null; // fragment-only: an SVG reference, not a file
      let abs;
      try {
        abs = new URL(text, base || baseUrl).href;
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
    absolute(raw, base) {
      try {
        return new URL(String(raw).trim(), base || baseUrl).href;
      } catch (_e) {
        return null;
      }
    },
  };
}

function tokenizeCssUrls(css, assets, base) {
  return String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, q, raw) => {
    const token = assets.token(raw, 'css', base);
    return token ? 'url(' + token + ')' : whole;
  });
}

// srcset: "url [descriptor], url [descriptor] …". URLs may contain commas
// (image CDNs: ".../w_300,c_fill/a.jpg"), so a comma only ends a candidate when
// it follows whitespace-delimited descriptors or the url ends in one.
function tokenizeSrcset(value, assets, base) {
  const s = String(value);
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let start = i;
    while (i < s.length && !/\s/.test(s[i])) i++;
    let url = s.slice(start, i);
    let descriptor = '';
    if (/,+$/.test(url)) {
      url = url.replace(/,+$/, ''); // "a.jpg," — no descriptor
    } else {
      start = i;
      let depth = 0;
      while (i < s.length) {
        const ch = s[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) break;
        i++;
      }
      descriptor = s.slice(start, i).trim();
    }
    const token = assets.token(url, 'image', base);
    out.push((token || url) + (descriptor ? ' ' + descriptor : ''));
  }
  return out.join(', ');
}

// ---- css rule extraction ------------------------------------------------------------
function stripStatePseudos(selector) {
  // ".btn:hover::after" still belongs to ".btn" — match on the bare shape.
  return String(selector)
    .replace(/:root(?![\w-])/g, 'html')
    .replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// html / body / :root in a kept selector point at the shells in the export.
function rewriteDocumentSelector(selector) {
  return String(selector)
    .replace(/:root(?![\w-])/g, '[data-caos-export-html]')
    .replace(/(^|[\s>+~,(])html(?![\w-])/gi, '$1[data-caos-export-html]')
    .replace(/(^|[\s>+~,(])body(?![\w-])/gi, '$1[data-caos-export-body]');
}

// Only the declarations an ancestor passes down (inheritable + custom props).
function inheritedDeclarations(style) {
  const out = [];
  for (let i = 0; i < style.length; i++) {
    const name = style[i];
    if (name.indexOf('--') !== 0 && !INHERITABLE_PROPS.has(name) && name.indexOf('font-') !== 0) continue;
    // Size is baked once (the `context` typography + the rem base) — applying a
    // percentage or em on a shell as well would compound it.
    if (name === 'font-size' || name === 'font') continue;
    const value = style.getPropertyValue(name);
    if (!value) continue;
    const prio = style.getPropertyPriority ? style.getPropertyPriority(name) : '';
    out.push(name + ': ' + value + (prio ? ' !' + prio : '') + ';');
  }
  return out.join(' ');
}

function groupHeader(rule) {
  const text = rule.cssText || '';
  const i = text.indexOf('{');
  return i > 0 ? text.slice(0, i).trim() : '';
}

function sheetBaseUrl(sheet, fallback) {
  try {
    if (sheet && sheet.href) return sheet.href;
  } catch (_e) {
    /* ignore */
  }
  return fallback;
}

function collectCss(el, ancestors, assets, ctx) {
  const docBase = ctx.docBase;
  const state = { blocked: 0, seen: 0, chars: 0, truncated: false };
  const kept = [];
  const fontFaces = [];
  const keyframes = {};
  const visited = new Set();
  const cache = new Map(); // bare selector -> 'full' | 'ancestor' | null

  // Does this selector part apply to the captured piece? One native query per
  // distinct selector: `matches` for the root, `querySelector` for its subtree.
  const classify = (part) => {
    const bare = stripStatePseudos(part);
    if (!bare) return null;
    if (cache.has(bare)) return cache.get(bare);
    let kind = null;
    try {
      if (el.matches(bare) || el.querySelector(bare)) kind = 'full';
      else if (ancestors.some((a) => a.matches(bare))) kind = 'ancestor';
    } catch (_e) {
      kind = null; // unparseable here -> not provably relevant
    }
    cache.set(bare, kind);
    return kind;
  };

  const push = (out, text) => {
    state.chars += text.length;
    if (state.chars > MAX_CSS_CHARS) {
      state.truncated = true;
      return;
    }
    out.push(text);
  };

  const walk = (rules, out, base, depth) => {
    for (const rule of Array.prototype.slice.call(rules)) {
      if (state.truncated) return;
      state.seen++;
      if (state.seen > MAX_RULES) {
        state.truncated = true;
        return;
      }
      try {
        // @import — follow it with the imported sheet's own URL as the base.
        if (rule.styleSheet !== undefined && rule.href !== undefined) {
          const imported = rule.styleSheet;
          if (!imported || depth >= MAX_IMPORT_DEPTH || visited.has(imported)) continue;
          let importedRules = null;
          try {
            importedRules = imported.cssRules;
          } catch (_e) {
            importedRules = null;
          }
          if (!importedRules) {
            state.blocked++;
            continue;
          }
          visited.add(imported);
          let importedBase = base;
          try {
            importedBase = imported.href || new URL(rule.href, base).href;
          } catch (_e) {
            importedBase = base;
          }
          const inner = [];
          walk(importedRules, inner, importedBase, depth + 1);
          if (inner.length) {
            const mq = rule.media && rule.media.mediaText && rule.media.mediaText !== 'all' ? rule.media.mediaText : '';
            out.push(mq ? '@media ' + mq + ' {\n' + inner.join('\n') + '\n}' : inner.join('\n'));
          }
          continue;
        }
        // CSSStyleRule
        if (rule.selectorText != null && rule.style) {
          const parts = rule.selectorText.split(',').map((s) => s.trim()).filter(Boolean);
          const full = [];
          const inherit = [];
          for (const p of parts) {
            const k = classify(p);
            if (k === 'full') full.push(rewriteDocumentSelector(p));
            else if (k === 'ancestor') inherit.push(rewriteDocumentSelector(p));
          }
          if (full.length) {
            push(out, tokenizeCssUrls(full.join(', ') + ' { ' + rule.style.cssText + ' }', assets, base));
          }
          if (inherit.length) {
            const decls = inheritedDeclarations(rule.style);
            if (decls) push(out, tokenizeCssUrls(inherit.join(', ') + ' { ' + decls + ' }', assets, base));
          }
          continue;
        }
        const text = rule.cssText || '';
        if (/^@font-face/i.test(text)) {
          fontFaces.push(tokenizeCssUrls(text, assets, base));
          continue;
        }
        if (/^@(-webkit-)?keyframes/i.test(text) && rule.name) {
          keyframes[rule.name] = tokenizeCssUrls(text, assets, base);
          continue;
        }
        // @media / @supports / @layer / @container — keep the wrapper only if
        // something inside stuck.
        if (rule.cssRules && groupHeader(rule)) {
          const inner = [];
          walk(rule.cssRules, inner, base, depth);
          if (inner.length) push(out, groupHeader(rule) + ' {\n' + inner.join('\n') + '\n}');
          continue;
        }
      } catch (_e) {
        /* a rule we cannot read is a rule we skip */
      }
    }
  };

  const sheets = Array.prototype.slice.call(ctx.styleSheets || []);
  try {
    if (ctx.adoptedStyleSheets && ctx.adoptedStyleSheets.length) {
      Array.prototype.push.apply(sheets, Array.prototype.slice.call(ctx.adoptedStyleSheets));
    }
  } catch (_e) {
    /* ignore */
  }
  for (const sheet of sheets) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch (_e) {
      rules = null;
    }
    if (!rules) {
      state.blocked++;
      continue;
    }
    try {
      if (sheet.disabled) continue;
      if (sheet.ownerNode && isOwnNode(sheet.ownerNode)) continue;
    } catch (_e) {
      /* ignore */
    }
    visited.add(sheet);
    const base = sheetBaseUrl(sheet, docBase);
    const sheetOut = [];
    walk(rules, sheetOut, base, 0);
    // <link media="print"> and friends only apply under that query.
    let mq = '';
    try {
      mq = sheet.media && sheet.media.mediaText && sheet.media.mediaText !== 'all' ? sheet.media.mediaText : '';
    } catch (_e) {
      mq = '';
    }
    if (sheetOut.length) kept.push(mq ? '@media ' + mq + ' {\n' + sheetOut.join('\n') + '\n}' : sheetOut.join('\n'));
  }

  // Only the fonts and animations the kept rules actually call for.
  const keptText = kept.join('\n');
  let rootFamily = '';
  try {
    rootFamily = getComputedStyle(el).fontFamily || '';
  } catch (_e) {
    rootFamily = '';
  }
  const usedFonts = fontFaces.filter((face) => {
    const m = /font-family:\s*(['"]?)([^;'"]+)\1/i.exec(face);
    if (!m) return false;
    const name = m[2].trim();
    return keptText.indexOf(name) !== -1 || rootFamily.indexOf(name) !== -1;
  });
  const usedKeyframes = Object.keys(keyframes).filter((name) =>
    new RegExp('\\b' + name.replace(/[^\w-]/g, '') + '\\b').test(keptText)
  );

  // Baseline for what rules alone cannot carry (CE-15): the rem base, and the
  // resolved value of every custom property the kept CSS reads — computed on
  // the element, so inherited and theme-scoped values come along even when the
  // rule that set them lives on something we did not keep.
  const baseline = [];
  try {
    const rootFont = parseFloat(getComputedStyle(ctx.documentElement).fontSize);
    if (rootFont && Math.abs(rootFont - 16) > 0.01) baseline.push('html { font-size: ' + rootFont + 'px; }');
  } catch (_e) {
    /* ignore */
  }
  try {
    const names = new Set();
    const scan = (txt) => {
      const re = /var\(\s*(--[\w-]+)/g;
      let m;
      while ((m = re.exec(txt))) names.add(m[1]);
    };
    scan(keptText);
    scan(ctx.inlineStyleText || '');
    const cs = getComputedStyle(el);
    const decls = [];
    names.forEach((n) => {
      const v = String(cs.getPropertyValue(n) || '').trim();
      if (v) decls.push(n + ': ' + v + ';');
    });
    if (decls.length) baseline.push(':root { ' + decls.join(' ') + ' }');
  } catch (_e) {
    /* ignore */
  }

  const css = []
    .concat(tokenizeCssUrls(baseline.join('\n'), assets, docBase) || [])
    .concat(usedFonts)
    .concat(usedKeyframes.map((k) => keyframes[k]))
    .concat(kept)
    .filter(Boolean)
    .join('\n\n');

  return { css, blocked: state.blocked, seen: state.seen, ruleCount: kept.length, truncated: state.truncated };
}

// ---- markup ---------------------------------------------------------------------------
const SAFE_SHELL_ATTR = /^(id|class|dir|lang|role|title|data-[\w-]+|aria-[\w-]+)$/i;

// Attribute-only copy of an ancestor: enough for selectors to match, nothing
// that renders, navigates or runs. Inline custom properties are kept (themes).
function shellFor(node, kind) {
  let shell;
  if (kind) {
    shell = document.createElement('div');
    shell.setAttribute(kind === 'html' ? 'data-caos-export-html' : 'data-caos-export-body', '');
  } else if (node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
    shell = node.cloneNode(false);
  } else {
    // <p> cannot legally hold the block content below it.
    const tag = node.nodeName.toLowerCase() === 'p' ? 'div' : node.nodeName.toLowerCase();
    shell = document.createElement(tag);
  }
  if (shell.attributes) {
    Array.prototype.slice.call(shell.attributes).forEach((a) => {
      if (!/^data-caos-export-/.test(a.name) && !SAFE_SHELL_ATTR.test(a.name)) shell.removeAttribute(a.name);
    });
  }
  Array.prototype.forEach.call(node.attributes || [], (a) => {
    if (SAFE_SHELL_ATTR.test(a.name) && !/^data-caos/i.test(a.name)) {
      try { shell.setAttribute(a.name, a.value); } catch (_e) { /* invalid name */ }
    }
  });
  try {
    const custom = [];
    const st = node.style;
    for (let i = 0; st && i < st.length; i++) {
      if (st[i].indexOf('--') === 0) custom.push(st[i] + ': ' + st.getPropertyValue(st[i]) + ';');
    }
    if (custom.length) shell.setAttribute('style', custom.join(' '));
  } catch (_e) {
    /* ignore */
  }
  return shell;
}

const EDITING_STYLE_PROPS = ['outline', 'outline-offset', 'user-select', 'opacity'];

// Point every asset reference of one cloned element at a token.
function rewriteAssets(src, dst, assets) {
  const tag = dst.nodeName.toLowerCase();
  const get = (n) => (dst.hasAttribute(n) ? dst.getAttribute(n) : null);

  const srcVal = get('src');
  if (srcVal != null) {
    if (tag === 'iframe' || tag === 'frame' || tag === 'embed') {
      const abs = assets.absolute(srcVal);
      if (abs) dst.setAttribute('src', abs); // a document, not a fetchable asset
    } else {
      let kind = 'asset';
      if (tag === 'img') kind = 'image';
      else if (tag === 'video' || tag === 'audio' || tag === 'track') kind = 'media';
      else if (tag === 'source') kind = src.parentElement && /^picture$/i.test(src.parentElement.nodeName) ? 'image' : 'media';
      const t = assets.token(srcVal, kind);
      if (t) dst.setAttribute('src', t);
    }
  }
  const srcset = get('srcset');
  if (srcset != null) dst.setAttribute('srcset', tokenizeSrcset(srcset, assets));
  const poster = get('poster');
  if (poster != null) {
    const t = assets.token(poster, 'image');
    if (t) dst.setAttribute('poster', t);
  }
  if (tag === 'object' && get('data') != null) {
    const t = assets.token(get('data'), 'asset');
    if (t) dst.setAttribute('data', t);
  }
  // SVG <image>/<use>/<feImage> references (fragment-only ones stay put).
  if (tag === 'image' || tag === 'use' || tag === 'feimage') {
    ['href', 'xlink:href'].forEach((n) => {
      const v = get(n);
      if (v != null) {
        const t = assets.token(v, tag === 'use' ? 'asset' : 'image');
        if (t) dst.setAttribute(n, t);
      }
    });
  }
  const style = get('style');
  if (style && /url\(/i.test(style)) dst.setAttribute('style', tokenizeCssUrls(style, assets));
}

// Clone `root` element-by-element with a node budget enforced BEFORE each clone
// (never cloneNode(true) on an unbounded subtree), dropping scripts and our own
// UI as it goes, and keeping the source->clone correspondence (CE-17).
function cloneBounded(root, assets, maxNodes) {
  const pairs = []; // { src, dst }, document order
  let truncated = false;
  let truncatedReason = '';
  let chars = 0;

  const shallow = (src) => {
    const dst = src.cloneNode(false);
    if (dst.removeAttribute) dst.removeAttribute('contenteditable');
    try {
      if (isSecretField(src) && dst.removeAttribute) dst.removeAttribute('value');
    } catch (_e) {
      if (dst.removeAttribute) dst.removeAttribute('value');
    }
    rewriteAssets(src, dst, assets);
    return dst;
  };

  const rootClone = shallow(root);
  try {
    // our own editing outline is not part of the component
    EDITING_STYLE_PROPS.forEach((p) => rootClone.style && rootClone.style.removeProperty(p));
    if (rootClone.getAttribute('style') === '') rootClone.removeAttribute('style');
  } catch (_e) {
    /* ignore */
  }
  pairs.push({ src: root, dst: rootClone });

  const stack = [{ node: root, dst: rootClone, i: 0 }];
  walk: while (stack.length) {
    const frame = stack[stack.length - 1];
    const kids = frame.node.childNodes;
    if (frame.i >= kids.length) {
      stack.pop();
      continue;
    }
    const child = kids[frame.i++];
    if (child.nodeType === 3) {
      chars += child.nodeValue.length;
      if (chars > MAX_TEXT_CHARS) {
        truncated = true;
        truncatedReason = 'text-limit';
        break walk;
      }
      frame.dst.appendChild(child.cloneNode(false));
    } else if (child.nodeType === 1) {
      if (isOwnNode(child) || /^script$/i.test(child.nodeName)) continue; // never captured, never counted
      if (pairs.length >= maxNodes) {
        truncated = true;
        truncatedReason = 'node-limit';
        break walk;
      }
      const dst = shallow(child);
      frame.dst.appendChild(dst);
      pairs.push({ src: child, dst });
      stack.push({ node: child, dst, i: 0 });
    }
    // comments and other node types are not part of the piece
  }
  return { root: rootClone, pairs, truncated, truncatedReason };
}

// ---- inline fallback ---------------------------------------------------------------------
// `pairs` is the source->clone map built while cloning, so removed nodes
// (scripts, our UI) can never shift which style lands on which node.
function inlineComputed(pairs, assets) {
  for (let n = 0; n < pairs.length; n++) {
    const { src, dst } = pairs[n];
    let cs;
    try {
      cs = getComputedStyle(src);
    } catch (_e) {
      continue;
    }
    const decls = [];
    for (const prop of INLINE_PROPS) {
      // The root's own editing outline / opacity are ours, not the page's.
      if (n === 0 && EDITING_STYLE_PROPS.indexOf(prop) !== -1 && src.style && src.style.getPropertyValue(prop)) continue;
      const v = cs.getPropertyValue(prop);
      if (!v) continue;
      if (NOOP_VALUES.has(v)) {
        const keep = (v === 'none' && KEEP_NONE.has(prop)) || (v === '0px' && KEEP_ZERO.test(prop));
        if (!keep) continue;
      }
      decls.push(prop + ': ' + (prop.indexOf('background') === 0 ? tokenizeCssUrls(v, assets) : v));
    }
    if (decls.length) dst.setAttribute('style', decls.join('; ') + ';');
  }
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

// ---- entry point -----------------------------------------------------------------------------
function collect(el, opts) {
  if (!el || el.nodeType !== 1) return null;
  const options = opts || {};
  const docBase = document.baseURI || location.href;
  const assets = createAssetTable(docBase);
  const warnings = [];

  const cloned = cloneBounded(el, assets, MAX_NODES);
  const nodeCount = cloned.pairs.length;
  if (cloned.truncated) {
    warnings.push(
      cloned.truncatedReason === 'text-limit'
        ? 'The element carries more text than the export limit; the rest was left out.'
        : 'The element has more than ' + MAX_NODES + ' nodes; only the first ' + MAX_NODES + ' (document order) were captured.'
    );
  }

  // Ancestors, nearest first: the element's own selectors may depend on them.
  const ancestors = [];
  let truncatedAncestors = false;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (isOwnNode(p)) continue;
    if (p === document.documentElement || p === document.body) {
      ancestors.push(p);
      continue;
    }
    if (ancestors.filter((a) => a !== document.documentElement && a !== document.body).length >= MAX_ANCESTORS) {
      truncatedAncestors = true;
      continue;
    }
    ancestors.push(p);
  }
  if (truncatedAncestors) warnings.push('Only the nearest ' + MAX_ANCESTORS + ' ancestors were kept as selector context.');

  let mode = 'rules';
  let out = { css: '', blocked: 0, ruleCount: 0, truncated: false };
  out = collectCss(el, ancestors, assets, {
    styleSheets: document.styleSheets,
    adoptedStyleSheets: document.adoptedStyleSheets,
    docBase,
    documentElement: document.documentElement,
    inlineStyleText: cloned.pairs.map((p) => p.dst.getAttribute && p.dst.getAttribute('style')).filter(Boolean).join('\n'),
  });
  if (!out.ruleCount) {
    mode = 'inline';
    inlineComputed(cloned.pairs, assets);
  }
  if (out.truncated) warnings.push('The page has more CSS than the export limit; later rules were left out.');
  if (out.blocked) warnings.push(out.blocked + ' stylesheet(s) could not be read (cross-origin); their rules are not included.');
  if (mode === 'rules' && /:(nth-[\w-]+|first-child|last-child|only-child|first-of-type|last-of-type)\b|\s[+~]\s/.test(out.css)) {
    warnings.push('Some kept rules depend on sibling position; they may not apply with the siblings removed.');
  }

  // Wrap the piece in its ancestor shells (outermost first) so selector
  // context survives. Ancestors outside <body>/<html> are shells of their own.
  const elementHtml = cloned.root.outerHTML;
  let wrapped = cloned.root;
  let shellCount = 0;
  if (mode === 'rules') {
    for (const a of ancestors) {
      const kind = a === document.documentElement ? 'html' : a === document.body ? 'body' : null;
      const shell = shellFor(a, kind);
      shell.appendChild(wrapped);
      wrapped = shell;
      shellCount++;
    }
  }
  const html = wrapped === cloned.root ? elementHtml : wrapped.outerHTML;

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
    html,
    elementHtml,
    css: out.css,
    context,
    surface,
    assets: assets.list.map((a) => ({ token: a.token, url: a.url, kind: a.kind })),
    truncated: cloned.truncated,
    meta: {
      label: label(el),
      slug: slug(el),
      selector: options.selector || '',
      sourceUrl: location.href,
      pageTitle: document.title || '',
      tag: el.nodeName.toLowerCase(),
      box: { w: Math.round(r.width), h: Math.round(r.height) },
      nodeCount,
      nodeLimit: MAX_NODES,
      truncated: cloned.truncated,
      truncatedReason: cloned.truncatedReason,
      mode,
      blockedSheets: out.blocked,
      ruleCount: out.ruleCount,
      cssTruncated: !!out.truncated,
      ancestorContext: shellCount,
      warnings,
      capturedAt: new Date().toISOString(),
    },
  };
}

module.exports = { collect, MAX_NODES, internals: { tokenizeSrcset, tokenizeCssUrls, createAssetTable, rewriteDocumentSelector } };
