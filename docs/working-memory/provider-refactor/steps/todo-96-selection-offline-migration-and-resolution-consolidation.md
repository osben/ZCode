# Todo 96: Model Selection Offline Migration and Effective-Selection Resolution Closeout

> Status: implementation closed; 2026-09-09. Offline migration, protection of the restored original intent and target dispatch are done; the final explicit-Subagent wiring was completed by Todo99 through Worker-local shared resolution and DI with Pro execution evidence, no longer waiting for the old Host RPC proposal ruling. Process: [execution record](../research/todo94-97-execution-and-review.md); follow-up: [Todo99 ledger](../research/todo99-implementation-review.md). Residual cross-platform verification is handed to Todo102 with no all-platform pass claimed.
>
> Core ruling: apart from off-peak tasks, migration of an old Selection does not depend on the current connection, login, entitlement or Provider model config. Migration preserves the original intent; current availability and account correspondence are obtained through `getView({ selection })` as the View and effectiveSelection. A transient Provider anomaly must not damage the original selection, especially for SSH remotes.

> Later ruling: [Todo 97](todo-97-subagent-markdown-in-place-migration-and-legacy-read-audit.md) changes the user-data-directory Subagent Markdown to migrate in place within the formally kept `model` / `thoughtLevel` original fields, replacing this document's old limit "Markdown is not auto-rewritten" for the user directory; project, plugin and other sources are never auto-migrated or written back. The unreleased intermediate format gets no compatibility, old fields serve migration only, and the whole Selection migration chain gets a dedicated re-review. "Current field first" here applies only to the final formal format and does not retain the Markdown `modelSelection` intermediate state. Effective-selection execution wiring is still this Todo's job.

## 1. Ruling and scope

- Old BigModel / Z.ai Coding Plan is fixed-migrated to the **same-domain Individual Provider** and no longer decided by the current personal/Team connection at migration time. Individual is only the deterministic landing of the old intent; it does not mean historical requests used a personal plan, and no account connection is activated or switched.
- Later, the existing effective-selection resolution maps to the current Account Provider's same model and level; no separate Provider-substitution mechanism and Registry validation never replaces the Provider quietly.
- A currently unselectable model or level does not stop the old intent from migrating in; the transient effective result can be empty or lack a level.
- Off-peak task migration and Provider/Ticket binding are excluded this round and not mechanically migrated to a personal plan. No separate Account / Off-Peak logical Selection options (that discussion is shelved); no new Selection persistence format or storage version.
- New-version records already written empty by the old implementation are not repaired automatically and not re-overwritten from old files; restoring stored corrupt data needs a separate ruling of the exact scope.

This Todo changes [Todo 72](todo-72-legacy-builtin-provider-and-model-selection-migration.md) §3.2/§4 ("migrate the old Coding Plan by the current logged-in connection"); it keeps [Todo 87](todo-87-selection-view-unified-resolution.md)'s public resolution, original-intent protection and target-Host authority and completes the entries, and links to [Todo 88](todo-88-provider-audit-regression-repair.md)'s history restore and Subagent boundary.

## 2. Problems investigated

| Entry / boundary | Fact at the time | Handling |
| --- | --- | --- |
| shared old identity conversion | the old Coding Plan branch in `legacy-model-provider-identity.ts` depended on `currentAccountAccess` | deterministic mapping; remove the account context serving only migration |
| Host assembly | `readMigrationAccountAccess` in `node.ts` went through account-settings preparation and login identity; an old Team missing the organization could indirectly wait for the OAuth query | Selection migration no longer takes this chain; independent connection migration and real authentication stay |
| Session | after format/identity migration the `create-app.ts` restore path validated the original Selection directly and returned empty on failure | the original intent must reach the public resolution and not be dropped before the entry; runtime binding stays strictly validated |
| scheduled tasks | legacy-column import checked no model list but the old Built-in callback depended on accounts; SQL NULL keeps the retry boundary | pure import, current-field precedence and CAS kept; the current effective result is used at the original first-dispatch boundary |
| Bot | an old string had to hit the current candidate list while an identical structured selection did not; after the first import wrote v3 the old file was no longer read | delete the candidate-list gate so an explicit but temporarily unavailable intent is not lost permanently |
| Wiki/Subagent storage | old account IDs converted through a Host callback; unconfirmable ones could keep the old intent | switch to the pure conversion; real execution wiring per §5 |

