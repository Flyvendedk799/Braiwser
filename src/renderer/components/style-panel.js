// Style tab (right panel): the properties editor for whatever Edit mode has
// selected — copy, type, colour, spacing, size. Every control applies live to
// the page as you drag or type, and commits on change-end, where the guest
// folds the whole visit into ONE edit note carrying the exact CSS.
//
// Two things make it feel like an editor rather than a form: every property you
// have touched is marked and individually revertible, and every number can be
// scrubbed by dragging its label.
//
// Numbers and units (RF-07). A control's number and its unit always come from the
// SAME source: the element's inline declaration when it is a length this panel
// can express (2rem, 50%, 1.5em, 12px), otherwise the computed pixel value with
// "px". Mixing the two used to show a computed 32px beside an inline "rem", so
// merely focusing and leaving the field wrote 32rem. Each input also tracks
// whether it is dirty; blur / change with nothing edited sends NOTHING. Changing
// the unit converts the number deliberately (same rendered size) when the
// conversion is knowable; when it is not, the field is cleared for a fresh value
// rather than silently re-labelling the old one.
//
// Guest payload fields consumed here (all degrade gracefully when absent):
//   info.specified[prop]   { raw, value, unit, source:'inline'|'computed', unsupported? }
//                          the number+unit pair from ONE source (preferred)
//   info.inline[prop]      the inline declaration, e.g. "2rem" (fallback when the
//                          guest sends no `specified`)
//   info.metrics           optional { rootFontSize, parentFontSize, parentWidth,
//                          parentHeight } in px, used only to convert between units.
//   info.session           { active, changed:[props] } (a style visit in progress)
//   info.inlinePriority    { prop: 'important'|'' } (shown as a tooltip note)
import { h, icon, clear } from '../lib/dom.js';
import { displayName, selectorLabel } from '../lib/naming.js';

const FONT_STACKS = [
  ['', 'Keep current'],
  ['system-ui, -apple-system, Segoe UI, Roboto, sans-serif', 'System sans'],
  ['Georgia, "Times New Roman", serif', 'Serif'],
  ['ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', 'Monospace'],
  ['Inter, system-ui, sans-serif', 'Inter'],
  ['"Helvetica Neue", Helvetica, Arial, sans-serif', 'Helvetica'],
  ['Arial, sans-serif', 'Arial'],
  ['"Courier New", monospace', 'Courier'],
];

const WEIGHTS = ['', '300', '400', '500', '600', '700', '800', '900'];
const ALIGNS = [
  ['left', 'L', 'Left'],
  ['center', 'C', 'Centre'],
  ['right', 'R', 'Right'],
  ['justify', 'J', 'Justify'],
];
const SIZE_UNITS = ['px', 'rem', 'em', '%'];

// "16px" -> 16 ; "normal" -> '' — and 28.015625px -> 28, because nobody types
// a sixteenth of a pixel.
function num(v, places = 1) {
  const m = /(-?[\d.]+)/.exec(String(v == null ? '' : v));
  if (!m) return '';
  const f = Math.pow(10, places);
  return Math.round(parseFloat(m[1]) * f) / f;
}

const round = (n, places = 2) => {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
};

// An inline length this panel can show faithfully: "2rem" -> {value:2, unit:'rem'}.
export function parseLength(v) {
  const m = /^\s*(-?(?:\d+\.?\d*|\.\d+))(px|rem|em|%)\s*$/i.exec(String(v == null ? '' : v));
  return m ? { value: parseFloat(m[1]), unit: m[2].toLowerCase() } : null;
}

