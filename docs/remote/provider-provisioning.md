# Remote Provider Provisioning

## Status

Current implementation spec. This capability means only one Desktop-initiated Local Environment -> Remote
Environment configuration Provisioning. It does not change the Provider/Model authority boundary of remote
Workspaces and does not restore the historical `workspace/updateProviderRegistry` snapshot sync. The Desktop
model settings page is always bound to the Local Environment and offers no remote config editing or manual
sync entry.

## Goal

When a Remote Environment comes online, and after local model config, default model, account state or
syncable credentials are saved successfully, the Local Environment's latest complete snapshot is copied
automatically to every online Remote Environment. This v0 capability provides no remote config management UI;
the Local Environment is the edit authority and the remote keeps only a disposable execution mirror.

## Invariants

- The remote formal `provider_config.json`, `model-selection.json`, `setting.json` and Credential Store remain the fact sources of the remote Environment.
- Provisioning writes only the target Environment's formal Stores; afterwards the target Environment rebuilds Provider Config, Account Source and Registry itself.
- No complete Registry, Runtime Model, API Key snapshot or dynamic headers are injected into the Remote Worker.
- The cross-Environment `provider/updateAccountConfig` is not used; that protocol still belongs only to the in-process sync of remote Host -> remote Worker.
- Provisioning does not go through the relay and persists no Secret in Desktop Main, Renderer or remote task state.
- Deleting a local allowlist credential deletes the same-named remote credential at the next sync; non-allowlist credentials are unaffected.
- Desktop `continuous`, Mobile `replayable` task streams and the existing workspace identity routing are unchanged.

## Trigger and scope

### Automatic triggers

Runs only for SSH, WSL, Docker and Server remote, triggered by a successful persist or an Environment
lifecycle event:

- a Remote Environment goes from zero online connections to at least one;
- Personal Provider Config saved successfully;
- Configured Default saved or cleared successfully;
- an account narrow setting allowed by the Provisioning Envelope saved successfully;
- an allowlist credential saved or deleted successfully.

Every sync overwrites the corresponding remote mirror with the latest complete local snapshot, without
checking whether the remote already has config or comparing the two sides. An empty local Personal Config is
written as empty as well; allowlist credentials use replace semantics. On the first-connection sync only
`applied` / `already-applied` may publish Remote Workspace ready; a first result of `failed`,
`rollback_failed` or `unsupported` ends the request through the formal connection-failure channel. A later
sync failure of an already published Workspace does not tear down the connection; it only leaves a
Secret-free structured warning and waits for the next real trigger to read the latest snapshot again.

When an R3 Source Server auto-reconnect changes the `remoteSessionId` generation
(`desktopRemoteSessions.ts handleReconnected`), Desktop Main first disposes the registration bound to the old
session and re-registers the same Environment key with the new `remoteSessionId`, equivalent to the
Environment coming back online: it triggers one `environment-online` full redelivery, filling in local config
changes made while offline. A reconnect is not a publish barrier; a failure only logs a structured warning
and does not tear down the restored Workspace.

### Environment-level coordination

A Workspace is not a sync unit. Several Workspaces and windows of the same Remote Environment share one sync
lane in Desktop Main:

```text
Workspace A ─┐
Workspace B ─┼─> Remote Environment key ─> single-flight lane ─> executed by one online Host
Workspace C ─┘
```

Main keeps only the Environment key, Host registration, trigger, generation and request correlation, and
neither reads nor forwards config or Secrets. The selected Window Host re-reads the latest Local Source at
execution time and calls that Environment's Remote Target. New triggers during a sync only advance the
generation; after the current round ends the latest snapshot is read once more for a trailing sync; there is
no queue per event and no fixed delay.

### Physical connection close and sync request closure

The Window Host's `ServerRemoteConnection` owns the lifecycle of the transport, `SocketProtocol` and
`ChannelClient`. On explicit disconnect, socket close/error or handshake failure it must idempotently release
that connection's RPC client and protocol; unfinished requests and those waiting for Initialize are rejected
with `ConnectionClosed`, and a late response cannot complete an old request again. Connection-close events
still notify the upper layer per the existing Source lifecycle. `connectOnce` holds connection ownership
before writing the online table; every failure exit, including a handshake record persist failure or a
version-parse throw, releases the unpublished connection exactly once. After a successful publish the online
table takes over, and a late close of an old connection does not affect the new one.

