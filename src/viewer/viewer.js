// Standalone viewer client. It never treats a URL as authority: redemption,
// acquire and resume are explicit, and clicks are dropped when the frame is stale.
(function () {
  const handoffId = location.pathname.split('/').filter(Boolean).pop();
  const statusEl = document.getElementById('status');
  const identityEl = document.getElementById('identity');
  const freshEl = document.getElementById('fresh');
  const frameEl = document.getElementById('frame');
  const redeemForm = document.getElementById('redeem');
  const controls = document.getElementById('controls');
  const note = document.getElementById('note');
  let csrf = '';
  let lastFrame = null;
  let inputOn = false;

  function csrfCookie() {
    const m = document.cookie.match(/(?:^|; )braiwser_csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json', 'x-braiwser-csrf': csrf } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error((data.error && data.error.message) || res.statusText);
    return data.value || data;
  }

  function show(state) {
    statusEl.textContent = state;
  }

  function paint(frame) {
    lastFrame = frame;
    const age = Math.max(0, Date.now() - Date.parse(frame.capturedAt || 0));
    freshEl.textContent = frame.withheld ? 'Private — frame withheld' : `Frame ${frame.sequence} · ${age} ms old`;
    inputOn = !frame.withheld && frame.fresh === true && age < 2000 && frame.sequence > 0;
    if (frame.image) frameEl.src = `data:image/png;base64,${frame.image}`;
    else frameEl.removeAttribute('src');
  }

  async function tick() {
    try {
      const frame = await api(`/v1/handoffs/${encodeURIComponent(handoffId)}/frame`);
      paint(frame);
      const st = await api(`/v1/handoffs/${encodeURIComponent(handoffId)}`);
      identityEl.textContent = `${st.controlOwner || 'unknown'} · ${st.method || ''} · epoch ${st.controlEpoch}`;
      show(st.blocker || st.state || 'connected');
      note.textContent = st.resumeEligible ? 'Return to agent is authorized.' : '';
    } catch (err) {
      inputOn = false;
      show(err.message || 'offline');
    }
  }

  redeemForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    document.getElementById('redeem-error').textContent = '';
    try {
      await api(`/v1/handoffs/${encodeURIComponent(handoffId)}/redeem`, { code: document.getElementById('code').value });
      csrf = csrfCookie();
      redeemForm.hidden = true;
      controls.hidden = false;
      await tick();
    } catch (err) {
      document.getElementById('redeem-error').textContent = err.message;
    }
  });

  document.getElementById('take').addEventListener('click', () => api(`/v1/handoffs/${encodeURIComponent(handoffId)}/acquire`, {}).then(tick).catch((e) => show(e.message)));
  document.getElementById('pause').addEventListener('click', () => api(`/v1/handoffs/${encodeURIComponent(handoffId)}/release`, {}).then(tick).catch((e) => show(e.message)));
  document.getElementById('back').addEventListener('click', () => api(`/v1/handoffs/${encodeURIComponent(handoffId)}/resume`, { requestKey: `vw_${Date.now()}` }).then(tick).catch((e) => show(e.message)));
  document.getElementById('stop').addEventListener('click', () => api(`/v1/handoffs/${encodeURIComponent(handoffId)}/cancel`, {}).then(tick).catch((e) => show(e.message)));
  document.getElementById('priv').addEventListener('click', () => api(`/v1/handoffs/${encodeURIComponent(handoffId)}/private`, { enabled: true }).then(tick).catch((e) => show(e.message)));

  document.getElementById('stage').addEventListener('click', (ev) => {
    if (!inputOn || !lastFrame) {
      show('Input frozen until a fresh frame is acknowledged');
      return;
    }
    const rect = frameEl.getBoundingClientRect();
    api(`/v1/handoffs/${encodeURIComponent(handoffId)}/input`, {
      frameSequence: lastFrame.sequence,
      controlEpoch: lastFrame.controlEpoch,
      x: ev.clientX - rect.left,
      y: ev.clientY - rect.top,
      kind: 'click',
    }).catch((e) => show(e.message));
  });

  api(`/v1/handoffs/${encodeURIComponent(handoffId)}`).then(() => {
    csrf = csrfCookie();
    if (!csrf) { redeemForm.hidden = false; show('Sign in required'); return; }
    controls.hidden = false;
    show('Connected');
    tick();
  }).catch(() => { redeemForm.hidden = false; show('Sign in required'); });

  setInterval(() => { if (!controls.hidden) tick(); }, 1000);
}());
