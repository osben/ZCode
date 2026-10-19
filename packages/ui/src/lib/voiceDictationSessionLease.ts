/**
 * Owner of the voice dictation session for one renderer window (module state, so it is not shared
 * across windows). Each composer's dictation hook takes the lease when it leaves the idle phase and
 * gives it back when it returns to idle. Within the window only one composer (main conversation,
 * side conversation, or draft) may record, transcribe, or post-process at a time, so a second start
 * cannot open a second microphone or a second Host stream. Cross-window concurrency is a known gap:
 * the microphone is OS-global, so Main or the Host would be the real owner (specs/voice-dictation.md).
 */
let sessionOwner: symbol | null = null;

/** Returns true when `owner` now holds the session (free, or already held by the same owner). */
export function acquireVoiceDictationSession(owner: symbol): boolean {
  if (sessionOwner === null || sessionOwner === owner) {
    sessionOwner = owner;
    return true;
  }
  return false;
}

/** Releases the session only when `owner` holds it; a stale caller cannot free another composer's session. */
export function releaseVoiceDictationSession(owner: symbol): void {
  if (sessionOwner === owner) sessionOwner = null;
}

export function getVoiceDictationSessionOwner(): symbol | null {
  return sessionOwner;
}
