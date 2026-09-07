// Hand-off result modal: wrote the request file, optional agent preset, run.
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

  const body = h('div', {}, [
    h('div', { style: { color: 'var(--dim)', marginBottom: '6px' }, text: 'Wrote change-request prompt to:' }),
    h('div', { class: 'mono', style: { wordBreak: 'break-all', marginBottom: '10px', color: 'var(--text)' }, text: file }),
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
      if (!command) { toast('Pick an agent preset first, or copy the prompt', 'warn'); return true; }
      if (running) return true;
      running = true;
      const runBtn = (dlg.actionButtons || []).find((b) => /Run agent/.test(b.textContent));
      if (runBtn) { runBtn.disabled = true; runBtn.setAttribute('aria-busy', 'true'); }
      if (dlg.card) dlg.card.setAttribute('aria-busy', 'true');
      outPre.style.display = 'block';
      outPre.textContent = '$ ' + command + '\n\n';
      try {
        const result = await onRun({ command, file, onChunk: (chunk) => { outPre.textContent += chunk; outPre.scrollTop = outPre.scrollHeight; } });
        const tag = result && result.ok ? 'done' : 'exit ' + ((result && result.exitCode) ?? '?') + (result && result.error ? ' — ' + result.error : '');
        outPre.textContent += '\n[' + tag + ']\n';
        toast(result && result.ok ? 'Agent finished' : 'Agent exited with errors', result && result.ok ? 'success' : 'error');
      } finally {
        running = false;
        if (runBtn) { runBtn.disabled = false; runBtn.removeAttribute('aria-busy'); }
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
}
