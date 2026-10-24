# M2 Provider Config / Registry Impact Brief

> Status: Historical implementation contract
>
> Scope: Impact assessment, boundaries, and test handoff when M2's first pure domain slice began work.
> This document preserves the planning evidence from that time; "this batch", "subsequent integration", and open items in the body do not represent M2's current state.
> Current implementation status is in [`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md), remaining retirement items are in
> [`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md), and current design is in
> [`../design/registry/registry.md`](../design/registry/registry.md).
>
> Full history: git show 4353b0eaacff170f5219feda4d7462e560ed450b:docs/working-memory/provider-refactor/steps/02-provider-config-and-registry-impact.md

## Feature Summary

| Field            | Value                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Developer intent | Establish a Provider Config parsing and Registry domain core reusable by Host, Worker, Prompt CLI, and TUI         |
| Capability       | Provider registry, model capabilities, model selection option source                                               |
| Change layer     | option-source, validation, persistence boundary                                                                    |
| Operating mode   | planning                                                                                                           |
| Primary seeds    | `IModelProviderService`, `ModelProviderConfig`, `ModelConfigSelect`, Workspace Model Catalog, M1 `Model` contract  |
| Out of scope     | UI changes, physical config storage, watcher, account network requests, Submission, Adapter, remote sync migration |

## UI Surface Matrix

This batch does not integrate with UI. The table below records the consumption boundaries that subsequent integration must maintain.

| User scenario | UI entry                                          | Shared implementation                                    | Display/draft owner      | Default/inherit source                       | Validation/gating                        | Commit action                            | Authority/persistence              | Mode boundary                       | Must remain isolated from                   |
| ------------- | ------------------------------------------------- | -------------------------------------------------------- | ------------------------ | -------------------------------------------- | ---------------------------------------- | ---------------------------------------- | ---------------------------------- | ----------------------------------- | ------------------------------------------- |
| Edit Provider | Model Provider Settings                           | ProviderConfigResolver; future Settings Facade           | Settings page draft      | Official + Personal + draft overlay          | Resolver issues                          | Future Config Service save               | Personal Provider Config           | Host's Environment                  | Model selection state, active Agent Loop    |
| Select model  | Conversation/Automation/Subagent/Repo Wiki picker | Registry View; each Surface organizes its own candidates | Each Surface's own draft | Each Surface's own default/inheritance rules | Registry only provides selectable models | Each Surface's original submission chain | Each Surface's own Selection owner | local/remote Registry independently | Other Surface's draft and commit sink       |
| Execute model | Core Worker / Prompt CLI / TUI                    | Registry lookup; future ModelFactory                     | Agent Loop               | Submission/Session ModelSelection            | Registry Selection validation            | Create Model                             | Worker's Environment Registry      | Worker does not depend on Renderer  | Host draft, App Recent, settings page state |

## Shared And Divergent Behavior

| Concern              | Shared across surfaces                             | Deliberately different                                                                       | Why it matters                                                                 |
| -------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Option source        | ProviderConfigResolver and Registry View           | Settings page also needs invalid items and explicit Personal values                          | Registry must not retain grayed-out unavailable models for the settings page    |
| Validation           | Schema, three-layer Overlay, and integrity check   | accessId authentication, quotas, and network errors are still handled by the execution chain | Registry does not handle account permission judgment                           |
| Commit effect        | None                                               | Settings save, model selection, and Agent execution each retain their own owner              | Shared parsing must not unify different product semantics                      |
| Persistence/recovery | Config type and normal Object serialization format | Physical file, remote service, cache, and watcher are determined by the Source Service       | Pure domain package does not own IO                                            |

## Feature Relationships