```text
Provider apply not yet returned -> Source disconnects -> old ChannelClient.dispose
                                      -> Host returns sync failure -> old lane closes
new Source connection -> same Environment reads latest config -> sync succeeds -> Renderer attachment ready
```

The remote config file already updated does not mean the whole apply RPC has ended; a disconnect at that
moment must still satisfy the contract above. The first-sync barrier must not be skipped, and a hanging
request must not be sidestepped by UI delays, clearing the sync queue or extra retries. The WebSocket Server
and the Duplex connection shared by SSH/WSL/Docker follow the same rule; a mobile relay disconnect and
replayable attachment recovery do not mean the physical Source ended and trigger no such cleanup. No change
to workspace identity, session routing, desktop-continuous/web-remote-replayable semantics or the persisted
format; no data migration.

Regression coverage: `serverRemoteConnectionLifecycle.test.ts` uses real network requests to cover an RPC not
returned at disconnect, the new connection's Environment sync, late responses and duplicate release;
`r3-provisioning-gui` keeps the GUI assertions of disconnecting right after deletion, offline modification,
group-header reconnect, latest-config sync and continuing the conversation.

### Desktop model settings page

Whether the active workspace is local or remote, the model settings page reads and writes the local
Provider/Model config through the Local Environment's `IProviderSettingsService`. The page does not read the
remote Provider Settings and shows no Local -> Remote manual sync button. Remote config can be changed only
from the remote Environment's own management entry; first-connection automatic Provisioning still follows the
conditions and failure semantics above.

The model connectivity test on the page also belongs to the Local Environment. With a remote Workspace
active, the test must pick a local workspace as the Agent cwd; with no usable local workspace it returns an
unavailable result and must not send the remote `workspacePath`/`workspaceIdentity` to the Local Host.

```text
SettingsPage
  └─ Model Provider section
       └─ ServiceProvider(localHostServices)
            └─ Local IProviderSettingsService

Active workspace (local / remote) ── decides only the workspace context, never the model config data source
```

### Validation boundary

Sync must reject corrupt JSON, unknown Envelope structure, malformed allowlist credentials, credential
decryption failures and fact changes during config reading; these errors must not be masked by skipping
fields or partial writes. Runtime fields of a Personal Provider (such as `api.baseURL`) may enter the Personal
Layer as strings (including unfinished values), but an invalid Provider must fail closed at Registry
integrity validation, must not block the sync of other valid Providers in the same file and must not enter
the executable Registry. Non-allowlist Credential records are not sync facts, so even a corrupt value there
must not block reading the allowlist credentials; an allowlist entry itself must still be a string and
decryptable with the Source cipher.

The sync is still an atomic replacement of the whole Personal Layer and never silently drops or partially
overwrites a Provider; an invalid Provider stays in the target Personal Config and surfaces through the
target Environment's Provider Settings integrity issues. The Configured Default is an initial preference for
new sessions, not a success condition of config copying. Sync must keep it as is; when the Provider/Model is
missing or reasoning is absent or invalid, the target Host's existing `resolveInitialModelSelection` picks an
available Registry recommendation. With no usable model it stays without recommendation and never fabricates
an executable model. The fully written config must not be rolled back for this, and the persisted default or
the selection of existing sessions must not be cleared or rewritten.

```text
Old behavior: full write -> default preference validation fails -> whole rollback -> workspace connection rejected
New behavior: full write -> refresh succeeds -> open workspace -> Host resolves the default preference or a Registry recommendation
Actual IO / refresh failure -> original transaction rolls back -> first connection rejected
```

This adjustment changes only Provisioning's handling of the default preference; the Target still owns the
transaction and the Registry, and Main still only schedules. No retry, timeout pass-through or second state
copy is added. Desktop `desktop-continuous` and mobile `web-remote-replayable` keep accessing services
through the trusted attachment of the same ready Host, and the stream, snapshot, queue, owner/lease and
`workspaceIdentity` boundaries are unchanged.

## Sync data

### Config

Syncs the Personal Layer:

