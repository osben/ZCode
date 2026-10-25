# Desktop remote workspace Renderer reattach

Current spec. Applies to renderer reload / ErrorBoundary recovery in the same BrowserWindow and to project
attachment reattach after a Source comes online. SSH/WSL/Docker are managed uniformly by the window Local
Host; the independent/pooled Remote Host process model is no longer used. Ownership of project entries and
caches follows the [virtual project design](../superpowers/specs/2026-09-09-virtual-project-design.md).

## Authority and delivery order

| Fact                                                              | Sole owner                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Source physical connection and recovery                           | Window Host `SourceServerConnectionManager`                                             |
| logical session, remoteSessionId, generation, workspace readiness | Window Host `WindowRemoteConnectionRegistry`                                            |
| Window routing and Renderer port delivery                         | `routesBySessionId` in Main `desktopRemoteSessions.ts`                                  |
| Renderer services registration and gate                           | Renderer service store; a sessionId in a tab is not ready evidence                      |
| Project identity                                                  | `workspaceIdentity?.trim() \|\| workspacePath`, separate from the actual execution path |

```text
same-window renderer ready → Main enumerates routes with attachmentState=attachable
  → request an attachment from the existing Window Host → deliver RemoteServicePort
  → Renderer registers scoped services / ready ACK → workspace RPC allowed
Source generation change → Registry replaces session/generation → Main replaces route → re-establish attachment
```

- Only routes of this window that are still attachable are reattached; pending, disposed and stale-generation routes are not delivered.
- Reattach replaces the port and attachment and never destroys the shared Window Host, the physical Source or remote tasks.
- A remote port arriving before the base ServicePort is parked and flushed once base is ready; it must not be dropped.
- Concurrent connects to the same workspace may return the same sessionId; Main joins the existing route/attachment and does not overwrite a healthy route.
- A late ready, port or old timer cannot reclaim a new generation; a failure releases exactly this attachment.
- Desktop stays continuous; mobile keeps sharing the existing Host's replayable attachment, and Main/relay hold no business snapshot.

## Cold-start selection and existing Renderer reattach

[Virtual project F5](../superpowers/specs/2026-09-09-virtual-project-design.md) is the new persistence
authority: cold start restores only the active execution directory from `lastActiveWorkspace`, other project
entries are read from Host SQLite, and an attachment is created when the user opens them.
`lastWorkspaceSession` is a degraded compatibility projection, not the new open set; cold start must not
generate tabs for all of A/B just because it lists them. Old settings without the new field keep the one-time
import and active-first fill. "All open projects" below means only the disconnected tabs the current Renderer
actually keeps, not every directory in the old field.

```text
Cold start: Host-saved connection → Source online
        lastActiveWorkspace → active tab → attachment
        Host project entries → user opens another project → attachment for that directory
Same-window disconnect recovery: existing tabs → Source online → reattach one by one, without stealing focus
```

## Two-level recovery gate

1. Host cold start tries every saved connection once, sorted by most recent online time, with no 7-day filter; only credentials the default Profile can fetch silently are used, and the global auto-reconnect off switch is respected. legacy candidates and those needing interaction/upgrade/migration confirmation stay manual.
2. The Renderer restores the open, disconnected, stable-identity projects of that Source in the current window only after Management observes the Source online; it no longer filters by workspace age or last connected state.
3. Directory validity is checked by Host admission; one project failing does not block the others. The remote conversation UI is disabled, so its historical entries do not enter recovery candidates.
4. Deduplicate per cycle; after a terminal close, no immediate self-recovery without an observed offline. Siblings arriving after active-first are checked by workspace key and must not be swallowed by a Source-level attempted marker.

## Navigation recovery and reattach gate (RDUX-09)

The main window restores the last activated remote project and session selection; see [navigation spec §2.3](./project-first-remote-navigation-spec.md#23-重连与重启后回到原处rdux-09). The constraint "Source online does not auto-activate" is kept: the startup position is decided by tab persistence, and background reattach does not rewrite focus. The Host still warms only local paths, and the Renderer may activate a remote placeholder first; before the first ready no remote content is read/rendered, and failure or not-connected keeps the original tab and banner. Already loaded content is kept read-only by the existing owner; mobile replayable does not consume desktop navigation recovery.

## Manual Disconnect Boundary

A user-initiated disconnect is a terminal intent within the current window and is not startup recovery or
abnormal-disconnect recovery. Of the Source status events only entering `online` may trigger startup recovery
of historical workspaces; when an existing tab goes from live session to a disconnected placeholder, only the
disconnected state is updated and recovery is not retriggered. Active-first startup fill of a new disconnected
tab may still trigger one candidate recomputation.

A directory delta by itself is still not a reconnect signal; but when it first fills the
`legacyWorkspaceIdentity -> remote:server:*` mapping, the Renderer must first synchronously re-project the
recovered in-memory sessions and disconnected tabs. Whether to recover afterwards is decided only by Source
`online`, open membership, stable identity and the once-per-connection-cycle dedup gate; silent credentials
and the global auto-reconnect switch are enforced at the Host startup reconnect. An ordinary rename, route
deletion, recording an opened project or an isolated `failed` history must not be widened into an automatic
recovery initiator; once a Source flight is admitted, a failed open entry is only a recovery member of that
flight.

The owner of automatic recovery is the online Source, not some workspace initiator. Source `online` only
decides whether a Source flight may start this round; once started, the flight must traverse all open and
disconnected entries of that Source within the current window, without filtering by workspace age or last
connected. A member that is already live or in another recovery flight is settled only for itself and must not
mark the whole group skipped. A Source whose manual connection is not yet online keeps reusing the Host's
device-connection initiator/credential gate; this rule does not widen it.

## Regression and evidence boundary

| Stable ID       | Contract and original recorded status                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DRS-RR-01       | Same-window ready replaces the attachment and keeps the session; originally unit covered.                                                                            |
| DRS-RR-02/05    | pending is not delivered; remote port parked before base ready; originally planned in the Accepted Cases, not to be inferred as passing from the candidate table.    |
| DRS-RR-03/08    | Two-level recovery, legacy→stable re-projection; originally unit / real SSH covered, valid only for the recorded baseline.                                           |
| DRS-RR-04/06/07 | Mobile boundary unchanged; non-qualifying startup candidates stay disconnected; manual disconnect triggers no self-recovery.                                         |
| DRS-RR-09       | An admitted Source flight skips already-live members and continues with siblings; the current UI recovers projects only.                                             |
| DRS-RR-10       | Route/attachment join on repeated connect; originally conversation scenarios are unit + real SSH pending. Old UI scenarios are not current navigation pass evidence. |

The 10-second startup budget belongs only to the Host physical flight; on timeout a stable error is settled
first, then abort and exact cancellation of the transport. The Renderer cannot call connectProfile ahead of
that to widen the same recovery flight, and a late handshake must not register online.

Test files and run evidence are in the [coverage matrix](../testing/conversation-session-e2e-coverage-matrix.md);
the old candidate table, Accepted Cases and historical limits are kept in
`git show 45f808f7:docs/remote/desktop-remote-session-renderer-reattach.md`.
This text records no run results and changes no formal/pending status.
