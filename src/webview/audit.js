// Braiwser — audit.js
//
// A dependency-free accessibility & UI-quality audit that runs INSIDE the guest
// page (it is required by the inspector preload, so it has full DOM + computed
// style access). Everything here is local: no network, no API key, no build
// step — the audit works offline on any page the browser can open.
//
// Each finding carries a stable `ruleId`, a severity, a human explanation, and
// an anchor `target` produced by anchor.js, so a finding can be located on the
// page or promoted into a real annotation with one click.

const RULES = {
  'doc-lang': { severity: 'serious', title: 'Document has no language', help: 'Add lang="…" to <html> so screen readers use the right pronunciation.' },
  'doc-title': { severity: 'serious', title: 'Document has no title', help: 'Give the page a descriptive, unique <title>.' },
  'doc-viewport': { severity: 'moderate', title: 'No responsive viewport meta', help: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> so the page adapts on mobile.' },
  'landmark-main': { severity: 'minor', title: 'No main landmark', help: 'Wrap the primary content in <main> (or role="main") so assistive tech can skip to it.' },
  'img-alt': { severity: 'serious', title: 'Image has no alt text', help: 'Add alt="…" describing the image, or alt="" if it is purely decorative.' },
  'img-broken': { severity: 'serious', title: 'Image failed to load', help: 'The src does not resolve to an image — fix the path or remove the element.' },
  'control-name': { severity: 'critical', title: 'Control has no accessible name', help: 'Give it visible text, aria-label, or aria-labelledby so it can be announced and targeted.' },
  'form-label': { severity: 'critical', title: 'Form field has no label', help: 'Associate a <label for="…">, or add aria-label / aria-labelledby.' },
  'link-no-href': { severity: 'moderate', title: 'Link is not a real link', help: 'An <a> without href is not focusable or clickable by keyboard — use <button> or add href.' },
  'contrast': { severity: 'serious', title: 'Low text contrast', help: 'WCAG AA needs 4.5:1 for body text and 3:1 for large text.' },
  'heading-order': { severity: 'moderate', title: 'Heading level skipped', help: 'Headings should step down one level at a time so the outline stays parseable.' },
  'heading-no-h1': { severity: 'moderate', title: 'Page has no <h1>', help: 'Every page needs exactly one top-level heading naming the page.' },
  'tap-target': { severity: 'moderate', title: 'Tap target is too small', help: 'Interactive targets should be at least 24×24 CSS pixels (WCAG 2.2 AA).' },
  'duplicate-id': { severity: 'moderate', title: 'Duplicate element id', help: 'Ids must be unique — duplicates break label/aria references and querySelector.' },
  'positive-tabindex': { severity: 'moderate', title: 'Positive tabindex', help: 'tabindex greater than 0 fights the natural focus order. Use 0 and fix the DOM order instead.' },
  'iframe-title': { severity: 'moderate', title: 'Frame has no title', help: 'Add title="…" to the iframe so its purpose is announced.' },
  'tiny-text': { severity: 'minor', title: 'Very small text', help: 'Text below 11px is hard to read; prefer 12px or larger for body copy.' },
};

const MAX_ELEMENTS = 4000; // keep a huge page from freezing the audit
const MAX_FINDINGS_PER_RULE = 25;

// ---------------------------------------------------------------- utilities

function isOwn(el) {
  try {
    return !!(el && el.closest && el.closest('[data-caos], #__caos_root'));
  } catch (_e) {
    return false;
  }
}

function visible(el, style) {
  const s = style || getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function textOf(el) {
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}

// Accessible name, approximated: aria-label / aria-labelledby / visible text /
// title / alt / value. Good enough to catch the controls that have *nothing*.
function accessibleName(el) {
  const aria = el.getAttribute && el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const named = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map(textOf)
      .join(' ')
      .trim();
    if (named) return named;
  }
  const text = textOf(el);
  if (text) return text;
  for (const attr of ['title', 'alt', 'value', 'placeholder']) {
    const v = el.getAttribute && el.getAttribute(attr);
    if (v && v.trim()) return v.trim();
  }
  // An icon-only control is still named if it wraps a titled/labelled image.
  const img = el.querySelector && el.querySelector('img[alt]:not([alt=""]), svg > title');
  if (img) return (img.getAttribute && img.getAttribute('alt')) || textOf(img);
  return '';
}

function labelFor(el) {
  const id = el.getAttribute('id');
  if (id) {
    const esc = window.CSS && CSS.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    const lbl = document.querySelector(`label[for="${esc}"]`);
    if (lbl && textOf(lbl)) return textOf(lbl);
  }
  const wrapper = el.closest && el.closest('label');
  if (wrapper && textOf(wrapper)) return textOf(wrapper);
  return '';
}

// ---------------------------------------------------------------- contrast

function parseColor(value) {
  const m = String(value || '').match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

function relativeLuminance({ r, g, b }) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function blend(fg, bg) {
  const a = fg.a == null ? 1 : fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

// Walk ancestors for the first opaque-enough background; default to white.
function effectiveBackground(el) {
  let node = el;
  let acc = null;
  while (node && node.nodeType === 1) {
    const c = parseColor(getComputedStyle(node).backgroundColor);
    if (c && c.a > 0) {
      acc = acc ? blend(acc, c) : c;
      if (acc.a >= 0.999 || c.a >= 0.999) return { ...acc, a: 1 };
    }
    node = node.parentElement;
  }
  const page = parseColor(getComputedStyle(document.documentElement).backgroundColor);
  const base = page && page.a > 0 ? page : { r: 255, g: 255, b: 255, a: 1 };
  return acc ? blend(acc, base) : base;
}

function contrastRatio(a, b) {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// WCAG "large text": >= 24px, or >= 18.66px when bold.
function isLargeText(style) {
  const size = parseFloat(style.fontSize) || 16;
  const weight = Number(style.fontWeight) || (style.fontWeight === 'bold' ? 700 : 400);
  return size >= 24 || (size >= 18.66 && weight >= 700);
}

// Does this element directly own visible text (rather than only via children)?
function ownsText(el) {
  for (const node of el.childNodes) {
    if (node.nodeType === 3 && node.nodeValue && node.nodeValue.trim()) return true;
  }
  return false;
}

// ---------------------------------------------------------------- the audit

const INTERACTIVE = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [onclick], [tabindex]';

function runAudit({ describe } = {}) {
  const findings = [];
  const counts = {};
  const seenPerRule = {};

  const push = (ruleId, el, detail, extra) => {
    seenPerRule[ruleId] = (seenPerRule[ruleId] || 0) + 1;
    if (seenPerRule[ruleId] > MAX_FINDINGS_PER_RULE) return;
    const rule = RULES[ruleId];
    let target = null;
    try {
      target = el && describe ? describe(el) : null;
    } catch (_e) {
      target = null;
    }
    findings.push({
      id: `${ruleId}-${findings.length}`,
      ruleId,
      severity: rule.severity,
      title: rule.title,
      help: rule.help,
      detail: detail || '',
      selector: (target && target.selector) || '',
      snippet: el && el.nodeType === 1 ? outline(el) : '',
      target,
      ...(extra || {}),
    });
    counts[rule.severity] = (counts[rule.severity] || 0) + 1;
  };

  // ---- document-level rules
  const html = document.documentElement;
  if (!html.getAttribute('lang')) push('doc-lang', html, 'The <html> element has no lang attribute.');
  const title = (document.title || '').trim();
  if (!title) push('doc-title', html, 'The document <title> is empty.');
  if (!document.querySelector('meta[name="viewport"]')) {
    push('doc-viewport', html, 'No <meta name="viewport"> — the page will not scale on phones.');
  }
  if (!document.querySelector('main, [role="main"]')) {
    push('landmark-main', document.body || html, 'No <main> element or role="main" on the page.');
  }

  // ---- duplicate ids
  const idSeen = new Map();
  for (const el of document.querySelectorAll('[id]')) {
    if (isOwn(el)) continue;
    const id = el.id;
    if (!id) continue;
    if (idSeen.has(id)) push('duplicate-id', el, `id="${id}" is used more than once.`);
    else idSeen.set(id, el);
  }

  // ---- headings
  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter((el) => !isOwn(el));
  if (!headings.some((el) => el.tagName === 'H1')) {
    push('heading-no-h1', headings[0] || document.body || html, 'No <h1> found on the page.');
  }
  let prevLevel = 0;
  for (const el of headings) {
    const level = Number(el.tagName.slice(1));
    if (prevLevel && level > prevLevel + 1) {
      push('heading-order', el, `<h${prevLevel}> is followed by <h${level}> — a level was skipped.`);
    }
    prevLevel = level;
  }

  // ---- element sweep
  const all = Array.from(document.body ? document.body.querySelectorAll('*') : []).slice(0, MAX_ELEMENTS);
  for (const el of all) {
    if (isOwn(el)) continue;
    const tag = el.tagName.toLowerCase();
    let style;
    try {
      style = getComputedStyle(el);
    } catch (_e) {
      continue;
    }
    const shown = visible(el, style);

    if (tag === 'img') {
      const role = (el.getAttribute('role') || '').toLowerCase();
      const decorative = role === 'presentation' || role === 'none' || el.getAttribute('alt') === '';
      if (!el.hasAttribute('alt') && !decorative && !el.getAttribute('aria-label')) {
        push('img-alt', el, `<img src="${(el.getAttribute('src') || '').slice(0, 120)}"> has no alt attribute.`);
      }
      if (el.complete && el.naturalWidth === 0 && el.getAttribute('src')) {
        push('img-broken', el, `Image did not load: ${(el.getAttribute('src') || '').slice(0, 160)}`);
      }
    }

    if (tag === 'iframe' && !el.getAttribute('title') && !el.getAttribute('aria-label')) {
      push('iframe-title', el, 'Frame has neither title nor aria-label.');
    }

    const tabindex = el.getAttribute('tabindex');
    if (tabindex && Number(tabindex) > 0) {
      push('positive-tabindex', el, `tabindex="${tabindex}" overrides the natural tab order.`);
    }

    if (tag === 'a' && !el.hasAttribute('href') && !el.getAttribute('role')) {
      push('link-no-href', el, 'Anchor has no href, so it is not keyboard-reachable.');
    }

    // Form fields need a label; other controls need any accessible name.
    const isField = tag === 'select' || tag === 'textarea' || (tag === 'input' && !/^(hidden|submit|button|reset|image)$/i.test(el.type || ''));
    if (isField && shown) {
      if (!labelFor(el) && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !el.getAttribute('title')) {
        push('form-label', el, `<${tag}${el.type ? ` type="${el.type}"` : ''}> has no associated label.`);
      }
    } else if (shown && (tag === 'button' || (tag === 'a' && el.hasAttribute('href')) || /^(button|link)$/.test(el.getAttribute('role') || ''))) {
      if (!accessibleName(el)) {
        push('control-name', el, `<${tag}> is interactive but announces as empty.`);
      }
    }

    if (!shown) continue;

    // Tap targets — only leaf-ish interactive controls, and never inline links
    // inside a paragraph (where the 24px rule does not apply).
    if (el.matches(INTERACTIVE) && style.display !== 'inline') {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24)) {
        push('tap-target', el, `Rendered ${Math.round(r.width)}×${Math.round(r.height)} px — below the 24×24 minimum.`);
      }
    }

    if (ownsText(el)) {
      const size = parseFloat(style.fontSize) || 16;
      if (size > 0 && size < 11) {
        push('tiny-text', el, `Font size is ${size.toFixed(1)}px.`);
      }
      const fg = parseColor(style.color);
      if (fg && fg.a > 0.1) {
        const bg = effectiveBackground(el);
        const ratio = contrastRatio(blend(fg, bg), bg);
        const min = isLargeText(style) ? 3 : 4.5;
        if (ratio < min) {
          push(
            'contrast',
            el,
            `Contrast ${ratio.toFixed(2)}:1 (needs ${min}:1) — ${style.color} on rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)}).`,
            { ratio: Number(ratio.toFixed(2)), required: min }
          );
        }
      }
    }
  }

  const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    at: new Date().toISOString(),
    url: location.href,
    title: document.title || location.href,
    scanned: all.length,
    truncated: all.length >= MAX_ELEMENTS,
    counts,
    total: findings.length,
    findings,
  };
}

// A one-line source outline of the element, for display next to a finding.
function outline(el) {
  let s = '<' + el.tagName.toLowerCase();
  if (el.id) s += ` id="${el.id}"`;
  const cls = el.getAttribute && el.getAttribute('class');
  if (cls) s += ` class="${String(cls).slice(0, 60)}"`;
  s += '>';
  const t = textOf(el);
  if (t) s += ' ' + (t.length > 60 ? t.slice(0, 59) + '…' : t);
  return s;
}

module.exports = { runAudit, RULES };