- `providers`;
- `modelConfigRules`;
- `providerOrder`;
- the Configured Default in `model-selection.json`.

ZCode Built-in Provider/Model Releases are not copied. The remote keeps using its own Built-in Release; a
difference in candidate sets may make the default preference unavailable, handled by the Host
recommendation rule above and not treated as a config copy failure.

### Account connection state

Only the narrow fields needed for account resolution are synced:

- `providerFamilyDomain`;
- `providerFamilyConnectionSelections`.

The whole `setting.json` is not copied, to avoid overwriting the remote's proxy, data directory, locale,
window and task settings.

### Credentials

The sync scope is defined by a versioned allowlist:

- `oauth:active_provider`;
- the access token, refresh token and user info of `oauth:zai:*` and `oauth:bigmodel:*`;
- `zcodejwttoken`.

After the OAuth -> Project Token migration, `account-provider:*:api-key` is no longer in the sync allowlist.
The Source neither decrypts nor sends the old account Key; the Target neither reads, overwrites nor deletes
existing old/manual Keys. A new Source always emits `schemaVersion=2`, expressing the semantics of replacing
only the OAuth allowlist; a new Target accepts v1/v2, ignores old `account-provider` entries of v1 after
validation, and counts only actually synced OAuth entries in the result. v2 allows no account Key entries. An
old Target accepts only v1 and rejects v2 before the transaction and any Store write. The Host reports a
failure under existing sync failure semantics, does not downgrade the envelope to v1 and does not pass the old
Key through; the remote's existing OAuth, Keys and config stay untouched until the Target is upgraded. The
on-disk idempotency state version is unchanged.

```text
new Source v2 -> old Target v1 validation rejects -> zero writes, old credentials kept
new Source v2 -> new Target -> replaces only the OAuth allowlist
old Source v1 -> new Target -> ignores historical account Keys, keeps the target's existing values
```

The target Host exchanges for a Token using the synced login state and its own Key ID cache; short-lived
Tokens and the ID cache are not transferred across Environments. The Key of an explicit manual Provider is
still synced with the Personal Config. This does not change the existing sync lane, transaction rollback or
the desktop continuous / mobile replayable boundaries.

SSH passwords/private keys, Bot credentials, MCP OAuth tokens, plugin Secrets and other generic Credential
keys are not exported.

The local and remote Credential ciphers may differ, so copying `credentials.json` ciphertext directly is
forbidden. The Source decrypts allowlist values through the Credential Service and the target re-encrypts to
disk through its own Credential Store. Results and logs record only counts, status and non-Secret
identifiers, and never return or print credential values.

## Transaction and rollback

The Provisioning Envelope contains:

