// Link-and-poll helper for an external harness. It reads handoff status only.
// It never acquires control and never mints a resume grant.
export async function waitForAgent({ status, handoffId, signal, intervalMs = 50, attempts = 40 } = {}) {
  if (typeof status !== 'function') throw new Error('status callback is required');
  for (let i = 0; i < attempts; i += 1) {
    if (signal && signal.aborted) {
      const err = new Error('cancelled');
      err.code = 'CANCELLED';
      throw err;
    }
    const value = await status(handoffId);
    if (value && (value.controlOwner === 'agent' || value.state === 'closed')) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const err = new Error('handoff is still waiting');
  err.code = 'TIMEOUT';
  throw err;
}
