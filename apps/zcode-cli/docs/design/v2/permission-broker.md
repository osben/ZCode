# Permission Broker Design v2

## Background

The early permission layer could judge a tool call as `allow`, `ask` or `deny`, but `ask` only emitted a
`permission_requested` event and then treated the tool as denied. That gap is closed: core hands `ask`
to `PermissionBrokerPort` to wait for the client's choice, and continues or ends tool execution based
on `allow`, `modify`, `deny` or `escalate`.

Permission memory supports project-level rules only. The user-facing choices are:

- `Allow once`: this tool call passes; no rule is written.
- `Always allow in this project`: writes into the current project's permission ruleset; later calls in
  the same project that hit the rule pass directly.
- `Deny`: this call is rejected; no rule is written.

No session-level or global-level persistence, and no scope list in the approval UI. User/global
settings may later add a new destination without changing `Allow once` semantics.

v2 separates `PermissionService` from `PermissionBroker`:

- `PermissionService` makes only synchronous policy decisions from mode, tool capability, allow/deny
  rules, risk level and side-effect scope, returning `allow`, `ask` or `deny`.
- `PermissionBroker` handles only asynchronous client negotiation: it publishes `ask` requests to the
  client, waits for `allow`, `deny` or `modify`, and supports cancellation, timeout and observable
  events.
- The `edit` permission mode is a narrow automation variant of `build`: project deny/ask, project allow
  and allowedTools keep their existing precedence; if the tool capability declares `permission: "edit"`
  and the side-effect scope is `workspace`, the synchronous decision is `allow`; everything else falls
  back to the `build` policy.

## Current implementation (verified 2026-05-08)

The following is implemented; do not rebuild it as a "pending broker":

- Contract: `packages/contracts/src/interfaces/permission.port.ts` defines `PermissionBrokerPort`,
  `PermissionBrokerRequest`, `PermissionBrokerResult`, project-level `PermissionUpdate` and
  `PermissionRuleset`.
- Core service: `packages/core/src/permission/service.ts` makes the synchronous `allow` / `ask` /
  `deny` decision and matches project `allow` / `ask` / `deny` rules.
- Core broker: `packages/core/src/permission/broker.ts` provides the default fail-closed
  `DenyPermissionBroker` and the inspectable, manually resolvable `ManualPermissionBroker`, covering
  pending, timeout and abort cleanup.
- Tool executor: `packages/core/src/tool/executor.ts` publishes `permission_requested` on `ask`, waits
  for the broker or the `PermissionRequest` hook, publishes `permission_resolved`, supports `allow`
  execution, `modify` replacing the full input, `deny` structured failure, `escalate` failure, and
  `permissionUpdates` written into the project permission ruleset.
- Runtime/TUI: `packages/core/src/runtime/agent-runtime.ts` injects the broker into the executor;
  `packages/tui/src/app-permission.ts` uses a queued approval UI with `Allow once`,
  `Always allow in this project` and `Deny`, and reuses the same broker channel for `AskUserQuestion`
  clarification questions. `packages/cli/src/tui-command.ts` must attach the current TUI
  `requestPermission` callback to the broker on both the `submitPrompt` and `sendInput` paths, so that
  busy-time input, post-resume continuation or queued input that starts a new turn does not lose the
  approval UI.
- TUI rendering: the normal approval prompt shows the `description` from the tool input as the
  human-readable explanation; for command-like input the preview shows only the `command` value, not
  the full JSON, and the panel shows no risk/mode policy metadata. Explanation and command preview must
  word-wrap to the current panel width and grow the panel height by rendered lines, so permission text
  never covers the decision options or help line in narrow terminals.
