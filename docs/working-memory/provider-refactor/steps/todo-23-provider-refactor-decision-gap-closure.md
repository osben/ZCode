# 23 Provider Refactor Decision Gaps and Settings Transaction Consolidation

> Verification ownership update (2026-09-09): remaining untested/failed/manual-promoted items moved to
> [Todo102](todo-102-verification-debt-closeout.md), closing independent verification schedules here; historical
> evidence is retained and the transfer does not mean the tests passed.

> Status: Completed (automation consolidation; macOS Electron interaction re-validation proceeds with the dev chain)
>
> Date: 2026-08-27
>
> Source: reverse review after Provider Refactor completion
>
> Related tasks: [`05`](./todo-05-model-ref-retirement.md),
> [`07`](./todo-07-account-connection-selection-and-access-context-cutover.md),
> [`12`](./todo-12-model-selection-validation-boundary-cutover.md),
> [`13`](./todo-13-target-host-model-selection-authority.md),
> [`14`](./todo-14-post-refactor-mechanical-zero.md),
> [`15`](./todo-15-provider-release-validation.md),
> [`20`](./todo-20-account-overlay-atomicity-and-review-closeout.md),
> [`21`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md)

## 0. Task Positioning

Consolidates decided but incompletely implemented Provider Refactor decisions; not a new architecture rewrite. Gaps
fall into three kinds: old abstractions running under new names (e.g. `ForkModelRef`); Todo/Design declared complete
but implementation unmet (Model editing atomic save, inheritance state); decided in discussion but not entered into
official Todo/Design (public `accessId` retirement, simplified editor for normal Built-in Providers).

Target main chain:

```text
Future execution intent
    ModelSelection
          |
          v
Provider Registry + ModelFactory
          |
          v
      Active Model
          +--> Account request-period auth (account service owns current connection and credentials)
          `--> Adapter / AI SDK

Provider/Model Settings
    Host View @ revision R1
          v
      Local Draft
          v
One atomic Host Mutation
          v
Persist + Registry @ revision R2
```

### 0.1 Decisions not reopened

- `modelMatch` does a case-insensitive regex complete match against the complete Model ID; Rule authors write
  leading/trailing `.*` explicitly for containment; the Resolver does not auto-complete.
- Provider group, Provider visibility, Provider/Model enabled, Provider/Model order, Builtin-wins, five Source
  Schemas and `provider-model` specific Rules are unchanged.
- Model Config, Runtime and Protocol keep sharing `properties.input_format/output_format`.
- Local workspace uses Local Host, remote workspace uses Remote Host; Renderer does not regain configuration
  authority.
- No `ModelIdentity`, second Registry, second capability DTO set or new Config Document abstraction.

### 0.2 Non-goals

OpenRouter, OpenCode Zen, Azure, Volcano Ark, AWS Bedrock (Todo 22); Client Config global public Service refactor;
Telemetry redesign; structured Off-Peak errors; conversation queue, continuous/replayable, workspace identity or
model selection product lifecycle changes; dual-read, compat aliases or needless migrations for the unreleased
branch.

## 1. Gaps and Target States

| ID  | Gap                                                                                                                             | Target state                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| G1  | `accessId` enters Account Overlay, Provider Config, Protocol, Credential key, Request Auth and UI                               | Deleted by Todo 24; the account service resolves the current compatible connection by static family/planKind                |
| G2  | `ForkModelRef { providerId, modelId, variant }` is an isomorphic alias of the old `ModelRef`                                    | Future execution intent uses `ModelSelection` directly; `variant` exits                                                     |
| G3  | `formatModelSelection()` cannot save `maxOutputTokens`; strings still treated as a reversible domain format                     | State, protocol and persistence pass only structured `ModelSelection`; strings only at Picker/Legacy boundaries            |
| G4  | Model editing submits and closes immediately; rename and config save are two Mutations                                          | Complete Draft submitted through one atomic Host Mutation; popup closes when Registry observes success                      |
| G5  | Changing Model ID does not first move the Personal-specific Rule and re-preview Effective Config                                | Host provides a non-persistent Preview; the new ID refreshes inheritance immediately, Personal explicit values unchanged    |
| G6  | UI copies Effective values into the Personal Draft; inheritance, not-set and explicit override are confused                     | Draft separates Personal values from Effective Preview; four-state semantics observable, editable, restorable               |
| G7  | Normal Built-in Provider and Personal-only Provider reuse the complete editor                                                   | "Add Supplier" enters the simplified editor; "Create Custom Provider" keeps the complete editor                             |
| G8  | `adapterCompatibility.reasoningReplay` keeps historical model specials as a formal Config dimension                             | Delete the whole Compatibility container; all Adapters execute canonical replay only                                        |
| G9  | Adapter execution files/comments keep old Registry naming; old Todo completion claims disagree with code                        | Naming mechanically zeroed; historical Todos get correction notes; roadmap and Feature Graph synchronized                   |

## 2. Access: replaced by Todo 24

The account connection version and old Active Model invalidation design originally proposed here were revoked. The
only current Access contract is in Todo 24:

- Built-in fixes `family + planKind`; the Account Overlay projects only `enabled` and Start account model members.
- Current account, product, Team scope and dynamic credentials are managed by the account service; each request
  resolves the current compatible connection.
- No account connection ID or version is saved; account changes under the same `family + planKind` do not manually
  invalidate old Active Models.
- Local, Remote and Standalone each use their Environment's account service and fail closed before the network when
  no compatible connection exists.

## 3. ModelSelection and `ModelRef` mechanical zero

### 3.1 Fork uses standard `ModelSelection`

Public `ForkModelRef` and its `variant` are deleted:

```text
Fork / Side Chat / Before-input Fork
    Subsequent need to create Model
          v
    Save ModelSelection
    ├─ providerId
    ├─ modelId
    └─ options.reasoningLevel / maxOutputTokens (when present)
