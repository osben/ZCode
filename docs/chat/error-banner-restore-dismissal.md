# Error Banner Dismissal (current state)

The conversation error banner's dismissed state is pane-local UI state. It is not part of the CLI projection and is not written to the workspace Zustand bucket.

- The fingerprint combines session, error code, time and message.
- The pane keeps only the most recent ~20 dismissed fingerprints, so the same error does not reappear repeatedly within the current view.
- After the pane is switched or rebuilt, an authoritative error that still exists is shown again. Dismissing the banner does not clear the CLI error state.
- A new error fingerprint is shown normally.

Entry point: `packages/ui/src/v4/SessionPane.tsx`.
