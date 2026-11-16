/**
 * ui-voice-span module contract: everything a caller must know to use the voice span.
 *
 * The voice span is the in-document twin of a running dictation (specs/voice-dictation.md
 * "Voice text span"): preview updates replace the span content in place, the final transcript
 * swaps it for plain text, and a cancel removes it. All operations are Lexical $-functions and
 * must run inside an editor.update tagged with VOICE_SPAN_UPDATE_TAG (lib/editorUpdateTags.ts);
 * the tag is also how user typing is told apart from programmatic updates.
 */
export interface VoiceSpanContract {
  /** Creates the span at the caret (first update) or replaces its content in place. */
  update(preview: { committed: string; tentative: string }): void;
  /** Replaces the span with final plain text; empty removes it; without a span inserts at the caret. */
  finalize(text: string): void;
  /** Removes the span without inserting anything. */
  cancel(): void;
}
