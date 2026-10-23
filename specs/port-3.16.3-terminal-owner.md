# Port 3.16.3: terminals scoped to an owner window

Status: analysis only, not ported

Blockers (details in "Blockers" below): the phone-side producer of `terminalClientSessionId` is not in the desktop bundle and the fork's phone client (`packages/web`) does not send it. Porting only the desktop half would change the lifetime of every phone terminal in the fork, so the port waits for the real 3.16.3 source.

## Evidence and method

- Baseline: `integration` at `809fab71`. The fork is upstream 3.16.2 (`3c5b2276`) plus fork features, as recorded in `specs/upstream-sync-3.16.2.md` (3.16.3 ledger, binary-only).
- Bundle: the extracted 3.16.3 app under the scratch directory, `asar/out/` (`main/`, `host/`, `preload/`, `renderer/assets/`) and `zcode.cjs`. Read-only, never executed.
- Anchors below cite the bundle file plus an identifier. Identifiers wrapped by the bundler as `i(fn, "name")` keep the source name, so `createWindowHostTerminalOwners`, `createTerminalScope`, `endTerminalOwner`, `ensureTerminalOwner` and `setTerminalOwner` are reliable. Other minified names (`nre`, `zN`, `fB`, `x`, `_`, `oe`, `re`, `Ie`, `O$e`, `SI`) are local to their bundle file and are cited only as locations.
- Fork anchors are the current `integration` tree.

Anchor index (file, identifier, location):

| Concern                    | Bundle anchor                                                                                                                                                                   | Fork anchor                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Host owner registry        | `host/index.js` `nre` = `createWindowHostTerminalOwners`, `var fB = nre(...)`                                                                                                   | none                                                                                                                     |
| Host terminal scope        | `host/index.js` `zN` = `createTerminalScope`                                                                                                                                    | none                                                                                                                     |
| Host attachment with owner | `host/index.js` `O$e` = `exposeServicesOnMessagePort` (terminal override `l`, attachment scope `d`)                                                                             | `packages/desktop/src/host/index.ts` `exposeServicesOnMessagePort` (~2625)                                               |
| Host set-owner message     | `host/index.js` `SetTerminalOwner` branch (`fB.setOwner(r.ownerId)`)                                                                                                            | `packages/desktop/src/host/index.ts` `AttachServicePort` branch (~3711)                                                  |
| Host dispose               | `host/index.js` `Ine` (`fB.setOwner(null)`, then `oi.dispose()`)                                                                                                                | `disposeAttachedServicePorts` (~2815)                                                                                    |
| Main owner state           | `main/index.js` `x` = `endTerminalOwner`, `_` = `ensureTerminalOwner`                                                                                                           | none                                                                                                                     |
| Main bootstrap             | `main/index.js` `kd`, case `bootstrap-request` (`_(h, b.terminalClientSessionId)`)                                                                                              | `packages/desktop/src/main/webRemoteControlManager.ts` `routePayload` (~1392)                                            |
| Main bridge open           | `main/index.js` `re` (session check), `oe` = `buildWorkspaceBridge` (`terminalOwnerId`)                                                                                         | `webRemoteControlManager.ts` `buildWorkspaceBridge` (~1002)                                                              |
| Main mobile grace          | `main/index.js` `Ie` = `scheduleMobileDisconnectGrace` (calls `x`)                                                                                                              | `webRemoteControlManager.ts` `scheduleMobileDisconnectGrace` (~580, no owner end)                                        |
| Main app failure           | `main/index.js` `Hn` (calls `x`)                                                                                                                                                | `webRemoteControlManager.ts` failure path                                                                                |
| Main Host bridge           | `main/index.js` `SI` = `createWebRemoteControlSharedHostAttachments` (`setTerminalOwner`, `attachWorkspaceHost` with `terminalOwnerId`)                                         | `packages/desktop/src/main/webRemoteControlSharedHostAttachments.ts`                                                     |
| Shared host message        | `host/chunk-5YNPFY3L.js` `HostMessageTypes.SetTerminalOwner: "set-terminal-owner"`                                                                                              | `packages/shared/src/channels.ts` (~638)                                                                                 |
| Shared schemas             | `renderer/assets/validation-Bm1aanb4.js` (`bootstrap-request`, `workspace-bridge-open`, bridge descriptor `IC`, `bridge-degraded`, `attach-service-port`, `set-terminal-owner`) | `packages/shared/src/validation.ts` (286, 311, 446, 760) and `packages/shared/src/web-remote-control.ts` (449, 478, 616) |

