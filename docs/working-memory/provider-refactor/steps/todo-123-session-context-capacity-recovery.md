# Todo123: Decouple Historical-Session Capacity Lookup from Execution Selection Validation

> Status (2026-09-12): implementation and review complete; 12 new targeted tests, the final batch gates and the Pro real
> Electron CW01-CW06 pass. The phone protocol branch is covered by Bootstrap integration tests; real phone remote control
> on-device is not claimed.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-123-session-context-capacity-recovery.md`

## Problem and Goal

An Air historical session showed GLM-5.3-Flash with about `29,908 / 200,000` context capacity, while the installed
package's Built-in config declares `1,000,000` for the model and the session's new-format selection lacked a thinking
level. The restore entry read the saved ModelSelection and returned it unchanged, but wrote the Runtime session selection
only after full execution validation passed; the capacity query took the selection only from the Runtime, so a missing
level left no model identity, the Registry lookup was skipped and history restore ended on the default 200,000. The
executed Model had not been created without capacity, and the actual request is not shown to be limited to 200,000.

Goal: a known model identity is enough to query the Registry capacity, so an (execution-wise) not-yet-valid selection
does not lose the configuration display; when no capacity is found no fake 200k or percentage is shown. Historical token
usage keeps its real source.

## Rules

```text
Runtime current session selection, else existing restoredModelSelection
  -> exact lookup in Registry by providerId/modelId
  -> history event restore init  |  usage-seed backfill (historical used + the same capacity result)
  -> V4 usage projection / snapshot -> desktop and phone capacity display