```

Historical messages carry actual provider/model/reasoning facts but no complete future choice; the consumer decides
explicitly whether it can build a Selection and may not invent another Ref/Identity type. `Model.options` is the
bound execution value and cannot be reverse-projected to a future choice.

### 3.2 Structured Selection is the only domain representation

`modelSelectionSchema` stays the sole strict Schema. Only objects may be saved or transmitted in protocol
commands/responses; Session/Task/Automation/Subagent/Repo Wiki states; Fork/Compact/Child execution intents; Host
and Agent model settings, defaults and submission parameters.

Strings are allowed only as (1) the UI Select control's Picker Value and (2) explicitly published Legacy string
reading. Helpers are named `formatModelPickerValue`, `parseModelPickerValue`, `parseLegacyModelSelectionValue` and
must not claim `parse(format(selection))` recovers a Selection with `maxOutputTokens`; callers hold the structured
Selection and never rebuild it from a Picker Value.

### 3.3 Comparison semantics

No unified `sameModelSelection()` or `ModelIdentity` helper. Each consumer compares the fields it cares about and
keeps its pre-change behavior: execution target change may compare only `providerId/modelId`; user-choice change
compares that product's saved option leaves; reasoning does not re-enter identity.

## 4. Settings: Model editing as a real manual transaction

### 4.1 Single submission contract

The popup keeps manual save. Host exposes one complete Mutation:

```ts
interface SavePersonalModelDraftInput {
  providerId: string;
  originalModelId: string;
  nextModelId: string;
  personalConfig: ModelConfigObject;
  basedOnRevision: string | number;
}
```

Names may follow existing service naming; semantics must not split. In one transaction Host: validates
Provider/Model membership, Builtin conflict, Model ID and Source Schema; on Personal rename atomically updates
`modelIds` and `modelOrder`; moves the Personal `provider-model` Rule; saves the complete sparse Personal Model
Config; persists and publishes the Registry revision; returns the observable new Host View/revision. The popup closes
only on success; validation, persistence, Registry publish or revision-conflict failures keep Draft and popup with
explicit errors; Renderer never compensates with two calls.

### 4.2 Model ID real-time Preview

```text
Original Personal Rule + Local Draft
              +--> Move exact target to nextModelId in preview state
              v
