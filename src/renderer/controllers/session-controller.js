// Session/notes state transitions with context ownership (RF-11).
//
// Every async step captures the session (and a generation) when it is
// dispatched, and writes to the DISPLAYED state only if that session is still
// the current one. Durable results (a saved note) are always recorded against
// the session they belong to, in a session-local cache, even when the user has
// moved on — so "what is stored" and "what is displayed" never get mixed up.
//
// Pure over injected `api` (the preload surface) and `state` (a plain object
// with currentSession, annotations, currentProject, currentUrl, currentTitle,
// sessionEpoch) + `ui` callbacks. Unit-tested with delayed fakes.
import { createGeneration, createOwnerCache } from './operation-context.js';

export function createSessionController({ api, state, ui }) {
  const loadGen = createGeneration();            // latest openSession wins
  const notesCache = createOwnerCache();         // sessionId -> annotations[]
  let creating = null;                           // { key, promise } single in-flight create

  const isCurrent = (id) => !!(state.currentSession && state.currentSession.id === id);
  const bumpEpoch = () => { state.sessionEpoch = (state.sessionEpoch || 0) + 1; };

  // Switch the displayed session. The session is shown immediately with an
  // empty list (never the previous session's notes); the notes it loads are
  // applied only if it is still the latest requested session.
  async function open(session) {
    const token = loadGen.begin();
    bumpEpoch();
    state.currentSession = session;
    state.annotations = notesCache.get(session.id) ? notesCache.get(session.id).slice() : [];
    ui.setNotes(state.annotations);
    ui.sessionChanged(session);
    let list;
    try {
      list = await api.annotations.bySession(session.id);
    } catch (e) {
      if (loadGen.valid(token) && isCurrent(session.id)) ui.toast('Could not load notes: ' + ((e && e.message) || e), 'error');
      return false;
    }
    notesCache.set(session.id, list.slice());
    if (!loadGen.valid(token) || !isCurrent(session.id)) return false; // user moved on
    state.annotations = list;
    ui.setNotes(state.annotations);
    return true;
  }

  // Leave the current session (project change, delete). Invalidates loads.
  function close() {
    loadGen.invalidate();
    bumpEpoch();
    state.currentSession = null;
    state.annotations = [];
    ui.setNotes([]);
  }

  // Persist one note into `session` (the one captured at dispatch).
  async function addNote(session, annotation) {
    const saved = await api.annotations.create({ ...annotation, sessionId: session.id });
    const cached = notesCache.get(session.id);
    if (cached) notesCache.set(session.id, cached.concat(saved));
    ui.bumpCount(session.id, 1);
    if (isCurrent(session.id)) {
      state.annotations.push(saved);
      ui.setNotes(state.annotations);
      return { saved, displayed: true };
    }
    return { saved, displayed: false };
  }

  // The session new notes go to. Concurrent callers share one create, scoped to
  // the project/url intent; a create that finishes after the user switched
  // project/session does not take over the screen.
  async function ensure() {
    if (state.currentSession) return state.currentSession;
    const key = `${state.currentProject ? state.currentProject.id : ''}|${state.sessionEpoch || 0}`;
    if (creating && creating.key === key) return creating.promise;
    const epoch = state.sessionEpoch || 0;
    const promise = (async () => {
      const session = await api.sessions.create({
        projectId: state.currentProject ? state.currentProject.id : null,
        name: 'Quick notes',
        url: state.currentUrl,
        title: state.currentTitle,
      });
      if (!state.currentSession && (state.sessionEpoch || 0) === epoch) {
        bumpEpoch();
        state.currentSession = session;
        state.annotations = [];
        notesCache.set(session.id, []);
        ui.setNotes(state.annotations);
        await ui.refreshSessions();
        ui.toast('Started a “Quick notes” session');
      } else {
        await ui.refreshSessions();
      }
      return session;
    })();
    creating = { key, promise };
    try { return await promise; } finally { if (creating && creating.promise === promise) creating = null; }
  }

  // Keep the session's title fresh as the page reports titles — written back
  // only if that same session is still current when the update lands.
  async function syncTitle() {
    const s = state.currentSession;
    if (!s || !state.currentTitle || s.title) return;
    const id = s.id;
    const updated = await api.sessions.update(id, { title: state.currentTitle, url: state.currentUrl });
    if (updated && isCurrent(id)) state.currentSession = updated;
  }

  // Restore pins: fetch for (session, url), deliver only if still the same
  // session and the caller says the target page is still the same.
  async function restorePins({ session, url, stillValid, deliver }) {
    if (!session || !url) return false;
    let list;
    try { list = await api.annotations.bySessionUrl(session.id, url); } catch (_e) { return false; }
    if (!isCurrent(session.id)) return false;
    if (stillValid && !stillValid()) return false;
    const arr = (Array.isArray(list) ? list : []).map((a) => {
      const i = state.annotations.findIndex((x) => x.id === a.id);
      return { ...a, pinNum: i >= 0 ? i + 1 : null };
    });
    deliver(arr);
    return true;
  }

  return { open, close, addNote, ensure, syncTitle, restorePins, isCurrent, cache: notesCache };
}
