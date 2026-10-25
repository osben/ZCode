# Todo121: Restore the Thinking Level Missed When 0020 Backfilled the Session Selection

> Status (2026-09-11): the appended migration 0022 is implemented; targeted formal-runner / storage-Reader verification
> and local review passed; whole-batch final delivery review was pending. It follows the data-migration gap of
> [Todo109](./todo-109-database-migration-consolidation-and-rollback-readability.md); no real user database was modified.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-121-repair-backfilled-session-reasoning-level.md`

## Problem and Goal

With no `runtime/model_selection` entry, 0020 picks the last candidate in message order. An old user message may carry
`model.variant = max` while the later assistant message only has the model identity. The user message's new
`modelSelection` keeps the level, but the backfilled Session selection has no options, and the new version reads only the
Session's new selection, so the level is empty after restore.

Running the existing 0020 SQL directly reproduced this for a custom model and a Coding Plan GLM. The counterpart's "140
recoverable" statistic is for their machine only, was not independently verified and is not the full impact scope or an
acceptance count.

Goal: one new formal migration that restores only the definitely-missed level. Sessions that continued to be used or had
their selection saved after 0020 are simply skipped; not every historical state is rescued, with no complex history
reconstruction or needless defense.

## Final Approach

### 1. One Appended Migration Covers Both Kinds of Users

0020 and 0021 content and checksums are unchanged; they are neither re-run nor bypassed by editing the ledger. The latest
session-DB number was 0021; the number is re-checked before appending, not reserved in advance.

```text
never ran 0020: 0020 backfills the entry (keeping the message's historical time) -> ledger records execution time T -> 0021 -> new repair migration
already ran 0020: executed migrations skipped, original time T kept -> new repair migration
```

T is read from `schema_migration` `0020_provider_model_selection.time_applied`. The runner executes in order within one
startup transaction and records afterwards, so a first upgrade can use the same time and needs no second repair flow.

### 2. Skip Sessions Touched After the Migration

Skip the whole session if either holds:

- `session.time_updated > T` (normal message/content writes update the session activity time).
- The target selection entry's `time_updated > T` (saving a selection alone uses `touchSession: false` and does not
  update the session time, so the entry must be checked separately).

This is a conservative filter on existing write times, not a full operation audit and no tracking of arbitrary external
changes; over-skipping some sessions because other operations updated the time is acceptable. 0021 only normalizes
identity and updates neither time, so it is not mistaken for later user activity.

### 3. Backfill Conditions for Untouched Sessions

1. The entry type is `runtime/model_selection` with the standard ID `sessionId:runtime-model-selection`.
2. The entry data has no old flat `providerId`, `modelId`, `thoughtLevel`; the new `modelSelection` has a valid
   Provider/Model identity and **no `options` member**. Existing options (including empty object, explicit null or other
   values) and an explicit empty selection are never overwritten.
3. In 0020's order (`sequence desc, time_created desc, rowid desc`) take the **last role=user message** of the same
   Session first, then check whether its `modelSelection.options.reasoningLevel` is a non-empty string (never filter to
   messages with a level first and skip over a newer empty selection).
4. Read identity and level directly from that user's new `modelSelection` (0020 already converted old `model.variant`; no
   old-field fallback is added).
5. The user message identity, normalized by the frozen migration rules, must equal the entry identity: this includes
   Provider renames and 0021's limited official-GLM case rule; no global case-insensitivity for arbitrary
   Providers/models and no account, entitlement, live catalog or Registry lookup.

When matched, only `data.modelSelection.options.reasoningLevel` is added, keeping the user message's recorded level (no
new level-rename semantics). Different model, last user without a level and bad data are skipped. No parentID inference,
no rebuilding of Guide/branch/model-switch history, no search of earlier messages for a level, no rerun of 0020's
candidate expression for history forensics, and no runtime old-field read-back.

### 4. Data and Implementation Boundary

- Only the target `session_entry.data` location above in the session DB changes: no model identity, other options, old
  fields, historical messages, body, tasks or any activity time.
- The existing startup migration runner, transaction and ledger are used; a successful repair records once and does not
  re-run on restart.
- Conversion rules are frozen at the migration boundary (no versioned Resolver/catalog reference); SQL stays simple and
  the migration framework is not extended.
- Normal Session restore, Registry and UI are unchanged. Todo109's top principle holds: a rollback or rollback and
  re-upgrade may invalidate model selection, but sessions/tasks must open without reporting an error for missing new fields.
- Tests first; no real user database; a failed old checksum is not an exception to ignore.

## Acceptance and Review

- First upgrade: a real old-format user with max, assistant without variant and no selection entry restores max after
  0020 / 0021 / the new migration in order; covers a custom model and a Coding Plan GLM.
- Already ran 0020: the original ledger time is kept and untouched backfilled sessions are repaired; confirm 0020 is not re-run.
- After migration, new messages / session updates, and saving only the selection without updating the Session time, are
  each skipped; cover later no-level reselection, explicit clearing and new sessions.
- Provider old identity and official-GLM case follow the frozen rules; a different Provider/model does not borrow a level;
  third-party models get no arbitrary case normalization.
- Last user without a level or with an explicit empty selection is not backfilled even if an earlier user has max; existing
  options, old flat selection entries, invalid JSON / identity are untouched and do not block content reads.
- Only the target field changes: old values, messages, body and all activity times asserted unchanged; no re-run on
  restart, unchanged checksum, a failed transaction leaves no partial repair.
- Storage Reader / Session cold restore reads the restored level; per Todo109, rollback and re-upgrade content stays
  readable without exceptions for missing fields (a successful disk write alone is not recovery-chain success).
- Related tests, typecheck, lint and full review in one batch; two user kinds, skip scope, Selection/Provider abstractions
  and all entries checked before closing.

Investigation start points: `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations/{0020-provider-model-selection,0021-official-glm-selection}.ts`,
`migration-runner.ts`, `repositories/{session-entries,messages}.ts`,
`apps/zcode-cli/packages/bootstrap/src/app/session-store.ts`,
`apps/zcode-cli/packages/adapters/tests/provider-database-migration.test.ts`. The early in-memory probe only showed the
problem and filter direction (first-upgrade / migrated-untouched cases selected; later messages, later reselection,
different model, existing level, last user without level, explicit empty user selection skipped); it is not formal fix or
full-regression evidence.

## Implementation and Review

- Latest number confirmed 0021; appended `0022_backfilled_session_reasoning` without changing 0020/0021 SQL, checksums or
  activity times and without adding tables/columns.
- 19 new real temporary SQLite / startup-runner cases failed before and pass after; with the original whole-DB migration
  and official-GLM migration tests, **3 files / 29 tests pass**: first upgrade with three identities, migrated-untouched,
  later activity/reselection, empty options/null, old flat, mismatch / third-party case, last user empty / missing level,
  bad JSON, bad identity / non-standard entry, whole-transaction rollback and retry, no re-run on restart.
- The formal storage Reader reads the new level and the original session title/messages; messages, Session, old ledger and
  selection-entry times are asserted unchanged. The original whole-DB migration regression keeps verifying readable history
  after rollback and re-upgrade without the new field. No real user database; no full desktop/phone acceptance claimed.
- SQL review: the last user is selected first, then the level checked (no skipping over a newer empty selection); only its
  new field is referenced; the frozen identity table matches 0020/0021 with no live Registry/account dependency; existing
  options are never overwritten and already-continued sessions are not repaired.
- Root typecheck, Adapter typecheck and the architecture gate pass; the new 0022 file's lint passes alone, while full
  Adapter lint is blocked by existing max-lines errors (not all green). Batch final regression and delivery records:
  [execution ledger](./provider-stabilization-20260911-execution.md).
