# external-sessions-ui

UI half of "Sessions from other tools" (spec: `specs/external-sessions.md`). The scanner, cache and
the `external-sessions` channel live in `packages/services/src/external-sessions`.

Invariants:

- `contract.ts` is the only file of this module that imports `@zcode/services`; the panel, dialog and
  hook consume the re-exported types.
- The panel renders only when the base workspace services expose `externalSessionsService`
  (desktop local Host) and the host passes `enabled`; web, web remote control and remote workspace
  scopes render nothing and make no RPC call.
- Listing state belongs to the Host cache; `useExternalSessions` only re-queries. `refresh: true` is
  sent for the one request the Refresh button started, never for later filter changes.
- An external session is a local fact: no remote workspace identity is ever attached to it because a
  path happens to match.
- Actions never send a message on the user's behalf: Continue in ZCode leaves an unsent draft,
  Import to ZCode reuses the upstream Claude import, Resume opens a terminal (or copies the command).
