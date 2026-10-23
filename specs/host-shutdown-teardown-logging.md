# Host shutdown teardown logging

Status: accepted 2026-10-23 (ISSUE-061).

## Problem

An orderly app quit logged one `[warn]` per open workspace topic plus one more:

- `[zcode-task-index-syncer] 清理 task index sessions-index 订阅失败 …` and the
  `workspace-config` twin, error `ZCode Protocol client disposed`;
- `[zcode-host] failed to forward attachment connection flow state`, payload state
  `closed`, message `ZCode Protocol client disposed`.

`AGENTS.md` reserves `warn` for recoverable exceptions. None of these is one.

## Event order (confirmed from the 2026-10-23 dev log and the source)

```text
Main app-before-quit
  └─ Host disposeHostResources("parent dispose")
       1. disposeAttachedServicePorts()             attachment registry dispose
            └─ handle.dispose() → forward "closed" flow state (RPC to the CLI, not awaited)
       2. runHostShutdownPhases
            remote-registry-dispose
            source-server-manager-dispose
            service-dispose → disposeServiceResourcesAndWait
                 IZCodeTaskService.disposeAllAndWait
                   ├─ taskIndexSyncer.disposeAll() → unsubscribe RPCs (not awaited)
                   └─ agent disposeAllAndWait → protocol client disposed
                        └─ rejectAll("ZCode Protocol client disposed")  ← every in-flight RPC above
```

The order itself is correct: attachments close before services, and the syncer
releases its topics before the agent. The teardown RPCs are best effort; their only
purpose is to free CLI-side state, and the CLI process is being disposed in the same
shutdown, which frees that state anyway. Awaiting them would make shutdown depend on
a responsive CLI inside the 3.5 s `service-dispose` budget and risk losing the CLI
force-kill fallback, so they stay fire-and-forget.

## Rules

1. **Attachment flow state.** When the attachment registry is disposed as part of host
   shutdown, the attachment handle does not forward its own `"closed"` flow state. It
   waits for the flow updates already queued on that attachment, then disposes the
   connection scope, which enqueues `"closed"` itself and treats a failure as silent
   best effort. Outside host shutdown (window close, detach, replace, stale remote
   generation) the handle keeps forwarding `"closed"` and a failure stays a `warn`.
2. **Task index syncer.** After `disposeAll()` the syncer still sends its best-effort
   unsubscribe RPCs (late subscribe ACKs included), but a rejection that settles after
   `disposeAll()` is a teardown cancellation: it logs at `debug`, not `warn`.
   A failed unsubscribe while the syncer is live (resubscription, workspace release)
   stays a `warn`.
3. No timeouts or delays are added to mask the order.

## Acceptance

- Unit: registry `dispose()` disposes handles with the host-shutdown reason;
  `detach`, port `close` and replacement do not.
- Unit: the attachment flow forwarder, on host-shutdown close, never calls
  `setTransportFlowState("closed")` itself, runs `scope.dispose()` after queued
  updates, and logs no warn when the scope's RPCs reject; on an ordinary close it
  forwards `"closed"` and warns on failure.
- Unit: syncer `disposeAll()` with active subscriptions whose unsubscribe rejects
  logs no `订阅失败` warn; a live-path unsubscribe failure still warns.
- Live (QA): quit the dev app with several workspaces open; the last 2 s of the log
  contain neither `订阅失败` nor `failed to forward attachment connection flow state`
  at `warn`.
