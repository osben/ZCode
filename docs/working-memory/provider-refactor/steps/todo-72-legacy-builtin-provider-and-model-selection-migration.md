# Todo 72: Legacy Built-in Provider Config and Model Selection Identity Migration

> Status: implementation and phase acceptance done (2026-09-04).
>
> Later ruling (2026-09-08): this document's migration of Selections by the current personal/Team account is superseded by [Todo96](todo-96-selection-offline-migration-and-resolution-consolidation.md): an old Coding Plan is fixed offline to the same-domain Individual Provider, and actual account correspondence is handled by effective-selection resolution. The text below keeps the implementation trajectory at the time; real connection-setting migration and OAuth/Team organization completion are unaffected.
>
> Updated 2026-09-03. Source: after a colleague's old `config.json` was migrated, built-in plans wrongly appeared in the custom provider list.
>
> The rollback boundary follows the latest Todo 69: no continuous dual-write of old fields. This document completes upgrade migration and does not restore the cancelled dual-write plan.

## 1. Confirmed problem

Entries with `builtin:*` in old config may also be stored with `source: "custom"`. `legacyPersonalProviderConfigImporter.ts` filtered mainly by `source`, so it migrated them in full as `standard-personal`, freezing the old plan Endpoint, account credentials and model members. Existing tests covered only `source: "builtin"`, not this real data shape.

Some old Model Selection conversions only carried the Provider ID. The old version shared one Coding Plan ID for personal and Team; the new version splits them into two Providers, so copying the string does not guarantee the migrated selection points to the right identity.

## 2. Provider config migration ruling

```text
old config.json
  +-- builtin:bigmodel --> bigmodel-api: migrate API Key only
  +-- builtin:zai ------> zai-api: migrate API Key only
  +-- other builtin:* --> no old Provider config imported
  +-- other confirmed account/system config --> no old Provider config imported
  `-- genuine custom Provider --> keep the established custom migration rules

current Built-in / Template + current Account data
  `--> provide built-in name, Logo, API config, models and plan facts
```

- Identify the legacy system-reserved Provider identity before `source`; `source: "custom"` must not override a built-in identity.
- The only legacy config kept for a Built-in API is a non-empty API Key. Old name, URL, Schema, Headers, management address, enabled state, model members, order, Context and other Model Rules are not migrated.
- The API Key lands in the current Personal config of `bigmodel-api` / `zai-api`, reusing the current Template creation; a required current identity or Template link is not an old-field copy, and the whole Template static config is not copied for it.
- With no API Key, create no custom copy and never write an empty Key over a valid existing value.
- Plan Token, JWT, dynamic Headers and old account state are not migrated into Personal; the current account credential chain supplies them.
- Genuine custom Providers keep migrating call config, model members/order and a legal Context Window; other model capabilities are dropped by the established rules.
- Built-in identity is never decided by display name or URL: a UUID custom Provider named "智谱" or "ZCode" must not be dropped by mistake.
- Old `config.json` stays unchanged, no backup, no `model-providers.json` fallback, no unreleased intermediate-version compatibility.

This handles the first import of the old file only. An already generated `provider_config.json` is never re-imported over nor scanned for "suspected built-in" entries to delete. **Users already wrongly migrated are repaired manually; no automatic repair code is written.** Fixing the first import must not be claimed to auto-fix such data.

## 3. How persisted model selections migrate

### 3.1 Directly mappable identities

- `builtin:bigmodel` -> `bigmodel-api`; `builtin:zai` -> `zai-api`.
- `builtin:bigmodel-start-plan` -> `account:bigmodel-start-plan`; `builtin:zai-start-plan` -> `account:zai-start-plan`.
- Genuine custom Providers keep their ID, consistent with the Provider config migration.
- The retired `builtin:zapi` with no current counterpart stays unbound; no custom Provider is created to fit.

### 3.2 Old Coding Plan lands on a concrete Provider by the current account connection at migration time