## What 3.16.3 does

A phone (the mobile "terminal" role in relay V2) is a terminal page session. The desktop window that serves it owns one terminal owner at a time. Terminals that a phone creates through its web-remote attachment belong to that owner. When the owner ends, those terminals are disposed.

Only `web-remote-replayable` attachments are scoped. `desktop-continuous` attachments keep the raw terminal service (`host/index.js` `O$e`, `l` is set only when `clientMode === "web-remote-replayable"`).

### Owners

| Owner                                         | Owned by                                         | Identity                                                                                                                                                                        | Created by                                       | Ended by                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main terminal owner (`runtime.terminalOwner`) | `main/index.js` `x`/`_`                          | `{ clientSessionId, id }`. `clientSessionId` is the phone's `terminalClientSessionId`. `id` is a fresh `Ka()` value, the same random helper used for start-authorization tokens | `ensureTerminalOwner` on `bootstrap-request`     | `endTerminalOwner`: bootstrap without `terminalClientSessionId` (only if an owner exists), bootstrap with a different id, mobile disconnect grace expiry, app failure |
| Window Host registry (`fB`)                   | `host/index.js` `createWindowHostTerminalOwners` | one per window Host process (module-level)                                                                                                                                      | `SetTerminalOwner` message (`setOwner(ownerId)`) | `setOwner(null)` (message or `disposeAttachedServicePorts`) or a replacing `setOwner(otherId)`                                                                        |
| Terminal scope (`createTerminalScope`)        | `host/index.js` `zN`                             | one per (owner, scopeKey) with `scopeKey` = `"local"` or `remote:<remoteSessionId>`; or one per web-remote attachment when no owner is given                                    | first `bind` for the key, or attachment setup    | owner change or Host dispose (owner scope); attachment close (attachment scope)                                                                                       |

Terminal scope semantics (`createTerminalScope`):

- `create` checks the scope is active, creates through the underlying service, and records the terminal id with an exit subscription. If the scope was disposed during the await, the new terminal is disposed and the call throws `Terminal owner has ended`.
- `write`, `resize`, `onDynamicData`, `onDynamicExit` throw `Terminal owner has ended or does not own this terminal` unless the terminal id is owned by the scope.
- `dispose({id})` is a silent no-op when the scope is inactive or does not own the id. Otherwise it releases the terminal in the underlying service.
- `dispose()` marks the scope inactive and releases every owned terminal. Release failures go to the `onError` callback (`failed to dispose mobile terminal owner` for the owner registry, `failed to dispose mobile attachment terminal` for attachment scopes).

Owner registry semantics (`createWindowHostTerminalOwners`):

- `setOwner(id)` is a no-op when `id` equals the current owner. Otherwise it replaces the owner and disposes every scope of the previous owner (terminals are killed). `setOwner(null)` clears the owner.
- `bind(ownerId, scopeKey, underlying)` throws `Terminal owner has ended` when `ownerId` is not the current owner. Otherwise it returns the scope service for `scopeKey`, creating the scope on first use. The `underlying` service is captured on first use of a key. Later binds for the same key ignore the argument.

### Attachment wiring (`O$e` = `exposeServicesOnMessagePort`)

For each attachment the Host computes:

