// Hand-off result modal: wrote the request file, optional agent preset, run.
//
// Where the agent runs matters. A local project has a directory (and possibly an
// entry file inside it); an imported bundle or URL project has neither, so the
// request is written to Braiwser's own data folder and an agent started there
// would not be looking at the user's code. Optional props describe that:
//   cwd                    absolute directory the agent command would run in
//   entry                  the project's entry file, when the project points at a
//                          file (index.html) rather than a directory
//   needsLocalDirectory    true when the project has no local directory: Run agent
//                          is disabled and the dialog explains why
//   onChooseDirectory()    optional; lets the user pick one. Resolve to
//                          { cwd, file? } (or a cwd string) once chosen, falsy to cancel
//   notices                extra strings from the hand-off (e.g. "entry is a file;
//                          using its folder"), shown above the file path
import { h, modal, esc, toast } from '../lib/dom.js';

export function openHandoffModal({
  file,
  command,
  presets,
  onSetCommand,
  onRun,
  onReveal,
  onCopy,
  onVerify,
  cwd,
  entry,
  needsLocalDirectory = false,
  onChooseDirectory,
  notices,
}) {
  const outPre = h('pre', { class: 'agent-output' });
  outPre.style.display = command ? 'block' : 'none';
  const presetRow = h('div', { class: 'preset-row' });
  const list = Array.isArray(presets) ? presets.filter((p) => p.id !== 'cat') : [];
  const hint = h('div', { class: 'field-hint', style: { margin: '0 0 8px' } });

  function setHint() {
    if (command) {
      hint.innerHTML = 'Agent command: <code>' + esc(command) + '</code>';
    } else {
      hint.textContent = list.some((p) => p.available)
        ? 'Pick an agent on this machine, or copy the prompt.'
        : 'No coding-agent CLI found on PATH. Copy the prompt, or pick a preset to save a command.';
    }
  }
  setHint();

  list.forEach((p) => {
    const btn = h('button', {
      class: `btn btn-sm ${p.available ? '' : 'btn-ghost'} ${command === p.command ? 'btn-primary' : ''}`,
      text: p.available ? p.label : p.label + ' (not found)',
      title: p.command,
      on: {
        click: async () => {
          if (onSetCommand) await onSetCommand(p.command);
          command = p.command;
          setHint();
          Array.from(presetRow.children).forEach((c) => c.classList.remove('btn-primary'));
          btn.classList.add('btn-primary');
          toast('Agent command saved', 'success');
        },
      },
    });
    presetRow.appendChild(btn);
  });

  // ---- where would the agent run? ----
  let blocked = !!needsLocalDirectory;
  const fileEl = h('div', { class: 'mono handoff-file', style: { wordBreak: 'break-all', marginBottom: '10px', color: 'var(--text)' }, text: file || '(no file was written)' });
  const cwdEl = h('div', { class: 'mono handoff-cwd', style: { wordBreak: 'break-all', marginBottom: '10px', color: 'var(--text)' } });
  const cwdRow = h('div', { class: 'handoff-cwd-row' }, [
    h('div', { style: { color: 'var(--dim)', marginBottom: '6px' }, text: 'An agent command runs in:' }),
    cwdEl,
  ]);
  const notice = h('div', { class: 'handoff-notice', role: 'status' });
  const chooseBtn = onChooseDirectory
    ? h('button', {
        class: 'btn btn-sm',
        text: 'Choose project folder…',
        on: {
          click: async () => {
            let picked;
            try { picked = await onChooseDirectory(); } catch (err) { toast('Could not choose a folder: ' + ((err && err.message) || err), 'error', 5000); return; }
            const dir = picked && typeof picked === 'object' ? picked.cwd : picked;
            if (!dir) return;
            cwd = dir;
            if (picked && picked.file) { file = picked.file; fileEl.textContent = file; }
            blocked = false;
            syncWhere();
            toast('Agent will run in ' + dir, 'success');
          },
        },
      })
    : null;

  function syncWhere() {
    cwdRow.style.display = cwd || blocked ? 'block' : 'none';
    cwdEl.textContent = cwd ? cwd + (entry ? '  (entry: ' + entry + ')' : '') : '(none)';
    notice.textContent = '';
    notice.style.display = 'none';
    const lines = [];
    if (blocked) {
      lines.push('This project has no local directory (it was imported or opened from a URL), so there is no code folder to run an agent in. The request was saved in Braiwser’s data folder instead. Copy the prompt, or choose the project folder on this computer to run an agent against it.');
    }
    (Array.isArray(notices) ? notices : []).forEach((n) => { if (n) lines.push(String(n)); });
    lines.forEach((l) => notice.appendChild(h('p', { class: 'handoff-notice-line', text: l })));
    if (lines.length) {
      notice.style.display = 'block';
      notice.classList.toggle('is-blocked', blocked);
    }
    if (chooseBtn) chooseBtn.style.display = blocked ? 'inline-flex' : 'none';
    const runBtn = dlg && (dlg.actionButtons || []).find((b) => /Run agent/.test(b.textContent));
    if (runBtn && !running) {
      runBtn.disabled = blocked;
      runBtn.title = blocked ? 'No local project directory to run the agent in' : '';
    }
  }

  const body = h('div', {}, [
    notice,
    h('div', { style: { color: 'var(--dim)', marginBottom: '6px' }, text: 'Wrote change-request prompt to:' }),
    fileEl,
    cwdRow,
    chooseBtn ? h('div', { style: { marginBottom: '10px' } }, [chooseBtn]) : null,
    hint,
    list.length ? presetRow : null,
    outPre,
  ]);

  let unsub = null;
  let running = false;
  let dlg;
  const actions = [
    { label: 'Reveal', kind: 'ghost', onClick: () => { if (onReveal) onReveal(file); return true; } },
    { label: 'Copy prompt', kind: 'ghost', onClick: async () => { if (onCopy) await onCopy(); return true; } },
  ];
  actions.push({
    label: 'Run agent',
    kind: 'primary',
    onClick: async () => {
      if (blocked) { toast('This project has no local directory — choose one, or copy the prompt', 'warn'); return true; }
      if (!command) { toast('Pick an agent preset first, or copy the prompt', 'warn'); return true; }
      if (running) return true;
      running = true;
      const runBtn = (dlg.actionButtons || []).find((b) => /Run agent/.test(b.textContent));
      if (runBtn) { runBtn.disabled = true; runBtn.setAttribute('aria-busy', 'true'); }
      if (dlg.card) dlg.card.setAttribute('aria-busy', 'true');
      outPre.style.display = 'block';
      outPre.textContent = '$ ' + command + '\n\n';
      try {
        const result = await onRun({ command, file, cwd, onChunk: (chunk) => { outPre.textContent += chunk; outPre.scrollTop = outPre.scrollHeight; } });
        const tag = result && result.ok ? 'done' : 'exit ' + ((result && result.exitCode) ?? '?') + (result && result.error ? ' — ' + result.error : '');
        outPre.textContent += '\n[' + tag + ']\n';
        toast(result && result.ok ? 'Agent finished' : 'Agent exited with errors', result && result.ok ? 'success' : 'error');
      } finally {
        running = false;
        if (runBtn) { runBtn.disabled = blocked; runBtn.removeAttribute('aria-busy'); }
        if (dlg.card) dlg.card.removeAttribute('aria-busy');
      }
      return true;
    },
  });
  if (onVerify) {
    actions.push({
      label: 'Verify',
      kind: 'ghost',
      onClick: () => { onVerify(); return false; },
    });
  }
  actions.push({ label: 'Close', kind: 'ghost' });

  dlg = modal({ title: 'Hand off to agent', width: 600, body, actions, onClose: () => { if (unsub) unsub(); } });
  syncWhere();
  return dlg;
}
