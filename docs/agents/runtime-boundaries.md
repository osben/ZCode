# Process, Workspace, and Real-Time Link Boundaries

Read before modifying process responsibilities of main/host/services, workspace isolation, session/task, input queues, stream, snapshot, or remote control links. This document only retains cross-module constraints; specific implementations follow the current fact documents and contracts.

## Process Ownership

- The app communicates with the Agent via subprocess stdio, using the `@zcode/protocol` protocol.
- Main is responsible only for windows/native dialogs, process forking, broadcast relay, log reception, and remote control authentication/pairing/heartbeat, payload passthrough, and host attachment scheduling; session/task, stream, queue, and snapshot business state remain with the business owner.
- Each BrowserWindow has exactly one window-scoped Local Host, connected directly to the renderer via MessagePort. Multiple local workspace tabs within the same window share that Host; services are isolated by workspaceKey. Do not turn the workspace service scope into an independent Host process.
- Local Host承载 `createLocalServices({ parentPort })`, handling file/system/terminal/setting/credential/broadcast, and manages the local Agent CLI by workspaceKey.
- SSH/WSL/Docker/Server workspaces are created or reuse connections by the same Local Host's `RemoteConnectionRegistry`, opened as logical tabs/sessions. Do not create an independent Desktop Remote Host; broadcast still belongs to the desktop-local behavior.
- Phone `/remote` connects to the desktop's existing local host or remote workspace session host via shared-host attachment. Creating an independent runtime, local host, or SSH/WSL/Docker session for the phone is an architectural change that requires prior communication, architecture document updates, and desktop/phone regression testing.
- External relays only handle authentication, pairing, heartbeat, and `rpc-frame`/app payload passthrough; they do not hold business state.

## Concurrent Launch and Release

Model execution startup for the same `workspaceKey` is handled by a single in-flight Promise in the Service, covering Provider readiness reads, read-only runtime reuse/launch, and model execution capability increases. Concurrent warmup, draft preheating, and first send share that result; do not mistakenly judge that the workspace is released simply because another call succeeded and removed the wait record.
Real `disposeWorkspace` still cancels old wait identities; old continuations must not resurrect the runtime; reopening the same path uses a new identity. If the Provider is not ready, startup is deferred, and subsequent ready events can still retry.
If ready events interleave with old readiness reads, wait for the old attempt to close, then confirm the waiting identity and read the new state. Do not allow new events to reuse old unready results that subsequently disappear.

```text
warmup / createSession / sendText → workspace startup Promise → ready → individual commands
                                            │
                            disposeWorkspace → cancelled → old calls fail
```

This state only controls runtime startup and does not take over the CLI CommandInbox; desktop continuous and phone replayable continue using their respective trusted clientMode, original owner/lease, and the same shared-host runtime.

## Workspace Identity

- `workspaceIdentity` is identity/isolation, `workspacePath` is the real file path. All identity checks uniformly use `workspaceKey = workspaceIdentity?.trim() || workspacePath`.
- Identity semantics include tab deduplication, session binding, cache/queue/persistence keys, cross-process request correlation, workspace config directory isolation, and remote history matching.
- File reads/writes, command cwd, Git operations, path display, and user path input continue to use `workspacePath`.
- Remote workspaces must pass `workspaceIdentity`; construction/parsing reuse unified utilities such as `buildRemoteWorkspaceIdentity`; do not hand-craft concatenation rules in business code.
- Local continues to allow passing no identity, falling back to path, without adding a new local identity format. The workspace isolation interface supports optional identity, keeping old calls compatible.
- Remote control links pass `workspaceIdentity` and `remoteSessionId` end-to-end; bridge, snapshot, queue, owner command, cache/dedup keys must not match only by path.

## Input and Real-Time Messages

```text
Desktop desktop-continuous ─ direct continuous real-time link ─┐
                                                            ├─ Same task owner
Phone web-remote-replayable ─ snapshot + gap recovery ────────┘

Desktop/phone submit input → trusted attachment injects clientMode → owner/lease routing
                   → CLI/runtime CommandInbox serial admission → FIFO execution
Renderer: unsubmitted drafts + pending optimistic overlay
```

- Desktop defaults to direct continuous; phone remote control defaults to replayable. The desktop does not concatenate the phone's runtime recovery messages, and the phone does not bypass replayable gap/snapshot recovery.
- When modifying `getTaskSnapshot`, dynamic task event, stream mirror, runtime snapshot, queued prompt, task command, permission/elicitation, stop generation, or reconnection recovery, explicitly pass and verify `clientMode` and `deliveryKind`.
- Submitted busy/running inputs are uniformly received by the CLI/runtime `CommandInbox`, executed in FIFO order based on CLI serial admission order. The Host's owner/lease only routes; it does not save a second copy of the accepted input queue; commands retain the clientMode injected by trusted attachments.
- owner/lease/owner command still handles single owner for in-flight tasks, cross-host routing, blocked request responses, and stale run protection. Do not remove checks just because the shared-host primary path exists; changes must demonstrate that dependencies for remote workspaces, bot/proxy, and cross-host fallback are all handled.

Before modifying the above remote control/real-time behaviors, read the following current fact documents for the problem; historical plan/specs serve as background only:

- [Remote Control Architecture](../web-remote-control/web-remote-control-architecture.md): attachments, process responsibilities, and remote workspaces.
- [Real-Time Synchronization](../web-remote-control/task-realtime-sync.md): continuous/replayable, snapshot, gap, and reconnection.
- [Input Queue](../web-remote-control-task-command-queue.md): CommandInbox, admission, and cross-platform command routing.

## Runtime Evidence

- RPC channels use [LoggingChannelServer / LoggingChannelClient](../../packages/rpc/src/logging-middleware.ts) to log channels, commands, and durations; prioritize using existing logs to locate call chains.
- Agent session traces are in `~/.zcode/cli/rollout` or `~/.zcode/cli/debug`; CLI logs are in `~/.zcode/cli/log`.
- For UI reproduction, prefer agent-browser; on failure, CDP debugging is directly available; the development default port is 9229; verify the actual listening port before connecting.
- Verification covers affected desktop-local and phone-remote-control paths separately, recording owner, event ordering, identity, and delivery boundary evidence; missing environments are handled according to the blocking rules in the root AGENTS.md.
