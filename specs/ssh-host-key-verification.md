# SSH host key verification (ISSUE-055)

Status: implemented on `claude/fix-issue-055-ssh-hostkey`. Upstream 3.16.2 accepts any host key; this is a fork addition.

## Product rule

Every SSH handshake the app makes checks the server host key against the user's OpenSSH `known_hosts`, with the
semantics of `StrictHostKeyChecking=ask`:

| Lookup result                                                          | Outcome                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **match**: a line for this host has the same key                       | Connect.                                                                                                                                                                                                           |
| **unknown**: no line for this host has a key of the offered type       | Refuse this handshake with `remote-host-key-unknown`. The connect dialog shows the key type and SHA256 fingerprint and asks the user to trust it. Accept → append to `known_hosts`, connect again. Reject → abort. |
| **changed**: a line for this host has a different key of the same type | Refuse with `remote-host-key-changed` (`ERR_SSH_HOST_KEY_MISMATCH`). No override in the app. The copy tells the user how to fix `known_hosts`.                                                                     |
| **revoked**: an `@revoked` line carries the offered key                | Refuse with `remote-host-key-changed`.                                                                                                                                                                             |

"Known host with a different key type" is **unknown**, not changed, because ssh2 prefers `ssh-ed25519` while many
`known_hosts` files only carry `ecdsa`/`rsa` lines. To avoid needless prompts the backend reorders
`algorithms.serverHostKey` so the key types already recorded for the host are offered first (OpenSSH does the same).

No path writes `known_hosts` without an explicit user accept in the connect dialog.

## Connections covered

All SSH handshakes go through `SSHBackend.ensureConnected` (`packages/server/src/remote/ssh-backend.ts`), so all of them
verify:

| Path                                                                | UI that can ask    | Behaviour on unknown / changed                             |
| ------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------- |
| Connect dialog (new device, existing device, `connect-device`)      | Inline trust panel | Prompt / refuse                                            |
| Tab or project reconnect (`reconnectRemoteWorkspaceHistoryEntry`)   | none               | Fail closed; error copy points to the connect dialog       |
| Settings → device `connectProfile` / `confirmIdentityChange`        | none               | Fail closed; error shown in the device card                |
| Startup reconnect, online retry, offline probe, `updateServer`, bot | none (silent)      | Fail closed; automatic recovery stops (`retryable: false`) |
| Web `POST /api/connect-remote`                                      | none               | Fail closed                                                |

Jump hosts: `RemoteTarget` has no ProxyJump/ProxyCommand field and the ssh config alias picker only autofills
host/port/user/key, so every connection is a single direct handshake. Nothing to cover.

## Why not prompt inside the handshake

ssh2 allows an async `hostVerifier`, but waiting there for a human does not fit this app:

- ssh2's `readyTimeout` (60 s, `SSH_READY_TIMEOUT_MS`) keeps running while the verifier waits.
- There is no Host → renderer request/reply channel; the connect progress log is one-way.
- Callers that join an in-flight connect (`connectFlights`) cannot answer a prompt; startup, retry and probe have no UI.

So the app uses the repository's existing **fail → confirm → retry** pattern (`source-server-install-required`,
`source-server-identity-change-pending`). The confirm step persists only the exact key the user saw; the retry then
passes the ordinary `known_hosts` check. This gives the same guarantee as `StrictHostKeyChecking=ask`.

## Owners

| State                                             | Owner                                                                | Readers                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `known_hosts` file                                | the user / OpenSSH; the app appends only via `trustHostKey`          | `SSHBackend` verifier (re-read on every handshake, no cache) |
| Observed unknown key (blob, type, fp, host, port) | `SourceServerConnectionManager`, in memory, per `profileId`          | `trustHostKey` (Host only)                                   |
| `hostKeyPreview {keyType, fingerprint}`           | Manager state snapshot (`sourceServerConnectionStateSnapshotSchema`) | Connect dialog via `sourceManagement.getSnapshot()`          |
| Trust decision                                    | User, in the connect dialog                                          | `ISourceServerManagementService.trustHostKey`                |

