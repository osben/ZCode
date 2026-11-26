# Selection side chat on the Rust runtime

Status: implemented in `zcode-rs` (the v4 command `createSelectionSideSession`). Before: the command fell through to
`unsupported()` and answered `proto.unsupportedCommand`, so the side pane never opened.

Product rules: `docs/ui/conversation-selection-side-chat.md`. Wire shape: `packages/shared/src/zcode-protocol-v4/command.ts`
(`createSelectionSideSession`, result `{type, sessionId, input?}`). Node reference:
`commands/handlers/selection-side-session.ts`, `v4-bridge.ts` `createSelectionSideSession`, core `session-fork.ts`
`createSelectionSideConversation` and `selectionSideChatHistoryMessages`, `session-fork-commit` (`kind: selection_side_chat`).

## Rules

1. The envelope's `sessionId` is the parent. The command creates one child session of kind `selection_side_chat` and answers
   `{type: "createSelectionSideSession", sessionId: <child>}`. It is accepted at any time, also while the parent runs a turn,
   waits for an interaction, or has a goal.
2. The child inherits the parent's committed active history **for the model only**. The pane starts blank: the inherited rows
   are hidden, and a boundary reminder ends them (rule 6).
3. While the parent runs a turn, the inherited history keeps the committed input that opened the turn and drops everything
   after it (assistant text, tool calls and results). A turn opened by a notification keeps nothing of that turn (the
   notifications batched before its last one go too). A turn whose opening message is not stored yet leaves the whole
   committed history. A running compaction is not a turn: all committed history is copied.
4. The child copies no goal, goal verification, queue, auto-drain state or running state. It never changes the parent: no
   command, queue item, lease or event is sent to the parent session.
5. The child's model is `firstInput.modelSelection` when given, else the parent's current selection. Its permission mode and
   plan switch are the parent's current ones. The follow-up mode (queue or guide) is copied from the parent. The child keeps
   the parent's workspace and incognito profile.
6. Row shape (the same as Node writes, so Node reads a Rust-made child and the other way round): `task_type`
   `selection_side_chat`, `parent_id` the parent, title `Selection side chat` with source `generated`, slug
   `<parent slug>-selection_side_chat-<base36 ms>`. Each inherited message is `visibility: model-only` with
   `semantics.uiVisibility`/`transcriptVisibility` `hidden` and `providerVisibility` `visible`; `anchor.goalBoundary` is removed.
   After the last inherited message comes one hidden user reminder with `source: selection_side_chat` (Node's boundary text).
   No `session_fork` divider and no fork notice are written.
7. With `firstInput`, the first message starts in the child, under the command id, exactly as the `firstInput` of
   `createSession` does. The result adds `input: {delivery: "startNow", inputId: <commandId>}`. Without it the child stays
   empty.
8. Retry: the same `(sessionId, commandId)` answers the first ack again (status `duplicate`, same child) from the server's
   remembered acks, like every other command. The kernel refuses a second fork with the same command id (`Duplicate`).
9. Reading the child back (cold open or live): the boundary reminder reads as an attachment of source `selection_side_chat`
   and reaches the model. The projection skips every message up to and including it, so the pane shows only the side chat's
   own turns and draws no fork divider. A child without a boundary (not made by Node or Rust) shows all it has.

## Owners

| Fact                              | Owner                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| Where the inherited history ends  | session actor, `fork_input.rs` `side_chat_through` (reads the actor's own message list) |
| The child's rows                  | store, `SessionStore::fork` with `ForkKind::SelectionSideChat` (node-store `fork.rs`)   |
| The child's model, mode, plan     | session actor (`Command::ForkSelectionSideChat`), taken at the moment of the copy       |
| Follow-up mode, opening the child | protocol, `fork/selection_side_chat.rs`                                                 |
| First input                       | protocol, `commands::submit_first` on the child's handle                                |
| Hidden inherited rows             | projection, `cold.rs` (skips through the boundary attachment)                           |

The protocol never reads the parent's history: the cut and the copy happen in one actor turn, so a turn that ends between
two reads cannot make them disagree.

## Event order

```
App                Protocol (parent live)        Parent actor          Store            Child
 | createSelectionSideSession |                       |                  |                |
 |--------------------------->| ForkSelectionSideChat |                  |                |
 |                            |---------------------->| cut history      |                |
 |                            |                       | fork(kind=side)->| one transaction|
 |                            |<----- Forked(child) --|                  |                |
 |                            | copy follow-up mode                      |                |
 |                            | server.live(child), announce ----------------------------->| opens
 |                            | firstInput? submit_first(child) ----------------------------->| turn starts
 |<---- ack {sessionId, input?} ----------------------|                  |                |
```

## Divergences from Node

- A parent with no stored message at all (the first turn's input is not committed yet, or the session is new) gives a child
  of only the boundary. Node does the same (copies zero messages).
- Node also writes an environment update when the parent announced a visualization directory, and copies the parent's prompt
  snapshot entry. Rust writes neither: the child's first request renders its own prompt and environment.
- Node rolls back the input admission when the first input fails to start and fails the command. Here a first input the
  child refuses is left out of `result.input` and the command is still accepted; a draft that cannot be persisted fails the
  command (`fault.command.executionFailed`), as for `createSession`.
- Node titles a side chat after its first question (`specs/session-title-polish.md` section 6). Rust keeps the fixed title.
- Idempotency across a restart: Node reads the stored command fact and returns the same child. Rust remembers acks in memory
  only, so a retry after the app-server restarted forks again (the kernel `Duplicate` of the old actor is gone with it).
- The sessions index: node-store lists top-level sessions and forks only, and the workspace overview lists interactive
  sessions only, so a side chat is not in the cold sidebar list after a restart. Node's sidebar lists side chats under
  their parent. Not done here; the pane that created the child holds its id and opens it directly.
- While a turn runs, only the input that opened it stays. A notification turn drops the contiguous notifications before its
  last one (the batch); other model-only messages of that turn that are not notifications stay.

## Acceptance scenarios

Unit tests (all run offline):

- `session` `fork_input_tests.rs`: the cut rules (idle, running typed input, running notification turn, opening message not
  stored, tool result never a cut point, empty history); child shape, parent unchanged, chosen model, empty parent, accepted
  while a turn runs and the child holds only the opening input, kernel `Duplicate` on the same command id.
- `node-store` `fork_tests.rs`: row shape, hidden inherited messages, boundary, no goal, no divider, empty history, a plain
  fork still needs a target.
- `protocol-zcode` `worktree_tests.rs`: through the command entry (inbound schema included): create without `firstInput`,
  create with `firstInput` (child gets the input and the chosen model, parent untouched), retry with the same command id.
- `protocol-zcode` `projection/side_chat_tests.rs`: the pane starts after the boundary, a boundary alone is a blank pane.

Not covered by tests here: the desktop renderer against a live `zcode-rs` (E2E runs in the Linux box).
