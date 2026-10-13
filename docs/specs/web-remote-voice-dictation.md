# Web Remote Voice Dictation (Web Speech API)

## Goals and Scope

Add a microphone dictation entry to the chat composer of the web remote control client (the remote control page running in a browser): capture and transcription happen in the browser via the standard Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`), and the transcribed text flows into the Composer through the same `onTranscript` insertion path as on desktop. The desktop Host whisper chain (`useVoiceDictation` + `IVoiceDictationService` + 16 kHz PCM recording) stays unchanged; no recording or transcription code is shared between the two.

```mermaid
sequenceDiagram
    participant U as User (web remote)
    participant C as Composer (V4ComposerVoiceButton)
    participant H as useWebSpeechDictation
    participant E as WebSpeechDictationEngine
    participant B as Browser SpeechRecognition
    U->>C: click microphone
    C->>H: toggle()
    H->>E: start({language, callbacks})
    E->>B: new SpeechRecognition(); start()
    B-->>E: start event
    E-->>H: onSessionStart (phase → recording)
    B-->>E: result (interim / final)
    E-->>H: onPreview (reuses the VoiceTranscriptionPreview preview)
    U->>C: click again to stop
    C->>H: toggle()
    H->>E: stop()
    B-->>E: end event
    E-->>H: onSessionEnd (accumulated final text)
    H->>C: onTranscript(text) (appendText inserts into the composer)
    B-->>E: error (not-allowed / network / …)
    E-->>H: onError(code)
    H-->>U: toast (microphone failure / transcription failure)
```

## Engine Choice Matrix

| Environment                                                   | Capture and transcription                                                       | Entry visibility                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- |
| Desktop (Electron)                                            | Host whisper: `useVoiceDictation` (shortcut, push-to-talk, 16kHz PCM streaming) | Always visible (unchanged)                     |
| Web remote + SpeechRecognition available (Chrome/Edge/Safari) | Browser Web Speech API: `useWebSpeechDictation`                                 | Visible                                        |
| Web remote + API missing (Firefox etc.)                       | None                                                                            | Hidden (not disabled, avoiding a dead control) |
| Plain browser-accessed Web (not remote control)               | None                                                                            | Hidden (unchanged)                             |

The engine must be pluggable: both hooks expose the same control surface to the UI (`phase / level / preview / start / stop / toggle`), and `V4ComposerDictationControl` selects the engine by runtime mode. A future host-whisper engine over the relay only has to implement the same control surface and plug in there — zero changes to the button or the insertion path.

## Privacy Note (boundary accepted for the first iteration)

Chrome/Edge perform SpeechRecognition in the cloud (audio is processed by Google servers); Safari routes through Apple infrastructure. In other words, audio leaves the local browser to the platform vendor, though it never leaves the machine's microphone directly. The first iteration accepts this trade-off; the privacy-preserving alternative planned as a follow-up is a host-whisper engine: audio is sent over the existing relay to the desktop Host's `IVoiceDictationService` (which expects 16 kHz mono PCM16 little-endian, see `packages/services/src/voice-dictation/voiceDictation.ts`); once it implements the same `onTranscript` contract it can replace the UI branch.

## Behavioral Contract

- State ownership: session state (phase/preview/final text) lives only inside the `useWebSpeechDictation` hook; an engine instance serves exactly one session lifecycle, and `endDelivered` guarantees `onSessionEnd` is dispatched at most once per session. The UI holds no dictation state.
- Start: `continuous = true`, `interimResults = true`, `maxAlternatives = 1`; `lang` comes from `settings.voiceDictation.language` (empty — browser default — when `auto` or missing); the web side reads none of the desktop preferences (modelId, input device, idle unload).
- Preview: interim results map to `{ committed, tentative }` (reusing the `VoiceTranscriptionPreview` shape and the existing button preview UI); `committed` is the accumulated finalized text.
- Insertion: when the user stops (or the browser auto-ends on silence), the accumulated final text is trimmed and inserted once through `onTranscript`; empty text is never inserted. Same as desktop: the insert is performed by the Composer's `insertVoiceTranscript` (appendText + focus).
- Idempotency: `start`/`stop`/`toggle` are no-ops on repeated calls or when not in the idle phase; the engine ignores a start while already listening and treats stop as a no-op when not listening.
- Error handling (never silent): `not-allowed` / `service-not-allowed` / `audio-capture` → toast `voiceDictation.microphoneFailed`; other errors such as `network` / `language-not-supported` → toast `voiceDictation.transcribeFailed`; both are warn-logged via `packages/ui/src/logger.ts`. `no-speech` (silence auto-end) and `aborted` (accompanies stop/abort; final text still arrives via onSessionEnd) follow the desktop short-recording silent semantics: info log only, no toast. Synchronous exceptions thrown by start are treated as transcription failures and never strand the UI in loading.
- Unmount/cancel: on unmount the session is aborted — no text inserted, no state written (matching the desktop semantics of not inserting when unmounted during finalize).
- Desktop non-regression: `enabled: !webRemote` keeps the desktop branch fully inactive in web remote mode; the desktop call arguments stay byte-identical to the status quo.
- Accessibility: reuses the existing button (aria-label / aria-pressed / live region); the web engine has no audio level, so level is constantly 0 and the level bars render at their minimum baseline.
- The settings page `VoiceDictationSection` stays desktop-only (web remote keeps showing the "Desktop only" badge); this iteration adds no settings.

## Acceptance Scenarios

1. Firefox (no API) opening web remote control: no microphone entry in the composer; Chrome: entry visible.
2. Chrome clicks the microphone → speaks → interim text appears in the preview → clicks stop again → the final text is inserted once at the composer cursor.
3. Denying microphone permission (`not-allowed`): a toast reports the microphone failure and the UI returns to idle; a `network` error likewise reports transcription failure.
4. Rapidly repeated microphone clicks / repeated start and stop calls: no exceptions, no duplicate inserts.
5. Desktop (Electron): behavior completely identical to before the change (existing `useVoiceDictation` tests stay green); the presence or absence of the Web API does not affect the desktop branch.
6. Staying silent until the browser auto-ends: no toast, no insert, info log only.

## Verification

- `packages/ui/test/useWebSpeechDictation.test.ts` (jsdom + mocked SpeechRecognition) covers the hook/component-level scenarios 1, 2, 3, 4, and 5 above.
- `pnpm typecheck`, `pnpm lint`, `npx oxfmt --check <changed files>`, `pnpm architecture:check --changed`.
- Real-microphone and per-browser manual testing cannot run in CI/worktree; manual steps are listed in the PR's "Not verified" section.
