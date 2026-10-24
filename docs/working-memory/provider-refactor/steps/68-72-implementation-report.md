# Todo 68-72 Implementation Report

> Final state after the 2026-09-04 closeout (Todo 70-72 convergence). Detailed designs are in the same-directory Todo
> 68, 69, 70, 71 and 72 documents; this report keeps the outcome and handoff only.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/68-72-implementation-report.md`

## Execution Order and Rulings

```text
68 Active Model closeout -> 72 front: Provider import, old identity conversion, account context
  -> 69 Bot old/new file isolation -> 70 Session restore and unbound selection
  -> 71 Composer persistence and Submission -> 72 back: remaining domain integration, joint acceptance
```

Rulings written back to the Todos: a missing or invalid selection stays empty with no prompt; old fields are kept only
for rollback; the Bot never searches for a replacement Provider by model name; an old Coding Plan, once successfully
converted, pins its identity at the restore-save boundary; the draft limit grew from 50 to 500 (then the per-scope
limit was removed), keeping the original eviction rule and adding no storage tier; files already migrated wrongly are
repaired manually (no automatic repair program). No database table migration was added; old files stay behind the
one-way read boundary.

## 68: Active Model closeout (done)

- `EnvInfo.currentModel` type entry and the Context/persistence stripping bridges were deleted; main Agent and
  Subagent Builders receive the current execution Model and render its identity, never writing a model into the
  environment snapshot. The ordinary Queue's frozen intent is asserted to create the Model; stale "consume latest
  Session" wording in the catalog and matrix was corrected.
- Verification: Core full run 159 files, 2213 passed / 36 skipped / 2 todo; Bootstrap focused 82 passed; root
  typecheck and lint passed. Saved Session selection takes priority over startup arguments; the actual request matches
  the model description. Pro consecutive A -> B -> C -> A model-switch E2E passed twice
  (`desktop-e2e-20260903-122117-608`, `desktop-e2e-20260903-122428-270`; each round asserts target URL, Model ID and
  Provider/Model in system, same Session). That is packaged Desktop + replay gateway, not live model service; the case
  stays pending.
- Open: an extra full Bootstrap probe had 20 failures; the session-facade fake Registry missing `getView` was fixed,
  the other 19 were not fully rerun (12 old Release `schemaVersion`; PDF/plugin fixtures, old protocol boundary,
  marketplace copy dir, remoteCron, stale retry); they were deferred to final acceptance. The Feature Graph check
  found 4 dangling edges and nonexistent seed paths; only the model-fact invariant was updated.

## 72 front: import and old identity conversion (done)

- Desktop import first recognizes the reserved `builtin:*` / `account:*` identities (no `source=custom`
  misclassification); only the two old API Providers' non-empty Keys enter the current Template instance, other old
  Built-in configs are dropped. The standalone CLI bypass was closed too; an empty Key in a real old config no longer
  fails the whole parse.
- One-way identity conversion: API/Start map directly; an old Coding Plan uses only the same-Family connection
  currently logged in in this Environment; current IDs are preserved as-is; unknown old built-ins return unbound; no
  model-list scanning and no runtime alias. Redacted old files pass Reader -> Importer -> Repository -> Template/Resolver
  (API model executable, custom Context kept, old file bytes unchanged, repeated reads do not overwrite Personal
  edits). Services/Shared 5 files / 37 tests and CLI Importer 13 tests passed.

## 69: Bot file isolation (done)

- Config and State files and content are v3; the Repo imports first inside the target file lock and pins the result;
  afterwards only v3 is read/written. Old files stay unchanged; a corrupt new file is surfaced (never overwritten by
  old data, no old copy). The Service's v2 rewrite and model-name guessing were removed; old fields are decoded only
  by the Importer and a new Selection is never overridden by an old `thoughtLevel`. Identity conversion uses 72's rule;
  an unreachable remote is not actively connected and a local account is never used to interpret a remote old Coding
  Plan.
- Tests: storage tests first failed (5), then covered Config create/edit/delete, State update, concurrent first read,
  partial v3, corrupt v3, old/new field conflict, dynamic identity pinning, remote isolation. Bot and Off-Peak /
  Automation / Subagent / Provider storage 24 files / 353 tests passed. Old Config strict-Options Reader check: new
  Options written back to an old file are rejected; the retained old file stays readable and byte-identical. A narrow
  smoke of two frozen-staging task Row Decoders read old rows (it did not verify scheduling; Automation mode validation
  is a fixed null failure in that scenario).
- Pro Desktop `desktop-e2e-20260903-130224-371`: 3 files / 5 cases passed (bot popup enable persists v3 / bindings kept,
  AskUserQuestion, completion card, Feishu/Lark isolation, streaming card lifecycle). The popup is real UI; the other
  cases use the formal Service + controlled stream (no real third-party account connectivity claimed).
- Not tested: full old-App rollback and live Bot accounts (final release regression checklist).

## 70: Session restore and unbound selection (done; closed 2026-09-04)

Rules now holding:

1. Session restore accepts only the current Model Selection. Storage decoders prefer current fields (an incomplete
   current User Selection does not read the old model; Assistant / Timeline do not fill from old uppercase identity;
   current entry options are not patched by old `thoughtLevel`); decoders expose no old alias and the original database
   is not rewritten in bulk.
2. The Runtime allows an unbound selection: history hydration and the SessionStart hook create no Model; execution
   entry rejects an unbound selection; Factory accepts only a complete Selection. Restore never fails at Runtime
   creation because the Registry is empty or the selection is missing. New sessions still use the configured default.
3. `restorePersistedModelSelection` binds a Selection only after full Registry validation; the result may carry a
   valid model identity for the UI to complete. A reasoning error clears only the level; a selection-entry read failure
   records a storage error, reads no history/default replacement, and does not block opening history. A missing or
   invalid model/Reasoning stays empty (never silently replaced by the first Registry item; the leftover
   `ensureSessionModelAvailable` fallback became a no-write transitional entry).
4. History/synthetic messages may lack model source; Core, Protocol mapper, Host and UI history mapping never borrow
   the default model. Desktop continuous and Web replayable projections both cover missing-model messages without
   changing their transport/recovery boundaries.
5. One-time migration of an old Coding Plan: the Session Store operation recognizes the original old structure, injects
   the identity mapping asynchronously, re-checks candidates in the write transaction and immediately pins the current
   entry (a current entry blocks old-message fallback, a new selection during the wait wins, old messages' bytes and
   activity time are unchanged, no re-migration after an account change). The Host obtains the same Environment's
   account identity through a narrow RPC (local and externally authorized preference configs never forward to the
   desktop preference resolver). A malformed `options` still migrates a determinable Provider/Model with reasoning left
   empty.
6. Protocol bypasses were removed: message/fork-pair/thought-hint/default-model supplementing and `setModel` default
   filling. Protocol takes only the App's restore result; restore and user model selection share the existing App
   serial critical section; a new user selection clears the first-restore seed; an explicit empty value may clear the
   history model seed.
7. The toolbar and the underlying control show an empty level as a localized "choose reasoning level" placeholder
   (zh/en), not the catalog default (`max`) or the first item "off".

Verification: Core full 160 files / 2215 passed / 36 skipped / 2 todo; Bootstrap migration/unbound restore 35 passed;
Adapters migration 12 passed; Protocol/App/Projection focused 237 passed (Pro 219 on the latest source). Pro UI E2E
`desktop-e2e-20260903-161924-582` then `desktop-e2e-20260903-162422-098` passed the cold-restore case (missing level,
invalid level, invalid Provider, reselect in the same Session and keep sending); the case stays pending, not
auto-promoted.

Pro infrastructure note: WebDriver session creation timed out under the original `Desktop` directory (Electron sample
showed debugger `realpath/getcwd/open` and module-resolution waits). Copying the isolated code/dependency/build to
`/tmp/zcode-todo70-wdio.JjKqz1/source` fixed it; directory access is the evidence-supported cause but the exact macOS
mechanism is undetermined; no system permissions, installed app or real user config were changed. Runs that returned
exit 0 with 0 cases are not counted as passes. Earlier E2E fixture problems (a default fake JWT reaching the real
control plane and showing a login-expired dialog; worker-created Replay address not written to the Provider) were fixed
red-then-green.

Open: whole-package Bootstrap probe on Pro was 24 failed / 1437 passed (two tests lacked sync; others: old Built-in
`schemaVersion=2` fixtures, plugin import/packaging/PDF assets, V4 native boundary, existing Cron/command assertions);
72 back joint acceptance must review each as outdated test vs production issue without skipping by "baseline" label.

## 71: Composer persistence and Submission (done; closed 2026-09-04)

- Draft storage (v1 key kept) gains optional `mode` / `modelSelection`; a valid mode marks "initialized"; an empty model
  is kept; empty text no longer deletes a record holding mode/selection; the per-scope cap was removed (earlier 50 ->
  500) with the original updated-time eviction; the Reader reads draft and new leaves per entry, old text drafts stay
  readable, bad options keep the determinable current model identity, no old flat alias is read;
  `localStorage.getItem` throwing no longer propagates to the UI (a same-key failure logs once and resets after a
  successful write). No new business Store/Host Repo and no attachment serialization.
- `useDraftConfigControl` initializes in-memory state from the current scope's complete persisted Draft. An existing
  Session waits for the first matching Snapshot and reads only the new `modelSelection`; a new task waits for the Ready
  View and uses valid Recent/preferred. Later Snapshots, global mode preference and workspace `draftPreferred` no longer
  rewrite this selection. Ready revision updates and deferred Session seeding share the Provider Option validation: an
  invalid model clears the selection, an invalid level keeps only the identity, loading never clears, remount never
  fills defaults. The old invalidation Hook (default backfill / Toast) and the prewarm online fallback's reverse write
  to Composer were deleted. Menu updates write the full draft synchronously; late callbacks from an old scope are
  isolated.
- `createComposerSubmissionConfig` reads only the Composer's structured `modelSelection` / `mode`, reuses Registry
  Option validation and freezes a copy (Snapshot/base/display alias merging deleted). SessionPane takes values before
  the async command barrier, ConversationComposer before waiting for attachments (an explicit null cannot be refilled
  after the barrier). `/plan` changes the local next-Submission mode and no longer relies on Session config CAS
  confirmation. The toolbar shows only the Composer's structured selection, with candidate levels from the target Host
  View (an existing Session with an empty model keeps the reselect menu). The global `draftModePreference` (no
  consumers) was deleted from implementation (users' old localStorage keys are not removed).
- Attachment adoption/cleanup captures this submission's attachment ids: submitting A then adding B transfers/clears
  only A (scope isolation, upload flow, desktop/remote entries and non-serialization of attachments unchanged).
- Verification: local and Pro focused 9 files / 140 passed; UI full probe 850 files / 6685 passed / 1 skipped (before the
  last attachment fix); attachment/Composer 3 files / 42 passed; cold-restore E2E `desktop-e2e-20260903-164830-352`,
  `...171659-078`, `...172132-231` passed; root typecheck, lint (35 pre-existing warnings, 0 error), diff check passed.
- 2026-09-04 final: Composer Draft/controller 20 passed; Bootstrap command set 71 passed.

## 2026-09-04 Pro Recheck and Closeout

- `origin/provider-refactor-m2@7e86c01d8e` only fixed a startup credential fixture; it was not cherry-picked because
  this branch already has the more precise Personal-only rule. The equivalent fork/goal/tool no-account rule was
  adopted with a fixture unit test.
- After the latest Pro build: Composer toolbar, first-send cold restore and Composer draft switch 8 passed (text and
  image attachments survive completed/running/unsent tasks). Fork/goal/tool: CronCreate 1/1, Fork merge 1/1, Goal 22/22,
  Fork edit branch 1/1; the tool cross product ended 50 passed, 1 skipped by semantics. The one failure
  (`EnterPlanMode -> set goal`) was not a defect: the product explicitly forbids Goal in Plan mode, so the helper's
  forced switch-back was removed and that combination is explicitly skipped (other EnterPlanMode compact/fork checks
  remain); the earlier `SendMessage -> Goal` false failure disappeared.
- Open: the oversized-image pending case still calls a deleted old Session Store prefill interface (2/2 precondition
  failures); an old E2E fixture migration issue unrelated to the Provider refactor, no unverified compatibility bridge
  added.
- Built-in migration keeps only the BigModel/Z.ai pay-as-you-go API Key (other built-ins create no Personal copy); old
  Coding Plan identity is pinned once from the current account connection and later restores recognize only the new
  field.
- 72 back (remaining domain integration and joint acceptance) was never started as a separate stage; its remaining items
  are the Bootstrap failure review above and the final release regression checklist (old App rollback, live Bot
  accounts).

## Test Machine Note

All real-machine testing uses the MacBook Pro (an earlier Air requirement in Todo 68 was wrong and corrected). Air round
one stopped at an unclickable model menu (not a pass); round two was stopped; Air directories/logs were left, old source
directories and real user data untouched. Pro isolated test directory:
`/Users/dev/Desktop/projects/Z.AI/zcode-todo68-e2e.H1cvBo` (Node 24.14.0 / pnpm 10.33.2; Electron 41.0.3 binary reused
from an older directory; only PATH and skip-download were set for test commands, no global mise trust, Shell or Git
config change).
