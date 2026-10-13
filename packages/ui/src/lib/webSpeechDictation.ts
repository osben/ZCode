import type { VoiceTranscriptionPreview } from "@zcode/services";

/**
 * lib.dom.d.ts ships the Web Speech event payloads (SpeechRecognitionEvent /
 * SpeechRecognitionErrorEvent) but not the recognizer itself, so the recognizer surface is
 * declared structurally here and the constructor is detected at runtime (Chrome/Edge expose
 * SpeechRecognition; Safari only the webkit-prefixed name; Firefox has neither).
 */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: ((event: Event) => void) | null;
  onend: ((event: Event) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

/** Returns the browser's SpeechRecognition constructor, or null where the API is unavailable. */
export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const scope = globalThis as typeof globalThis & Record<string, unknown>;
  const candidate = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  return typeof candidate === "function" ? (candidate as SpeechRecognitionConstructor) : null;
}

export type WebSpeechSessionEndReason = "stopped" | "aborted";

export interface WebSpeechDictationSession {
  /** Recognition locale; null leaves the browser default (usually the UI language). */
  language?: string | null;
  /** Audio capture has started (the recognizer's start event). */
  onSessionStart?: () => void;
  onPreview: (preview: VoiceTranscriptionPreview) => void;
  /** Non-fatal recognizer errors; the session still ends through onSessionEnd afterwards. */
  onError: (code: SpeechRecognitionErrorCode) => void;
  /**
   * Fired exactly once per session with the accumulated finalized transcript (trimmed); the
   * reason is "aborted" when the session was cancelled, in which case the transcript is dropped.
   */
  onSessionEnd: (transcript: string, reason: WebSpeechSessionEndReason) => void;
}

/**
 * Browser-native dictation engine for the web remote client. Owns one SpeechRecognition session
 * per start(): the browser captures and transcribes the audio itself, so unlike the desktop
 * VoiceDictationRecorder no PCM stream is collected here. All outcomes are reported through the
 * session callbacks; the engine never touches React state.
 */
export class WebSpeechDictationEngine {
  private recognition: SpeechRecognitionLike | null = null;
  private session: WebSpeechDictationSession | null = null;
  private committed = "";
  private interim = "";
  private stopRequested = false;
  private abortRequested = false;
  private endDelivered = false;

  get isListening(): boolean {
    return this.recognition !== null;
  }

  /** Starts a session; a no-op while another session is running. Throws when start() is rejected. */
  start(session: WebSpeechDictationSession): void {
    if (this.recognition) return;
    const Ctor = getSpeechRecognitionConstructor();
    if (!Ctor) throw new Error("SpeechRecognition is not supported in this browser");
    const recognition = new Ctor();
    this.committed = "";
    this.interim = "";
    this.stopRequested = false;
    this.abortRequested = false;
    this.endDelivered = false;
    this.session = session;
    recognition.lang = session.language ?? "";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (this.recognition === recognition) session.onSessionStart?.();
    };
    recognition.onresult = (event) => {
      if (this.recognition === recognition) this.handleResult(event);
    };
    recognition.onerror = (event) => {
      if (this.recognition === recognition) session.onError(event.error);
    };
    recognition.onend = () => {
      if (this.recognition === recognition) this.settleSession();
    };
    this.recognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      this.settleSession();
      throw error;
    }
  }

  /** Ends the session gracefully; the recognizer flushes pending finals, then ends the session. */
  stop(): void {
    // Latch the request so repeated stops reach the recognizer at most once per session; the
    // session settles when the recognizer answers with its end event.
    if (!this.recognition || this.stopRequested) return;
    this.stopRequested = true;
    try {
      this.recognition.stop();
    } catch {
      // The recognizer can reject stop() when it never actually started; settle locally instead
      // of waiting for an end event that will never fire.
      this.settleSession();
    }
  }

  /** Cancels the session immediately; accumulated finals are discarded, not delivered. */
  cancel(): void {
    if (!this.recognition) return;
    this.abortRequested = true;
    try {
      this.recognition.abort();
    } catch {
      // Not started yet, so no end event will follow; settle synchronously below.
    }
    this.settleSession();
  }

  private handleResult(event: SpeechRecognitionEvent): void {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (!result) continue;
      const transcript = result[0]?.transcript ?? "";
      if (result.isFinal) {
        this.committed += transcript;
        this.interim = "";
      } else {
        this.interim = transcript;
      }
    }
    this.session?.onPreview({ committed: this.committed, tentative: this.interim });
  }

  /** Ends the current session exactly once and releases the recognizer reference. */
  private settleSession(): void {
    if (!this.recognition || this.endDelivered) return;
    this.endDelivered = true;
    const session = this.session;
    const transcript = this.committed.trim();
    const reason: WebSpeechSessionEndReason = this.abortRequested ? "aborted" : "stopped";
    this.recognition = null;
    this.session = null;
    this.committed = "";
    this.interim = "";
    session?.onSessionEnd(transcript, reason);
  }
}