Read-only evidence: pure functions / in-memory SQLite with an injected resolver reproduced the old Coding Plan varying with the current connection, Bot dropping an old string selection when candidates were empty, and Automation importing after identity confirmation without checking the old model/level. No writes to real user data.

## 3. Migration layer: convert only determinable old facts

| Input identity | Fixed output |
| --- | --- |
| `builtin:bigmodel-coding-plan` | `account:bigmodel-individual-coding-plan` |
| `builtin:zai-coding-plan` | `account:zai-individual-coding-plan` |
| `builtin:bigmodel` / `builtin:zai` | kept as `bigmodel-api` / `zai-api` |
| old Start Plan IDs of both domains | kept as the matching `account:<family>-start-plan` |
| formal current IDs, explicit custom Provider IDs | unchanged; no requirement that the Provider exist now |
| undecodable, unconfirmable, retired with no counterpart | keep the existing unbound/unfinished boundary; no Provider guessing, no default fallback |

1. The model ID is preserved as is; only determinable reasoning levels from a truly old format are carried over, never deleted or default-filled because the current config does not support them.
2. Migration must not read the current account connection, login identity, entitlement, Registry, Selection View or model candidates (reading the old record and the static identity mapping is fine).
3. The migration entry's dependency on the full `ZCodeAccountAccess` is removed: static conversion waits for no login, network, remote connectivity or Provider initialization.
4. Format validation stays: illegal JSON and wrong field types are not "temporarily unavailable models" and are not swallowed by loosened parsing.
5. An existing current field wins and an explicit clear does not revive; a bad new value is not repaired from a neighboring old field; an explicit old `builtin:*` identity even in a structured field is still recognized at the upgrade boundary.
6. Migration is idempotent; the old files/fields keep their rollback boundary and the original CAS/transaction protection; no bulk history rewrite and no continuous dual-write.
7. The current API/Team connection settings migration, OAuth query and credential requests themselves stay; only their dependency with Selection format/identity conversion is removed.

## 4. Public resolution and three states

```text
old record -> offline format / deterministic identity migration
 -> persisted original Selection / the user's latest draft  (original intent kept)
 + target Host's currently applied config and account facts
 -> getView({ selection }) -> candidate View | effectiveSelection / selectionIssue  (transient availability)
 -> accept / first dispatch, fix the concrete selection
 -> ModelFactory / Registry final validation  (execution authority)
```

- Account correspondence, emptying an unavailable model and clearing only an unavailable level reuse the existing public resolution; an ordinary Provider gets no cross-Provider same-name matching; a missing model does not take the first item and an invalid level is not filled with the highest.
- Duplicated availability checks and early emptying in restore/display entries are cleaned; deleting validation while still losing the original input does not count: the original intent must reach `getView` in full.
- The final Model build validation and runtime binding protection stay; an invalid original selection is never pushed straight into Runtime for "unification".
- Reads, refreshes and failures never write the original intent empty; saving text, title or other unrelated fields does not overwrite the original selection with the transient empty effectiveSelection.
- In the Composer an active clear/re-pick changes only the current draft intent and re-resolves at once; a menu click or View update alone never writes the Session's formal selection/Recent. Only when the next send is accepted is the formal selection/Recent updated from the actually submitted effective selection (without waiting for model generation to end); an unsent or failed submit does not overwrite the last formal selection; an incomplete cleared draft is not auto-filled with the default model and submitted.
- Draft persistence across restarts is a separate layer: this item does not delete the existing Draft save mechanism; even a saved draft stores only the user's draft intent, never the transient empty effectiveSelection, and never updates the formal session selection.
- Settings pages and scheduled-task / Bot / Subagent config editing still persist at their own explicit save/submit actions (not forced to "wait for sending a message"); a successful commit's write-back checks that the original intent and scope were not replaced by later edits; no global auto write-back mechanism.
- A scheduled task's long-term config changes only at the original explicit edit-save boundary; this run is frozen at the original first-dispatch boundary; a fixed run, Active Model and historical requests are not reinterpreted.
- "Migration incomplete / original intent unavailable" is not "never specified a model": the latter keeps the original default/inherit rule, the former never enters default execution silently.