| Rank           | From                    | Semantic edge           | To                           | Condition                            | Why inspect it                                              | Evidence                                                               |
| -------------- | ----------------------- | ----------------------- | ---------------------------- | ------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| must-inspect   | Provider Config         | resolves-through        | ProviderConfigResolver       | All entry points                     | Avoid Host and Worker each writing their own Overlay/filter | Working Memory registry design; `packages/services/src/model-provider` |
| must-inspect   | ProviderConfigResolver  | publishes-valid-view-to | ProviderRegistry             | Static facts complete and selectable | Registry only contains bindable candidates                  | `design/registry/registry.md`                                          |
| should-inspect | ProviderRegistry        | options-from            | Each model selection Surface | Subsequent UI integration            | Shared candidate source but not shared draft/commit         | feature graph `capability.model-selection`                             |
| conditional    | ProviderRegistry        | creates-model-through   | ModelFactory                 | Starting from M2.4                   | This batch does not create execution Model                  | `design/registry/model-creation.md`                                    |
| invariant-only | Registry update         | must-not-mutate         | Created Model / active Loop  | All processes                        | New config only affects Models created subsequently         | `design/registry/runtime.md`                                           |
| invariant-only | Provider domain package | must-not-own            | file/network/account runtime | All modes                            | Keep the domain core without IO, independently testable     | User-confirmed M2 boundary                                             |

## State Owners And Commit Sinks

| State/fact                      | Draft/display owner   | Authoritative owner                | Commit command/service   | Persistence/cache                                  | Evidence                          |
| ------------------------------- | --------------------- | ---------------------------------- | ------------------------ | -------------------------------------------------- | --------------------------------- |
| Official/Personal Config Object | Source Service        | Config Source of the Environment   | Future Config Service    | Current v2 config / management service; M5 details | M2 design                         |
| Account Provider Access         | Account Service       | Current account/entitlement Source | Account refresh chain    | Source's own cache                                 | M2 design; plan entitlement graph |
| Effective Provider resolution   | Resolver return value | Reconstructible derived facts      | None                     | Not persisted                                      | M2 design                         |
| Registry View / index           | In-process Registry   | Current Registry instance          | `replace()`              | Memory only                                        | M2 runtime design                 |
| Surface draft / Selection       | Each product Surface  | Own state owner                    | Original command/service | Own persistence                                     | feature graph surface edges       |

## Must-Preserve Invariants

| Invariant                                                                                                | Surfaces/modes                | Proof needed                  | Evidence                                    |
| -------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------- | ------------------------------------------- |
| Official key retains Official order; Personal-only keys appended in Personal order                       | Config, Settings, Registry    | Overlay unit tests            | configuration design                        |
| Nested ConfigOverlay recursive override, normal fields fully replaced, input not modified                | All consumers                 | Unit tests                    | configuration design                        |
| Account Source only produces third-layer ProviderConfig for account kind; API Provider has no such layer | Host/Worker/CLI/TUI           | Resolver unit tests           | registry design                             |
| Registry only publishes complete, enabled, statically selectable models                                  | Model selection and execution | Resolver/Registry unit tests  | Confirmed product conclusions               |
| Registry replacing View does not change the old View/Model already held by callers                       | Active Loop                   | Immutable snapshot unit tests | runtime design                              |
| This batch's code does not read/write files, make network requests, or depend on UI/Services/SDK         | All processes                 | Package dependency review     | User-confirmed pure domain package boundary |

## Boundary Decisions

| Boundary              | Decision                                          | Includes                                             | Excludes / prunes                                               | Source      |
| --------------------- | ------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- | ----------- |
| M2-A                  | Config + Resolver + Memory Registry               | schema, overlay, order, filter, issues, index, event | storage, watcher, account request, UI, ModelFactory              | user/design |
| Registry availability | Only contains fully configured and enabled models | complete, enabled, three-layer Provider Config       | accessId authentication, network health, quota, transient token  | user/design |
| View ownership        | Registry atomic replace immutable View            | New queries use new View                             | Modify old View / active Model                                   | user/design |
| Serialization form    | JSON/RPC normal Object; parsed after ConfigOverlay Class + ordered Map | wire and runtime representation | re-parsing per consumer                                          | user clarification |

## Accepted Cases