- `c = attachment services.getOptional(ITerminalService)`.
- If `clientMode === "web-remote-replayable"` and `c` exists:
  - With `terminalOwnerId` (`a`): the Terminal channel is `fB.bind(a, scopeKey, c)`. The scope survives the attachment. Only owner end or a Host dispose kills its terminals.
  - Without `terminalOwnerId`: the Terminal channel is a per-attachment `zN(c)`. Its terminals are disposed when the attachment closes (`pe.dispose` calls `d.dispose()`).
- `desktop-continuous`: no Terminal override. Behavior is unchanged from 3.16.2.

Note the consequence of the "without owner" branch. Before 3.16.3 (the fork today), a phone attachment has no terminal scope, so phone terminals survive attachment close. In 3.16.3 an attachment without an owner kills its terminals on close.

### Main owner lifecycle

`ensureTerminalOwner(runtime, clientSessionId)` (`_`), called from `bootstrap-request` (`kd`):

1. `clientSessionId` undefined: if an owner exists, `endTerminalOwner`. Otherwise no-op.
2. Same `clientSessionId` as the current owner: no-op.
3. Otherwise `endTerminalOwner` (if an owner exists), then a new owner `{clientSessionId, id: Ka()}`, then `setTerminalOwner(windowId, id)`.

`endTerminalOwner(runtime)` (`x`), in this order:

1. Remember whether an owner existed and clear `runtime.terminalOwner`.
2. `cancelBridgeOpen` (`$`).
3. If `runtime.currentBridge` exists, set `pendingBridgeInvalidation = { zcode_type: "bridge-degraded", bridgeSessionId, bridgeGeneration?, recoveryId?, reason: "terminal-owner-ended" }`. This happens even when no owner existed (observed in `x`; see Reconciling).
4. `disposeRuntimeBridgeResources` (`E`): dispose bridge pipes and release the attachment (`releaseWorkspaceHostAttachment`, which closes the port).
5. If an owner existed, `setTerminalOwner(windowId, null)` so the Host kills the owner's terminals.
6. `sendPendingBridgeInvalidation` (`It`): send now if the transport is up. Otherwise it stays pending.

Other triggers:

- Mobile disconnect: `scheduleMobileDisconnectGrace` (`Ie`) fires after `uN` = 3000 ms (fork: `MOBILE_DISCONNECT_STATUS_GRACE_MS = 3_000`). If it fires while the runtime is current and not in `error`, it calls `endTerminalOwner`, sets `status = "running"` and `mobileConnected = false`, then emits status. A reconnect clears the timer first (`clearMobileDisconnectGraceTimer`).
- App failure (`Hn`): posts `app-error`, then `endTerminalOwner`, then the usual disposal.

### Bridge open

`workspace-bridge-open` (`ve` = handler, `re` = check, `oe` = `buildWorkspaceBridge`):

- `re`: if the request carries `terminalClientSessionId` and it differs from the current owner's `clientSessionId`, reject with `Terminal page session has ended; bootstrap is required.`.
- `oe`: `terminalOwnerId = request.terminalClientSessionId ? runtime.terminalOwner?.id : undefined`. It is put on the bridge (`ee`) and passed to `attachWorkspaceHost` as `terminalOwnerId` (only when defined).
- `attachWorkspaceHost` (`SI`, `i`/`o`): local kind passes `terminalOwnerId` in `AttachServicePort`. Remote kind passes it to `attachRemoteWorkspaceSessionHost` (`Ee`), which posts `AttachServicePort` to the owning window Host with `scope: {kind: "remote", remoteSessionId, workspacePath, workspaceIdentity}`.
- The bridge descriptor sent to the phone (`gN` = `toExternalBridge`, carried in `workspace-bridge-ready`) includes `terminalOwnerId` when set.

### Host side messages

- `set-terminal-owner` (`HostMessageTypes.SetTerminalOwner`): Main posts `{ type: "set-terminal-owner", ownerId: string | null }` to the window Host process (`SI.setTerminalOwner`, `windowHostProcessMap.get(webContents.id ?? windowId)`). It is silently a no-op when the process is missing. The Host has no reply.
- `attach-service-port`: gains an optional `terminalOwnerId`. The Host defers a local attachment while the database is starting (`pendingStartupAttachments`). The owner id is captured in the deferred closure, so `bind` runs at attach time. An owner change between queueing and attach makes `bind` throw. The Host catches it and logs `failed to attach scoped service port`.

