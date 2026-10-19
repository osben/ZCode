/**
 * App-wide owner of the single voice dictation session. Each composer's dictation hook takes the
 * lease when it leaves the idle phase and gives it back when it returns to idle. Only one composer
 * (main conversation, side conversation, or draft) may record, transcribe, or post-process at a
 * time, so a second start cannot open a second microphone or a second Host stream.
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
