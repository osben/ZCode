# Voice Dictation Feedback Sounds & Recording Mute

Optional audio feedback for voice dictation, modeled after the Handy app (MIT, https://github.com/cjpais/Handy). Two independent settings plus a volume control; all default off/neutral so existing users see no behavior change.

## Settings

All fields live in `voiceDictation` app settings (`VoiceDictationSettings` in `packages/shared/src/protocol.ts`):

| Field                | Type      | Effective default | Meaning                                                                                                  |
| -------------------- | --------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| `feedbackSounds`     | `boolean` | `false`           | Play a short chime when recording starts and when it stops.                                              |
| `feedbackVolume`     | `number`  | `70`              | Chime volume, integer percent 0–100.                                                                     |
| `muteWhileRecording` | `boolean` | `false`           | Mute the OS audio output for the whole duration of a recording; restore the previous state when it ends. |

Read tolerance: `voiceDictation` is parsed with `.catch(undefined)` as a whole, so unknown/bad values from a newer version only drop the field (same policy as the existing dictation preferences). The write-side patch schema stays strict.

## Sound events

Only two sounds exist (Handy parity): **start** (`voice-dictation-start.wav`) and **stop** (`voice-dictation-stop.wav`, Handy "marimba" set, MIT license).

- The start chime plays when the recorder is actually live (phase `idle/loading → recording`).
- The stop chime plays when the user stops a live recording normally (explicit stop, including the quick-tap discard).
- Cancellation and failure paths stay **silent**: window-blur cancel, stream/transcription errors, hook unmount. Errors surface via the existing toast.
- Transcription completion inserts text silently — there is no third sound.
- Chime playback lives in the renderer (`packages/ui/src/lib/voiceDictationFeedbackSound.ts`), volume applied per play; playback failure is logged and never breaks the dictation flow.

## Mute-while-recording ownership and lifecycle

The **Desktop main process owns the mute**: it survives renderer and Host failures, and can restore on quit. The renderer requests it through `IPlatformService.setDictationSystemMute(active)` (optional, desktop-only capability; web/mobile leave it undefined).

```
renderer (useVoiceDictation)          main (desktopDictationSystemAudio)      OS
  | phase → recording                         |                                |
  | play start chime ──(await ended)──►       |                                |
  | setDictationSystemMute(true) ──IPC──►  snapshot output-muted state          |
  |                                       didMute guard (skip if already muted)│
  |                                       osascript/wpctl/pactl/amixer ──►  output muted
  | ... recording ...                        |                                |
  | phase → idle (real stop)                  |                                |
  | setDictationSystemMute(false) ──IPC──► restore snapshot (only if didMute)  |
  | play stop chime                           |                             output restored
```

Guarantees:

- Snapshot/restore: if the output was already muted before recording, the main process does not mute again (`didMute = false`) and does not unmute on release.
- Restore paths in main: explicit release call, `before-quit`, and the applying webContents being destroyed / render-process gone.
- Residual risk (same as Handy): a hard kill of the whole app mid-recording leaves the system muted; no persisted state to recover from.
- Per-OS implementation: macOS `osascript` (read + set); Linux `wpctl` → `pactl` → `amixer` fallback with explicit mute/unmute verbs; Windows v1 is a logged no-op (no state-preserving mechanism without a new native dependency).
- If the platform capability or the spawn fails, muting is skipped with a warn log; recording and chimes continue unaffected.

## Settings UI

Three rows in the voice input settings section (desktop only), below the push-to-talk row:

1. **Sound notification** toggle (`feedbackSounds`).
2. **Volume** slider 0–100% with a percent label and a **Test** button that plays start+stop back-to-back at the current volume, ignoring the enable toggle (so the slider is adjustable before turning sounds on).
3. **Mute system sound while recording** toggle (`muteWhileRecording`).

## Acceptance scenarios

1. Sounds off (default): recording behaves exactly as before; no audio, no IPC.
2. Sounds on, volume 0: chimes "play" silently; no errors.
3. Sounds on: start chime audible right when the mic indicator activates; stop chime on release; nothing on transcription errors.
4. Mute on + macOS: system audio is muted for the entire recording, then restored to its previous mute state.
5. Quit the app mid-recording (Cmd+Q): system audio is restored.
6. Web/remote: the section already renders as unavailable; new fields are inert.
