// Braiwser - probe.js
// Bundled, sandbox-compatible observation / highlight probe for the agent
// browser runtime (docs/AGENT_RUNTIME_CONTRACT.md, audit "Headless, visible, and
// human takeover").
//
// Design rules (these are load-bearing, tests pin them):
//   * ONE self-contained function, `run(cmd, args)`. It has no free variables
//     other than the page's own globals, so it can be shipped by value:
//       - Playwright:  frame.evaluate(probe.run, { cmd, args })
//       - Electron:    Runtime.callFunctionOn({ functionDeclaration: PROBE_SOURCE })
//       - jsdom unit tests: required and called directly.
//   * It is NOT installed on `window`, NOT exposed through contextBridge and NOT
//     reachable by page script. There is no eval, no Function(), no selector
//     passthrough except the closed `assertFacts` query used by the assertion DSL.
//   * `cmd` is a closed set (see COMMANDS). Unknown commands throw.
//   * Everything returned is data; page-controlled strings are clipped, stripped
//     of control / bidi characters and must be treated as 'untrusted-page'.
//   * Secret-trait fields (password, OTP, card, ...) are flagged `secret:true`;
//     field VALUES are never read or returned.
//   * Own UI ([data-caos], #__caos_root) is never observed or matched. The
//     overlays this probe creates carry data-caos so assertions ignore them.
//   * Open shadow roots are traversed. Closed roots cannot be traversed from
//     page JS; the probe reports custom elements that look like closed hosts so
//     the driver can state the limitation instead of pretending coverage.

'use strict';

const COMMANDS = Object.freeze([
  'collect', 'describe', 'assertFacts', 'viewportInfo', 'clickPoint',
  'highlight', 'clearHighlight', 'setBadge', 'badgeState', 'watchClick',
]);

