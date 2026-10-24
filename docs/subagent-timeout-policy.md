# Subagent Timeout Policy

## Background

`Agent` / `Task` is the entry through which the parent runtime schedules child agents. ZCode used to put
a fixed `600000ms` timeout on `Agent` at the tool layer; the current goal is to remove that fixed
wall-clock limit so a long but healthy child agent is not declared `tool_timeout` early by the parent
tool executor.

## Target semantics

- `Agent` / `Task` has no fixed tool execution timeout.
- A foreground subagent ends when the child runtime itself completes, fails or is cancelled.
- Cancel signals such as the user stopping the parent turn, a parent turn abort or process exit still
  propagate to the waiting `Agent` / `Task` call.
- The child session's setup, persist, resume and `onSessionReady` waits all belong to the foreground
  call's cancellable, inactivity-detectable lifecycle; Ready is only the publish barrier for
  `SubagentSpawned`, not the installation boundary of abort/watchdog.
- A background subagent's lifecycle stays managed by `SubagentPort` / the runtime task registry and is
  not cleaned up by the tool executor's fixed timeout.

```text
register task -> child setup/persist/resume -> onSessionReady -> foreground/background race -> settle
      ^                    ^                       ^                       ^
      |                    |                       |                       |
      +------------- parent abort + inactivity watchdog -----------------+
```

- On a parent abort or inactivity timeout in the pre-ready phase, the outer `Agent` / `Task` must fail
  promptly and clean up the unpublished runtime task; it must not keep waiting for the child to call
  `onSessionReady` on its own.
- After a foreground task turns into background, the `background` provenance of the child tool mirror
  must be read from the runtime task registry's current state at the moment each event is emitted; it
  must not reuse a boolean snapshot from child start. So events in the foreground phase do not carry
  `background: true`, while late events after switching to background must carry `background: true`, so
  the real terminal lifecycle can keep being projected after the parent turn ends.

## Non-goals

- No change to the timeout policy of ordinary tools such as Bash, WebFetch, Read, Edit.
- No restoring of the `120000ms` foreground auto-to-background logic.
- No change to the temporary policy that `subagents.backgroundEnabled` is off by default.

## Implementation constraints

- The tool executor must explicitly support `timeout: { kind: "none" }`; a tool without a timeout must
  not fall back to the executor's default timeout.
- The `Agent` / `Task` provider contract no longer exposes `timeoutMs`, so the model or UI does not
  mistake a subagent for having a fixed 10-minute cap.
- No timeout only cancels the wall-clock timer; the parent `AbortSignal` must still cancel a waiting handler.
- The subagent inactivity watchdog must start before child setup begins; the ready wait and the
  completion wait must listen to the same task abort signal together and keep the `ToolTimeout` reason
  produced by the watchdog.