The old Coding Plan ID meant "the Coding Plan this Family currently uses", and the old selection stayed usable when switching personal/Team. Per the latest user ruling, **the current account connection at migration time is allowed**; the original personal/Team identity need not be reconstructed.

```text
old builtin:<family>-coding-plan + the account connection currently selected for the same Family in the same environment
   +-- personal --> account:<family>-individual-coding-plan
   +-- Team ------> account:<family>-team-coding-plan
   `-- undeterminable --> empty/unbound; the body data still opens
```

- `<family>` is only `bigmodel` or `zai`; never select an account across Family.
- Use the existing account-connection authority, no separate "pick Team if there is one" priority and no guessing from the first model.
- Team organization/plan identity stays with the Account connection; account credentials or Team fields never go into ModelSelection.
- This is an upgrade rule for an old dynamic identity, not a current-runtime Account-first fallback. After migrating and saving the new identity, normal restore recognizes only the new fields and does not re-interpret the old field on every account switch.
- Logged-out or unclear connection does not block history opening and adds no infinite wait-for-login barrier: the selection control is empty, re-selection is allowed, no empty-state notice.
- Never guess the old identity from Configured Default, another Family, a same-named model or any executable Provider.

After a dynamic identity converts successfully, the new Selection is fixed through the owning record's existing save entry: Session saves the current selection during this successful restore without waiting for the next send; file import fixes it when first writing the new file. An empty Reasoning does not prevent fixing a confirmed Provider/Model. Historical request identities and bulk history are not rewritten; a write must protect a selection the user updated in the meantime; a failure keeps normal storage error handling, never claims migration done, never blocks history opening and spawns no migration scheduler.

### 3.3 Current fields, model and Reasoning

- With a current ModelSelection present, current fields win and an incomplete one is not overwritten by old fields. Do not judge old vs new by field name alone: the old version may also have written `modelSelection` containing an explicit reserved old built-in ID, which still converts at the upgrade boundary using only that selection's own identity and the account context allowed here (no supplementing from neighboring old fields); an ordinary unknown ID or a Registry lookup failure is not legacy-format evidence.
- Confirmed model IDs are kept; if the target Provider does not offer the model the selection stays unbound and old built-in model members are not copied to force a fit.
- Reasoning that old fields determinably express converts in the one-way Decoder; when the new field is missing or invalid it stays empty per Todo 70, never silently picking `values[0]`, `values.at(-1)` or another level.
- Actual-call info recorded in history messages is separate from the next-execution selection; "now Team is selected" is never forged into "the historical request used Team".
- Unrecoverable model/Reasoning stays empty with no auto-replacement and no Toast, dialog or banner; a failed binding never refuses to open a whole Session or task list. Genuine execution failures keep normal error feedback.

## 4. Scope and reuse boundary

First inventory the actual old formats, then reuse a small identity-conversion function used only by migration entries (not a runtime alias table or second Registry). Entries needing account connection receive an already-resolved migration context explicitly; low-level storage never reads global UI state.

Interface: the shared migration function converts only the old Provider ID and explicitly receives the `ZCodeAccountAccess` (may be empty) resolved by the current environment's account service; it reads no disk, waits for no login and queries/scans no Registry. An ordinary current ID goes unchanged to each domain's validation; an unknown `builtin:*` returns unbound. Model-member and Reasoning validity are still judged by the owning domain against the target Registry. Account context follows the existing `resolveCurrentAccountAccess` identity and connection rules; a saved Family preference alone is not treated as a logged-in account fact.

Persistence entries audited one by one (record existing conversion, gaps and tests; not only Provider config import):

- Provider Config: fix built-in identity classification and the Built-in API Key exception.
- Account Settings: check old connection selection conversion so Coding Plan migration can get the correct current connection of the same Family.
- Session: Todo 70 owns the single Decoder, current-field precedence and unbound restore; this document supplies the identity rules, no parallel Decoder.
- Automation definitions and Runs: check old selection format; an old `provider` may mean an Agent backend and must not be used directly as a model Provider ID.
- Off-peak tasks: keep off-peak-specific Provider/credential semantics, do not mechanically migrate the execution selection to an ordinary Coding Plan; if undeterminable keep the task, selection empty, no empty-state notice, never hand an incomplete selection to model execution.
- Built-in/custom Subagent: cover explicit old selections in state files and Markdown; inheritance semantics unchanged.
- Bot Config/State: hook into Todo 69's one-time v3 import, no longer overwriting old files directly.
- Wiki, Configured Default, Recent and Drafts with a real old persisted format: check the actual Reader; a shared type does not imply auto-migration.
- Remote environments: use that environment's config and account context; never bind a historical selection with another environment's connection.

Each entry distinguishes "old-structure migration" from "current-field corruption"; when no reliable old identity exists, leave empty with no unique-model-name side path. Migration comments are in Chinese (in code), describing the old-format source, the one-time read boundary and that old data is kept for rollback, not as the current fact source.

Relation to neighbors: Todo 69 (downgrade rollback boundary, Bot file isolation, no continuous dual-write elsewhere); Todo 70 (Session upgrade Decoder and unbound restore using this identity rule); Todo 71 (current Composer Draft/Submission, does not infer old Provider identity); Todo 72 (Provider config classification, old identity conversion, entry checks).

Joint order:

```text
68 wrap-up: execution model consistent
72 base: Provider classification, API Key, old identity conversion and account context
69: Bot v3 first import hooks directly to the correct conversion
70: Session unbound restore, dynamic identity write-back
71: persistent Draft, Submission, unified empty with no notice
72 later: other-domain entry checks, joint upgrade/restart/rollback verification, report
```

Bot/Session first import must be accepted after the final identity conversion is wired; never write a new file first and rely on the forbidden old-file read-back to fix identity.

## 5. Tests and acceptance

Tests first, using a desensitized fixture shaped like the colleague's attachment (fake Keys, no original credentials or private account info).

- A built-in ID with `source: "custom"` still creates no custom plan; a genuine UUID custom Provider is unaffected.
- A Built-in API keeps only the Key and the current Template provides the rest; an empty Key does not overwrite valid config.
- After first import the old file is not rewritten; reloading does not re-import or overwrite current Personal edits.
- BigModel/Z.ai each cover personal, Team and no clear account connection; verify model identity and unbound results, not only that a provider shows on the page.
- With old/new field conflict the new field wins; with a nonexistent model or missing/invalid Reasoning the Session history and task list still open.
- An explicit old built-in identity inside a legacy `modelSelection` also converts; "has the field" is not mistaken for "migration done".
- An empty selection shows no notice and is not refilled with a default by Composer initialization or restart.
- An existing new Provider file stays unchanged, no automatic correction migration; wrongly migrated users go through manual handling.
- Each persistence entry has targeted tests, especially automation old backend fields, off-peak-specific identity, Bot v3 and Subagent explicit selections.
- Interaction E2E covers the provider list after upgrading old config, API use and opening/re-selecting an old session and continuing; old assertions conflicting with these rulings are updated.
- Rollback verifies only Todo 69's promised read scope, not re-expanded into exact recovery of all new selections.

An implementation report lists each entry's outcome, real verification commands/results, unverified items and open rulings. Determinable defects are fixed directly; identity mappings that cannot be determined naturally are discussed first, never guessed to pass. Already wrongly migrated data is manual-only.

## 6. Execution checklist (all done)

Front section (before 69 / 70): desensitize the real old config and add classification/API Key tests; fix Desktop and Standalone Provider first import (the CLI allows an empty Key in old config); complete old identity conversion and personal/Team migration context tests (domain save wiring follows per 69/70).

Back section (after 69 / 70 / 71): wire/verify the persistence entries and de-duplicate with Todo 69/70/71; verify dynamic identity is fixed at the existing write boundary and that closing then switching the account connection does not re-interpret a migrated selection; run unit tests, interaction E2E, typecheck and lint; review for runtime old-field side paths, silent replacement, cross-environment binding and residual old-file writes; produce the implementation report and commit.
