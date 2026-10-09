'use strict';
// Main-owned Electron CDP input primitive (audit §E, ported + generalised).
//
// The broker owns ONE debugger connection per registered guest; it is never
// selected by a caller-supplied webContentsId. This primitive only SENDS INPUT:
// observation, ref resolution and actionability are prerequisites it does not
// pretend to provide, and it never claims verification (status is 'dispatched').
//
// It accepts either
//   * a debugger LEASE from src/main/services/browser/debugger-broker.js
//     ({ send, onLost, lost, released, release }) -- the production path: the
//     lease is shared and ref-counted, so closing us never detaches someone
//     else's attachment; or
//   * a bare webContents (the audit's original shape), which attaches its own
//     debugger and detaches on close() only if it still owns the attachment.
//
// Safety rules carried over from the audit:
//   * every Input.* command is preceded by control.beforeDispatch() (lease, owner,
//     epoch and permission are re-checked at the last moment);
//   * if anything fails after mouse-down, no late mouse-up is ever sent (it could
//     activate a control on a different document): the pointer is quarantined
//     (`closed = true`) and the caller must reset / reconcile;
//   * a detach / loss makes every later call fail DRIVER_DISCONNECTED.

const MODIFIER_BITS = Object.freeze({ Alt: 1, Control: 2, Meta: 4, Shift: 8 });

const KEYS = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
});

function fail(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

const noop = Object.freeze({ beforeDispatch() {}, check() {} });

class CdpPointer {
  constructor(source, options) {
    const o = options || {};
    this.closed = false;
    this.wc = null;
    this.lease = null;
    this.ownsAttachment = false;
    this._offLost = null;
    if (source && typeof source.send === 'function') {
      this.lease = source;
      this.ownsLease = o.ownsLease === true;
      if (source.lost || source.released) { this.closed = true; return; }
      if (typeof source.onLost === 'function') {
        this._offLost = source.onLost(() => { this.closed = true; });
      }
      return;
    }
    const webContents = source;
    this.wc = webContents;
    if (webContents.debugger.isAttached()) throw new Error('DEBUGGER_BUSY');
    webContents.debugger.attach('1.3');
    this.ownsAttachment = true;
    this.onDetach = () => { this.closed = true; this.ownsAttachment = false; };
    webContents.debugger.on('detach', this.onDetach);
  }

  _gone() {
    if (this.closed) return true;
    if (this.wc && this.wc.isDestroyed()) return true;
    if (this.lease && (this.lease.lost || this.lease.released)) return true;
    return false;
  }

  async _command(method, params) {
    if (this.lease) return this.lease.send(method, params);
    return this.wc.debugger.sendCommand(method, params);
  }

  // Send one Input.* command behind the last-moment dispatch check.
  async _send(control, method, params) {
    if (this._gone()) throw fail('DRIVER_DISCONNECTED');
    (control || noop).beforeDispatch();
    await this._command(method, params);
  }

  async clickCssPoint({ x, y, viewportWidth, viewportHeight }, control) {
    if (![x, y, viewportWidth, viewportHeight].every(Number.isFinite)
      || x < 0 || y < 0 || x >= viewportWidth || y >= viewportHeight) {
      throw new Error('INVALID_VIEWPORT_POINT');
    }
    const send = (type, extra = {}) => this._send(control, 'Input.dispatchMouseEvent', { type, x, y, ...extra });
    let pressed = false;
    try {
      await send('mouseMoved');
      pressed = true; // delivery can be uncertain if the command rejects
      await send('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
      await send('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
      pressed = false;
      return { status: 'dispatched', evidence: [] };
    } finally {
      if (pressed) {
        // Do not send a late mouse-up after cancellation: that can activate a
        // button on a different document. Quarantine and require reset/reconcile.
        this.closed = true;
      }
    }
  }

  // Types text into the currently focused element (focus is the caller's job).
  async insertText(text, control) {
    if (typeof text !== 'string' || text.length > 10000) throw new Error('INVALID_TEXT');
    await this._send(control, 'Input.insertText', { text });
    return { status: 'dispatched', evidence: [] };
  }

  // key: "Enter" | "a" | "Shift+Tab" | "Control+a". Named keys only; callers validate policy.
  async pressKey(key, control) {
    const parts = String(key).split('+');
    const main = parts.pop();
    let modifiers = 0;
    for (const p of parts) {
      if (!MODIFIER_BITS[p]) throw new Error('INVALID_KEY');
      modifiers |= MODIFIER_BITS[p];
    }
    const named = KEYS[main];
    const single = Array.from(main).length === 1;
    if (!named && !single) throw new Error('INVALID_KEY');
    const spec = named || { key: main, code: /^[a-z]$/i.test(main) ? `Key${main.toUpperCase()}` : '', vk: main.toUpperCase().charCodeAt(0), text: main };
    const printable = !!spec.text && !(modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Alt | MODIFIER_BITS.Meta));
    const base = { modifiers, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
    let down = false;
    try {
      await this._send(control, 'Input.dispatchKeyEvent', { type: printable ? 'keyDown' : 'rawKeyDown', ...base, ...(printable ? { text: spec.text } : {}) });
      down = true;
      await this._send(control, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      down = false;
      return { status: 'dispatched', evidence: [] };
    } finally {
      if (down) this.closed = true; // key left pressed: quarantine rather than guess
    }
  }

  close() {
    if (this._offLost) { try { this._offLost(); } catch (_e) { /* ignore */ } this._offLost = null; }
    if (this.lease) {
      if (this.ownsLease) { try { this.lease.release(); } catch (_e) { /* ignore */ } }
      this.closed = true;
      return;
    }
    this.wc.debugger.removeListener('detach', this.onDetach);
    // Only detach an attachment this instance still owns: a detached-then-reattached
    // debugger belongs to another client now.
    if (this.ownsAttachment && this.wc.debugger.isAttached()) this.wc.debugger.detach();
    this.ownsAttachment = false;
    this.closed = true;
  }
}

module.exports = { CdpPointer, KEYS };
