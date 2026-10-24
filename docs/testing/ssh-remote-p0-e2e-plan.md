# SSH Remote P0 E2E Spec

> The 2026-09-07 full regression uses [R3 merged automation plan](r3-remote-automation-plan.md) as its entry point and the [R3A matrix](r3-remote-automation-case-matrix.md) for per-case contracts. The "single server / no mobile" pruning below does not limit the new plan. The legacy `zcode-server.cjs` PID helper, legacy manifest proxy assertions and explicit Provider sync wording must be reworked to the current R3/Provisioning model before reuse. Existing formal/pending status does not mean the new baseline passed.

## Definition

SSH P0 is not a single case. It is the core set of cases for "a user can connect, develop, chat and keep working after common lifecycle events".

```text
Ubuntu 24.04 + password SSH
  |
  +-- connect/auth ----> directory ----> remote workspace identity/session
  |                                         |
  |                                         +-- file tree / terminal / Git
  |                                         |
  |                                         +-- task / request / reply
  |                                         |
  |                                         +-- close / restart / disconnect / reconnect
  |
  +-- one BrowserWindow ----> one Window Host ----> one shared SSH connection
                                               +--> workspace A logical session
                                               +--> workspace B logical session
```

Every case has its own setup, action and assertion. A long flow passing through a state does not make that state covered.

## Confirmed environment boundary

The user confirmed (2026-08-10) that phase one uses one existing server: Ubuntu 24.04, root, password SSH. Credentials are injected by the runtime environment. Docs, specs, fixtures, artifacts and error messages must not store the password.

| Dimension          | Phase one includes                                                                                          | Phase one prunes                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| target             | One Ubuntu 24.04 SSH server                                                                                 | Multiple servers, same path under different host identities         |
| auth               | password                                                                                                    | SSH config alias, private key, passphrase, agent forwarding         |
| workspace          | Multiple absolute paths under one target                                                                    | Other SSH targets, 3+ workspace scale combinations                  |
| client             | Desktop `desktop-continuous`                                                                                | Mobile `web-remote-replayable`, Bot, cross-window                   |
| user capability    | connect, directory, file, terminal, Git, task, restart/reconnect                                            | tool/MCP, attachments, queue, stop, permission, Goal, compact       |
| internal lifecycle | App cold-start auto reconnect, SSH Source disconnect and manual retry, OS service and detached daemon start | renderer reload (covered by the separate `R1-RELOAD-01`)            |

## P0 case set

### A. Connection and authentication

| Case ID        | Setup                                                                                                                  | Action                                                                                                                               | Assertions                                                                                                                                                                                                                                                         | Status                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| SSH-P0-CONN-01 | Local E2E workspace ready; target server reachable                                                                     | Open the SSH wizard from the composer workspace menu, connect with password, pick a remote directory                                  | Deploy/handshake/directory RPC succeed; tab `path`, `workspaceIdentity`, `remoteSessionId` correct; exactly one Window Host; tab/store/log hold no secret                                                                                                          | formal                                                                                         |
| SSH-P0-CONN-02 | Target server reachable                                                                                                | Connect with a wrong password, see the failure, retry with the correct password                                                      | Error visible and free of secrets; failure commits no workspace tab and leaves no usable logical session/Agent; retry succeeds                                                                                                                                    | formal                                                                                         |
| SSH-P0-CONN-03 | Target reachable; local test proxy keeps the first TCP connection pending and passes later connections through to SSH  | Connect with the old password, click "取消连接" (cancel connection) during pending, then immediately retry the same host/port/username with the correct password | First connection closes with no logical session or remote write; retry uses a new request/credential, reaches directory selection and opens the workspace; Host PID unchanged; WSL/Docker/Server cancel semantics unaffected                                       | pending (`manual-review/pending/conversation-session-ssh-remote-cancel-retry.test.ts`)         |
| SSH-P0-CONN-04 | Target reachable; local HTTP proxy configured in settings; remote-resource test CDN only reachable through that proxy  | Choose "download locally then upload" and connect an SSH workspace                                                                    | Proxy captures the Source Server descriptor request that first install must send; the fake CDN host cannot be reached directly; deploy/handshake and workspace open succeed; Host PID unchanged. Same-port routing of the Source Server archive is covered by forced cache miss in `sourceServerReleaseResolver.test.ts` | pending (`manual-review/pending/conversation-session-ssh-remote-local-download-proxy.test.ts`) |
| SSH-P0-CONN-05 | Ubuntu/minimal/container SSH target without an accessible user service manager                                         | Connect with password, confirm install, open the workspace                                                                            | Automatic detached fallback; daemon ready, `serviceRegistered=false`; Desktop disconnect does not stop the daemon; reconnect after remote environment restart relaunches it; errors/logs do not blame a Node warning                                                | pending                                                                                        |
| SSH-P0-CONN-08 | Local synced credentials are corrupt; SSH target reachable                                                             | Connect and fail, restore credentials, keep the invalid default model, retry                                                          | First error and connection log carry a safe source-read-failed message without credentials; no dirty tab; retry succeeds and the default preference is not rewritten                                                                                                | pending (`manual-review/pending/conversation-session-ssh-provisioning-failure.test.ts`)        |

