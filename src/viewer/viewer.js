// Human-only client. Credentials never appear in links or tool results.
(function () {
  const id = location.pathname.split('/').pop(), root = `/v1/handoffs/${encodeURIComponent(id)}`;
  const el = (id) => document.getElementById(id);
  const viewerInstanceId = crypto.randomUUID();
  window.braiwserViewerInstance = viewerInstanceId;
  let state, frame, displayedDocument, busy = false, privateOn = false;
  function setBusy(value) {
    busy = value;
    for (const id of ['take', 'pause', 'back', 'stop', 'priv']) el(id).disabled = value || state?.state === 'closed';
  }
  const csrf = () => decodeURIComponent(document.cookie.match(/(?:^|; )braiwser_csrf=([^;]+)/)?.[1] || '');
  async function api(action = '', body) {
    const res = await fetch(root + (action ? '/' + action : ''), { method: body ? 'POST' : 'GET', credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json', 'x-braiwser-csrf': csrf() } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok || !data.ok) { const error = new Error(data.error?.message || 'Viewer request failed'); error.authenticationLost = res.status === 401; throw error; }
    return data.value;
  }
  const show = (text) => { el('status').textContent = text; };
  async function tick() {
    if (busy) return;
    setBusy(true);
    try {
      state = await api(); show(state.blocker || state.state);
      el('identity').textContent = `${state.controlOwner} · epoch ${state.controlEpoch}`;
      el('redeem').hidden = true; el('controls').hidden = false;
      if (state.state === 'closed') { frame = null; el('frame').removeAttribute('src'); return; }
      frame = await api('frame');
      if (frame.fresh) displayedDocument = frame.documentEpoch;
      el('fresh').textContent = frame.fresh ? 'Live view' : 'Input frozen';
      if (frame.image) el('frame').src = `data:image/png;base64,${frame.image}`;
      else el('frame').removeAttribute('src');
    } catch (err) {
      frame = null; el('frame').removeAttribute('src'); show(err.message);
      if (err.authenticationLost) { state = undefined; displayedDocument = undefined; el('redeem').hidden = false; el('controls').hidden = true; }
    } finally { setBusy(false); }
  }
  async function write(action, data = {}) {
    if (busy || !state) return;
    setBusy(true);
    try {
      const value = await api(action, { ...data, viewerInstanceId, expectedControlEpoch: state.controlEpoch, requestKey: crypto.randomUUID() });
      if (Number.isInteger(value.controlEpoch)) state = { ...state, ...value };
    } catch (err) { show(err.message); } finally { setBusy(false); frame = null; }
    await tick();
  }
  el('redeem').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('redeem', { ownerToken: el('code').value, code: el('code').value });
      el('code').value = ''; await tick();
    } catch (err) { el('redeem-error').textContent = err.message; }
  });
  for (const [button, action] of [['take', 'acquire'], ['pause', 'release'], ['back', 'resume'], ['stop', 'cancel']]) {
    el(button).addEventListener('click', () => write(action));
  }
  el('priv').addEventListener('click', async () => { privateOn = !privateOn; await write('private', { enabled: privateOn }); });
  let inputQueue = Promise.resolve();
  function input(data) {
    const intendedDocument = displayedDocument;
    inputQueue = inputQueue.then(async () => {
      while (busy) await new Promise(resolve => setTimeout(resolve, 20));
      if (!frame?.fresh || state?.controlOwner !== 'human' || frame.documentEpoch !== intendedDocument) return;
      await write('input', { ...data, controlEpoch: frame.controlEpoch, documentEpoch: frame.documentEpoch, frameSequence: frame.sequence });
    }).catch(error => show(error.message));
    return inputQueue;
  }
  el('stage').addEventListener('click', (ev) => {
    const rect = el('frame').getBoundingClientRect();
    if (!frame || !rect.width || !rect.height) return;
    el('stage').focus();
    input({ kind: 'click', x: (ev.clientX - rect.left) * frame.width / rect.width, y: (ev.clientY - rect.top) * frame.height / rect.height });
  });
  el('stage').addEventListener('keydown', (ev) => {
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault(); input({ kind: 'text', text: ev.key }); return;
    }
    const keys = { ' ': 'Space' }; const key = keys[ev.key] || ev.key;
    if (!/^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space|[A-Za-z0-9])$/.test(key)) return;
    ev.preventDefault();
    input({ kind: 'key', key: [ev.ctrlKey && 'Control', ev.altKey && 'Alt', ev.shiftKey && 'Shift', ev.metaKey && 'Meta', key].filter(Boolean).join('+') });
  });
  el('stage').addEventListener('paste', (ev) => { ev.preventDefault(); input({ kind: 'text', text: ev.clipboardData.getData('text/plain') }); });
  el('stage').addEventListener('wheel', (ev) => { ev.preventDefault(); input({ kind: 'scroll', deltaX: Math.max(-4096, Math.min(4096, ev.deltaX)), deltaY: Math.max(-4096, Math.min(4096, ev.deltaY)) }); }, { passive: false });
  api().then(tick).catch(() => { el('redeem').hidden = false; show('Sign in with the owner token from the protected viewer-owner.json file.'); });
  setInterval(() => { if (!el('controls').hidden) tick(); }, 1000);
}());