- `schemaVersion`;
- `syncId`;
- source config/model/settings revision (used only for the Source's read-consistency check);
- no cross-Environment conflict revision judgment on the target side;
- the Personal Layer, Configured Default, account narrow settings and allowlist credentials.

The target validates the whole Envelope first, then writes in this order:

1. account narrow settings;
2. credentials (re-encrypted on the target);
3. `provider_config.json`;
4. `model-selection.json`.

Each formal file uses the existing atomic write and lock. Inside the transaction the target stages the old and
new value of every domain; when any step fails, all domains already written are restored in reverse order of
the record; a restore failure must return `rollback_failed` and must never report success. After rollback the
target's in-memory Account Source/Registry is refreshed so the restored facts take effect at once, but no
successful Provisioning result is produced. After success the target actively refreshes the Account
Source/Registry, and the existing remote Host -> Worker account overlay chain then syncs to the Agent Worker.

A running Active Model keeps the "frozen at creation" semantics; Provisioning affects subsequently created
Models/Sessions and never silently rewrites an in-flight request.

## Process boundary

```text
Desktop Main: Environment Coordinator (scheduling metadata only)
  └─ picks one online Window Host of that Environment
       ↓
Window Host
  ├─ re-reads the Local Provider Provisioning Source
  └─ Remote Target RPC (SSH/WSL/Docker/Server)
       ↓
Remote zcode-server
  ├─ Target Store writes and rollback
  ├─ Remote ProviderRuntime refresh
  └─ Remote Host → Worker Account Config sync
```

The Remote Target RPC does not reuse the Renderer's `IProviderSettingsService` write interface, so
"cross-Environment copy" and "remote local edit" are not mixed into one path without idempotency or rollback.

### Worker Registry refresh barrier

After Provisioning writes the target Environment's Personal Config, an existing Agent Worker may still hold
the in-process Registry from before the write. Before session creation, model switch and input execution, the
remote Host must have the target Worker read from its own formal Config Store and refresh the Registry
through the internal `provider/refreshRegistry` request; the request carries no Desktop Registry, credentials
or model config snapshot. The refresh and the pending Selection validation must complete before the input
ACK; a refresh failure or an unavailable Selection rejects this input and keeps the user draft, and must not
ACK first and let a background turn fail silently. V4 `switchModelConfig` and the input command share this
refresh barrier: the model switch command is sent only after the refresh succeeds.

```text
Host execution admission
  -> Worker provider/refreshRegistry
  -> Worker reads local Personal/Account Config and rebuilds Registry
  -> Selection validation
  -> ACK + turn execution
```

This barrier does not restart the Worker, does not change the creation-time freezing of a running Active
Model and does not change the Desktop `continuous` or Mobile `replayable` transport boundaries.

## Compatibility and failure semantics

- The Result and Host execution result gain an optional `errorCode` accepting only a fixed enum: `source-read-failed` (local snapshot read), `target-call-failed` (remote call threw, including validation/pre-read/RPC), `target-write-failed` (target Store write), `target-refresh-failed` (account/Registry refresh), `target-commit-failed` (idempotency record write), `target-apply-failed` (an old target returned only a failed status), `capability-unavailable`, `session-unavailable`, `host-execution-failed`. `rollback_failed` still expresses a rollback failure on its own and does not override the original failing stage. Error codes contain no path, credential or remote free text.
- A new Host uses `target-apply-failed` for a missing or unknown error code from an old Target; old results are still readable. The Envelope version, success status and idempotency file version are unchanged, and unconfirmable underlying faults are not inferred. The default-preference fix requires publishing the remote server bundle together; with only the Host updated, an old Target still runs the original strict validation.
- A first-sync failure records the Environment, trigger, status, errorCode and duration before rejecting; the connection panel and feedback both receive a failure line carrying the safe error code. Later failures of an existing connection still record only a warning. The raw `errorMessage` / `error` is not copied directly to Main logs or the Renderer.
- A legacy remote on first connection that does not support the Provisioning capability returns `unsupported`, sends no Secret and does not publish Remote Workspace ready.
- The HTTP `zcode-server` opens the trusted Desktop Host's Provisioning target only after `ZCODE_SERVER_AUTH_TOKEN` is configured; without authentication it stays "unsupported", so the cross-Environment credential write entry is not exposed to anonymous connections.
- The R3 Source Server Core (`packages/zcode-server-cli`, `serviceAuthorityMode: "standalone-server"`) **always** registers the Provisioning target: the R3 ingress token (`<serverRoot>/run/ingress-token`, 0600) always exists, so the "unsupported when authentication is unconfigured" branch above does not apply. Isolation is done at the `clientMode` layer: a `desktop-continuous` connection on `/ws/host` (capability ticket + ingress token) gets the real `IProviderProvisioningTargetService`; a `web-remote-replayable` connection on `/ws` is overridden in `exposeWebSocket` by a throwing stub ("Provider Provisioning 仅支持受信 Desktop Host" - supported only for a trusted Desktop Host), and the Window Host's mobile allowlist does not contain this channel. An old-version daemon (no target) never receives an Envelope on the R3 main chain: `ZCODE_MIN_COMPATIBLE_VERSION` defaults to the product version, the R3 compatibility gate decides "upgrade needed" at handshake and runs the remote update first, and the updated Core enters the first-connection Provisioning. The ZCode Built-in Provider Config used by the Core is materialized by a build-time define by content hash at `~/.zcode/server/config/provider/zcode-builtin-<sha256>.json` (not written into the immutable release directory). The R3-side wiring is in [r3-source-server-remote-architecture.md §8.3](../architecture/r3-source-server-remote-architecture.md).

  ```text
  zcode-server-cli Core (standalone-server, target always present)
    ├─ /ws/host  desktop-continuous ──► IProviderProvisioningTargetService (real implementation)
    └─ /ws       web-remote-replayable ─► { apply: () => throw }  (stub; the mobile allowlist does not contain this channel either)
  ```

- An automatic sync failure after the Remote Workspace is connected only records a structured warning, does not tear down the existing connection and does not change the local save-success feedback; this round adds no Environment error state, protocol, banner or settings-page entry. This is a transitional semantics until independent remote config management goes live.
- When a network drop makes the result unknown, retry with the same `syncId`; when the target receives any already completed `syncId` again it returns the previous result and does not re-apply an old Envelope because later syncs overwrote the idempotency record.
- While the Environment is offline one pending sync intent is kept and executed with the latest local state after it comes back online; ordinary failures do not loop-retry and wait for the next real trigger.

## Connection initialization of Desktop-attached Sources and the reverse resource channel

For every generation of physical RPC connection that SSH / WSL / Docker establish through
SourceServerConnectionManager, before publishing online and allowing logical workspace attachment, the
Desktop's current `dynamicWorkflowMode` is delivered first. Automatic reconnects also read the latest mode; a
mode sync that is unsupported or fails only logs a warning and keeps the existing old-version compatibility
behavior. A standalone `kind: "server"` keeps its own settings authority and does not receive this mode.

The reverse RPC channel for group-topic resources and channel reply is owned by the physical connection, and
the several logical workspaces of one Source share it. Every request is first validated through the registry
that `remoteSessionId + workspaceIdentity + workspacePath` still belongs to a currently online attachment,
then checked that its Agent service is the proxy instance of that physical connection; the logical
ServiceCollection object being the same cannot serve as physical identity, and a request must not pass by
workspace path alone. Socket close, connection failure or physical connection dispose all release the reverse
channel and in-flight reads; closing a logical tab does not close the physical connection shared by other
tabs. A new physical connection creates its own channel, and an old-generation request must not borrow the new
generation's permissions.

```text
physical RPC established → register reverse channel → deliver Desktop workflow mode → Manager publishes online
                         │                                  └→ multiple logical attachments
physical close/release ────┴→ cancel old-generation resource requests; reconnect re-executes from RPC establishment
```

This seam manages only the authenticated physical connection and reverse routing and adds no runtime,
accepted input queue or business state. The desktop continuous and the mobile shared-host replayable
boundaries keep their respective trusted attachment's clientMode.

Source Server internal peer routing uses the canonical workspace identity; before a reverse RPC returns to
Desktop it is mapped back to the stable identity through the same workspace identity mapper, and responses are
mapped to canonical again. The Desktop registry's permission check keeps using the stable identity; the
internal identity must not leak as a second attachment identity, and the check must not be lowered to
comparing only workspacePath to get around validation.

## Default-preference and first-failure diagnostic regression

- The real-Store regression of `R3A-PRV-05` must verify full replacement after deleting a Provider, keeping the invalid default, and an empty Registry returning no recommendation; `R3A-PRV-11` must verify an invalid Provider stays in the Personal Layer but is not executable, the invalid default is persisted as is and the Host recommends a legal model. Neither may keep asserting "roll back if the default is unavailable"; real write, refresh and commit failures are still verified for rollback by `R3A-PRV-08`.
- Focused tests cover missing/invalid reasoning, missing Provider/Model, an empty Registry, a valid default, write/refresh/idempotent-commit failures and rollback, and safe handling of old results and unknown error codes.
- `SSH-P0-CONN-08` verifies through real Electron -> SSH -> remote Target: with a corrupted local sync credential both the error and the connection log show `source-read-failed`; after restoring the credential, even with the invalid default kept, the remote directory and workspace can be entered. The case uses the existing no-account startup fixture so an unrelated fake OAuth does not trigger a login-expired dialog.
- 2026-10-09: macOS Desktop -> isolated Ubuntu 22.04 aarch64 SSH E2E passed, artifact `desktop-e2e-20261009032604472-p1453-8bb89553244ba5cc`. The case stays pending, not manually promoted. Windows/WSL, other remote systems and mobile UI were not tested; no on-site input from the original feedback user was obtained, so reproducing every user's historical incident is not claimed. Rollback reverts this commit; no persisted format migration.