### B. Remote development basics

Test data lives only under case-created `/root/.zcode-e2e/ssh-p0-*` isolated directories. Setup/cleanup goes through a test control connection and never touches user files outside them.

| Case ID       | Setup                                            | Action                                                                     | Assertions                                                                                                   | Status |
| ------------- | ------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| SSH-P0-DEV-01 | Remote isolated directory with a unique marker file | Connect it, expand the file tree and open a file; create a file in Terminal and refresh the tree | List and preview come from the remote; the new file is visible; the same local path plays no part; path execution semantics correct | formal |
| SSH-P0-DEV-02 | Remote isolated workspace connected              | Open Terminal and run `pwd`, an Ubuntu/system marker command and a file write | Output comes from remote Ubuntu; cwd equals the remote `workspacePath`; writes land only on the remote; control connection re-verifies the remote file | formal |
| SSH-P0-DEV-03 | Remote isolated directory is a Git repo with a baseline commit | Modify a remote file and open the Git pane/status | Git pane shows the remote repo's tracked/untracked changes; control connection re-verifies the modified marker; no test commit is created | formal |

### C. Task, request and multi-workspace

| Case ID        | Setup                                                                                                                      | Action                                                         | Assertions                                                                                                                                                                                        | Status                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| SSH-P0-TASK-01 | Case-local provider replay reachable by the remote Agent through a test-only SSH reverse tunnel; two directories on one target | Create and send a first prompt in each of workspace A/B, then switch back to A/B and send follow-ups | Task rows sit in the right workspace; running to idle without error; four requests and replies visible; A2 carries only A history, B2 only B history; identity/session independent; Window Host PID unchanged | formal                                                                                                    |
| SSH-P0-TASK-02 | A/B connected, each with a finished task                                                                                   | Close workspace A, switch back to B and send; then reopen A    | Closing A releases only its own attachment/session; B's task, requests and replies keep working; reopening A reuses the shared Host and does not overwrite B                                       | pending (`manual-review/pending/conversation-session-ssh-remote-task-lifecycle.test.ts`)                  |
| SSH-P0-TASK-03 | A connected with a finished task; case-local replay delays the follow-up response by 15s                                   | After the follow-up starts streaming, open and close the settings page; wait for completion | The sidebar task row spins during the follow-up; toggling settings does not create a second sessions-index subscription (the same attachment and topic would be silently replaced by the CLI); after completion the sidebar running state clears and matches the chat area | pending (`manual-review/pending/conversation-session-ssh-remote-settings-overlay-sidebar-status.test.ts`) |

### D. Persistence, disconnect and recovery

| Case ID        | Setup                                                                                                                                                 | Action                                                                                                                                | Assertions                                                                                                                                                                                                                | Status                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| SSH-P0-LIFE-01 | A/B have history tasks; default Profile credentials obtainable silently; Server connected within the last 7 days; after explicit disconnect the workspace history is all failed | Fully restart Electron/Main/Host; without clicking manual reconnect, wait for the main-window Host to auto-reconnect within the 10 s single-node budget and continue the original task | Stable Source/identity/path with no secret; failed history does not block A/B from getting a new `remoteSessionId`; task/history restored; follow-up hits the original task; no duplicate workspace/daemon; at startup each Server is tried once | pending (`manual-review/pending/conversation-session-ssh-remote-cold-reconnect.test.ts`) |
| SSH-P0-LIFE-02 | A/B share one online SSH Host                                                                                                                         | Kill only the `zcode-server` started by this case (never `sshd`), then click reconnect on A                                           | A/B both disconnected, local workspaces unaffected; exactly one new SSH Host is established; A/B each get a new `remoteSessionId` and recover; task/file routing does not cross                                            | pending (`manual-review/pending/conversation-session-ssh-remote-server-fault.test.ts`)   |

## Shared invariants

| Invariant                                  | P0 proof                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| One Host per BrowserWindow                 | Before and after every case Process Monitor shows the same single Window Host PID; app cold start excepted, after which exactly one new Host exists |
| Same-target workspaces share an SSH connection | A/B do not redeploy/re-handshake; one matching remote `zcode-server`; logical sessions independent               |
| identity and path are never mixed          | Isolation/keys use `workspaceIdentity?.trim() \|\| workspacePath`; file/git/terminal cwd uses `workspacePath`      |
| Remote execution, local app-global         | file/git/terminal/Agent come from the remote; setting/credential/provider come from local and sync explicitly       |
| desktop continuous does not leak replayable | P0 builds no mobile attachment and asserts no replayable gap/snapshot                                              |
| Secrets are neither persisted nor in evidence | password comes only from `ZCODE_E2E_SSH_PASSWORD`; tabs, settings, fixtures, captures, logs and failure text never contain it |

