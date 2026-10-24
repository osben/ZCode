# Post-update release notes

Release notes are edited by infra directly through an API on the `latest.yml` in the runner shared directory,
keeping the electron-updater-compatible `releaseName` / `releaseNotes`. z-code CI no longer generates
per-version `changelogs/vX.Y.Z*.md`, no longer injects notes from the root `CHANGELOG.md`, and no longer
generates a separate `latest-en.yml`; after approval the manifest in the shared directory is validated first and
uploaded only after validation passes.

After an auto-update download completes, the main process persists the current version's notes into
`pendingPostUpdateReleaseNotes` and broadcasts the same payload to the renderer with the `update-downloaded`
state. Hovering the top-left update button shows the Markdown from `releaseNotesByLocale` chosen by the current
UI language; if the old feed has no multi-language field, it falls back to the default `releaseNotes`. If the
user restarts the app before installing and the pending version is still higher than the current app version,
main restores the pending-install state from this payload but does not send it early to the renderer as
post-install notes to acknowledge.

If the user did not install through this auto-update chain (for example a jump upgrade from a website
installer), the disk may still hold notes of a **lower version** awaiting display; at startup, if semver judges
that version lower than the current `app.getVersion()`, the pending item is dropped so an old version's notes are
not popped up.

The current Root silently acknowledges post-install pending notes it receives, so no popup interrupts the user.
Markdown rendering reuses the existing message rendering capability.
