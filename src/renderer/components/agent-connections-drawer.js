// Connection drawer: which agent clients are connected, with which profile,
// scope and expiry. Scope is always visible BEFORE a client is enabled; enabling
// and revoking each ask for one explicit confirmation that repeats the scope.
//
// The drawer reflects the runtime's records. If the runtime exposes no connection
// registry it says so — it does not show an empty "all clear".
import { h, clear } from '../lib/dom.js';
import { openTrappedDialog } from '../lib/agent-dialog.js';
import { agentIcon, clockTime, describeError } from '../lib/agent-ui.js';

const STATUS = {
  pending: { label: 'Waiting for your approval', icon: 'pending', tone: 'warn' },
  active: { label: 'Enabled', icon: 'passed', tone: 'good' },
  revoked: { label: 'Revoked', icon: 'cancelled', tone: 'neutral' },
  expired: { label: 'Expired', icon: 'timedOut', tone: 'neutral' },
};

function expiryText(ms, now) {
  if (ms == null) return 'No expiry set';
  const d = ms - now;
  if (d <= 0) return `Expired at ${clockTime(ms)}`;
  const m = Math.round(d / 60000);
  return m < 90 ? `Expires in ${Math.max(1, m)} min (${clockTime(ms)})` : `Expires in ${Math.round(m / 60)} h`;
}

export function openConnectionsDrawer({ controller, now = () => Date.now(), onClosed }) {
  const list = h('ul', { class: 'agent-conn-list', 'aria-label': 'Connected agent clients', 'data-testid': 'agent-conn-list' });
  const status = h('div', { class: 'agent-banner', role: 'status', 'aria-live': 'polite', hidden: '', 'data-testid': 'agent-conn-status' });
  const body = h('div', { class: 'agent-conn' }, [
    h('p', { class: 'field-hint', id: 'agent-conn-hint', text: 'A client can only do what its scope lists. Page content can never widen a scope.' }),
    status,
    list,
  ]);

  const dialog = openTrappedDialog({
    title: 'Agent connections',
    width: 460,
    testid: 'agent-connections-drawer',
    describedBy: 'agent-conn-hint',
    body,
    actions: [{ id: 'done', label: 'Done', kind: 'primary', testid: 'agent-conn-done' }],
    onClose: (r) => { unsub(); if (onClosed) onClosed(r); },
  });
  dialog.card.classList.add('agent-drawer');
  dialog.backdrop.classList.add('agent-drawer-backdrop');

  function say(text, kind = 'warn') {
    if (!text) { status.setAttribute('hidden', ''); return; }
    status.removeAttribute('hidden');
    status.className = `agent-banner agent-banner-${kind}`;
    status.textContent = text;
  }

  function confirmDialog({ title, lines, scope, confirmLabel, kind, run }) {
    const content = h('div', { class: 'agent-confirm' }, [
      ...lines.map((l) => h('p', { text: l })),
      scope && scope.length ? h('div', {}, [h('div', { class: 'field-label', text: 'Scope' }), h('ul', { class: 'agent-scope-list' }, scope.map((s) => h('li', { text: s })))]) : null,
    ]);
    openTrappedDialog({
      title, width: 420, role: 'alertdialog', body: content, testid: 'agent-conn-confirm',
      actions: [
        { id: 'cancel', label: 'Cancel', kind: 'ghost', testid: 'agent-conn-confirm-cancel' },
        { id: 'ok', label: confirmLabel, kind, testid: 'agent-conn-confirm-ok', onClick: async () => { await run(); } },
      ],
      initialFocus: (card) => card.querySelector('[data-action="cancel"]'),
    });
  }

  function render() {
    clear(list);
    const c = controller.state.connections;
    if (c.error) say(`Could not load connections: ${c.error}`, 'warn');
    else if (c.supported === false) say('This runtime build does not report connected clients, so nothing can be listed or revoked here. That is not the same as having none.', 'warn');
    else say('');
    if (c.supported !== false && !c.items.length && !c.error) {
      list.appendChild(h('li', { class: 'empty agent-empty', 'data-testid': 'agent-conn-empty', text: 'No agent clients are connected.' }));
    }
    for (const it of c.items) {
      const st = STATUS[it.status] || STATUS.pending;
      const li = h('li', { class: 'agent-conn-item', 'data-client-id': it.clientId, 'data-testid': 'agent-conn-item' });
      li.appendChild(h('div', { class: 'agent-conn-head' }, [
        h('span', { class: 'agent-conn-name', text: it.client || it.clientId }),
        h('span', { class: `agent-state agent-tone-${st.tone}`, 'data-testid': 'agent-conn-status-label', html: `${agentIcon(st.icon, 13)}<span>${st.label}</span>` }),
      ]));
      const dl = h('dl', { class: 'agent-dl' });
      dl.appendChild(h('dt', { text: 'Profile' })); dl.appendChild(h('dd', { text: it.profile || 'Default isolated profile' }));
      dl.appendChild(h('dt', { text: 'Scope' }));
      dl.appendChild(h('dd', { 'data-testid': 'agent-conn-scope' }, [it.scope.length
        ? h('ul', { class: 'agent-scope-list' }, it.scope.map((s) => h('li', { text: s })))
        : 'No scope listed — this client cannot be enabled until the runtime states one.']));
      if (it.destinations.length) {
        dl.appendChild(h('dt', { text: 'Sites' }));
        dl.appendChild(h('dd', {}, [h('ul', { class: 'agent-scope-list' }, it.destinations.map((s) => h('li', { text: s })))]));
      }
      dl.appendChild(h('dt', { text: 'Expiry' })); dl.appendChild(h('dd', { 'data-testid': 'agent-conn-expiry', text: expiryText(it.expiresAt, now()) }));
      li.appendChild(dl);

      const acts = h('div', { class: 'agent-conn-acts' });
      if (it.status === 'pending') {
        acts.appendChild(h('button', {
          class: 'btn btn-sm btn-primary', type: 'button', 'data-testid': 'agent-conn-enable', disabled: !it.scope.length,
          'aria-describedby': undefined,
          text: 'Review and enable…',
          on: { click: () => confirmDialog({
            title: `Enable ${it.client || it.clientId}?`,
            lines: [`This client will be able to act with exactly this scope${it.expiresAt ? ' until ' + clockTime(it.expiresAt) : ''}.`],
            scope: it.scope, confirmLabel: 'Enable client', kind: 'primary',
            run: async () => { const r = await controller.enableConnection(it.clientId); if (!r.ok) say(describeError(r.error), 'danger'); render(); },
          }) },
        }));
      }
      if (it.status === 'active' || it.status === 'pending') {
        acts.appendChild(h('button', {
          class: 'btn btn-sm btn-danger', type: 'button', 'data-testid': 'agent-conn-revoke', text: 'Revoke…',
          on: { click: () => confirmDialog({
            title: `Revoke ${it.client || it.clientId}?`,
            lines: ['The client loses access immediately. Work already dispatched is not undone.'],
            scope: it.scope, confirmLabel: 'Revoke access', kind: 'danger',
            run: async () => { const r = await controller.revokeConnection(it.clientId); if (!r.ok) say(describeError(r.error), 'danger'); render(); },
          }) },
        }));
      }
      li.appendChild(acts);
      list.appendChild(li);
    }
  }

  const unsub = controller.subscribe((ev) => { if (ev.type === 'connections' && !dialog.closed) render(); });
  render();
  controller.loadConnections();
  return { dialog, render };
}