Model creation for execution still runs full execution validation (not relaxed here)
```

1. Reuse the `record.restoredModelSelection` the restore code already has, consistent with the config-seed selection
   source; no second database read, long-lived cache or second selection state. The rule clearing the restore candidate
   once a new selection takes effect stays (an old restored selection never overrides a new one nor revives after clearing).
   The capacity query never uses the uncommitted Composer draft, adds no thinking level, remaps no Provider, borrows no
   default model.
2. The App layer gains a read-only path querying Registry model config for a given selection, reusing the existing
   Registry query implementation, without writing the selection into the Runtime or creating a Model. Provider/Model
   identity is exact; the thinking level is not a metadata-lookup gate; a missing model or invalid capacity returns unknown.
   The Runtime session-selection save/clear convention and ModelFactory / Submission / Guide / Subagent execution and
   inheritance semantics are unchanged.
3. History restore and usage backfill converge: history event restore rebuilds chat content and initial state, the usage
   seed restores the latest context watermark from Runtime/persisted messages. Both may write capacity and must use the
   same query result (the later stage must not write back an old denominator). During cold restore the capacity result is
   obtained once and reused, with no synchronization wait, version system or long-lived state.
4. Unknown capacity follows the existing protocol `usage.contextWindow: null`; no `maxTokens: 0` pseudo capacity or fake
   percentage. Internal usage seed / projection supports unknown capacity while keeping used tokens (hiding the capacity
   panel must not drop usage facts). The protocol already allows the capacity object to be null, so no cross-process schema
   extension and no new "used / unknown limit" UI.
5. The restore seed does not overwrite real model/usage events that took effect during restore (existing event priority
   and same-model capacity update boundaries). Only this restore display chain's default denominator is handled: not every
   200,000 constant, the real compaction threshold nor the request output budget.

Not involved: database migration, account sync refactor, Registry capability rules, executed Model objects, quota service.
Thinking-level loss migration is fixed by its own Todo and a symptom disappearing after migration is no substitute for this
acceptance. Desktop `desktop-continuous` and phone `web-remote-replayable` keep consuming the same V4 usage facts with
their own transport/restore boundaries; no new phone Runtime and workspaceIdentity isolation is unchanged. Specs
`docs/context-window-usage-state.md` and `docs/coding-plan-context-usage.md` are updated first with the restore facts and
the unknown-capacity convention.

## Acceptance (all done)

- Model exists, capacity 1M, selection lacking a level: history opens, capacity correct, used tokens unchanged; execution
  still requires completing the level.
- Normal full selection: the first visible usage projection and later seed backfill are correct with no flash back to 200k;
  the current run and normal capacity updates do not regress.
- Missing model or unknown capacity: no fake capacity/percentage, no new error prompt; history and internal usage kept; a
  later valid capacity displays correctly.
- A new selection taking effect or new events during restore: the old restored candidate / old seed never overrides current
  facts; the Composer only changes the draft, not the running session's capacity.
- After Compact, cold restore still uses the compacted persisted watermark; cache / breakdown / cumulative usage keep their semantics.
- The existing cold-restore E2E is extended and the shared desktop/phone display and protocol null branch are checked;
  unexecuted environment verification is recorded, not marked passed.
- Related unit tests, typecheck and lint in one batch; review of selection identity source, read-only Registry query,
  unknown-value propagation, event priority and no selection write-back.

## Implementation and Review (2026-09-12)

- The App gained a read-only query of the Registry by a given selection; capacity comes from the Runtime's current identity,
  else the existing `restoredModelSelection`. Restore-selection validation, formal Model creation and the clearing time of
  the restore candidate are unchanged.
- In one load the exact capacity serves history synthesis and the usage seed and is returned to the Gateway together; the
  seed is restored first and the live buffer replayed after, with no long-lived cache or new sync. Without capacity no 200k
  is synthesized; the internal seed `maxTokens` may be null while usage is kept. Protocol, desktop continuous / phone
  replayable, shared-host and workspace isolation are unchanged.
- Real SQLite + real App + Server verify, for both clientModes, that a missing-level identity still shows 1M with readable
  content and no Runtime binding, and that an unknown model opens normally with capacity null. Also tested: restore after
  unknown usage, new events overriding the old seed, single delivery without a second query, current identity priority and
  no resurrection of the cleared candidate; 12 pass. The first fixture wrongly passed the DB encoded shape to the Store API;
  after correcting to the domain shape the two missing-level cases were confirmed failing on the old query implementation,
  then the fix restored.
- Six-file batch: 410 pass / 5 fail; rerunning the same five on pre-fix commit e1a28f23eb in an independent temporary
  worktree failed identically (three old cold-restore fixtures writing old fields after migration, the remote Cron denylist,
  an old Account serialization assertion), so they were not widened. The rest covers Compact, cache, breakdown, full
  selection and backfill. Bootstrap typecheck was first affected by stale Adapter dist declarations and passed after
  rebuilding the Adapter; root typecheck/lint (0 errors / 41 warnings) and architecture pass.
- CW05/CW06 extend the existing Electron E2E: only after the exit barrier do they change the new selection field of an
  isolated test Session, keeping the body and Compact watermark created by the real UI, then test missing-level / unknown
  model cold reads. On 2026-09-12 the whole group passed after rebuilding App/Agent from `fc757c0ec9` in an isolated Pro
  directory (the report title still says CW01-CW04 but CW05/CW06 ran). Log `/tmp/provider-20260912-pro-cold-resume.log`,
  remote artifact
  `/Users/dev/provider-stabilization-pro.euQzIZ/packages/desktop/.e2e-artifacts/provider-20260912-pro-cold-resume/summary.md`.
  Settings-browser passes do not replace this cold-restore acceptance.

## Main Code and Test Entries

`apps/zcode-cli/packages/bootstrap/src/app/{create-app,session-facade,types,provider-registry-selection}.ts`;
`bootstrap/src/zcode-protocol/{server-types,server-operations,workspace-model-runtime,v4-bridge,session-mapper}.ts`;
`bootstrap/src/zcode-protocol-v4/{transcript-hydration,product-projection}.ts`;
`packages/shared/src/zcode-protocol-v4/snapshot.ts` (existing nullable capacity protocol, not extended);
`packages/ui/src/v4/composer/V4ComposerToolbar.tsx` (shared display consumer, layout unchanged);
`packages/desktop/test/e2e/conversation-session/conversation-session-context-window-cold-resume.test.ts` and Bootstrap
hydration / projection / protocol unit tests.
