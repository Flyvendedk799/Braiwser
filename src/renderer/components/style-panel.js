// Style tab (right panel): the properties editor for whatever Edit mode has
// selected — copy, type, colour, spacing, size. Every control applies live to
// the page as you drag or type, and commits on change-end, where the guest
// folds the whole visit into ONE edit note carrying the exact CSS.
//
// Two things make it feel like an editor rather than a form: every property you
// have touched is marked and individually revertible, and every number can be
// scrubbed by dragging its label.
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

function unitOf(v, fallback = 'px') {
  const m = /[\d.](px|rem|em|%|vh|vw)\s*$/.exec(String(v || ''));
  return m ? m[1] : fallback;
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

  function numberInput(prop, value, opts = {}) {
    const { min, max, step, unit = 'px', width, units } = opts;
    const input = h('input', {
      class: 'st-num',
      type: 'number',
      value: value === '' ? '' : String(value),
      min: min != null ? String(min) : null,
      max: max != null ? String(max) : null,
      step: step != null ? String(step) : '1',
      style: width ? { width } : null,
    });
    let currentUnit = unit;
    const send = (commit) => {
      const v = input.value === '' ? '' : input.value + (currentUnit || '');
      actions.apply({ [prop]: v }, commit);
    };
    input.addEventListener('input', () => send(false));
    input.addEventListener('change', () => send(true));
    input.addEventListener('blur', () => send(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') input.blur();
    });
    if (!units) return { el: input, input, setUnit: () => {}, getUnit: () => currentUnit };

    const sel = h(
      'select',
      { class: 'st-unit' },
      units.map((u) => h('option', { value: u, text: u }))
    );
    sel.value = unit;
    sel.addEventListener('change', () => {
      currentUnit = sel.value;
      send(true);
    });
    return { el: h('div', { class: 'st-inline' }, [input, sel]), input, getUnit: () => currentUnit };
  }

  function numberRow(label, prop, value, opts = {}) {
    const ctl = numberInput(prop, value, opts);
    const r = row(label, ctl.el, [prop]);
    const labelEl = r.querySelector('.st-label');
    scrubbable(labelEl, () => ctl.input.value, (v, commit) => {
      ctl.input.value = String(v);
      actions.apply({ [prop]: v + (ctl.getUnit() || '') }, commit);
    });
    return r;
  }

  function swatchRow(prop, value, { allowNone } = {}) {
    const swatch = h('input', { class: 'st-color', type: 'color', value: hex(value) || '#000000' });
    const text = h('input', {
      class: 'st-hex',
      type: 'text',
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
          style: { background: cHex },
          on: { click: () => push(cHex, true) },
        })
      )
    );
    return h('div', { class: 'st-color-block' }, [h('div', { class: 'st-color-wrap' }, [swatch, text]), palette]);
  }

  function selectInput(prop, options, value) {
    const sel = h(
      'select',
      { class: 'st-select' },
      options.map(([v, label]) => h('option', { value: v, text: label }))
    );
    sel.value = options.some(([v]) => v === value) ? value : options[0][0];
    sel.addEventListener('change', () => actions.apply({ [prop]: sel.value }, true));
    return sel;
  }

  function rangeInput(prop, value, { min = 0, max = 1, step = 0.05, unit = '' } = {}) {
    const r = h('input', { class: 'st-range', type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
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
          on: { click: () => actions.apply({ [prop]: isOn ? off : on }, true) },
        });
      })
    );
  }

  function sideBox(kind, c) {
    // padding / margin as four small boxes, in the order everyone reads them.
    const mk = (side) => {
      const prop = kind + '-' + side;
      const ctl = numberInput(prop, num(c[prop]), { width: '44px' });
      const label = h('span', { class: 'st-side-label' + (touched()[prop] != null ? ' changed' : ''), text: side[0].toUpperCase() });
      scrubbable(label, () => ctl.input.value, (v, commit) => {
        ctl.input.value = String(v);
        actions.apply({ [prop]: v + 'px' }, commit);
      });
      return h('div', { class: 'st-side' }, [label, ctl.el]);
    };
    return h('div', { class: 'st-sides' }, ['top', 'right', 'bottom', 'left'].map(mk));
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
        row('Font', selectInput('font-family', fontOptions, matchFont(fontOptions, inline['font-family'] || c['font-family'])), ['font-family']),
        numberRow('Size', 'font-size', num(c['font-size']), { min: 1, max: 400, unit: unitOf(inline['font-size']), units: SIZE_UNITS }),
        row('Weight', selectInput('font-weight', WEIGHTS.map((w) => [w, w || 'Keep current']), inline['font-weight'] || String(num(c['font-weight'], 0) || '')), ['font-weight']),
        numberRow('Line height', 'line-height', num(c['line-height']), { min: 0, max: 400 }),
        numberRow('Letter spacing', 'letter-spacing', num(c['letter-spacing'], 2), { min: -20, max: 40, step: 0.1 }),
        row('Align', h('div', { class: 'st-seg' }, ALIGNS.map(([v, short, label]) =>
          h('button', {
            class: 'st-seg-btn' + (c['text-align'] === v ? ' on' : ''),
            text: short,
            title: label,
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
          numberInput('border-width', num(c['border-width']), { min: 0, max: 40, width: '48px' }).el,
          selectInput('border-style', [['solid', 'solid'], ['dashed', 'dashed'], ['dotted', 'dotted'], ['none', 'none']], c['border-style']),
        ]), ['border-width', 'border-style']),
        row('Border colour', swatchRow('border-color', c['border-color']), ['border-color']),
      ])
    );

    body.appendChild(group('Spacing', [row('Padding', sideBox('padding', c)), row('Margin', sideBox('margin', c))]));

    body.appendChild(
      group('Size', [
        numberRow('Width', 'width', num(c.width), { min: 0, max: 4000, unit: unitOf(inline.width), units: SIZE_UNITS }),
        numberRow('Height', 'height', num(c.height), { min: 0, max: 4000, unit: unitOf(inline.height), units: SIZE_UNITS }),
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