## Event order

```mermaid
sequenceDiagram
    autonumber
    participant P as Phone (web remote client)
    participant M as Desktop Main (web remote manager)
    participant H as Window Host (fB registry)
    participant A as Web remote attachment (MessagePort)
    participant D as Desktop renderer (desktop-continuous)

    P->>M: bootstrap-request {terminalClientSessionId: S1}
    Note over M: ensureTerminalOwner(S1): no owner, create owner O1
    M->>H: set-terminal-owner {ownerId: O1}
    H->>H: setOwner(O1)
    M-->>P: bootstrap-response
    P->>M: workspace-bridge-open {terminalClientSessionId: S1}
    Note over M: re(): S1 matches O1, else reject "bootstrap is required"
    M->>H: AttachServicePort {clientMode: web-remote-replayable, terminalOwnerId: O1}
    H->>H: Terminal channel = fB.bind(O1, scopeKey, terminalService)
    M-->>P: workspace-bridge-ready {bridge.terminalOwnerId: O1}
    P->>A: terminal create (RPC)
    A->>H: scope.create, terminal T1 recorded under O1
    Note over D: desktop-continuous attachments use the raw terminal service, unaffected
    P--xM: phone disconnects
    M->>M: scheduleMobileDisconnectGrace (3000 ms)
    Note over M: grace expires, endTerminalOwner
    M->>M: clear owner, cancelBridgeOpen, pendingBridgeInvalidation(terminal-owner-ended)
    M->>M: disposeRuntimeBridgeResources (release attachment)
    M->>H: set-terminal-owner {ownerId: null}
    H->>H: setOwner(null): dispose O1 scopes, kill T1
    M-->>P: bridge-degraded {reason: terminal-owner-ended} (when transport is up)
    P->>M: bootstrap-request {terminalClientSessionId: S2}
    Note over M: ensureTerminalOwner(S2): new owner O2
```

Alternative branch: a second phone page bootstraps with `S2` while `O1` is live. `ensureTerminalOwner` ends `O1` (bridge invalidated, `setTerminalOwner(null)`, then `setTerminalOwner(O2)`). The Host disposes O1's scopes in `setOwner(O2)`. A stale bridge request carrying `S1` is rejected by `re`.

## Interfaces and message schemas

Deltas from the fork, all optional or additive. Each new field needs strict types and runtime validation.

Host message (`packages/shared/src/channels.ts` `HostMessageTypes`):

```ts
SetTerminalOwner: "set-terminal-owner", // placed after DisposeRemoteWorkspaceSession, before AttachServicePort
```

Host message schema (`packages/shared/src/validation.ts`):

```ts
z.object({ type: z.literal("set-terminal-owner"), ownerId: z.string().nullable() }).strict();
```

Attach (`attach-service-port`, validation.ts ~760): add `terminalOwnerId: z.string().optional()` after `type`.

Phone to Main (`packages/shared/src/validation.ts` ~286 and ~311):

- `bootstrap-request`: add `terminalClientSessionId: z.string().optional()`.
- `workspace-bridge-open`: add `terminalClientSessionId: z.string().optional()`.

Bridge descriptor (`IC`, discriminated on `kind`, both `local` and `remote` variants): add `terminalOwnerId: z.string().optional()`. Type: `packages/shared/src/web-remote-control.ts`.

Bridge degraded (validation.ts ~446, web-remote-control.ts ~616-620): add `"terminal-owner-ended"` to the `reason` enum. The fork enum has `source-session-replaced` in validation.ts but not in the TypeScript interface. That gap predates this port and should be kept as is.

Internal interfaces (names from the bundle):

