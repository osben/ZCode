# Todo 69: Practical Rollback Compatibility for the Provider Refactor

> Database-scope ruling (2026-09-10): later work follows [Todo109](./todo-109-database-migration-consolidation-and-rollback-readability.md); the old baseline is fixed at staging_backup@790884b1ce. Avoid dual writes where possible, but after a rollback a single task/message/session whose content cannot be opened needs minimal necessary compatibility writes; lost config can be re-selected. All related database migrations are consolidated, original old fields/values are kept, and the new version reads normally without re-migrating. This document's "never dual-write" and its tolerance of some unreadable content no longer constrain that database work; historical evidence and non-database rulings stay.

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.

> Status: implementation and phase acceptance done (2026-09-03); no full old-App rollback was run, evidence scope is in the implementation report.
>
> This document replaces the earlier multi-domain continuous dual-write plan.
>
> Review baseline: branch `eb8b9deee500` plus working tree; the rollback target is only `origin/staging@6e781fdd9029`.
>
> Later ruling (2026-09-09): old fields must not be deleted or cleared because of new-selection wiring. The Off-Peak edit and the Wiki save keep old values; continuous reverse dual-write is not required. Session was ruled to add `modelSelection` to the original entry.data and keep the old identity/level fields. Subagent Markdown follows the readability trade-off and user-directory in-place field migration already ruled in [Todo97](./todo-97-subagent-markdown-in-place-migration-and-legacy-read-audit.md); listing it earlier as a re-review item was a mistake and is withdrawn. See [Todo104 §6.18](./todo-104-pre-release-schema-review.md) (m2, formerly Todo99). These are pending additions; they do not change this document's verified facts about the frozen Reader and do not restore Bot original-file writing.

## 1. Goal and final ruling

After rolling back to the staging version, the old App starts and the main pre-upgrade data still opens. Individual messages, tasks and model selections created or changed by the new version may degrade; the old version need not understand the current Provider architecture.

Only critical compatibility problems that make a whole file, collection or the App unreadable are handled; no large amount of old code is maintained for the semantic loss of one new-version record.

```text
data written by the current version
        |
        v
staging's real Reader
        +-- can ignore new fields / columns / files  --> no compatibility write
        +-- affects only individual new messages/tasks --> accept the listed degradation, no compatibility write
        `-- one new record makes a whole file or collection rejected --> fix the physical compatibility boundary