// Number + unit for a unit-bearing control, both from ONE source.
export function lengthSource(prop, computed, inline, specified) {
  const spec = specified && specified[prop];
  if (spec && typeof spec === 'object') {
    const unit = spec.unit === '' && spec.value === 0 ? 'px' : spec.unit;
    if (spec.source === 'inline' && !spec.unsupported && Number.isFinite(spec.value) && SIZE_UNITS.includes(unit)) {
      return { value: round(spec.value), unit, from: 'inline' };
    }
    // An inline value the panel cannot express (calc(), vw, var()…): never pair
    // its unit with a number from somewhere else — show the computed px instead.
    const px = Number.isFinite(spec.computedPx) ? spec.computedPx : null;
    if (px != null) return { value: num(px), unit: 'px', from: 'computed' };
  }
  const inl = parseLength(inline && inline[prop]);
  if (inl) return { value: round(inl.value), unit: inl.unit, from: 'inline' };
  return { value: num((computed || {})[prop]), unit: 'px', from: 'computed' };
}

// Pixels per one unit, or null when the base is not known.
function pxPer(unit, base) {
  if (unit === 'px') return 1;
  if (unit === 'rem') return base.root > 0 ? base.root : null;
  if (unit === 'em') return base.em > 0 ? base.em : null;
  if (unit === '%') return base.percent > 0 ? base.percent / 100 : null;
  return null;
}

// Convert so the rendered size stays the same; null when a needed base is unknown.
export function convertLength(value, from, to, base) {
  if (from === to) return value;
  const a = pxPer(from, base);
  const b = pxPer(to, base);
  if (a == null || b == null) return null;
  return round((value * a) / b);
}

// rgb(a) -> #rrggbb, for <input type="color">, which speaks nothing else.
function hex(v) {
  const s = String(v || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
  const m = /rgba?\(([^)]+)\)/i.exec(s);
  if (!m) return '';
  const p = m[1].split(',').map((x) => parseFloat(x));
  if (p.length < 3 || p.some((x) => isNaN(x))) return '';
  return (
    '#' +
    p
      .slice(0, 3)
      .map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0'))
      .join('')
  );
}

function isTransparent(v) {
  return /rgba\(0,\s*0,\s*0,\s*0\)|transparent/i.test(String(v || ''));
}

