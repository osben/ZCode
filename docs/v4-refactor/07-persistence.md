# V4 Persistence and Cold Recovery: Current Spec

Updated: 2026-07-15

V4's persistence principle: transcript, timeline anchors, session metadata and the input lifecycle are long-term facts; projection, topic event log, subscriptions, the CommandInbox LRU and active runtime work are rebuildable or in-process state.

## SQLite facts

The CLI session store is at `~/.zcode/cli/db/db.sqlite`. The migration entry is `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts`, currently migrated to `0018`:

| Migration                                       | Current role                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `0014_message_part_sequence`                    | Establish a stable order for message/part                                  |
| `0015_message_part_sequence_backfill_and_guard` | Repair empty sequences and guarantee later writes with a trigger           |
| `0016_session_input_ledger`                     | Add the durable input lifecycle ledger                                     |
| `0017_session_input_start_now_delivery`         | Bring `startNow` into the input admission ledger                           |
| `0018_session_input_failed_status`              | Distinguish the terminal state of a runtime start failure after acceptance |

message/part still evolve additively with index columns plus JSON data. A missing optional anchor is tolerated on the read side; only structures needing query, uniqueness or transaction constraints are added through append-only migrations.

## Transcript and timeline anchors

`MessageProjectionAnchor` can currently hold: `turnId`, `productTurnId`; `origin`; `sourceCommandId`; the ordered/boundary message ids and goal boundary of a stable fork.

A timeline part stores visible markers such as compact, goal verification, fork and model change, and may carry `sourceCommandId`. New writes must keep these anchors where possible; when historical data lacks a field, the single resolver degrades its interpretation, and multiple UI/helper heuristics are forbidden.

When a stable fork copies conversation facts it must rewrite child-local references. A local anchor pointing to a parent message that was not copied is cleared and the original reference is kept only as provenance; the child on recovery must never re-read the parent's current state posing as the fork-time state.

## Input lifecycle ledger

`session_input` records:

```text
admitted
  |-- promoted  -> atomically linked to the transcript user message
  |-- cancelled -> user deletion or cancel
  |-- discarded -> explicit reasons such as restart / queue clear
  `-- failed    -> accepted, but the runtime cannot start
```

delivery is `startNow | guide | queue`. The id aligns with `sourceCommandId`, and the payload keeps the full `ConversationInputIntent` including attachments, submitting client and dispatch info.

The table solves "a crash after ACK but before the message is persisted makes the input vanish without trace", and does not mean the CLI auto-executes old inputs after restart. On resume, leftover `admitted` records become `discarded(session_resumed)`; `commands/query` can return an explicit failure fact, and the user decides whether to resubmit.

## Command idempotency facts

There is no persisted CommandInbox table. Beyond the settled LRU, `commands/query` rebuilds results from these persisted sources: (1) transcript anchor; (2) timeline part; (3) child/session-entry command fact; (4) input ledger terminal state.

The query must hit exactly by `(sessionId, commandId)`. A global `createSession` finds the real session through the input/child fact matching the command id, never guessing from title, workspace path or latest creation time.

## Cold hydration

V4 cold subscription follows:

```text
persisted message/part + timeline + session input + session metadata
  -> transcript-hydration / cold-event-merge
  -> canonical SessionEvent
  -> ProductProjection
  -> snapshot + new logEpoch
```

Recovery covers visible facts such as text, reasoning, tool, subagent, compact, goal, model/config and queue/input terminal states. A historical `pending/running` tool or active work must not pretend to still run after a CLI restart; hydration must close it into a read-only historical terminal state. For the compact marker the authoritative order is still the new timeline part first; the legacy compaction boundary serves only runtime history and must not render a duplicate visible banner.

The event log serves only bounded resume within the current CLI process. A logEpoch change means the old base is invalid and the client must accept the new snapshot; database messages must not be sent straight to the renderer bypassing the projection, and an old seq/revision is not a cross-process stable cursor.

## Draft and runtime-state boundary

1. A pure draft session may appear in sessions-index but without a transcript is not recovered as a long-term session fact.
2. Active runtime work, pending network requests and subscriptions are not persisted.
3. The queue's visible input has a durable ledger but is not auto-executed after restart.
4. Desktop continuous and mobile replayable share the persisted facts above, and recovery frames are still generated per their own delivery profile.