SSH cancel/retry state pruning (user confirmed 2026-08-19): only "the last SSH pending waiter cancels" is accepted as the new underlying abort semantic. Shared waiters and the online SSH cache keep using the existing contract cases. WSL, Docker and Server keep their original transport lifecycle and are not crossed with SSH. SSH-P0-CONN-03 fixes the pending window with a same-port TCP proxy that blocks the first connection and passes later ones through, instead of sleeps or wrong-password timing. The case sends no prompt; provider request policy is none.

## Fixture and run constraints

- Required env vars: `ZCODE_E2E_SSH_HOST`, `ZCODE_E2E_SSH_PORT`, `ZCODE_E2E_SSH_USERNAME`, `ZCODE_E2E_SSH_PASSWORD`.
- Default formal full discovery includes the real SSH specs only when `ZCODE_E2E_SSH_HOST`, `ZCODE_E2E_SSH_USERNAME` and `ZCODE_E2E_SSH_PASSWORD` all exist; the port still defaults to 22. Without credentials the default suite excludes these environment-bound cases and must not count "environment not configured" as a product failure. Explicit targeted runs of SSH specs stay fail-closed and report the missing variables.
- Workspace paths use `ZCODE_E2E_SSH_WORKSPACE_PATHS`; conversation cases default to `/root,/home`, development-basics cases use case-local `/root/.zcode-e2e/ssh-p0-*`.
- Provider cases use a case-local OpenAI-compatible replay fixture. The reverse tunnel carries only test provider traffic; the product SSH connection is still established through the real UI.
- Remote fixtures carry a unique per-run prefix and are cleaned in `finally`. Disconnect cases may only kill the `zcode-server` started by the current window's connection; never modify `sshd`, system networking or other users' processes.
- All specs start in `manual-review/pending` and are not promoted to formal without human review.
- The proxy/CDN of `SSH-P0-CONN-04` must be provided entirely by case-local processes and never reach the real release CDN. The target URL is unresolvable on the direct path and only the proxy mock can return the manifest, which mechanically proves there is no silent direct fallback.

## Run evidence

- `SSH-P0-TASK-01`: 2026-08-10 on Ubuntu 24.04 with `/root,/tmp`, formal default replay (1 passing, artifact `desktop-e2e-20260810-074921-918`) and explicit case-local replay (1 passing, artifact `desktop-e2e-20260810-075053-683`).
- `SSH-P0-CONN-01/02`: 2026-08-10 same host, formal default replay, 1 passing, artifact `desktop-e2e-20260810-073137-368`.
- `SSH-P0-DEV-01/02/03`: 2026-08-10 on a case-local `/tmp` repo, formal default replay, 1 passing, artifact `desktop-e2e-20260810-073248-576`.
- `SSH-P0-TASK-02` and `SSH-P0-LIFE-01/02/03` stay `pending` until actually run; unit/integration evidence does not replace real SSH Electron E2E status.
- `SSH-P0-TASK-03` (added 2026-09-04): from a 3.11.1 WSL user report, where opening settings while a remote workspace runs leaves the sidebar spinning forever; root cause and unit evidence are in `docs/wsl-task-status-inconsistency.md` T3. The fixture contract check passed (`pnpm --filter @zcode/desktop e2e:fixture:check`); stays `pending` until a real SSH run passes.

## Lifecycle pending implementation

These pending specs use the same Ubuntu password SSH + reverse-tunnel replay harness and are not claimed formal/covered. They need capture/replay on a real SSH environment and human review before promotion:

- `conversation-session-ssh-remote-task-lifecycle.test.ts`: close A, verify B follow-up, reopen A.
- `conversation-session-ssh-remote-cold-reconnect.test.ts`: after a `browser.reloadSession()` cold restart, no manual reconnect is triggered; wait for the main-window Host's single auto reconnect and recover A/B. Interactive-credential negative cases belong to R3-REMOTE-05.
- `conversation-session-ssh-remote-server-fault.test.ts`: kill only the `zcode-server` PID created and recorded by this connection; verify A/B disconnect and grouped reconnect. It never calls `sshd`, `wsl --terminate` or `wsl --shutdown`.
- `conversation-session-ssh-remote-cancel-retry.test.ts`: first connection stays pending; after confirmed stop, immediately retry the same target with the correct password. No provider request.

