// Default timer pair for controllers that accept injected timers (for tests).
// Arrow wrappers, not bare references: browsers throw "Illegal invocation" when
// window.setTimeout is called with a different `this` (e.g. `timers.setTimeout()`).
export const DEFAULT_TIMERS = Object.freeze({
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
});