- Host: `createWindowHostTerminalOwners(onDisposeError)` returns `{ setOwner(ownerId: string | null): void; bind(ownerId: string, scopeKey: string, service: ITerminalService): ITerminalService }`.
- Host: `createTerminalScope(service: ITerminalService, onError: (error: unknown) => void): { service: ITerminalService; dispose(): void }`.
- Main: `createWebRemoteControlSharedHostAttachments` returns `setTerminalOwner(windowId: number, ownerId: string | null)`. `attachWorkspaceHost` context gains `terminalOwnerId?: string`.

## Acceptance scenarios

Desktop-continuous (desktop real-time link, `clientMode: "desktop-continuous"`):

1. Desktop creates a terminal, phone bootstraps with a new id, and then the phone disconnects for more than 3 s. The desktop terminal keeps running and its output keeps streaming. Owner changes never touch it.
2. `attach-service-port` for `desktop-continuous` never carries `terminalOwnerId`. The Terminal channel is the raw service. The attachment close does not dispose its terminals.
3. A `set-terminal-owner` message does not change the raw service for desktop attachments.

Web-remote-replayable (mobile recovery link, `clientMode: "web-remote-replayable"`):

4. Bootstrap with `S1`, bridge open with `S1`. Phone creates terminal T1. The bridge is rebuilt (`bridge-degraded` with a non-owner reason such as `rpc-transport-fault`) without a bootstrap. T1 survives. The new bridge uses the same `terminalOwnerId`.
5. Phone disconnects and reconnects within 3 s. The grace timer is cleared. The owner and T1 survive.
6. Phone disconnects for more than 3 s. `endTerminalOwner` runs. T1 is killed. The `bridge-degraded` payload with reason `terminal-owner-ended` stays in `pendingBridgeInvalidation` until the transport next flushes it (`sendPendingBridgeInvalidation`). A later bootstrap creates a new owner.
7. Bootstrap with `S2` while `S1` is live. The bridge for `S1` is invalidated. T1 is killed. A bridge request carrying `S1` is rejected with `Terminal page session has ended; bootstrap is required.`.
8. Bridge open without `terminalClientSessionId` on a window with no owner gets a per-attachment scope. Its terminals are disposed when the attachment closes. The fork today keeps them.
9. Remote workspace: the same as 4 to 7 with `scopeKey = remote:<remoteSessionId>`. Two remote sessions on one owner keep separate scopes. Disposing one remote session does not kill the other's terminals.
10. Race: the owner changes between `AttachServicePort` queueing (startup) and attach. `bind` throws, the attachment fails, and the phone must bootstrap again.

Invariants for both links: no change to `desktop-continuous` owner, snapshot or gap-recovery boundaries; relay V2 remains forwarding-only (no owner state in the relay); Main holds only the owner id and bridge runtime; the Host owns the scopes.

## Divergences from the fork (3.16.2 plus fork features)

- The fork has no owner state in `webRemoteControlManager.ts`. `bootstrap-request` does not call `ensureTerminalOwner`, and the bridge open path does not check owner state.
- The fork's `scheduleMobileDisconnectGrace` does not end any owner. 3.16.3 ends the owner in the grace callback.
- The fork's Host has no `ITerminalService` scoping. Phone terminals are not owned or disposed by the attachment today.
- The fork's `disposeAttachedServicePorts` does not clear an owner, because no owner exists.
- The fork's phone client (`packages/web/src/main.tsx`) sends `bootstrap-request` (~1515) and `workspace-bridge-open` (~1683, ~1701) without `terminalClientSessionId`. It handles `bridge-degraded` generically (~1405, `recoverVisibleSession(reason)`). Whether that recovery re-bootstraps on `terminal-owner-ended` is not shown.
- The fork's relay V2 has a `terminal_sid` in `auth_ack` (`packages/remote-relay/src/app/relay.ts`, `packages/shared/src/web-remote-relay/contract.ts`). It is assigned by the relay per phone connection. It is one candidate for the phone's id, but the bundle does not confirm it.

## Blockers