## 5. Per-entry implementation list (share resolution, not save side effects)

| Level / entry | Shared point, change seed | Display/intent and commit landing | Kept boundary |
| --- | --- | --- | --- |
| must change: Session/Composer | Agent `model-selection-migration.ts`, `create-app.ts`, Host return chain, `SessionPane` and the shared View hook | clear/re-pick changes only the draft; formal selection/Recent updates after a send is accepted; Draft persistence handled separately | the original selection is not lost because Runtime cannot bind it yet; a concurrent edit beats a late result |
| must change: Automation | `automationSelectionMigration.ts`, `automationRepo.ts`, `automationModelSelection.ts`, edit-page shared selection control | old columns import into the current column; long-term config and each run are separate | first dispatch consumes the effective result, a frozen run is not re-resolved |
| must change: Bot | `storageMigration.ts`, `bots/repo.ts`, `botsService.ts`, selection interaction | Config/State each use v3 storage; the effective result is only for the owning interaction/execution | empty candidates do not erase a decoded intent; a disconnected remote never adopts local state |
| must change: Wiki | `repoWikiStorage.ts`, Wiki generation selection resolution and shared control | reads keep intent, new generation uses the effective result | no body/output-budget change (Todo 94); one-time on-disk migration of old files continues in Todo97 §8, reads do not write back afterwards |
| must change, wired separately: Subagent | `subagentsService.ts`, Agent profile initialization, explicit model start path | built-in overrides/Markdown original intent vs this subtask's actual model are separate | not only the settings page; an unspecified model inherits the parent task; Markdown is not rewritten automatically |
| check: Recent/Default/other drafts | existing Readers, save paths after calling the public resolution | existing preference/draft owners | only real old formats; no new migrator because of a shared type; new-default behavior unchanged |
| excluded: off-peak | existing Off-Peak resolver, Repo, Ticket | original flow | no cross-domain rebinding, ticket exchange or ordinary Coding Plan migration |

Subagent extra boundary: the explicit model was validated independently inside the Agent rather than via the Host `getView`. After unifying on Individual, a current-Team scenario must still get the right effective result, so this is not "delete the redundant check and done"; find the reusable Host/Agent wiring first, put concrete contracts to the user if an App-Agent protocol change is needed, and no second account resolution inside the Agent; UI support never counts as backend support (resolved by Todo99 as noted above).

## 6. SSH / Web key protections

```text
SSH down / Provider not yet synced / account state abnormal
  +--> old data can still be purely migrated, original intent kept
  `--> target View not ready or effective result incomplete -> do not execute
target Host recovers / config event arrives -> call the public read again with the kept original Selection
 -> restore the current effective result (not rely on a value written empty)