```

Final scope:

- Provider Config, Session, Off-Peak, Automation, Account Settings, Subagent and Repo Wiki do not continuously dual-write old fields.
- SQLite keeps additive nullable schema changes with no destructive downgrade.
- **Bot Config and State are the only confirmed whole-domain failure risk and use file-version isolation, not continuous dual-write.**
- Model/Reasoning follow their owning record; no generic old-version Encoder, compatibility DTO or second model fact.
- One-way upgrade reads of old data in the current version stay; dropping downgrade dual-write does not remove upgrade Importers.

## 2. Verified read boundaries

The current Writers were compared with the frozen staging commit's file names, strict Schemas, null handling, list parsing and failure scope. This is code fact.

| Domain             | Real staging read behavior                                                      | Accepted rollback degradation                              | Ruling              |
| ------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------- |
| Provider Config    | reads old `config.json`; current writes only new `provider_config.json`         | pre-upgrade config; new Provider/Template edits invisible  | no dual-write       |
| Session            | knows `runtime/model_selection`; message, Part, Entry are lenient JSON reads    | new model metadata, Reasoning or some new messages degrade | no dual-write       |
| Off-Peak           | old `model/thought_level` nullable; extra columns harmless                      | new tasks may use staging's default model                  | no dual-write       |
| Automation         | old `model/provider/thought_level` nullable; extra columns harmless             | new tasks and Runs cannot keep the new frozen selection    | no dual-write       |
| Account Settings   | non-strict Schema, ignores new fields, empty defaults for missing old fields    | account connection or plan selection may need re-choosing  | no dual-write       |
| Custom Subagent    | Frontmatter reads known fields only; new `modelSelection` does not reject file  | explicit model selection degrades to inherit/default       | no dual-write       |
| Built-in Subagent state | lenient field picking, ignores new model override fields                   | model override lost; `disabledAgentIds` kept               | no dual-write       |
| Repo Wiki          | old and new Readers parse JSON leniently                                        | Wiki readable; regeneration may need model re-selection    | no dual-write       |
| Bot Config/State   | same-file old and new Options both strict, field sets mutually incompatible     | whole Bot config/state rejected is unacceptable            | versioned file isolation |
| Model/Reasoning    | no independent persistence medium                                               | follows owning domain                                      | no generic layer    |

This proves the Provider-refactor fields are not rejected domain-wide by old Readers; it is not a full old-App startup, display and execution acceptance. Records must distinguish static review, targeted tests and real rollback evidence.

### 2.1 Provider Config

The formal file is `provider_config.json`. Old `config.json` is a one-time upgrade input only; the Repository neither rewrites it nor creates a backup (pinned by the `packages/services/test/providerConfigRuntime.test.ts` test "imports old config.json into the same-directory provider_config.json, no rewrite and no backup"). After rolling back to staging the pre-upgrade config applies; new Template instances, Providers and Personal Model Rules are not synced back. Never restore a dual Provider config authority because some new models cannot run after rollback.

### 2.2 Session

Frozen staging defines `runtime/model_selection`; the Session Store `JSON.parse`s `message.data`, `part.data` and `session_entry.data` and reads by consumption path, with no strict mutually exclusive Schema. Session Selection's Provider/Model identity fields stay readable; the current `options.reasoningLevel` may be ignored. New model metadata on User/Assistant/Timeline/Subtask may not be understood by old display or execution, but this does not imply the database or session list is unreadable.

No rollback aliases are added: User Message old `model.providerID/modelID/variant`; Assistant Message old `providerID/modelID/variant`; Timeline/Subtask old Selection fields; Session Entry old `thoughtLevel`. Reading old Sessions, detecting invalid selections and keeping history openable in the current version belong to Todo 70.

### 2.3 Off-Peak

`off_peak_tasks` gained a nullable `model_selection` and keeps old columns. Creation writes `model_selection` = the complete ModelSelection, `model` = NULL, `thought_level` = NULL. Frozen staging's Row type and `rowToTask()` accept null old columns (mapped to `undefined`), so new rows do not break `list()`. Staging dispatch uses old model fields only when present, else its own default logic; after rollback a new task may not use the exact Provider/Model/Reasoning (accepted; no dual-write of `model/thought_level`).

Direction note: a legacy row lacking the current `model_selection` failing in the **current** version is an upgrade Decoder/recovery tolerance problem, not a reason for reverse dual-writes.

### 2.4 Automation

`automations` keeps nullable old columns and adds nullable `model_selection`; new tasks have null old `model/provider/thought_level`. The staging Reader null-maps these and can load the list. After rollback new tasks may use the staging default model, and `automation_runs.model_selection` cannot be understood exactly by the old version. No reverse mapping from the current Registry Provider ID to the old Agent Provider enum and no dual-write of old model columns.

### 2.5 Account Settings

Current field `providerFamilyConnectionSelections`; staging uses `modelProviderFamilyModes/modelProviderFamilySelectedKeys`. The staging Settings Schema is non-strict, ignores new fields and defaults missing old fields to empty objects, so Settings load. Users may need to re-select the account connection; staging saves may drop unknown new fields, requiring re-selection after re-upgrade. This is a rebuildable settings degradation; no continuous reverse projection of Family selection.

### 2.6 Subagent

The staging Markdown Parser reads known Frontmatter fields only, ignores `modelSelection` and does not reject the Agent; model selection degrades to inherit/default. `agents-state.json` is parsed leniently:

```text
staging                              current
builtInModelOverrides                builtInModelSelectionOverrides
builtInThoughtLevelOverrides
disabledAgentIds                     disabledAgentIds
```

Built-in Agent disable state stays readable; current model overrides are ignored by staging without losing the Agent set. Neither store dual-writes old model fields.

### 2.7 Repo Wiki

`repoWikiStorage.ts` parses Wiki and Draft with lenient `JSON.parse`. After rollback the Wiki body stays readable; if `modelSelection` is unrecognized, regeneration may use the old default or require re-selection. No reverse generation of `generationModel/generationOptions.thoughtLevel`.

### 2.8 Bot: the confirmed hard exception

Current and staging both use `bot-config.json` and `bot-state.v2.json`, but `botCurrentOptionsSchema/botDraftOptionsSchema` are `.strict()`: staging Options `model / thoughtLevel` vs current `modelSelection`. Once the current version writes the new structure into the same file, staging rejects it for the unknown `modelSelection`; its Repository then falls back Bot Config to empty and Bot State to the legacy file or empty. That hits the whole Bot data. Writing old and new fields together does not work (staging rejects new fields, the current strict Schema rejects old fields), so the physical files are isolated.

Verified: the Bot Model Cache Repository is already removed and `bots-model-cache.v2.json` is no longer written; the old cache stays untouched and staging can keep using it.

## 3. Bot minimal design

```text
pre-upgrade files (never rewritten)
├─ bot-config.json
└─ bot-state.v2.json
        | one-way import when the matching v3 file does not exist
        v
