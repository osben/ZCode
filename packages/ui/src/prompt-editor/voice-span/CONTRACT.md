# ui-voice-span

The live voice-dictation text inside the chat editor (specs/voice-dictation.md "Voice text span").
The module exists so the span's node types, replacement rules, and programmatic-update tag live in
one managed place instead of spreading through the editor component.

Invariants:

- Span mutations run only inside editor.update tagged VOICE_SPAN_UPDATE_TAG; the tag doubles as
  the user-typing boundary (updates without it while a span is live are user input).
- The committed node keeps its key across updates (in-place replacement); the tentative suffix is
  a separate node that exists only while tentative text is non-empty.
- Voice nodes never survive a finalize: the final text is a plain text node, so drafts and
  serialization contain no voice nodes.

Consumed only by LexicalChatInput (the updateVoiceSpan/finalizeVoiceSpan/cancelVoiceSpan handle
methods and registerVoiceSpanUserInput); tests drive the $-functions on a headless editor.
