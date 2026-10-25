# Process, Workspace, and Real-Time Link Boundaries

Read before modifying process responsibilities of main/host/services, workspace isolation, session/task, input queues, stream, snapshot, or remote control links. This document keeps only cross-module constraints; implementation details follow the current fact documents and contracts.

## Process Ownership

- The app communicates with the Agent via subprocess stdio, using the `@zcode/protocol` protocol.
- Main handles only windows/native dialogs, process forking, broadcast relay, log reception, remote control authentication/pairing/heartbeat, payload passthrough, and host attachment scheduling. Session/task, stream, queue, and snapshot business state stay with the business owner.
- Each BrowserWindow has exactly one window-scoped Local Host, connected directly to the renderer via MessagePort. Local workspace tabs in the same window share that Host; services are isolated by workspaceKey. Do not turn the workspace service scope into an independent Host process.
- Local Host hosts `createLocalServices({ parentPort })`, handles file/system/terminal/setting/credential/broadcast, and manages the local Agent CLI by workspaceKey.
- SSH/WSL/Docker/Server workspaces are created or reused by the same Local Host's `RemoteConnectionRegistry` and opened as logical tabs/sessions. Do not create an independent Desktop Remote Host; broadcast stays desktop-local behavior.
- Phone `/remote` connects to the desktop's existing local host or remote workspace session host via shared-host attachment. Creating an independent runtime, local host, or SSH/WSL/Docker session for the phone is an architectural change: communicate first, update architecture docs, and run desktop/phone regression tests.
- External relays handle only authentication, pairing, heartbeat, and `rpc-frame`/app payload passthrough; they hold no business state.

## Concurrent Launch and Release

Model execution startup for one `workspaceKey` is handled by a single in-flight Promise in the Service. It covers Provider readiness reads, read-only runtime reuse/launch, and model execution capability increases. Concurrent warmup, draft preheating, and first send share that result. Do not conclude the workspace is released just because another call succeeded and removed the wait record.

Real `disposeWorkspace` still cancels old wait identities. Old continuations must not resurrect the runtime; reopening the same path uses a new identity. If the Provider is not ready, startup is deferred and later ready events can still retry. If a ready event interleaves with an old readiness read, wait for the old attempt to close, then confirm the waiting identity and read the new state. New events must not reuse old unready results that subsequently disappear.

```text
warmup / createSession / sendText → workspace startup Promise → ready → individual commands
                                            │
                            disposeWorkspace → cancelled → old calls fail
```

This state only controls runtime startup and does not take over the CLI CommandInbox. Desktop continuous and phone replayable keep using their own trusted clientMode, original owner/lease, and the same shared-host runtime.

## Workspace Identity

- `workspaceIdentity` is identity/isolation; `workspacePath` is the real file path. All identity checks use `workspaceKey = workspaceIdentity?.trim() || workspacePath`.
- Identity semantics cover tab deduplication, session binding, cache/queue/persistence keys, cross-process request correlation, workspace config directory isolation, and remote history matching.
- File reads/writes, command cwd, Git operations, path display, and user path input use `workspacePath`.
- Remote workspaces must pass `workspaceIdentity`. Construction/parsing reuse unified utilities such as `buildRemoteWorkspaceIdentity`; do not hand-craft concatenation rules in business code.
- Local may omit identity and fall back to path; do not add a new local identity format. The workspace isolation interface takes optional identity so old calls stay compatible.
- Remote control links pass `workspaceIdentity` and `remoteSessionId` end to end. Bridge, snapshot, queue, owner command, and cache/dedup keys must not match by path alone.

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
- When modifying `getTaskSnapshot`, dynamic task event, stream mirror, runtime snapshot, queued prompt, task command, permission/elicitation, stop generation, or reconnection recovery, pass and verify `clientMode` and `deliveryKind` explicitly.
- Submitted busy/running inputs are received by the CLI/runtime `CommandInbox` and executed FIFO in CLI serial admission order. The Host's owner/lease only routes and does not keep a second copy of the accepted input queue. Commands keep the clientMode injected by trusted attachments.
- owner/lease/owner command still provides a single owner for in-flight tasks, cross-host routing, blocked request responses, and stale run protection. Do not remove checks because the shared-host primary path exists; a change must show that remote workspaces, bot/proxy, and cross-host fallback dependencies are all handled.

Before modifying these remote control/real-time behaviors, read the current fact documents; historical plans/specs are background only:

- [Remote Control Architecture](../web-remote-control/web-remote-control-architecture.md): attachments, process responsibilities, remote workspaces.
- [Real-Time Synchronization](../web-remote-control/task-realtime-sync.md): continuous/replayable, snapshot, gap, reconnection.
- [Input Queue](../web-remote-control-task-command-queue.md): CommandInbox, admission, cross-platform command routing.

## Runtime Evidence

- RPC channels use [LoggingChannelServer / LoggingChannelClient](../../packages/rpc/src/logging-middleware.ts) to log channels, commands, and durations; use existing logs first to locate call chains.
- Agent session traces are in `~/.zcode/cli/rollout` or `~/.zcode/cli/debug`; CLI logs are in `~/.zcode/cli/log`.
- For UI reproduction prefer agent-browser; on failure CDP debugging is available. The development default port is 9229; verify the actual listening port before connecting.
- Verification covers affected desktop-local and phone-remote-control paths separately, recording owner, event order, identity, and delivery boundary evidence. Missing environments follow the blocking rules in the root AGENTS.md.