Parse Built-in Rules by nextModelId + Effective Provider api/baseURL
              v
Overlay Personal Draft's explicitly present leaves
              v
Return Effective Preview + validation issues
```

Preview is debounced after a Model ID edit; stale responses are discarded by request sequence or Draft revision.
Preview never modifies the Personal file, Provider membership, modelOrder or the formal Registry, and does not accept
Renderer API/Endpoint authority. Host re-parses and re-validates on save and never trusts Renderer Preview.

### 4.3 Draft and inheritance separation

The Renderer Draft does not copy Effective values into Personal values. Each field retains personal / inherited /
effective (`ModelFieldDraft<T> { personal: T | null | undefined; inherited: T | undefined; effective: T | undefined }`;
the generic need not exist, per-field structures are fine). Four semantics:

| Status                          | Saved facts                                  | UI                                                             |
| ------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| Upstream has value, no Personal | No Personal written                          | Low-emphasis inherited value                                   |
| Upstream no value, no Personal  | No Personal written                          | "Not set" / dash                                               |
| Personal explicit value         | Corresponding sparse leaves                  | Normal emphasis, can restore inheritance                       |
| Personal explicit clear         | `null`, only for fields permitting clear     | Explicit cleared state, not equal to not overridden            |

Numeric/text inputs use inherited values as placeholder; Boolean/Format use Toggle Chip/Selectable Tag, status
distinguished by checkmark, dash, stroke and low-interference undo, never by color alone. PDF/Audio stay hidden but
are preserved losslessly. `requiresMfjsToolSchema` is at the editor end.

### 4.4 JSON slots

Three independent JSON editors: `optionSpecs.reasoningLevel`, `optionSpecs.maxOutputTokens`, `reasoningMapping`.
Each directly replaces its Personal slot; empty content restores inheritance; no per-key merge inside an editor.
Save validates with the Provider authoritative Schema with at least formatting and field-path errors (row/column if
the editor reliably provides them). UI never copies Effective JSON into the Personal text box; Effective results use a
separate low-emphasis preview.

## 5. Settings: Built-in add vs custom create

```text
Add Supplier
└─ Select from group=standard-builtin candidates with no Personal Overlay yet
   └─ Create/enable Personal Overlay, enter simplified editor
      ├─ API Key
      └─ Model list and model config

Create Custom Provider
└─ Create incomplete group=standard-personal Provider
   └─ Enter complete editor
      ├─ Provider Name (unique)
      ├─ API Schema
      ├─ Endpoint / Headers
      ├─ API Key
      └─ Model list and model config