The pending key is cleared when trust succeeds, when the profile connects successfully, and when the manager is
disposed. A Host restart loses it; `trustHostKey` then fails and the user reconnects to see the prompt again.

## Event order

```mermaid
sequenceDiagram
  participant UI as Connect dialog (renderer)
  participant Main as Electron main
  participant Host as Local Host: Manager
  participant SSH as SSHBackend (ssh2)
  participant KH as ~/.ssh/known_hosts

  UI->>Main: platform.connectRemote(target, requestId)
  Main->>Host: ConnectRemoteWorkspace
  Host->>SSH: adapter.probe → ensureConnected
  SSH->>KH: read (async) + lookup(host, port, key)
  KH-->>SSH: unknown
  SSH-->>Host: verify(false) → Error{code: remote-host-key-unknown, hostKey}
  Host->>Host: pending[profileId] = hostKey; state failed + hostKeyPreview, retryable false
  Host-->>Main: RemoteWorkspaceConnectFailed{reasonCode, profileId}
  Main-->>UI: {success:false, reasonCode, profileId}
  UI->>Host: sourceManagement.getSnapshot()
  UI->>UI: trust panel (key type + SHA256 fingerprint)
  alt Accept
    UI->>Host: trustHostKey(profileId, fingerprint)
    Host->>KH: re-read; match → no-op; same-type different key → refuse; else append
    Host-->>UI: snapshot
    UI->>Main: platform.connectRemote(target, newRequestId)
    Main->>Host: ConnectRemoteWorkspace
    Host->>SSH: ensureConnected → lookup = match → verify(true)
  else Reject
    UI->>UI: abort, show "Host key not trusted" in the error area, nothing written
  end
```

Stale-result rule: the dialog's existing `requestId`/`entryEpoch` checks guard the trust panel exactly like the
install panel; a closed or replaced dialog cannot trust or retry. A pending key is single-use:
`trustHostKey` consumes it, and a second call (or a call after a newer attempt, a Host restart, or with a fingerprint
that differs from the pending one) is refused with `remote-host-key-unknown`, so the user connects again and sees the
key actually offered. The file append itself is idempotent: if `known_hosts` already holds the key it writes nothing,
and if a different key of the same type appeared meanwhile it refuses with `remote-host-key-changed`.

Desktop `desktop-continuous` and mobile `web-remote-replayable` links are not touched: the check runs below them, in
the transport handshake.

## `known_hosts` support

Files read: `~/.ssh/known_hosts` (`os.homedir()`, so `%USERPROFILE%\.ssh\known_hosts` on Windows) and, read-only,
`/etc/ssh/ssh_known_hosts` on macOS/Linux. A missing file is empty. Unreadable or unparsable lines are skipped.

| Format                                    | Support                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `host,host2 keytype base64 [comment]`     | Yes                                                                                            |
| `[host]:port`                             | Yes. Port 22 matches the bare host and `[host]:22`; any other port matches only `[host]:port`. |
| Hashed `\|1\|salt\|hmac`                  | Yes (HMAC-SHA1 of the lookup name).                                                            |
| Wildcards `*` `?` and negation `!pattern` | Yes, OpenSSH semantics (a negated match excludes the line).                                    |
| `@revoked`                                | Yes: the key is refused for any host.                                                          |
| `@cert-authority`                         | Ignored. ssh2 does not verify host certificates, so a host covered only by a CA is unknown.    |

Lookup name is `target.host` as typed (after ssh config alias resolution in the form). These ssh config options are
not honoured: `HostKeyAlias`, `UserKnownHostsFile`, `GlobalKnownHostsFile`, `StrictHostKeyChecking`, `CheckHostIP`,
`HashKnownHosts`.

