# desktop-microphone-access

System microphone permission for voice dictation (specs/voice-dictation.md "Microphone permission
guide"). The module exists because the OS privacy store can only be read, prompted, and reset from
the main process, and the renderer needs one trusted surface instead of raw OS access.

Invariants:

- All OS access stays in main: `getMediaAccessStatus`, `askForMediaAccess`, `tccutil`, and settings
  URLs never run in a renderer. The renderer sees only the optional `IPlatformService` capabilities.
- Settings pages are a closed set (`microphone-privacy`, `sound-input`); the renderer cannot pass a
  free-form URL.
- `tccutil reset` addresses only this app's own bundle id, and never runs in dev builds (the
  unpackaged app shares the Electron bundle id and TCC records dev apps by path).
- Re-authorize attempts serialize on one chain; an existing grant is never reset; a post-reset
  denial that persists means `restart-required` (TCC re-reads on next launch), never a retry loop.

Intersections with other modules happen at one hook point: the IPC registration is called from
`desktopMainIpcPlatform` alongside the other platform handlers; nothing else imports this module.
