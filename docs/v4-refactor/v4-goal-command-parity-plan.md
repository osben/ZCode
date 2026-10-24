# V4 Goal Command Parity Plan

Goal: restore v4 `/goal` parity with z-code-2 for the visible composer command path. A draft-first `/goal` sets
or replaces the session target through the goal command channel, a queued `/goal` stays a goal command, and no
`/goal` command is downgraded into an ordinary model prompt.

Architecture: goal state is owned by the agent/session runtime and surfaced through v4 conversation snapshots.
The UI parses visible slash commands at the send boundary and routes them through `v4/command`. Running or
compacting sessions keep the existing command barrier for immediate target writes but enqueue `/goal` as a
command-aware pending item, consumed only through the goal command path.

Code areas: React UI in `packages/ui/src/v4`, protocol schemas in `packages/shared/src/zcode-protocol-v4`,
bootstrap command handlers in `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4`, core queue/runtime
contracts in `apps/zcode-cli/packages/contracts` and `apps/zcode-cli/packages/core`.

Full history: `git show b8876e8b:docs/v4-refactor/v4-goal-command-parity-plan.md`

## Scope

Covers `/goal`, `/target`, `/goal replace` and `/goal resume` on the v4 chat composer and queue paths.

Out of scope:

- The `Multiple system messages that are separated by user/assistant messages` failure (a provider SDK/version issue).
- Full standalone goal setup mode parity (`direct` / `quick` / `grill` and `ExitGoalSetup` approval cards).
  z-code-2 added it later; v4 protocol only exposes `sendGoalCommand(text)` and `resumeGoal`.
- `/goal show`, `/goal pause`, `/goal clear` protocol behavior (the old parser recognized them; v4 has no
  matching command payloads yet).
- UI redesign of the goal card/sidebar. The target is command semantics and queue preservation.

## Source review

Current v4 source of truth:

- `docs/conversation-protocol-declaration.md`: `/goal xxx` sets or updates the session goal; running and
  compacting `/goal xxx` append to the queue.
- `docs/testing/conversation-session-goal-specific-coverage-matrix.md`: G0/G1/G2 define completed
  replacement, running queue, queue edit/delete/reorder, send-now and compact interaction expectations.
- `packages/shared/src/zcode-protocol-v4/command.ts`: `sendGoalCommand({ text, heldQueueDisposition? })` and `resumeGoal({})`.
- `packages/shared/src/zcode-protocol-v4/snapshot.ts`: queue items already have `kind: "sendText" | "sendGoalCommand"`.
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/goal-compact.ts`: `sendGoalCommand`
  already implements set/replace by reading the existing target, but rejects active turns.
- `packages/ui/src/v4/SessionPane.tsx`: slash parsing only runs when `sessionId` exists, so a draft-first
  `/goal` falls through to `createSession(firstInput)` + `sendText`.

z-code-2 evidence (rationale to preserve):

- Visible slash commands (`/compact`, `/goal`, `/target`) are parsed at the submit boundary; draft/no-task
  slash commands create or resume a session first, then run the session control command rather than sending
  ordinary prompt text.
- Queued prompt kind is classified as goal/compact/text, and the `/goal` prefix is restored when a queued goal
  is edited to objective-only text.
- Queued command drain waits until the session active lock is actually released; an active/incomplete goal
  target blocks queued prompt drain until complete; send-now during active goal output acts as stop/pause
  first and never interleaves another command into the active goal turn.
- `/goal` writes `session_target` and must not bypass a running turn. The old decision "block while running" is
  superseded by current docs, which require queueing.
- Full standalone setup/verifier parity is a future reference, not Phase 1.

## Current gaps

1. Draft-first `/goal` is not parsed: `SessionPane.handleSendText` calls `handleSlashCommand` only when
   `sessionId` exists, so in a new draft `/goal ...` becomes first input and ordinary `sendText`.
2. The parser is too narrow: it recognizes `/goal <text>` but not `/target`, `/goal replace <text>` or `/goal resume`.
3. Running `/goal` has no command-aware queue path: `sendGoalCommand` rejects when
   `record.activeAbortController` exists. The barrier is right for immediate target writes, but running/
   compacting semantics require enqueueing instead of failing or sending ordinary prompt text.
4. Queue kind is declared but not preserved: `queueItemSchema` supports `sendGoalCommand`, but
   `product-projection.ts` hardcodes `TurnSteerQueued` items to `kind: "sendText"`.
5. Core pending-input drain injects everything as a user prompt: `drainPendingInput` calls `persistUserPrompt`
   and `messageHistory.addUser`; a queued `/goal` must not pass through this path.
6. `sendQueuedNow` always replays as prompt text (the v4 queue handler reads item text, removes it, waits idle,
   then calls `startPromptTurn`).
7. Queue editing can lose command syntax; v4 should restore `/goal` using `queueItem.kind` as authority.

## Target behavior

The composer submit boundary classifies visible slash commands before normal send logic:

```text
composer text + attachments
  |
  v
