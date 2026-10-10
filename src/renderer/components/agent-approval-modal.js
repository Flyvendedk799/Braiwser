// Approval modal: the one place a person lets an agent perform a consequential
// action. It shows what will actually happen (origin, exact action, destination,
// data, scope, expiry) and offers Allow once / Deny.
//
// Safety properties (all unit-tested):
//   * The Allow button is bound to the action DIGEST the person is looking at. If
//     the runtime's current request has a different digest (the page navigated,
//     the target changed) Allow is disabled, the change is announced, and the
//     person must explicitly review the new request first. Nothing is approved
//     "by id".
//   * Expired, withdrawn (control moved to the human) and unknown requests cannot
//     be allowed.
//   * Own focus trap; Escape closes only this modal and leaves the request
//     pending (closing is not denying).
import { h } from '../lib/dom.js';
import { openTrappedDialog } from '../lib/agent-dialog.js';
import { agentIcon, clockTime, shortId } from '../lib/agent-ui.js';

export function openApprovalModal({ controller, approvalId, now = () => Date.now(), onClosed }) {
  const first = controller.getApproval(approvalId);
  if (!first) return null;
  let shownDigest = first.actionDigest;
  let shown = first;
  let busy = false;

  const banner = h('div', { class: 'agent-banner', role: 'alert', 'aria-live': 'assertive', 'data-testid': 'agent-approval-banner', hidden: '' });
  const bannerText = h('span', { class: 'agent-banner-text' });
  const bannerSlot = h('span', { class: 'agent-banner-slot' });
  banner.append(h('span', { class: 'agent-banner-icon', html: agentIcon('warn', 14) }), bannerText, bannerSlot);
  const detail = h('dl', { class: 'agent-dl', 'data-testid': 'agent-approval-detail' });
  const hint = h('p', { class: 'field-hint', id: 'agent-approval-hint', text: 'Allow once permits this single action only. Closing this window leaves the request pending; it is not a denial.' });
  const body = h('div', { class: 'agent-approval' }, [banner, detail, hint]);

  let timer = null;

  const dialog = openTrappedDialog({
    title: 'Approve agent action?',
    role: 'alertdialog',
    width: 520,
    testid: 'agent-approval-modal',
    describedBy: 'agent-approval-hint',
    body,
    dismissible: true,
    actions: [
      { id: 'deny', label: 'Deny', kind: 'danger', testid: 'agent-approval-deny', onClick: () => decide('deny') },
      { id: 'allow', label: 'Allow once', kind: 'primary', testid: 'agent-approval-allow', onClick: () => decide('allow') },
    ],
    // Start on the safe choice, never on Allow.
    initialFocus: (card) => card.querySelector('[data-action="deny"]'),
    onClose: (reason) => {
      if (timer) clearInterval(timer);
      unsub();
      if (onClosed) onClosed(reason);
    },
  });
  const allowBtn = dialog.buttons.allow;
  const denyBtn = dialog.buttons.deny;

  function row(label, value, testid, extra) {
    const dd = h('dd', { 'data-testid': testid }, [value, extra || null]);
    return [h('dt', { text: label }), dd];
  }

  function showBanner(text, kind = 'warn') {
    if (!text) { banner.setAttribute('hidden', ''); bannerText.textContent = ''; return; }
    banner.removeAttribute('hidden');
    banner.className = `agent-banner agent-banner-${kind}`;
    bannerText.textContent = text;
  }

  function renderDetail() {
    detail.textContent = '';
    const a = shown;
    const kids = [
      ...row('Site', a.origin || 'Unknown origin', 'agent-approval-origin'),
      ...row('Action', `${a.action.kind ? a.action.kind + ': ' : ''}${a.action.label || 'Unnamed action'}`, 'agent-approval-action',
        a.action.target ? h('div', { class: 'agent-untrusted', text: `Target (text from the page): ${a.action.target}` }) : null),
      ...row('Destination', a.destination || 'Not stated', 'agent-approval-destination'),
      ...row('Data', a.dataSummary || 'None stated', 'agent-approval-data'),
      ...row('Scope', a.scope.length ? h('ul', { class: 'agent-scope-list' }, a.scope.map((s) => h('li', { text: s }))) : 'No scope listed', 'agent-approval-scope'),
      ...row('Expires', a.expiresAt ? `${clockTime(a.expiresAt)} (${remaining(a.expiresAt)})` : 'No expiry stated', 'agent-approval-expiry'),
      ...row('Request ID', shortId(a.approvalId, 14) + (a.actionDigest ? ' · action ' + shortId(a.actionDigest, 10) : ''), 'agent-approval-id'),
    ];
    kids.forEach((k) => detail.appendChild(k));
  }

  function remaining(exp) {
    const s = Math.max(0, Math.round((exp - now()) / 1000));
    return s === 0 ? 'expired' : s < 90 ? `in ${s}s` : `in ${Math.round(s / 60)} min`;
  }

  // Recompute everything that gates Allow from the controller's CURRENT view.
  function sync() {
    const cur = controller.getApproval(approvalId);
    let msg = '';
    let kind = 'warn';
    let canAllow = false;
    if (!cur) {
      msg = 'This request is no longer pending.';
    } else if (cur.actionDigest !== shownDigest) {
      msg = 'The requested action changed after this window opened. It cannot be allowed as shown. Review the new request to continue.';
      kind = 'danger';
      if (!bannerSlot.firstChild) addReviewButton();
    } else if (busy) {
      msg = '';
    } else {
      const gate = controller.canAllow(approvalId, shownDigest);
      canAllow = gate.ok;
      if (!gate.ok) msg = gate.message || '';
      else if (cur.error) { msg = cur.error; }
    }
    showBanner(msg, kind);
    allowBtn.disabled = busy || !canAllow;
    denyBtn.disabled = busy || !cur || cur.status === 'allowed' || cur.status === 'denied';
    allowBtn.setAttribute('aria-disabled', allowBtn.disabled ? 'true' : 'false');
    dialog.card.setAttribute('aria-busy', busy ? 'true' : 'false');
    if (cur) {
      const expiryEl = detail.querySelector('[data-testid="agent-approval-expiry"]');
      if (expiryEl && cur.actionDigest === shownDigest && cur.expiresAt) expiryEl.textContent = `${clockTime(cur.expiresAt)} (${remaining(cur.expiresAt)})`;
    }
  }

  function addReviewButton() {
    const btn = h('button', {
      class: 'btn btn-sm', type: 'button', 'data-action': 'review', 'data-testid': 'agent-approval-review',
      text: 'Review new request',
      on: {
        click: () => {
          const cur = controller.getApproval(approvalId);
          if (!cur) return;
          shown = cur;
          shownDigest = cur.actionDigest;
          btn.remove();
          renderDetail();
          sync();
          denyBtn.focus(); // land on the safe choice; the person decides again
        },
      },
    });
    bannerSlot.appendChild(btn);
  }

  async function decide(decision) {
    if (busy) return true;
    busy = true;
    sync();
    const res = await controller.decide(approvalId, decision, shownDigest);
    busy = false;
    if (res && res.ok) return false; // close
    sync();
    if (res && res.message) showBanner(res.message, 'danger');
    return true; // keep open: the person sees why nothing happened
  }

  const unsub = controller.subscribe((ev) => {
    if (dialog.closed) return;
    if (ev.type === 'approvals') sync();
  });
  timer = setInterval(() => { if (!dialog.closed) sync(); }, 1000);

  renderDetail();
  sync();
  return { dialog, sync, get shownDigest() { return shownDigest; } };
}