current-version files
├─ bot-config.v3.json
└─ bot-state.v3.json   <- sole authority read/written by the current Repository

rollback staging: keeps reading the pre-upgrade files, never touches v3
```

1. Both Config and State are version-isolated (not State only).
2. File name and content version rise to v3 together.
3. If the matching v3 file does not exist, read the old file, reuse the one-way conversion, write v3; the old file is neither rewritten nor deleted.
4. Once v3 exists, never fill, repair or overwrite current data from the old file; a corrupt current file never silently falls back to stale config.
5. No old file: start from an empty v3, no fake old-version copy.
6. Creating, editing, deleting a Bot and updating Draft/State write v3 only.
7. Determinable old model fields convert to the current ModelSelection; undeterminable selections stay empty, the Bot body is kept, no Provider guessing.
8. Reuse the existing file-write and Repository boundaries; no two-file distributed transaction or generic dual-write scheduler.

"Reuse the one-way conversion" does not mean calling `bots/storageMigration.ts` as-is: `findUniqueProviderByModel` looks for other Providers by model name when the old Provider does not match, and `migrateDraftOptions` lets old `thoughtLevel` override an existing new `modelSelection.options.reasoningLevel`. Both are removed/fixed before wiring v3 and replaced by Todo 72's explicit identity conversion: an existing new selection trusts only its own fields, and an undeterminable one is left empty with no rerouting by model name.

The old files are a pre-upgrade snapshot, not a synced copy: after rollback users see the pre-upgrade Bot config and state; Bots added/removed/changed during the new version are not guaranteed to appear (accepted product boundary). A first import may complete the not-yet-generated v3 file on the next startup; it must not become continuous write-back on every save. Each file keeps the existing safe-write mechanism and failures are never disguised as success.

Import context is assembled by the service layer: an ordinary Bot default config uses the owning Host's models and current login connection; legacy state with `workspaceIdentity` may use only that remote's model facts (never the local account to interpret an old Coding Plan). If the remote is unreachable or has no obtainable account context, unconfirmable bindings are left empty and the body imports normally. Parse/IO errors in the new file surface to the caller, never read back the old file, and never rewrite a corrupt file as empty.

## 4. Scope constraints and neighbor Todos

Production changes target only Bot Config/State file isolation and its one-way upgrade entry. Other domains keep the current one-way upgrade read and add no downgrade writes.

Forbidden: Provider Config reverse sync; Session, Off-Peak, Automation, Settings, Subagent, Repo Wiki continuously writing old aliases; silently remapping Reasoning levels or guessing the old Agent Provider for compatibility; a generic old-version Selection Encoder, compatibility DTO or second Config/Registry authority; whole-database copies and destructive SQLite downgrade migration; the current version continuously reading frozen old files to repair current data.

```text
Todo 69: current -> staging downgrade rollback
         prevent whole-domain rejection by old Readers; current hard point: Bot file isolation
Todo 70: old Session -> current upgrade recovery
         old/new field decisions, reliable migration, invalid Selection, history openability
Todo 71: Composer -> Submission inside the current version
         persistent draft and submission state, no cross-version field dual-write
Todo 72: old Provider config and persisted selection -> current identity
         fix built-in classification, migrate Built-in API Key only, convert old Coding Plan identity by current connection at migration time