slash parser
  |-- attachments present --------------------------> sendText
  |-- not /goal|/target|/compact --------------------> sendText
  |-- /goal or /target -----------------------------> goal command route
  |-- /goal resume ----------------------------------> resumeGoal route
```

- `/goal <objective>` sets a target when none exists and replaces the existing target otherwise.
- `/goal replace <objective>` maps to the same replace-capable `sendGoalCommand` payload with `replace` stripped.
- `/target <objective>` is an alias for `/goal <objective>`. `/goal resume` maps to `resumeGoal`.
- Attachments disable slash parsing; the input stays ordinary `sendText`.
- Empty `/goal` is consumed as an unsupported/empty goal command with a UI warning; it must not create an ordinary prompt.

State and queue order:

```text
idle/completed, queue empty
  /goal A
    -> sendGoalCommand(A)
    -> set or replace session target
    -> start goal continuation when mode allows

running or compacting
  /goal B
    -> enqueue queue item { kind: sendGoalCommand, text: original or canonical /goal B }
    -> no target write yet
    -> no model request for B yet

active work becomes ready
  queue head sendText
    -> existing text drain behavior
  queue head sendGoalCommand
    -> remove queue item
    -> sendGoalCommand(objective)
    -> target set/replace + goal continuation

held queue (completed + queue>0 + autoDrain=false)
  /goal C
    -> require heldQueueDisposition choice
    -> clearQueueAndSend: clear queue, then sendGoalCommand(C)
    -> keepQueueAndSend: preserve existing queue, then sendGoalCommand(C)