```

A normal Built-in Provider's API Schema, default Endpoint and identity come from Built-in Config and are not shown
as editable fields on the main path. Delete always deletes only the Personal Overlay; Built-in Config is never
deleted; a Personal-only Provider disappears when deleted. Provider ID is read-only in all UIs. The two editors may
share model list, API Key and test components but must not re-expose complete fields by reusing
`InlineEditableProviderCard`. Z.ai/BigModel Family keeps the fixed Family UI, outside both entries, with no Provider
disable operation.

## 6. Adapter compatibility deletion and naming zero

### 6.1 Reasoning replay

Canonical history replay needs no `reasoningReplay` configuration. `adapterCompatibility`, `reasoningReplay` and the
synthetic empty-thinking projection are deleted entirely:

```text
Canonical Message -> Adapter standard encoding -> Complete replay of real reasoning; no deletion, no synthetic empty thinking
```

Model Config Schema, Overlay, Resolver, Registry, Runtime, Built-in/Personal Config and test fixtures must not
accept or propagate the Compatibility container. Unpublished historical formats get no importer; old fields are
rejected by strict Schema.

### 6.2 Adapter execution naming

Adapter files carry AI SDK Model Execution assembly, not a business Registry: use accurate `model-execution.ts` /
factory naming, delete "session registry" / "provider registry cache" comments that no longer hold, keep genuinely
Adapter-private transport/factory/cache, introduce no new public abstraction by renaming, and never re-copy business
Provider/Model Config as an Adapter-queryable Registry.

## 7. Impact Brief

Capability: Provider Registry, Account Request Auth, Model Selection, Provider Settings. Change layer:
`draft-default`, `validation`, `commit-effect`, `persistence`, `presentation`. Primary seeds:
`ZhipuAccountAccessConfig`, `AccountProviderCredentialService`, `ForkModelRef`, `formatModelSelection`,
`ProviderModelMetadataDialog`. Out of scope: Provider expansion, Telemetry refactor, Conversation recovery, Client
Config public Service.

### 7.1 UI surface matrix

| Scenario                      | UI entry                                   | Draft/presentation owner                    | Default/inheritance source      | Validation and submission                                    | Authoritative owner                | Mode boundary                      |
| ----------------------------- | ------------------------------------------ | ------------------------------------------- | ------------------------------- | ------------------------------------------------------------ | ---------------------------------- | ---------------------------------- |
| Add normal Built-in Provider  | Provider Settings fixed operations         | Renderer selection state; no Provider Draft | Target Host Built-in Config     | Create Personal Overlay                                      | Target Environment Host            | Local/Remote use their own Host    |
| Create Personal-only Provider | Custom creation interface                  | Renderer creation state                     | No default API Schema           | Immediately create incomplete Provider, then auto-save       | Target Environment Host            | Same                               |
| Edit Model                    | Larger manual-save popup                   | Renderer Local Draft                        | Host Effective Preview          | One atomic Model Mutation                                    | Personal Config + Registry         | Desktop/Mobile same semantics      |
| Model selection               | Conversation/Automation/Subagent/Repo Wiki | Each product's own Draft                    | Target Host Selection View      | Each commit sink                                             | Each product state/Worker Registry | Product lifecycles not unified     |
| Account connection display    | Family/Usage/Entitlement UI                | Host projection state                       | Account Connection/Availability | Existing login/connection actions                            | Account Service                    | Does not read `accessId`           |

### 7.2 Hierarchy relations

- must-inspect: Account Connection -> Account Overlay -> Request Auth (resolve by current compatible connection
  after deleting connection ID, fail-closed when missing).
- must-inspect: Model editor -> Host Mutation -> Personal Config/Registry (step-by-step save drops Draft and gives
  non-atomic state).
- must-inspect: Fork/Protocol/Persistence -> ModelSelection (`ForkModelRef` and strings keep creating a second choice
  representation).
- should-inspect: Usage/Telemetry/Family UI -> Account status (inferred connection by `accessId` presence);
  Automation/Subagent/Repo Wiki/Conversation pickers (shared Picker Value, state and submission targets stay
  separate).
- conditional: Standalone/Remote Host Request Auth (each Environment uses its own account service).
- invariant-only: desktop continuous / mobile replayable (stream, snapshot, queue, recovery untouched); Off-Peak
  (normal ModelSelection/Registry/ModelFactory and request-period auth).

### 7.3 State owner and commit sink

| State/fact                                  | Authoritative owner                      | Mirror/cache                   | Commit sink                                       |
| ------------------------------------------- | ---------------------------------------- | ------------------------------ | ------------------------------------------------- |
| Built-in/Personal Provider and Model Config | Target Environment Host Provider Service | Renderer Host View             | Provider Config Repository + Registry publication |
| Model editing Draft                         | Current popup Renderer                   | No persistent cache            | Single Host Model Mutation                        |
| Current account connection and identity     | Account/Credential Services              | Account Provider snapshot      | Existing login, connection, logout flows          |
| Request-period credentials                  | Account Request Auth Service             | Private Credential Store/cache | Resolved per request attempt, no Config written   |
| Future model selection                      | Each product structured `ModelSelection` | Picker Value display only      | Each product's existing submission entry          |
| Current execution model                     | Agent Runtime Active Model               | No reverse editable mirror     | ModelFactory creation                             |

### 7.4 Invariants

1. Account-type Provider Config saves no credentials or account identity; API Access can still save a user-filled
   API key directly.
2. After account switch/logout an old Active Model uses only current compatible family/planKind connections, else
   fails before the network.
3. Local and Remote Environments each resolve Provider Registry, account connections and request credentials.
4. `ModelSelection` saves only explicit choice intent; default options are still resolved by ModelFactory.
5. Model editing cancel writes no config, failure keeps the popup, success publishes one final revision.
6. Built-in Models cannot be deleted, Provider IDs cannot be modified, Built-in Config is never deleted by Settings.
7. Hidden PDF/Audio and unedited Personal JSON slots are preserved losslessly.
8. No change to each model selection entry's state ownership, Queue, Recovery, Off-Peak admission or Telemetry
   design.
9. No restored ModelRef, ModelIdentity, public connection key or second Registry.
10. Cleaning old naming does not move the old Registry's config responsibility into new execution/factory
    abstractions.

Graph drift (Feature Graph declared Account Overlay publishing opaque `accessId`; Todo 05/21 held completion claims
inconsistent with the code) was synchronized with this Todo and Todo 24: Design Tree Account Access, Request Auth,
Model Selection, Settings and Registry docs; Feature Graph nodes and invariants; corrective notes or superseded links
for Todo 05, 07, 12–14, 20, 21; Todo 00 roadmap. Synchronization never elevates implementation trade-offs into
design.

## 8. Acceptance

### 8.1 Config, Account, Request Auth

- Zhipu Account Access Schema does not accept, serialize or require `accessId`.
- Account Overlay publishes only enabled and Start account model members.
- Individual/Start/Team each obtain correct credentials from the current account service.
- Switching accounts under the same Family/Plan re-resolves old Model credentials by the current compatible
  connection.
- Credential refresh does not hot-change a Model's Endpoint, API type, Properties or Model Selection.
- Credential Store/in-flight cache is not shared across accounts, Providers or Team scopes.
- UI, Usage and Telemetry do not infer account connections from access strings.
- Local, Remote, Standalone and Off-Peak use their own Environment account facts.

### 8.2 ModelSelection

- `modelSelectionSchema` fully accepts and preserves `reasoningLevel/maxOutputTokens`.
- Fork/Side Chat/Before-input Fork produce no `variant` or Ref alias.
- Picker Value does not override the caller's complete Selection options.
- Legacy strings are parsed only at explicit importer/codec boundaries.
- Conversation, Automation, Subagent, Repo Wiki comparison and submission semantics are unchanged.
- Config default changes are not reverse-solidified into historical Selection.

### 8.3 Settings transaction and Preview

- Open, edit, cancel/X/Esc write no config.
- Save produces one Host Mutation and one final Registry revision.
- Rename updates Personal membership, modelOrder and exact Rule together.
- Save failure, revision conflict and Registry publish failure keep popup and Draft.
- Changing Model ID first moves the Preview Rule, then parses the new Built-in default; Personal explicit values stay.
- A stale Preview response does not override the latest Model ID.
- Four-state round-trip (upstream value, upstream no value, Personal override, explicit clear).
- PDF/Audio and unedited JSON slots preserved losslessly.
- Three JSON editors replace independently; empty content restores inheritance; invalid content blocks save.
- `requiresMfjsToolSchema` is at the end.

### 8.4 Provider Settings

- "Add Supplier" lists only un-added normal `standard-builtin` candidates and then shows the simplified API Key +
  Model edit path.
- "Create Custom Provider" creates an incomplete `standard-personal` Provider with the complete editor.
- Deleting any Provider deletes only the Personal Overlay; Built-in Config unchanged.
- Family UI, normal ordering, Provider ID, Built-in Model delete permissions and model enabled behavior are
  unchanged.
- Desktop/Web/Mobile, Zai Light/Zai Dark, keyboard, touch and Chinese/English regressions pass.

### 8.5 Mechanical zero

```text
Production public chain accessId                         = 0
ForkModelRef / public isomorphic ModelRef alias          = 0
reasoning identity variant                               = 0
Selection string serialization in current write paths    = 0
Step-by-step submission of Model editing (rename then save) = 0
adapterCompatibility / reasoningReplay                   = 0
Old Adapter Registry naming and erroneous comments       = 0
```

Allowed search hits are listed individually in completion records (third-party fields, explicit Legacy read-only
boundaries, historical doc references); broad allowlists may not cover production residues. Final execution: related
Provider, Services, Shared, Core, Bootstrap, UI unit tests; `pnpm typecheck`; `pnpm lint`; `pnpm fmt:check`;
affected Desktop E2E and Local/Remote Host Provider Settings/Selection regression; `pnpm knip` and targeted `rg`
mechanical-zero checks; when necessary `pnpm test:unit:affected` and `pnpm verify:pre-push`.

## 9. Completion Definition

Marked Completed only when: G1–G9 code, tests and mechanical-zero gates are complete; `accessId` has not re-entered
Provider Config, Model, Protocol, UI or the public Credential contract under new names; account switch, logout,
credential refresh and Remote/Standalone requests have current-connection resolution and fail-closed-on-missing
evidence; Fork, Picker, Protocol and Persistence have no second ModelSelection representation; Model editing save is
one Host Mutation, failure keeps Draft, Preview persists nothing; the Built-in simplified editor and the Personal-only
complete editor split by group; Design Tree, Feature Graph, roadmap and related old Todos match the implementation;
required tests, typecheck, Lint, format check, affected E2E and residue checks pass.

## 10. Implementation Record (2026-08-27)

- ModelSelection uniformly preserves structured `providerId/modelId/options`; Fork, Side Chat, Automation, Subagent
  and Persistence keep no Ref aliases or reasoning identity variants.
- Model editing save is one Host Mutation with `basedOnRevision`; rename, membership, order and the exact Personal
  Rule are atomic; Preview returns only inherited and Effective values.
- Personal Model Draft is a truly sparse Overlay: untouched leaves not written, PDF/Audio and JSON slots lossless;
  "restore all defaults" uses the new inheritance results of the current model ID as baseline.
- Provider/Model settings simplification, ordering and popup interactions are complete; continuous Provider ordering
  uses a UI optimistic projection, and an Environment owner change discards the old pending state (no second config
  fact).
- `adapterCompatibility`, `reasoningReplay`, synthetic empty-thinking and related fixtures/helpers are deleted from
  the current production chain.
- Access slice was completed by Todo 24, ZAPI retirement by Todo 25.

Follow-up from a later reverse review: Host Preview and atomic Model Draft save are complete per this Todo; stable
group priority of Personal Match/Exact Rules and mechanical normalization of the Resolver and write-side three-segment
order helpers are taken by [`Todo 28`](./todo-28-model-rule-precedence-and-order-canonicalization.md).

Verification: root `pnpm typecheck` passed; root `pnpm lint` 0 errors (34 pre-existing warnings); model settings
directed tests 235/235, UI/Services contract tests 47/47, CLI Provider/Adapter/Bootstrap directed tests 228/228;
root full unit 12,438/12,440 (the 2 failures are Windows ZIP cases from a missing system `zip`, 17/17 on rerun with
an isolated compatible command); 216 changed files passed directed format check after `oxfmt` (root `fmt:check` is
still blocked by pre-existing binary files and Electron upstream example HTML parse errors); root `knip` reports only
the pre-existing workspace-wide baseline with no new Access/Credential/UI-split symbols; production code search
confirms `ForkModelRef`, `adapterCompatibility`, `reasoningReplay`, `anthropic-empty-thinking` and the old Access
Type are all zero.