Appended line: `host keytype base64` for port 22, `[host]:port keytype base64` otherwise, plain (not hashed),
preceded by a newline if the file does not end with one. `~/.ssh` is created with mode 0700 and the file with 0600
when missing (modes ignored on Windows). IO is async (`fs/promises`).

## Interfaces

- `packages/server/src/remote/sshAuth.ts` (the server package's remote directory is not an architecture-managed module,
  so the known_hosts code lives next to the other SSH connect helpers instead of a new file): `describeHostKey`
  (type + `SHA256:` fingerprint, unpadded base64 like `ssh-keygen -l`), `lookupHostKey`, `verifyHostKey`,
  `readKnownHostKeyTypes`, `appendTrustedHostKey`, `orderServerHostKeyAlgorithms`, `defaultKnownHostsFiles`.
- `SSHBackendOptions.knownHosts?: { userFile: string; globalFiles: string[] }`, defaulting to the user's OpenSSH files;
  `SourceServerConnectionManagerOptions.knownHostsFiles` for the trust step. Tests inject a temp dir for both.
- Public error codes: `remote-host-key-unknown` (new), `remote-host-key-changed` (existing). Both carry
  `retryable: false`; both stop automatic recovery.
- Error extra field `hostKey: { host, port, keyType, fingerprint, publicKey }` on the backend error (Host-internal,
  never crosses IPC).
- Snapshot field `hostKeyPreview: { keyType, fingerprint }` (strict schema updated, parse test added).
- `ISourceServerManagementService.trustHostKey(profileId, fingerprint): Promise<SourceServerManagementSnapshot>`.

## Copy

Error messages raised in the backend stay generic (no host, no key) because `onClientError` logs them. The UI builds
the user-facing text from i18n keys:

- `remote.error.hostKeyUnknown`: "Unrecognized host key" / reason: the computer has not connected to this device
  before; open the connection dialog to review the fingerprint. Primary action `retry` (the wizard reconnects, which
  brings the trust panel back; other surfaces reconnect and fail closed again).
- Trust panel: `remote.hostKeyTrustTitle`, `remote.hostKeyTrustDescription`, `remote.hostKeyType`,
  `remote.hostKeyFingerprint`, `remote.hostKeyTrustConfirm` ("Trust and connect"), `remote.hostKeyTrustRejected`.
- `remote.error.hostKeyChanged.reason` (updated): the key no longer matches known_hosts; the device may have been
  reinstalled or the connection intercepted; confirm with the administrator, remove the old entry with
  `ssh-keygen -R HOST` (`ssh-keygen -R "[HOST]:PORT"` for a non-default port) and connect again. Primary action
  `security` (details only); there is no override.

The refused key travels on the backend error as a non-enumerable `hostKey` property, so `console.error` of the
connect error never prints the host, key or fingerprint.

## Logging

The verifier logs nothing at info. `debug` may log the lookup result kind. Host names, keys and fingerprints are never
logged at info or above.

## Acceptance

Unit (fake keys, temp dir, no network): match, unknown, changed, revoked, different key type is unknown, hashed entry,
`[host]:port` entry, port 22 bare host, wildcard and negation, append format and file modes, trust refuses a
fingerprint different from the pending one, the file append is a no-op when the key is already present, a pending key
is single-use, the refused key is not logged, the real transport probe chain carries the key to the manager, automatic
recovery stops on both codes, and the wizard's reject → retry brings the prompt back. Manual (QA, RM-14): see the PR's
Verify steps.

## Open question: existing devices after upgrade

The app never wrote `known_hosts` before, so devices added through the app usually have no entry. After this change
their startup reconnect, tab reconnect and settings connect fail closed with `remote-host-key-unknown` until the user
reconnects once through the connect dialog and trusts the key. Options: (a) accept it and say so in the release notes;
(b) add a one-time banner that opens the connect dialog for affected devices. Auto-trusting previously connected
profiles is not an option: it would trust whatever key is offered at that moment, which is the gap this fixes.