```

Key invariant: a queue item of kind `sendGoalCommand` never flows into `persistUserPrompt` / `startPromptTurn`
as raw `/goal ...`.

Desktop and web remote boundaries: `desktop-continuous` client -> `v4/command` -> existing desktop
host/runtime; `web-remote-replayable` client -> `v4/command` through the shared-host attachment -> same
owner/runtime boundary, with a replayable snapshot restoring queue/target state. No relay/main-process goal
state is introduced.

## Implementation plan

**Phase 1: UI visible slash parser and draft session routing**
- Add a pure v4 parser (for example `packages/ui/src/v4/slashCommands.ts`) with output: command type
  (`sendGoalCommand`, `resumeGoal`, `compact`, or unsupported), `objective`, `displayText` (preserving the
  visible command when possible), and whether it requires `baseRevision`.
- Parse before the `sessionId` guard in `SessionPane.handleSendText`.
- For a draft/no-session goal command: reuse the prewarm session if present, otherwise dispatch `createSession`
  without `firstInput`; promote through the existing draft promotion hooks; dispatch `sendGoalCommand` or
  `resumeGoal` to the new session; never call `sendText` with the raw `/goal` input.
- For existing sessions dispatch directly; carry `heldQueueDisposition` into `sendGoalCommand` in choice mode.
- Keep `/compact` as implemented; do not broaden into compact rendering changes.

**Phase 2: preserve queued goal command kind**
- Recommended durable path: extend the core/contracts pending-input shape with an explicit command kind
  (`TurnSteerInput.commandKind?: "sendText" | "sendGoalCommand"`, `PendingTurnInput.commandKind`,
  `TurnSteerQueuedPayload.commandKind`); omitted defaults to `sendText`.
- When `sendGoalCommand` arrives during active work, enqueue through `record.app.steerTurn` with
  `commandKind: "sendGoalCommand"`, the visible command as queue text (`displayText` if the protocol carries
  it, else canonical `/goal ${objective}`), and `inputId` / `queryId` from the command id.
- `product-projection.ts` sets `queue.items[].kind` from the event command kind.
- If `displayText` is added to the `sendGoalCommand` payload, make it optional and keep `text` as the parsed
  objective, preserving exact `/target` or `/goal replace` text without changing existing callers.
- Fallback if core contract churn must be minimized: infer `sendGoalCommand` in projection from queued text
  starting with `/goal` or `/target`. Weaker (an edited queued goal can lose the prefix); a temporary bridge only.

**Phase 3: command-aware auto-drain**
- Existing text pending inputs keep current behavior. If the queue head is `sendGoalCommand`,
  `drainPendingInput` must not call `persistUserPrompt` or `messageHistory.addUser`.
- `turn-stop` must not loop forever on a non-text head: replace `hasPendingInput` checks used for auto-drain
  with a helper such as `hasAutoDrainablePendingInput`; only text-at-head is auto-drainable inside the model
  loop; a goal-at-head completes the active turn and leaves the item visible for the command drain path.
- Add a v4 command queue drain trigger after active work reaches ready: only when queue `autoDrain` is true,
  only the head item, preserve FIFO by blocking later text behind a queued goal until it is consumed, and apply
  the same active-lock wait/retry guard as z-code-2's ready-boundary fixes.

**Phase 4: queue actions**
- Replace `getQueueItemText` with a host method returning `{ kind, text }` (or add a parallel `getQueueItem`).
- `sendQueuedNow`: read kind and text before removal; remove the item; stop/pause the current active goal when
  preempting (as today); wait for idle; `sendText` -> `startPromptTurn`; `sendGoalCommand` -> parse the
  objective and call the extracted goal-command execution helper.
- `editQueueItem`: keep the item kind; if a `sendGoalCommand` edit no longer starts with `/goal` or `/target`,
  store objective-only text plus kind, or canonicalize to `/goal ${objective}`; an edit triggers no request.
- `reorderQueueItem` and `deleteQueueItem` stay kind-preserving and side-effect-free.

**Phase 5: tests and verification**
- Parser: `/goal fix login`, `/target fix login`, `/goal replace fix login` -> objective `fix login`;
  `/goal resume` -> `resumeGoal`; attachment + `/goal` -> not a command; empty `/goal` consumed as unsupported/empty.
- UI routing: draft-first `/goal` creates/promotes a session and dispatches `sendGoalCommand`, not `sendText`;
  existing session dispatches `sendGoalCommand`; held queue passes `heldQueueDisposition`.
- Command handler: completed + no target sets; completed + existing target replaces; active turn enqueues
  `sendGoalCommand` without writing the target immediately.
- Projection: `TurnSteerQueued` with command kind `sendGoalCommand` yields queue item kind `sendGoalCommand`;
  edit/reorder/delete preserve kind.
- Core drain: text-at-head drains into prompt history as today; goal-at-head is not persisted as a user prompt
  and creates no infinite continue loop.
- Queue actions: `sendQueuedNow` on a goal item calls the goal command path; an edited objective-only goal
  still consumes as a goal.
- Runtime verification: reproduce a draft-first `/goal` (like `sess_ec648b58-f3f1-476e-8f2e-c76bffd7735e`):
  `session_target` has the new objective, no raw `/goal ...` user_prompt reaches the model request, the UI goal
  banner/card updates from the snapshot. Running session: `/goal next target` -> snapshot queue shows
  `kind=sendGoalCommand`, target unchanged until consumed. Queue send-now: queued goal preempts active work
  through stop/pause, then sets/replaces the target via the goal command path.
- Required checks before commit: `pnpm typecheck`, `pnpm lint`, and the focused test files for parser,
  projection, command handler and queue/send-now behavior.

## Open product questions

- Should v4 show a visible command row for `/goal <objective>`, or only the target card/banner? z-code-2
  preserved the visible command shape, but current v4 acceptance can first assert the stronger invariant that
  it must not become an ordinary model prompt.
- Should `/goal show`, `/goal pause` and `/goal clear` be added to the v4 command schema now, or left for full
  standalone parity?
- Should setup-mode parity from z-code-2 (`direct` / `quick` / `grill`) be planned as a separate v4 protocol
  extension after this command-routing fix?