// Computed font stacks come back quoted differently than they were written, so
// match on the shape rather than the string.
function matchFont(options, value) {
  const norm = (v) => String(v || '').replace(/["']/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(value);
  if (!want) return '';
  const hit = options.find(([v]) => v && norm(v) === want);
  return hit ? hit[0] : '';
}

export function createStylePanel(actions) {
  let info = null; // last caos:style-picked payload
  let editingText = false;

  const header = h('div', { class: 'st-header' });
  const body = h('div', { class: 'st-body' });
  const root = h('div', { class: 'tab-body', dataset: { tab: 'style' } }, [header, body]);

  const touched = () => (info && info.inline) || {};

  function empty() {
    clear(header);
    clear(body);
    body.appendChild(
      h('div', { class: 'placeholder' }, [
        h('div', { class: 'ph-icon', html: icon('edit', 26) }),
        h('div', { class: 'ph-title', text: 'Nothing selected' }),
        h('div', {
          class: 'ph-sub',
          text: 'Turn on Edit and click any element — or double-click one in Inspect — to change its copy, type, colour, spacing and size.',
        }),
      ])
    );
  }

  // ---- control primitives ----------------------------------------------------
  // Controls apply live on input and commit on change-end; the guest keeps both
  // in one note, so a slider does not file forty of them.
  function row(label, control, props) {
    const changed = (props || []).some((p) => touched()[p] != null);
    const labelEl = h('span', { class: 'st-label' + (changed ? ' changed' : ''), text: label });
    const kids = [labelEl, control];
    if (changed) {
      kids.push(
        h('button', {
          class: 'st-clear',
          title: 'Revert ' + (props.length > 1 ? 'these' : 'this') + ' to the page’s own CSS',
          'aria-label': 'Revert ' + label + ' to the page’s own CSS',
          html: icon('close', 11),
          on: {
            click: () => {
              const patch = {};
              props.forEach((p) => (patch[p] = ''));
              actions.apply(patch, true);
            },
          },
        })
      );
    }
    return h('div', { class: 'st-row' }, kids);
  }

  // Drag any numeric label sideways to scrub its value — the gesture every
  // design tool has, and the fastest way to find the size that looks right.
  function scrubbable(el, get, set) {
    el.classList.add('st-scrub');
    el.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startVal = parseFloat(get()) || 0;
      let moved = false;
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        const step = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
        set(Math.round((startVal + dx * step) * 100) / 100, false);
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        if (moved) set(parseFloat(get()) || 0, true);
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    });
  }

  // opts: { min, max, step, unit, width, units, label, convert, note }
  //   convert(value, fromUnit, toUnit) -> number | null   (unit conversion)
  //   note: tooltip explaining where the shown value came from
  function numberInput(prop, value, opts = {}) {
    const { min, max, step, unit = 'px', width, units, label, convert, note } = opts;
    const initial = value === '' || value == null ? '' : String(value);
    const input = h('input', {
      class: 'st-num',
      type: 'number',
      value: initial,
      min: min != null ? String(min) : null,
      max: max != null ? String(max) : null,
      step: step != null ? String(step) : '1',
      style: width ? { width } : null,
      'aria-label': label || prop,
      title: note || null,
    });
    let currentUnit = unit;
    // What the page already has: nothing is sent until the user departs from it.
    let committedValue = initial;
    let committedUnit = unit;
    let liveDirty = false; // an input/scrub event pushed a live preview
    let pending = null; // { value, unit }: number cleared by an unconvertible unit change
    const isDirty = () => liveDirty || input.value !== committedValue || currentUnit !== committedUnit;
    const send = (commit) => {
      const v = input.value === '' ? '' : input.value + (currentUnit || '');
      if (commit) {
        committedValue = input.value;
        committedUnit = currentUnit;
        liveDirty = false;
      }
      pending = null;
      actions.apply({ [prop]: v }, commit);
    };
    const settle = () => { if (isDirty()) send(true); };
    input.addEventListener('input', () => {
      // A half-typed "1e" reads as '' in a number input: that is not a request to
      // clear the property.
      if (input.validity && input.validity.badInput) return;
      liveDirty = true;
      send(false);
    });
    input.addEventListener('change', settle);
    input.addEventListener('blur', settle);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') input.blur();
    });
    // Programmatic edits (scrubbing) go through the same dirty bookkeeping.
    const setValue = (v, commit) => {
      input.value = String(v);
      liveDirty = true;
      send(commit);
    };
    if (!units) return { el: input, input, setValue, getUnit: () => currentUnit, isDirty };

    const sel = h(
      'select',
      { class: 'st-unit', 'aria-label': (label || prop) + ' unit' },
      units.map((u) => h('option', { value: u, text: u }))
    );
    sel.value = unit;
    sel.addEventListener('change', () => {
      const from = currentUnit;
      const to = sel.value;
      if (from === to) return;
      if (input.value === '' && pending && pending.unit === to) {
        // Back to the unit that was cleared: hand the old number back, unchanged.
        currentUnit = to;
        input.value = pending.value;
        committedValue = pending.value;
        committedUnit = to;
        pending = null;
        input.removeAttribute('title');
        return;
      }
      if (input.value === '') {
        currentUnit = to; // nothing to convert; the next number typed uses it
        if (isDirty()) send(true);
        return;
      }
      const typed = liveDirty || input.value !== committedValue;
      if (typed) {
        // The user entered this number on purpose: it keeps its value, and the
        // unit they chose is applied to it.
        currentUnit = to;
        send(true);
        return;
      }
      const converted = convert ? convert(parseFloat(input.value), from, to) : null;
      if (converted == null || Number.isNaN(converted)) {
        // The same rendered size is not computable (e.g. the parent's size is
        // unknown). Do not re-label 500px as 500%: clear the field, send nothing,
        // and wait for a value in the new unit.
        pending = { value: input.value, unit: from };
        currentUnit = to;
        input.value = '';
        input.placeholder = to;
        committedValue = '';
        committedUnit = to;
        liveDirty = false;
        input.title = 'Can’t convert to ' + to + ' without the surrounding size — type a value in ' + to + '.';
        return;
      }
      currentUnit = to;
      input.value = String(converted);
      send(true);
    });
    return { el: h('div', { class: 'st-inline' }, [input, sel]), input, setValue, getUnit: () => currentUnit, isDirty };
  }

  function numberRow(label, prop, value, opts = {}) {
    const ctl = numberInput(prop, value, { label, ...opts });
    const r = row(label, ctl.el, [prop]);
    const labelEl = r.querySelector('.st-label');
    scrubbable(labelEl, () => ctl.input.value, (v, commit) => ctl.setValue(v, commit));
    return r;
  }

  function swatchRow(prop, value, { allowNone } = {}) {
    const swatch = h('input', { class: 'st-color', type: 'color', value: hex(value) || '#000000', 'aria-label': prop + ' colour picker' });
    const text = h('input', {
      class: 'st-hex',
      type: 'text',
      'aria-label': prop + ' colour value',
      value: isTransparent(value) ? '' : hex(value) || '',
      placeholder: allowNone ? 'none' : '',
    });
    const push = (v, commit) => {
      text.value = v;
      if (hex(v)) swatch.value = hex(v);
      actions.apply({ [prop]: v || (allowNone ? 'transparent' : '') }, commit);
    };
    swatch.addEventListener('input', () => push(swatch.value, false));
    swatch.addEventListener('change', () => push(swatch.value, true));
    text.addEventListener('change', () => push(text.value.trim(), true));

    // The colours the page already uses, one click away.
    const palette = h(
      'div',
      { class: 'st-palette' },
      ((info && info.pageColors) || []).map((cHex) =>
        h('button', {
          class: 'st-swatch',
          title: cHex,
          'aria-label': 'Use ' + cHex,
          style: { background: cHex },
          on: { click: () => push(cHex, true) },
        })
      )
    );
    return h('div', { class: 'st-color-block' }, [h('div', { class: 'st-color-wrap' }, [swatch, text]), palette]);
  }

  function selectInput(prop, options, value, label) {
    const sel = h(
      'select',
      { class: 'st-select', 'aria-label': label || prop },
      options.map(([v, label]) => h('option', { value: v, text: label }))
    );
    sel.value = options.some(([v]) => v === value) ? value : options[0][0];
    sel.addEventListener('change', () => actions.apply({ [prop]: sel.value }, true));
    return sel;
  }

  function rangeInput(prop, value, { min = 0, max = 1, step = 0.05, unit = '' } = {}) {
    const r = h('input', { class: 'st-range', 'aria-label': prop, type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    const out = h('span', { class: 'st-range-val', text: String(value) });
    r.addEventListener('input', () => {
      out.textContent = r.value;
      actions.apply({ [prop]: r.value + unit }, false);
    });
    r.addEventListener('change', () => actions.apply({ [prop]: r.value + unit }, true));
    return h('div', { class: 'st-range-wrap' }, [r, out]);
  }

  // A row of on/off buttons that each toggle one property between two values.
  function toggles(defs) {
    return h(
      'div',
      { class: 'st-seg' },
      defs.map(([prop, on, off, label, title]) => {
        const isOn = (info.computed[prop] || '').indexOf(on) !== -1;
        return h('button', {
          class: 'st-seg-btn' + (isOn ? ' on' : ''),
          text: label,
          title,
          'aria-pressed': isOn ? 'true' : 'false',
          on: { click: () => actions.apply({ [prop]: isOn ? off : on }, true) },
        });
      })
    );
  }

  function sideBox(kind, c) {
    // padding / margin as four small boxes, in the order everyone reads them.
    const mk = (side) => {
      const prop = kind + '-' + side;
      const inl = touched()[prop];
      const ctl = numberInput(prop, num(c[prop]), {
        width: '44px',
        label: kind + ' ' + side,
        note: inl != null && !/^-?[\d.]+px$/.test(String(inl)) ? 'Page CSS: ' + inl + ' — shown as computed px' : null,
      });
      const label = h('span', { class: 'st-side-label' + (touched()[prop] != null ? ' changed' : ''), text: side[0].toUpperCase() });
      scrubbable(label, () => ctl.input.value, (v, commit) => ctl.setValue(v, commit));
      return h('div', { class: 'st-side' }, [label, ctl.el]);
    };
    return h('div', { class: 'st-sides' }, ['top', 'right', 'bottom', 'left'].map(mk));
  }

  // A unit-bearing length (font-size / width / height): number and unit are read
  // from one source, and unit changes convert using what the guest can tell us.
  function lengthRow(label, prop, range) {
    const c = (info && info.computed) || {};
    const src = lengthSource(prop, c, touched(), info && info.specified);
    const m = (info && info.metrics) || {};
    const ownFont = num(c['font-size'], 2) || null;
    const base = {
      root: m.rootFontSize || 16,
      // font-size's em/% are relative to the PARENT's font size; width/height's
      // em is the element's own font size.
      em: prop === 'font-size' ? m.parentFontSize || null : ownFont,
      percent: prop === 'font-size' ? m.parentFontSize || null : prop === 'height' ? m.parentHeight || null : m.parentWidth || null,
    };
    const spec = info && info.specified && info.specified[prop];
    const raw = spec && spec.source === 'inline' ? spec.raw : touched()[prop];
    const important = info && info.inlinePriority && info.inlinePriority[prop] === 'important' ? ' !important' : '';
    const note = src.from === 'computed' && raw != null && raw !== ''
      ? 'Page CSS: ' + raw + important + ' — can’t be shown as a plain length, so the computed px is shown'
      : src.from === 'inline' ? 'Page CSS: ' + raw + important : null;
    return numberRow(label, prop, src.value, {
      ...range,
      unit: src.unit,
      units: SIZE_UNITS,
      note,
      convert: (v, from, to) => convertLength(v, from, to, base),
    });
  }

  function group(title, children) {
    return h('div', { class: 'st-group' }, [h('div', { class: 'st-group-title', text: title })].concat(children.filter(Boolean)));
  }

  // ---- render ------------------------------------------------------------------
  function render() {
    if (!info) {
      empty();
      return;
    }
    const c = info.computed || {};
    const inline = info.inline || {};
    const changedCount = Object.keys(inline).length;

    clear(header);
    header.appendChild(
      h('div', { class: 'st-target' }, [
        h('button', {
          class: 'st-up',
          title: 'Select the parent element',
          'aria-label': 'Select the parent element',
          html: icon('chevron', 12),
          on: { click: () => actions.selectParent() },
        }),
        h('span', { class: 'st-target-name', text: displayName(info.brief || {}) }),
        h('span', { class: 'st-target-sel', text: selectorLabel(info.brief || {}) }),
        h('span', { class: 'st-grow' }),
        h('span', { class: 'st-size', text: info.box ? info.box.w + '×' + info.box.h : '' }),
      ])
    );
    header.appendChild(
      h('div', { class: 'st-actions' }, [
        h('span', { class: 'st-changed-count', text: changedCount ? changedCount + (changedCount === 1 ? ' change' : ' changes') : 'No changes yet' }),
        h('span', { class: 'st-grow' }),
        // Take the piece with you: markup + the CSS that applies to it + its
        // assets, as one .html file, or a .zip when the assets are real files.
        h('button', {
          class: 'btn btn-sm st-export',
          text: 'Export',
          title: 'Export this element as a standalone file (or a .zip when it carries assets)',
          on: { click: () => actions.exportElement() },
        }),
        changedCount
          ? h('button', {
              class: 'btn btn-sm',
              text: 'Copy CSS',
              title: 'Copy this element’s changes as CSS',
              on: { click: () => actions.copyCss(cssText(inline)) },
            })
          : null,
        changedCount
          ? h('button', {
              class: 'btn btn-sm',
              text: 'Reset',
              title: 'Undo the changes you made to this element in this visit',
              on: { click: () => actions.reset() },
            })
          : null,
      ])
    );

    clear(body);

    // Copy — the thing people reach for first.
    if (info.editableText) {
      const ta = h('textarea', { class: 'st-text', value: info.text || '', rows: '3' });
      const commit = () => {
        if (ta.value !== (info.text || '')) actions.setText(ta.value);
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit();
          ta.blur();
        }
      });
      ta.addEventListener('blur', commit);
      body.appendChild(
        group('Content', [ta, h('div', { class: 'st-hint', text: 'Edit here, or double-click the text on the page.' })])
      );
    }

    const fonts = (info.pageFonts || []).map((f) => [f, f.split(',')[0].replace(/["']/g, '').slice(0, 24)]);
    const fontOptions = FONT_STACKS.concat(fonts.filter((f) => !FONT_STACKS.some(([v]) => v === f[0])));

    body.appendChild(
      group('Type', [
        row('Font', selectInput('font-family', fontOptions, matchFont(fontOptions, inline['font-family'] || c['font-family']), 'Font'), ['font-family']),
        lengthRow('Size', 'font-size', { min: 1, max: 400 }),
        row('Weight', selectInput('font-weight', WEIGHTS.map((w) => [w, w || 'Keep current']), inline['font-weight'] || String(num(c['font-weight'], 0) || ''), 'Weight'), ['font-weight']),
        numberRow('Line height', 'line-height', num(c['line-height']), { min: 0, max: 400 }),
        numberRow('Letter spacing', 'letter-spacing', num(c['letter-spacing'], 2), { min: -20, max: 40, step: 0.1 }),
        row('Align', h('div', { class: 'st-seg' }, ALIGNS.map(([v, short, label]) =>
          h('button', {
            class: 'st-seg-btn' + (c['text-align'] === v ? ' on' : ''),
            text: short,
            title: label,
            'aria-label': label,
            'aria-pressed': c['text-align'] === v ? 'true' : 'false',
            on: { click: () => actions.apply({ 'text-align': v }, true) },
          })
        )), ['text-align']),
        row('Style', toggles([
          ['font-style', 'italic', 'normal', 'I', 'Italic'],
          ['text-decoration-line', 'underline', 'none', 'U', 'Underline'],
          ['text-transform', 'uppercase', 'none', 'AA', 'Uppercase'],
        ]), ['font-style', 'text-decoration-line', 'text-transform']),
        row('Colour', swatchRow('color', c.color), ['color']),
      ])
    );

    body.appendChild(
      group('Appearance', [
        row('Opacity', rangeInput('opacity', num(c.opacity, 2) === '' ? 1 : num(c.opacity, 2), { min: 0, max: 1, step: 0.05 }), ['opacity']),
        row('Background', swatchRow('background-color', c['background-color'], { allowNone: true }), ['background-color']),
        numberRow('Radius', 'border-radius', num(c['border-radius']), { min: 0, max: 400 }),
        row('Border', h('div', { class: 'st-inline' }, [
          numberInput('border-width', num(c['border-width']), { min: 0, max: 40, width: '48px', label: 'Border width' }).el,
          selectInput('border-style', [['solid', 'solid'], ['dashed', 'dashed'], ['dotted', 'dotted'], ['none', 'none']], c['border-style'], 'Border style'),
        ]), ['border-width', 'border-style']),
        row('Border colour', swatchRow('border-color', c['border-color']), ['border-color']),
      ])
    );

    body.appendChild(group('Spacing', [row('Padding', sideBox('padding', c)), row('Margin', sideBox('margin', c))]));

    body.appendChild(
      group('Size', [
        lengthRow('Width', 'width', { min: 0, max: 4000 }),
        lengthRow('Height', 'height', { min: 0, max: 4000 }),
        h('div', { class: 'st-hint', text: 'Drag a label sideways to scrub it. Shift for ×10, Alt for tenths.' }),
      ])
    );

    if (editingText) body.appendChild(h('div', { class: 'st-editing', text: 'Typing on the page — click away or press Esc to finish.' }));
  }

  function cssText(inline) {
    return Object.keys(inline)
      .map((k) => k + ': ' + inline[k] + ';')
      .join('\n');
  }

  function setStyle(next) {
    info = next || null;
    render();
  }

  function setTextEditing(on) {
    editingText = !!on;
  }

  empty();
  return { root, setStyle, setTextEditing, hasSelection: () => !!info };
}