function run(cmd, args) {
  'use strict';
  // Single-object form ({ cmd, args }) so one serializable argument can be passed by
  // evaluate()-style transports (Playwright passes exactly one argument).
  if (cmd && typeof cmd === 'object') { args = cmd.args; cmd = cmd.cmd; }
  args = args || {};
  const doc = document;
  const win = window;
  const OWN_SEL = '[data-caos], #__caos_root';
  const NAME_MAX = 120;
  const CTX_MAX = 60;
  const MAX_CANDIDATES = 6000;

  const LANDMARK_ROLES = ['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region'];
  const INTERACTIVE_ROLES = ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'switch', 'textbox', 'searchbox', 'combobox', 'option', 'slider', 'spinbutton', 'treeitem'];
  const CANDIDATE_SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,'
    + '[contenteditable=""],[contenteditable="true"],[role],h1,h2,nav,main,aside,footer,header,form,'
    + 'section,dialog,canvas';
  const SECRET_HINT = /pass(?:word|wd|code|phrase)|(?:^|[^a-z0-9])(?:pwd|otp|cvv|cvc|csc|pin|ssn|iban)(?:$|[^a-z0-9])|one[-_ ]?time|verification[-_ ]?code|security[-_ ]?code|card[-_ ]?(?:number|num|no)\b|cardnumber|cardnum|ccnum|credit[-_ ]?card|secret/i;
  const SECRET_AC = /(?:^|\s)(?:one-time-code|current-password|new-password|cc-[a-z-]+)(?:\s|$)/i;

  // ---- helpers ------------------------------------------------------------
  const clip = (value, max) => {
    let s = String(value == null ? '' : value)
      // control chars, zero-width and bidi overrides never help a model read a label
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (s.length > max) s = s.slice(0, max - 1) + '\u2026';
    return s;
  };
  const isOwn = (el) => {
    try { return !!(el.closest && el.closest(OWN_SEL)); } catch (_e) { return false; }
  };
  const boxVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const cs = win.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const rendered = (el) => {
    if (!boxVisible(el)) return false;
    try { if (el.closest('[aria-hidden="true"], [inert]')) return false; } catch (_e) { /* ignore */ }
    return true;
  };
  const attr = (el, name) => {
    const v = el.getAttribute(name);
    return v == null ? '' : v;
  };

  // Visible-ish text of a subtree, bounded, piercing open shadow roots + slots.
  const textOf = (node, budget) => {
    let out = '';
    const walk = (n) => {
      if (out.length >= budget) return;
      if (n.nodeType === 3) { out += n.nodeValue + ' '; return; }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.nodeType === 1) {
        const t = n.tagName;
        if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' || t === 'TEMPLATE' || t === 'SELECT'
          || t === 'TEXTAREA' || t === 'OPTION' || t === 'INPUT') return;
        if (n.getAttribute('aria-hidden') === 'true' || n.hidden) return;
        if (t === 'IMG') { out += attr(n, 'alt') + ' '; return; }
        if (t === 'SLOT' && typeof n.assignedNodes === 'function') {
          const assigned = n.assignedNodes({ flatten: true });
          if (assigned.length) { for (let i = 0; i < assigned.length; i++) walk(assigned[i]); return; }
        }
        if (n.shadowRoot) { walk(n.shadowRoot); return; }
      }
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(node);
    return out;
  };

  const roleOf = (el) => {
    const explicit = attr(el, 'role').trim().toLowerCase().split(/\s+/)[0];
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'button': case 'summary': return 'button';
      case 'select': return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'input': {
        const t = (attr(el, 'type') || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image' || t === 'file') return 'button';
        if (t === 'range') return 'slider';
        if (t === 'number') return 'spinbutton';
        if (t === 'search') return 'searchbox';
        return 'textbox';
      }
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'aside': return 'complementary';
      case 'footer': return el.closest('article,section,aside,main,nav') ? 'generic' : 'contentinfo';
      case 'header': return el.closest('article,section,aside,main,nav') ? 'generic' : 'banner';
      case 'form': return (attr(el, 'aria-label') || attr(el, 'aria-labelledby') || attr(el, 'name')) ? 'form' : 'generic';
      case 'section': return (attr(el, 'aria-label') || attr(el, 'aria-labelledby')) ? 'region' : 'generic';
      case 'dialog': return 'dialog';
      case 'canvas': return 'canvas';
      default: break;
    }
    if (el.isContentEditable && attr(el, 'contenteditable') !== 'false') return 'textbox';
    return 'generic';
  };

  const accName = (el, role) => {
    const byIds = (ids) => {
      const root = el.getRootNode();
      const parts = [];
      ids.split(/\s+/).forEach((id) => {
        if (!id) return;
        const t = root.getElementById ? root.getElementById(id) : null;
        if (t) parts.push(textOf(t, 200));
      });
      return parts.join(' ');
    };
    let name = '';
    const lb = attr(el, 'aria-labelledby');
    if (lb) name = clip(byIds(lb), NAME_MAX);
    if (!name) name = clip(attr(el, 'aria-label'), NAME_MAX);
    const tag = el.tagName.toLowerCase();
    if (!name && tag === 'input') {
      const t = (attr(el, 'type') || 'text').toLowerCase();
      if (t === 'button' || t === 'submit' || t === 'reset') {
        name = clip(attr(el, 'value') || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : ''), NAME_MAX);
      } else if (t === 'image') {
        name = clip(attr(el, 'alt'), NAME_MAX);
      }
    }
    if (!name && (tag === 'input' || tag === 'select' || tag === 'textarea') && el.labels && el.labels.length) {
      const parts = [];
      for (let i = 0; i < el.labels.length; i++) parts.push(textOf(el.labels[i], 200));
      name = clip(parts.join(' '), NAME_MAX);
    }
    if (!name && tag === 'img') name = clip(attr(el, 'alt'), NAME_MAX);
    if (!name && (INTERACTIVE_ROLES.indexOf(role) >= 0 && role !== 'textbox' && role !== 'searchbox'
      && role !== 'combobox' && role !== 'slider' && role !== 'spinbutton' || role === 'heading'
      || role === 'alert' || role === 'status' || role === 'dialog')) {
      name = clip(textOf(el, 240), NAME_MAX);
    }
    if (!name) name = clip(attr(el, 'title'), NAME_MAX);
    if (!name && (tag === 'input' || tag === 'textarea')) name = clip(attr(el, 'placeholder'), NAME_MAX);
    if (!name && role === 'textbox' && el.isContentEditable) name = clip(attr(el, 'data-placeholder'), NAME_MAX);
    return name;
  };

  const ctxOf = (el) => {
    const p = el.parentElement || (el.getRootNode() && el.getRootNode().host);
    if (!p || !p.closest) return '';
    const row = p.closest('li,tr,[role=row],[role=listitem],article,fieldset,[role=group],[role=dialog],dialog,form,section,[role=region]');
    if (!row) return '';
    let label = clip(attr(row, 'aria-label'), CTX_MAX);
    if (!label) {
      const lb = attr(row, 'aria-labelledby');
      if (lb) {
        const t = row.getRootNode().getElementById ? row.getRootNode().getElementById(lb.split(/\s+/)[0]) : null;
        if (t) label = clip(textOf(t, 100), CTX_MAX);
      }
    }
    if (!label && row.tagName === 'FIELDSET') {
      const lg = row.querySelector('legend');
      if (lg) label = clip(textOf(lg, 100), CTX_MAX);
    }
    if (!label) label = clip(textOf(row, 120), CTX_MAX);
    return label;
  };

  const isSecret = (el, name) => {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !el.isContentEditable) return false;
    const t = attr(el, 'type').toLowerCase();
    if (t === 'password') return true;
    if (SECRET_AC.test(attr(el, 'autocomplete'))) return true;
    const hint = [attr(el, 'name'), attr(el, 'id'), attr(el, 'aria-label'), attr(el, 'placeholder'),
      attr(el, 'data-testid'), name].join(' ');
    return SECRET_HINT.test(hint);
  };

  const enabledOf = (el) => {
    try { if (el.matches(':disabled')) return false; } catch (_e) { /* ignore */ }
    return attr(el, 'aria-disabled') !== 'true';
  };

  const editableOf = (el, enabled) => {
    if (!enabled) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return !el.readOnly;
    if (tag === 'input') {
      const t = (attr(el, 'type') || 'text').toLowerCase();
      const textual = ['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'time',
        'datetime-local', 'month', 'week'].indexOf(t) >= 0;
      return textual && !el.readOnly;
    }
    return !!el.isContentEditable;
  };

  // kind: what the driver does with the node.
  const kindOf = (el, role) => {
    if (role === 'canvas') return 'canvas';
    if (INTERACTIVE_ROLES.indexOf(role) >= 0) return 'interactable';
    if (role === 'alert') return 'error';
    if (role === 'status') return 'status';
    if (role === 'dialog' || role === 'alertdialog') return 'dialog';
    if (role === 'heading') {
      const level = el.tagName.length === 2 && el.tagName[0] === 'H' ? Number(el.tagName[1]) : Number(attr(el, 'aria-level'));
      return level >= 1 && level <= 2 ? 'heading' : null;
    }
    if (LANDMARK_ROLES.indexOf(role) >= 0) return 'landmark';
    return null;
  };

  const checkedOf = (el, role) => {
    if (role !== 'checkbox' && role !== 'radio' && role !== 'switch' && role !== 'menuitemcheckbox'
      && role !== 'menuitemradio') return undefined;
    if (el.tagName === 'INPUT') return el.indeterminate ? 'mixed' : !!el.checked;
    const a = attr(el, 'aria-checked');
    return a === 'mixed' ? 'mixed' : a === 'true';
  };

  const makeItem = (el) => {
    const role = roleOf(el);
    const kind = kindOf(el, role);
    if (!kind) return null;
    const name = accName(el, role);
    const item = { kind, role, name, tag: el.tagName.toLowerCase() };
    if (kind === 'interactable') {
      item.enabled = enabledOf(el);
      if (editableOf(el, item.enabled)) item.editable = true;
      const checked = checkedOf(el, role);
      if (checked !== undefined) item.checked = checked;
      const exp = attr(el, 'aria-expanded');
      if (exp === 'true' || exp === 'false') item.expanded = exp === 'true';
      if (attr(el, 'aria-invalid') === 'true') item.invalid = true;
      if (isSecret(el, name)) item.secret = true;
      item.type = el.tagName === 'INPUT' ? (attr(el, 'type') || 'text').toLowerCase() : '';
      item.ctx = ctxOf(el);
      // Closed vocabulary consumed by the broker's policy (never page text).
      const traits = [];
      if (item.type === 'password') traits.push('password');
      if (/one-time-code/i.test(attr(el, 'autocomplete'))) traits.push('one-time-code');
      if (/cc-number/i.test(attr(el, 'autocomplete'))) traits.push('cc-number');
      if (/cc-csc/i.test(attr(el, 'autocomplete'))) traits.push('cc-csc');
      if (/cc-exp/i.test(attr(el, 'autocomplete'))) traits.push('cc-exp');
      if (item.secret && traits.length === 0) traits.push('secret');
      if (item.type === 'file') traits.push('file-input');
      const form = el.form || (el.closest ? el.closest('form') : null);
      const btnType = el.tagName === 'BUTTON' ? (attr(el, 'type') || 'submit').toLowerCase() : item.type;
      if (form && (btnType === 'submit' || btnType === 'image') && (el.tagName === 'BUTTON' || el.tagName === 'INPUT')) traits.push('submit');
      if (traits.length) item.traits = traits;
    } else if (kind === 'error' || kind === 'status') {
      // name = accessible name (aria-label when present, else the text); text = the live content.
      const txt = clip(textOf(el, 400), NAME_MAX * 2);
      if (txt !== item.name) item.text = txt;
    } else if (kind === 'canvas') {
      item.name = clip(attr(el, 'aria-label') || attr(el, 'title'), NAME_MAX);
      item.limitation = 'canvas-content-not-observable';
    }
    const tid = attr(el, 'data-testid') || attr(el, 'data-test') || attr(el, 'data-cy') || attr(el, 'data-qa');
    if (tid) item.testId = clip(tid, 80);
    return item;
  };

  const gatherAll = () => {
    const all = [];
    const stats = { shadowRootsOpen: 0, possibleClosedShadowHosts: 0 };
    const gather = (root) => {
      const els = root.querySelectorAll('*');
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        all.push(el);
        if (el.shadowRoot) { stats.shadowRootsOpen++; gather(el.shadowRoot); }
        else if (el.tagName.indexOf('-') > 0 && el.childElementCount === 0 && !el.textContent) {
          stats.possibleClosedShadowHosts++;
        }
      }
    };
    gather(doc);
    return { all, stats };
  };

  const candidatesOf = (all) => {
    const out = [];
    let capped = false;
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!el.matches(CANDIDATE_SEL)) continue;
      if (out.length >= MAX_CANDIDATES) { capped = true; break; }
      if (isOwn(el)) continue;
      out.push(el);
    }
    return { out, capped };
  };

  const occlusionOf = (el) => {
    const r = el.getBoundingClientRect();
    const vw = win.innerWidth || doc.documentElement.clientWidth;
    const vh = win.innerHeight || doc.documentElement.clientHeight;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) return { offscreen: true };
    const root = el.getRootNode();
    const top = (root && root.elementFromPoint ? root : doc).elementFromPoint(cx, cy);
    if (!top) return {};
    if (top === el || el.contains(top)) return {};
    const label = el.closest && el.closest('label');
    if (label && (label === top || label.contains(top))) return {};
    return { occluded: true };
  };

  const keyOf = (item) => item.role + '\u241f' + item.name.toLowerCase() + '\u241f' + item.ctx.toLowerCase();

  // ---- commands -----------------------------------------------------------
  switch (cmd) {
    case 'collect': {
      const { all, stats } = gatherAll();
      const { out: cands, capped } = candidatesOf(all);
      const items = [];
      const els = [];
      let canvases = 0;
      let iframes = 0;
      for (let i = 0; i < all.length; i++) if (all[i].tagName === 'IFRAME' || all[i].tagName === 'FRAME') iframes++;
      const counts = Object.create(null);
      for (let i = 0; i < cands.length; i++) {
        const el = cands[i];
        const item = makeItem(el);
        if (!item) continue;
        if (item.kind === 'interactable' || item.kind === 'canvas') {
          if (!rendered(el)) continue;
        } else if (!boxVisible(el) || (el.closest && el.closest('[aria-hidden="true"], [inert]'))) {
          continue;
        }
        if (item.kind === 'canvas') canvases++;
        if (item.kind === 'landmark' && !item.name && item.role !== 'main' && item.role !== 'navigation'
          && item.role !== 'banner' && item.role !== 'contentinfo') continue;
        if ((item.kind === 'error' || item.kind === 'status') && !item.name) continue;
        if (item.kind === 'interactable') {
          const k = keyOf(item);
          counts[k] = (counts[k] || 0) + 1;
        }
        items.push(item);
        els.push(el);
      }
      // focus filter (applied after ambiguity counting so duplicates elsewhere still count)
      const focus = args.focus && typeof args.focus === 'object' ? args.focus : null;
      let selected = items.map((_, i) => i);
      if (focus) {
        const wantRole = focus.role ? String(focus.role).toLowerCase() : '';
        const wantName = focus.name != null ? String(focus.name).toLowerCase().replace(/\s+/g, ' ').trim() : '';
        const wantText = focus.text != null ? String(focus.text).toLowerCase() : '';
        selected = selected.filter((i) => {
          const it = items[i];
          if (wantRole && it.role !== wantRole) return false;
          if (wantName) {
            const n = it.name.toLowerCase();
            if (focus.exact ? n !== wantName : n.indexOf(wantName) < 0) return false;
          }
          if (wantText && (it.name + ' ' + (it.ctx || '')).toLowerCase().indexOf(wantText) < 0) return false;
          return true;
        });
      }
      const total = selected.length;
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const max = Math.max(0, Math.floor(Number(args.max) || 0));
      const slice = selected.slice(offset, offset + max);
      const outItems = [];
      const outEls = [];
      for (let s = 0; s < slice.length; s++) {
        const item = items[slice[s]];
        const el = els[slice[s]];
        if (item.kind === 'interactable') {
          const dup = counts[keyOf(item)];
          if (dup > 1) { item.ambiguous = true; item.dupCount = dup; }
          Object.assign(item, occlusionOf(el));
        } else if (item.kind === 'canvas') {
          Object.assign(item, occlusionOf(el));
        }
        // Every returned node is addressable (for highlight / evidence); only 'interactable'
        // nodes can ever be ACTED on, and the drivers enforce that.
        item.hi = outEls.length;
        outEls.push(el);
        outItems.push(item);
      }
      // iframes are enumerated by the driver from its frame registry; the probe only counts.
      return {
        items: outItems,
        elements: outEls,
        total,
        stats: {
          candidates: cands.length,
          candidatesCapped: capped,
          shadowRootsOpen: stats.shadowRootsOpen,
          possibleClosedShadowHosts: stats.possibleClosedShadowHosts,
          canvases,
          iframes,
          title: clip(doc.title, 120),
        },
      };
    }

    case 'describe': {
      const el = args.el;
      if (!el || el.nodeType !== 1) return { connected: false };
      if (!el.isConnected) return { connected: false };
      const item = makeItem(el);
      if (!item) return { connected: true, kind: null };
      let dup = 1;
      if (item.kind === 'interactable') {
        const { all } = gatherAll();
        const { out: cands } = candidatesOf(all);
        const key = keyOf(item);
        dup = 0;
        for (let i = 0; i < cands.length; i++) {
          const c = cands[i];
          if (roleOf(c) !== item.role) continue;
          const other = makeItem(c);
          if (other && other.kind === 'interactable' && keyOf(other) === key && rendered(c)) dup++;
        }
        if (dup < 1) dup = 1;
      }
      const o = item.kind === 'interactable' ? occlusionOf(el) : {};
      return {
        connected: true,
        kind: item.kind,
        role: item.role,
        name: item.name,
        tag: item.tag,
        type: item.type || '',
        ctx: item.ctx || '',
        enabled: item.enabled !== false,
        editable: item.editable === true,
        secret: item.secret === true,
        traits: item.traits || [],
        checked: item.checked,
        rendered: rendered(el),
        dupCount: dup,
        occluded: o.occluded === true,
        offscreen: o.offscreen === true,
      };
    }

    case 'assertFacts': {
      let list;
      const t = args.target;
      if (t && typeof t === 'object') {
        // Semantic locator ({ by: role|label|testId }), the same vocabulary plans use. Exact, normalised
        // name equality: a locator never "best-guesses" a match.
        const nn = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
        const { all } = gatherAll();
        list = [];
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (t.by === 'testId') {
            const v = String(t.value);
            if (attr(el, 'data-testid') !== v && attr(el, 'data-test') !== v && attr(el, 'data-cy') !== v && attr(el, 'data-qa') !== v) continue;
          } else if (t.by === 'role') {
            const r = roleOf(el);
            if (r !== String(t.role).toLowerCase() || nn(accName(el, r)) !== nn(t.name)) continue;
          } else if (t.by === 'label') {
            const tag = el.tagName;
            if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA' && !el.isContentEditable) continue;
            if (nn(accName(el, roleOf(el))) !== nn(t.value)) continue;
          } else {
            return { error: 'invalid-target' };
          }
          if (!isOwn(el)) list.push(el);
        }
      } else {
        try {
          list = Array.prototype.slice.call(doc.querySelectorAll(String(args.selector || ''))).filter((e) => !isOwn(e));
        } catch (_e) {
          return { error: 'invalid-selector' };
        }
      }
      const first = list[0] || null;
      return {
        matchCount: list.length,
        firstText: first ? String(first.innerText || first.textContent || '').slice(0, 20000) : null,
        firstVisible: first ? boxVisible(first) : null,
      };
    }

    case 'viewportInfo':
      return {
        scrollX: Math.round(win.scrollX || 0),
        scrollY: Math.round(win.scrollY || 0),
        width: win.innerWidth,
        height: win.innerHeight,
        scale: win.devicePixelRatio || 1,
      };

    case 'clickPoint': {
      const el = args.el;
      if (!el || !el.isConnected) return { connected: false };
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const vw = win.innerWidth;
      const vh = win.innerHeight;
      const occ = occlusionOf(el);
      return {
        connected: true,
        x,
        y,
        viewportWidth: vw,
        viewportHeight: vh,
        inViewport: !(x < 0 || y < 0 || x >= vw || y >= vh),
        occluded: occ.occluded === true,
        empty: !(r.width > 0 && r.height > 0),
      };
    }

    case 'watchClick': {
      // Attestation of delivery: a capture-phase listener that counts the click events that actually reached
      // `el` (or a descendant, shadow-aware). Returns a live handle { n, trusted, stop() }: it is read once,
      // right after dispatch, and removed. Trusted = produced by browser input, not by page script.
      const el = args.el;
      if (!el || !el.isConnected) return null;
      const rec = { n: 0, trusted: 0, stop() { doc.removeEventListener('click', handler, true); } };
      const handler = (e) => {
        let hit = false;
        try { hit = e.composedPath().indexOf(el) >= 0; } catch (_e) { hit = e.target === el; }
        if (hit) { rec.n += 1; if (e.isTrusted) rec.trusted += 1; }
      };
      doc.addEventListener('click', handler, true);
      return rec;
    }

    case 'highlight': {
      const el = args.el;
      if (!el || !el.isConnected) return { ok: false };
      const prev = doc.querySelectorAll('[data-caos="agent-highlight"]');
      for (let i = 0; i < prev.length; i++) prev[i].remove();
      const r = el.getBoundingClientRect();
      const box = doc.createElement('div');
      box.setAttribute('data-caos', 'agent-highlight');
      box.setAttribute('aria-hidden', 'true');
      box.style.cssText = 'position:fixed;pointer-events:none;box-sizing:border-box;z-index:2147483646;'
        + 'outline:3px solid #7c3aed;outline-offset:2px;border-radius:4px;background:rgba(124,58,237,.12);'
        + 'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
      const label = clip(args.label, 60);
      if (label) {
        const tag = doc.createElement('span');
        tag.textContent = label;
        tag.style.cssText = 'position:absolute;left:0;top:-22px;font:600 11px/18px system-ui,sans-serif;'
          + 'padding:0 6px;background:#7c3aed;color:#fff;border-radius:3px;white-space:nowrap;';
        box.appendChild(tag);
      }
      doc.documentElement.appendChild(box);
      const ms = Math.min(10000, Math.max(200, Number(args.ms) || 2500));
      win.setTimeout(() => { try { box.remove(); } catch (_e) { /* ignore */ } }, ms);
      return { ok: true, rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
    }

    case 'clearHighlight': {
      const prev = doc.querySelectorAll('[data-caos="agent-highlight"]');
      for (let i = 0; i < prev.length; i++) prev[i].remove();
      return { ok: true, removed: prev.length };
    }

    case 'setBadge': {
      const owner = String(args.owner || '');
      const old = doc.querySelectorAll('[data-caos="agent-badge"]');
      for (let i = 0; i < old.length; i++) old[i].remove();
      const texts = {
        agent: ['Braiwser agent is controlling this page', '#7c3aed'],
        human: ['You are in control', '#047857'],
        quarantined: ['Agent paused: needs your attention', '#b91c1c'],
      };
      if (!texts[owner]) return { ok: true, owner: 'none' };
      const badge = doc.createElement('div');
      badge.setAttribute('data-caos', 'agent-badge');
      badge.setAttribute('data-owner', owner);
      badge.setAttribute('role', 'note');
      badge.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;pointer-events:none;'
        + 'font:600 12px/20px system-ui,sans-serif;padding:2px 10px;border-radius:999px;color:#fff;'
        + 'box-shadow:0 1px 4px rgba(0,0,0,.35);background:' + texts[owner][1] + ';';
      badge.textContent = texts[owner][0];
      doc.documentElement.appendChild(badge);
      return { ok: true, owner };
    }

    case 'badgeState': {
      const badge = doc.querySelector('[data-caos="agent-badge"]');
      return { owner: badge ? attr(badge, 'data-owner') : 'none', text: badge ? clip(badge.textContent, 80) : '' };
    }

    default:
      throw new Error('PROBE_UNKNOWN_COMMAND');
  }
}

const PROBE_SOURCE = run.toString();

// Named wrappers (direct, in-process use: jsdom tests, the preload bundle).
const probe = { run, COMMANDS, PROBE_SOURCE };
for (const c of COMMANDS) probe[c] = (args) => run(c, args);

module.exports = probe;