- ZCode app-server: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` injects the
  ZCode app-server broker; normal tools are turned into `Allow once`, `Always allow in this project` or
  `Deny` through the ZCode app-server `requestPermission`; a project allow returns `permissionUpdates`
  for core to write into the current project ruleset; `AskUserQuestion` currently goes through the
  `zcode.dev` elicitation extension request.

Existing tests:

- `packages/core/tests/permission-broker.test.ts`: pending request, client resolution, timeout cleanup,
  abort cleanup.
- `packages/core/tests/permission-service.test.ts`: build/plan/yolo modes, project rules, permission
  decisions for user-interaction tools.
- `packages/core/tests/tool-executor-trace.test.ts`: default fail-closed without a broker, execution
  after broker allow, project `permissionUpdates` persisted and hit by later calls, broker `modify`
  replacing input, hook allow/deny.
- `packages/core/tests/runtime-tool-loop.test.ts`: the runtime executes a side-effecting tool only after
  broker approval and `permission_resolved` precedes `tool_call_started`.
- `packages/cli/tests/cli.unit.test.ts`: TUI `submitPrompt` and `sendInput` both attach the approval
  request to the runtime permission broker, preventing fail-closed after the approval handler is lost.
- `packages/tui/tests/tui.unit.test.ts`: TUI approval UI, project allow update, and Esc/close/cancel
  interaction paths.

Remaining boundary: session/global permission rulesets are out of scope for the first version; the ZCode
app-server and the TUI currently expose only project-level remember allow and no reject-always; finer
Bash/WebFetch rule suggestions should still come from a later tool policy.

## Runtime flow

Permission flow before tool execution:

1. `ToolExecutor` calls `PermissionService.checkPermission`.
2. `allow`: execute the tool.
3. `deny`: record `permission_denied`; the tool does not run.
4. `ask`: record `permission_requested`, then `PermissionBroker.requestPermission` races concurrently
   with `PermissionRequest` hooks and the first decision wins (see `permission-responder-race.md`; the
   broker must establish the reply channel synchronously inside the `requestPermission` call and clean
   the pending prompt on abort).
5. The client returns:
   - `allow`: record `permission_resolved`; execute the tool with the original input.
   - `modify`: record `permission_resolved`; execute the tool with `modifiedInput`.
   - `deny`: record `permission_resolved`; the tool does not run; return a structured
     `permission_denied` error.
6. If the client returns `permissionUpdates`, core writes them into the project permission ruleset
   before executing the tool and updates the current permission context.

`ask` is not an error state. It becomes a tool error only when the client denies, the request times out,
execution is cancelled or the broker itself fails.

## Broker contract

`PermissionBrokerPort` is a client-boundary contract; its input must be displayable, auditable and
recoverable:

- `requestId`: ID of this permission request.
- `sessionId`, `turnId`, `traceId`, `toolCallId`: full call-chain identifiers.
- `toolName`, `input`: the original tool call.
- `mode`, `ruleId`, `reason`: policy source and user-visible reason.
- `riskLevel`, `sideEffectScope`: risk and side-effect scope.
- `requestedAt`: time of entering the pending state.

Result:

- `decision`: `allow`, `deny`, `modify` or the reserved `escalate`.
- `reason`: optional client note.
- `modifiedInput`: meaningful only for `modify`; it must be a full replacement input, not a patch.
- `permissionUpdates`: optional project-level rule updates. The first version supports only `addRules`,
  to express "from now on allow/ask/deny this kind of call in this project".
- `resolvedAt`: client response time; core fills it when absent.

The broker must support `AbortSignal`. If the turn is cancelled, the pending permission is also cleaned
so no promise dangles in the background. The caller passes the timeout explicitly; with no timeout
configured the broker may wait for the client indefinitely.

## Events and state

Event semantics:

- `permission_requested`: recorded before entering the broker; projection adds the request to
  `pendingPermissions`.
- `permission_resolved`: the client's final reply to `ask`; projection removes the pending entry; `deny`
  marks the tool status denied.
- `permission_denied`: the synchronous policy rejects directly, or the broker hits an unrecoverable
  rejection before it can become pending.

Tool state semantics:

- `scheduled` -> `waiting_permission` -> `running` -> `completed`
- `scheduled` -> `waiting_permission` -> `permission_denied`
- A synchronous `deny` can go directly to `permission_denied`.

## Default behavior

Without a client broker the default broker must fail closed: it returns `deny` immediately with a reason
saying no interactive permission client is configured. This guarantees headless CLI, tests and
background tasks never wait without bound.

A client needing interactive permission injects a broker explicitly:

- TUI/IDE: show the request; after the user allows/denies, call the resolver.
- SDK: expose the request as an event or callback and let the host process reply.
- Automation: may implement a policy broker that auto allows/denies by external rules, but must still
  record `permission_resolved`.

## Minimal TUI interaction

The TUI, as the first interactive client, implements only the minimal usable UI for `ask` requests:

- The runtime still waits on `PermissionBrokerPort.requestPermission`; the TUI never executes the tool.
- While the turn is busy the TUI shows an approval box with `toolName`, `riskLevel`, `sideEffectScope`,
  `reason` and a truncated `input` preview.
- Keyboard use is explicit select-and-confirm: the box shows `Allow once`,
  `Always allow in this project` and `Deny`. `Deny` is selected by default; `Up`/`Down` move between
  options, `Enter` returns the current option, `Escape` returns `deny`; `Ctrl-C` still cancels the
  current TUI session and cleans pending requests through the abort signal.
- `Always allow in this project` returns only project-level `permissionUpdates`. The first version may
  generate tool-only rules; finer Bash/WebFetch rules come from a later tool policy.
- The TUI shows only the head-of-queue approval request at a time; if concurrent requests are supported
  later, queue them in the TUI layer without changing the broker contract.
- `--prompt`, background tasks and entries without an interactive client keep the default deny broker,
  to avoid unbounded waits.

## Test requirements

Changes to permission capability cover at least:

- `ask` then client `allow`: the tool really runs.
- `ask` then client `allow` with project `permissionUpdates`: the rule is written into the project
  ruleset and later calls in the same project that hit the rule no longer ask.
- Under `edit` mode, file-editing tools such as `Write`, `Edit`, `ApplyPatch` are allowed directly,
  while Bash, MCP, user-interaction, network or system-level operations are not auto-approved by
  `edit` mode.
- `ask` then client `modify`: the tool receives the replacement input.
- `ask` then client `deny`: the tool does not run and the pending entry is removed.
- Without a broker the default is deny and nothing hangs.
- Cancellation or timeout cleans pending and keeps the traceId.

## Group session isolation (2026-09)

The project-only restriction above has one scoped extension: a trusted group input initializes
`SessionInfo.permission.scope = "session"` before tools execute. Executor rule loading and remembered
updates use that session's permission object, never `ProjectPermission`. Initialization drops inherited
rules once; subsequent turns and cold resumes keep the task's own grants. Normal tasks without this
marker retain project behavior. The marker is protocol metadata, not interpreted prompt text. See the
root `docs/permission-project-approval.md` and `docs/bots-feishu-group-collaboration.md` for group
authorization and client boundaries.