1. Producer of `terminalClientSessionId` is not in the desktop bundle. I searched every file under `asar/out/` and `zcode.cjs`. The field appears only as schema declarations (`renderer/assets/validation-*.js`, `host/chunk-5YNPFY3L.js`, `preload/*`, `scheduler/index.js`) and as reads in `main/index.js` (`b.terminalClientSessionId`). No file assigns it a value, so the phone is the producer. Its 3.16.3 source is not in this artifact. The renderer `styles-CQuzX8si.js` also has `terminalOwnerId`, but that is a separate renderer xterm cache owner (`releaseStaleOwner(clientNamespace, owner)`). Its provider `Pl`/`n1n` receives the value by props, and no desktop caller passes it. It is not the Host owner.
2. Consequence if only the desktop half is ported: an owner-less phone attachment gets a per-attachment scope (behavior 8). Every bridge rebuild or reconnect that drops the attachment kills the phone's terminals. Today the fork keeps them. The fork's phone client never sends an id, so the port would regress the fork's `web-remote-replayable` recovery link.
3. Choosing the id source (per page load, per phone session in storage, or relay `terminal_sid`) and how the fork's phone client recovers after `terminal-owner-ended` is design work in `packages/web` and the relay client. The bundle does not say which one upstream uses, so guessing it would be a fallback hack.
4. Remote-session scope capture: `bind` keeps the first `underlying` service per scope key. Whether a remote session generation change leaves a stale service in the owner scope is not verified from the bundle. The fork's `windowRemoteConnectionRegistry.resolveScopedServices` may differ.

Gate result: blockers 1 to 3 make the behavior unverifiable with high confidence. Porting would require guessed design in fork-owned phone client code. Status stays "analysis only".

## Reconciling with the real 3.16.3 source

Check these against the upstream source when it is published:

- Names: `createWindowHostTerminalOwners`, `createTerminalScope`, `endTerminalOwner`, `ensureTerminalOwner`, `setTerminalOwner`, `SetTerminalOwner`, `set-terminal-owner`, `terminal-owner-ended`, and the `terminalOwnerId` / `terminalClientSessionId` field names. These come from `keepNames` wrappers and string literals.
- Source of `terminalClientSessionId` on the phone (per page load, persisted, or relay `terminal_sid`), and whether it survives a reload.
- `endTerminalOwner` invalidates the current bridge even when no owner existed (bundle `x` sets `pendingBridgeInvalidation` on any `currentBridge`). Confirm this is intended, since it means a bootstrap with a new id invalidates a bridge opened without an owner.
- `ensureTerminalOwner` does not end an owner for a bootstrap without an id when none exists. Confirm.
- Whether the mobile grace timer is 3000 ms in source (bundle `uN = 3e3`).
- Whether `bind` should capture the underlying service per call (bundle keeps the first).
- Whether `setOwner(id)` disposes the previous owner's terminals before or after the new owner is installed (bundle: installs first, then disposes the old scopes).
- Whether the phone-side `bridge-degraded` handler re-bootstraps on `terminal-owner-ended`.
- Error message strings: `Terminal owner has ended`, `Terminal owner has ended or does not own this terminal`, `Terminal page session has ended; bootstrap is required.`, `failed to dispose mobile terminal owner`, `failed to dispose mobile attachment terminal`.
- Whether bundle-only 3.16.3 host code paths for remote sessions (`attachRemoteWorkspaceSessionHost` passing `terminalOwnerId`) have the same shape in the fork's `desktopRemoteSessions`/`windowRemoteConnectionRegistry` code.

## Next step

When upstream 3.16.3 source is published, re-run this analysis against it. Then port in one change: Host (`createWindowHostTerminalOwners`, `createTerminalScope`, `exposeServicesOnMessagePort`), Main (`webRemoteControlManager.ts` owner lifecycle, `webRemoteControlSharedHostAttachments.ts`), shared schemas, and the phone client (`packages/web`). Tests come first: registry and scope unit tests, message validation tests, and the acceptance scenarios 1 to 10 for both links.