Under R3 all four use the handshake-returned stable `remote:server:<sourceServerId>:<workspacePath>` as controller identity. The old `buildRemoteWorkspaceIdentity(sshTarget)` is only a Host-internal legacy route hint and must not be a Renderer/E2E expected value. Tests complete the handshake first, then read and verify the stable identity from the authoritative tab snapshot.

Case-local replay fixtures and manifests for the four cases exist and the fixture check passes. Before real runs, confirm the provider stream, SSH server PID ownership, disconnect events and reconnect grouping behavior.

## SSH project entry orchestration (merged 2026-09-13 from `docs/archive/remote-r3/ssh-project-entry-helper.md`)

SSH project cases follow the [current three-screen wizard](../architecture/remote-device-connection-ux-spec.md): an entry without a directory goes straight to directory selection after connecting; an existing project keeps its directory intent and returns to the original project after connect/install/upgrade. Cases must not wait for remote conversation ready, and wizard close does not stand for project ready.

```text
unified select / configure -> connect (credentials, install or upgrade wait)
  -> directory selection or original project -> verify workspaceIdentity / remoteSessionId
  -> select the case's model and thinking level -> first send
```

Constraints:

- Device-card lookup is scoped to the visible SSH dialog; the sidebar may contain the same host/port, so never pick the first section on the page.
- Handle only the installs and identity confirmations the case authorizes. The persistent-run note is a non-blocking hint, not a confirmation wait. Failures and other confirmations are reported explicitly.
- `browser.execute` arguments are serialized explicitly and must not reference Node module constants.
- A helper timeout reports the last UI observation and not an empty string created before the timeout.
- After switching to the lifecycle custom model, select the thinking level (`disabled`) explicitly; the product does not add a default level for new models, and the send key stays disabled until one is selected.
- Test orchestration does not change business connection, command replay, desktop continuous or mobile replayable semantics.

Verification entries: the isolated browser-context probe in `packages/desktop/test/sshDirectoryFlow.test.ts`, and the real SSH path of `conversation-session/manual-review/pending/conversation-session-r3-ack-loss.test.ts`. The helper lives in `packages/desktop/test/e2e/helpers/ssh-remote-p0.ts`.

<a id="rdux-04-向导回归"></a>

### RDUX-04 wizard regression

Setup, actions, assertions and run evidence: [conversation case catalog](../conversation-session-case-catalog.md#rdux-04-向导回归). Test paths and pending status: [coverage matrix](conversation-session-e2e-coverage-matrix.md#rdux-04-向导回归).

<a id="rdux-10-三屏向导验收"></a>

### RDUX-10 three-screen wizard acceptance

Setup, actions, assertions and run evidence: [conversation case catalog](../conversation-session-case-catalog.md#rdux-10-三屏向导验收). Test paths and pending status: [coverage matrix](conversation-session-e2e-coverage-matrix.md#rdux-10-三屏向导验收).

### RDUX-11 connecting and directory screen acceptance (accepted)

| Case       | Setup / Action / Assertions                                                                                                                                                                                                                                                  | Automation                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| RDUX-11-01 | Independent user first install: the in-stage install confirmation shows the release version, the actual install location under the remote home and the real package size; the first stage is unobstructed; after connecting, the first persistent-run intro appears and continues only on explicit confirmation; version 3 is not shown again | `manual-review/pending/conversation-session-ssh-remote-three-screen.test.ts`, Pending        |
| RDUX-11-02 | Wrong password: supply the password within the current connection stage, original target succeeds; error details and log visible, no return to the config form                                                                                                               | `conversation-session-ssh-remote-connection-p0.test.ts`, reuses SSH-P0-CONN-01/02            |
| RDUX-11-03 | TCP connection refused: classified reason, retry and back-to-config; log auto-expands                                                                                                                                                                                      | `manual-review/pending/conversation-session-remote-connection-log-contract.test.ts`, Pending |
| RDUX-11-04 | Directory shows the full path and name-save feedback; the first intro is marked read (3) only on clicking 「知道了」 ("Got it"), not repeated for a second project or after restart; recent/remote chip navigation and read failures are covered by the wizard DOM regression; connection/directory screens screenshotted light/dark x 1440/900px | Three-screen pending spec + `remoteConnectionDirectoryNavigation.test.ts`                    |

This ticket keeps the confirmed wizard UI / Source Server service / SSH E2E boundary. Desktop continuous and mobile replayable do not change owner or recovery protocol. The new read-only task list is not written to the remote persisted status format; an old remote that does not support it explicitly shows the list as unavailable.

Final real-SSH evidence for RDUX-11 (2026-09-29): `desktop-e2e-20260928171512189-p86116-9ec1bbe80ceb67aa`, the 4 specs above pass, first install took 4 clicks and 1 input. The install and directory screens include light/dark x 1440/900px screenshots; Pending status is unchanged. The scope extension (read-only install info and task list) was confirmed by the user the same day and the parent spec is synced.