```

UI/background consume the target Host's authoritative result and never use the local Provider to fill in for a disconnected remote; offline migration does not actively open an SSH connection. View-not-ready/read-error vs ready-but-unselectable are separated, using the public hook's notice and recovery with no new polling, unbounded wait or pre-send sync barrier. `workspaceIdentity?.trim() || workspacePath` isolation and the `remoteSessionId` boundary hold (same path on local vs different remotes must not mix selections). Desktop continuous, phone web-remote replayable and shared-host attachment are unchanged; message recovery and cross-Host scheduling are not redone.

## 7. Acceptance cases

| Case | Condition / action | Must prove | Evidence |
| --- | --- | --- | --- |
| SM96-01 | the same old selection migrated while logged out, personal, Team, Start, another account domain and empty Provider config | byte-identical new Selection; no account/Registry/network dependency invoked | parameterized pure conversion, importer unit tests |
| SM96-02 | old Coding Plan fixed to Individual, current Team has the same model/level | `getView` yields the Team effective selection; Individual availability not required | public resolution, Session restore integration, UI E2E |
| SM96-03 | Provider/model missing or level unsupported, read and save other content, then config recovers | original intent kept; the effective result empties per layer and can recover; no default execution | storage before/after comparison, UI/service tests |
| SM96-04 | Bot first import with empty candidates; old string and structured selection | explicit Provider/model/level all kept into v3 across restart; old file unchanged | Bot file import/restart tests |
| SM96-05 | scheduled task, Wiki, Bot reads and dispatch; existing frozen run | reads produce no selection write-back; each commit boundary correct; frozen records unchanged | business integration, representative E2E |
| SM96-06 | SSH disconnect, config not yet synced, account failure then recovery; local has a different model | migration does not wait for SSH or borrow local; original record unchanged; resolvable again after recovery | isolated remote fixture, protocol/storage, actual effective selection |
| SM96-07 | new field present, explicit clear, corrupt field; user re-picks during migration | no read-back of old fields or default guess; CAS/transaction does not overwrite new edits | storage concurrency/precedence tests |
| SM96-08 | explicit Subagent with an old Coding Plan, current Team; also unspecified model | actual Agent execution uses the unified effective result; inheritance kept | Agent integration after the wiring ruling (not substituted by a settings-page test) |
| SM96-09 | existing off-peak task, Ticket, historical requests | identity/ticket/run record unchanged this round | diff review and existing regressions |
| SM96-10 | Composer re-pick/clear without sending, submit failure, then successful send; edit the draft again meanwhile | click and failure do not update the formal selection/Recent; only an accepted send saves the actually submitted selection; a late result does not overwrite the new draft; Draft saving is not mixed with the formal selection | draft/Session/Recent layered assertions and interaction E2E |

Order: update the fact specs and Todo 72/87/88 superseded clauses keeping the ruling trail, record the Subagent wiring plan, with no new logical options in UI/API/storage; first write pure-migration-independent-of-environment tests, then edit the shared conversion and callers and delete the Bot list check; trace each entry's "original input -> View -> effective result -> save/execute" and add tests before closing duplicated logic (not deleting every Registry validation); wire Subagent (rule on a protocol change first), removing migration callbacks/parameters/RPC that truly have no consumers after a reference check (no half-backend left to delete an RPC); use the relevant AGENTS, UI DESIGN and E2E skills, update the Session coverage catalog/matrix, run `pnpm typecheck`, `pnpm lint`, related unit tests and MacBook Pro E2E with isolated old data / simulated accounts and no destructive tests on real user data; second review of data write-back, remote identity isolation and the selection actually used for requests, recording passed, unrun, environment-failed and open-ruling items before marking done.

## 8. Execution and ruling record

| Item | State | Closeout requirement |
| --- | --- | --- |
| unified offline migration and fixed Individual landing | implemented, targeted regressions pass | replaces the old current-account binding rule; every importer result independent of environment |
| public View resolution and original-intent protection | implemented; explicit Subagent completed by Todo99 | delete duplicated rules, keep the final execution validation and normal save boundaries |
| Bot first import depending on candidates | fixed and verified | the new-version file no longer fixes a temporary unavailability as empty |
| explicit Subagent execution wiring | done and verified by Todo99 | Worker-local public Facade/DI; explicit resolution; implicit inheritance and internal overrides stay frozen; the old per-request Host RPC proposal is not adopted |
| off-peak / logical Account, Off-Peak options | excluded | not done incidentally |
| recovery of new-version records already written empty | excluded, separate ruling if needed | old files not re-imported automatically |
| unit / integration / Pro E2E / second review | core passed; explicit Subagent evidence in Todo99 | real SSH/mobile residual verification goes to Todo102, no longer an independent to-do here |

Impact analysis reuses feature-boundary-planner's model-selection seeds and existing call chains (no codegraph; targeted code reading and in-memory reproduction, no full call-graph verification claimed). The feature graph only adds a link to this plan; [Selection State](../design/interaction/selection-state.md) and related coverage docs are synced after implementation. Todo 95's level-rename compatibility stays an independent task and is not changed here.