```

Upgrade identity rules are in [Todo 72](./todo-72-legacy-builtin-provider-and-model-selection-migration.md) (including the identity conversion for the one-time Bot import). Cutting the dual-write scope does not retract the confirmed upgrade principles: when the current structure exists, never fill from old fields; true legacy records may use a deterministic Decoder; unrecoverable ones are reported or handed to the user per owning domain. No change to Provider/Model Registry, Account Family, queues, Selection lifecycle or any execution chain. Local and remote Bot calls keep going through the same Repository; no old-file side path in the Remote/Bot Bridge.

## 5. Tests and acceptance

### 5.1 Bot (test first)

- With representative frozen staging Config/State as input, show the same-file strict conflict before import.
- First start generates v3; main Bot data and determinable Selections convert correctly.
- After creating, editing, deleting a Bot and updating Draft/State in the current version, both old files are byte-identical.
- With v3 present, never fill from the old file; v3 reads/writes satisfy the current strict Schema.
- With only one of Config/State generated, the next start imports only the missing one without overwriting.
- One old Bot whose Selection cannot convert does not break other Bots or drop its body config.
- A same-named model offered only by another Provider is not used to migrate the old selection; when the current Selection conflicts with old thoughtLevel the current value stays.
- The frozen staging strict Reader reads the preserved old files and gets pre-upgrade Bot data.
- With the old file absent, an empty current config is created without an old copy.

Only the necessary current-staging read contract is pinned; no multi-version compatibility framework, no restoration of new-version Bot changes.

### 5.2 Other domains (minimal)

Reuse the Provider Config test to show old `config.json` unchanged; use staging's Off-Peak/Automation Row Reader to read representative new rows with null old model columns (no need to obtain the exact new selection); confirm new SQLite columns are nullable and ignorable with no destructive deletion; for Session, Settings, Subagent and Wiki verify with representative new fields that old read entries are not rejected domain-wide (reuse existing tests, add only missing evidence). No "all old/new model values semantically equivalent" test.

### 5.3 Full checks

Targeted Bot, Services and storage-adapter tests; `pnpm typecheck`; `pnpm lint`; changed-file format check and `git diff --check`; a temp-directory rollback smoke "current version imports and edits Bot -> staging Reader reads the frozen old files". Never run destructive rollback tests on a user's real directory, Bot account or live database. Without a real old-App run the record may only say the Reader/storage smoke passed, not claim full-chain acceptance.

## 6. Order and completion

Order: verify the frozen staging target and add failing Bot tests; hook up Todo 72's tested old Provider identity conversion, then implement the two v3 files' Schema, paths and one-time Import; close all current Bot read/write entries and confirm old files unchanged; minimal regression of other domains (no continuous dual-write); update implementation record, allowed degradations and results and commit. The identity-conversion base of Todo 72 precedes Bot first-import acceptance; do not generate a wrong-identity v3 and patch later, and the boundary "once v3 exists never read the old file" holds.

Completion:

- Bot's only authority is v3; pre-upgrade files stay unchanged; staging no longer rejects the whole Bot data over new fields.
- Beyond Bot version isolation, no continuous dual-write or generic compatibility abstraction.
- Current one-way upgrade reads were not removed by the narrowed rollback scope; SQLite physical structure stays additively compatible.
- All allowed single-record / rebuildable-setting degradations are listed here.
- Targeted tests, types, lint, format and diff checks pass; real-device status is recorded truthfully.

## 7. Code evidence index

Paths are relative to the frozen commit; later refactors shifting lines do not change the read contract.

| Domain     | Main evidence paths                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider   | `packages/services/src/model-provider/providerConfigRuntime.ts`; `packages/services/test/providerConfigRuntime.test.ts`                                          |
| Session    | `apps/zcode-cli/packages/adapters/src/storage/session-store/codecs.ts`; `apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`                 |
| Off-Peak   | `packages/services/src/session/offPeakTaskRepo.ts` (Schema, create, rowToTask/list)                                                                               |
| Automation | `packages/services/src/session/automationRepo.ts` (Schema, create, rowToAutomation/list)                                                                         |
| Settings   | `packages/shared/src/validationAppSettings.ts`                                                                                                                   |
| Subagent   | `packages/services/src/subagents/subagentMarkdown.ts`; `packages/services/src/subagents/subagentsService.ts`                                                     |
| Wiki       | `packages/services/src/repo-wiki/repoWikiStorage.ts`                                                                                                             |
| Bot        | `packages/shared/src/bots.ts`; `packages/services/src/bots/config.ts`; `packages/services/src/bots/repo.ts`; `packages/services/src/bots/storageMigration.ts`    |

Implementation evidence: [68-72 implementation report](./68-72-implementation-report.md). Bot v3, the one-time import and old-file preservation are implemented; the running Service no longer rewrites old state. Rollback acceptance is the strict-read / file-byte boundary, not a full old-App real-device acceptance.