| Case ID          | Setup                                                      | Action                 | Assertions                                                                              | Evidence layers  | E2E status |
| ---------------- | ---------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------- | ---------------- | ---------- |
| M2A-OVERLAY-01   | Official `[A,B,C]`, Personal `[Y,C',X,A']`                 | overlay                | Result `[A',B,C',Y,X]`; input unchanged                                                 | unit             | not-needed |
| M2A-OVERLAY-02   | Nested Properties + normal array/Record                    | overlay                | Nested Config field-by-field inheritance; array/Record fully replaced                   | unit             | not-needed |
| M2A-MODEL-01     | Official/Personal multiple regex rules                     | resolve model          | Full-string match; later-matched rule overrides earlier rule                            | unit             | not-needed |
| M2A-ACCESS-01    | API and Account Provider both exist                        | overlay Account Config | Only fill in Account Provider's accessId/models; API unchanged                          | unit             | not-needed |
| M2A-VALID-01     | Incomplete, disabled, complete Provider/model              | resolve                | Registry View only contains complete enabled items; issues retained for Resolver result | unit             | not-needed |
| M2A-REGISTRY-01  | Registry already holds v1                                  | replace v2             | revision/event updated; old v1 snapshot remains unchanged                               | unit             | not-needed |
| M2A-SELECTION-01 | provider/model exists or missing                           | validate               | Returns stable success/error result                                                     | unit             | not-needed |
| M2B-SOURCE-01    | Config/Account Source both have current snapshot           | service start          | Subscribe first, then read; publish one complete Registry Snapshot                      | unit             | not-needed |
| M2B-REFRESH-01   | Source updates to v2 while reading v1                      | source invalidation    | Discard outdated generation, only publish v2                                            | unit             | not-needed |
| M2B-REFRESH-02   | Two Source revisions both unchanged                        | repeated invalidation  | Do not rebuild View, do not increase Registry revision                                  | unit             | not-needed |
| M2B-FAILURE-01   | v1 published, next Source read fails                       | source invalidation    | v1 remains available; report refresh error; subsequent success can recover to v2        | unit             | not-needed |
| M2C-SETTINGS-01  | Official, Personal, invalid, and Account filtered items    | project settings       | Returns Personal explicit value, Effective value, issues, and reorderable flag          | unit             | not-needed |
| M2C-SELECTION-01 | Settings still contains non-publishable items              | project selection      | Selection View only contains Provider/Model published by Registry                       | unit             | not-needed |
| M2D-CONFIG-01    | Official or Personal Source updates                        | config source event    | Config Service notifies Registry to read latest snapshots from two paths                | unit             | not-needed |
| M2D-CONFIG-02    | Settings save, delete, or reorder Personal config          | repository update      | Only modify Personal layer within Repository's atomic boundary                          | unit             | not-needed |
| M2D-CONFIG-03    | Save exact Provider/Model ID with regex meta characters    | settings model save    | Exact rule escaping; does not unexpectedly match other IDs                              | unit             | not-needed |
| M2E-MIGRATE-01   | New Personal Config file does not exist, old config exists | repository read        | One-way import, validate, and atomically write current schemaVersion file               | unit/integration | not-needed |
| M2E-MIGRATE-02   | Personal Config is a supported old schemaVersion           | repository read        | Migrate step by step through adjacent versions and write back to latest version         | unit             | not-needed |
| M2E-MIGRATE-03   | File version is higher than current program support range  | repository read        | Report error and do not overwrite original file                                         | unit             | not-needed |
| M2E-MIGRATE-04   | Old config conversion or new file atomic write fails       | repository read        | Report error and keep old file; do not publish half-migrated Snapshot                   | integration      | not-needed |

## Formerly Open Questions

Both questions from planning are resolved: `reasoningMapping`'s final Schema follows
[`02-provider-config-and-registry-human-in-the-loop.md`](./02-provider-config-and-registry-human-in-the-loop.md) items 11–12, and the Source failure publication strategy (Last-known-good) is item 2 of the same document.
