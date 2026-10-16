# 23 Provider Refactor Decision Gaps and Settings Transaction Consolidation

> Verification ownership update (2026-09-09): Remaining untested/failed/manual-promoted items uniformly transferred to [Todo102](todo-102-verification-debt-closeout.md), closing independent verification schedules in this document; historical evidence retained, transfer does not represent test passing.

> Status: Completed (automation consolidation; macOS Electron interaction re-validation proceeds with dev chain)
>
> Date: 2026-08-27
>
> Source: Post-Provider Refactor completion reverse review
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

This Todo consolidates already-decided but incompletely implemented Provider Refactor decisions. It is not a new round of architecture rewriting, nor does it re-discuss already correctly
implemented Provider group, Model enabled, Builtin-wins, Provider/Model order, specific Rules, Access protocol, or Host authoritative source.

Issues found by this review are divided into three categories:

1. Old abstractions still running under new names, e.g., `ForkModelRef`;
2. Todo/Design declared complete, but implementation did not meet requirements, e.g., Model editing atomic save and inheritance state;
3. Already decided in discussion, but not entered into official Todo/Design, e.g., public `accessId` retirement and normal Built-in Provider simplified editor.

After goals are complete, the main chain must re-satisfy:

```text
Future execution intent
    ModelSelection
          |
          v
Provider Registry + ModelFactory
          |
          v
      Active Model
          |
          +--> Account request-period auth (account service owns current connection and credentials)
          `--> Adapter / AI SDK

Provider/Model Settings
    Host View @ revision R1
          |
          v
      Local Draft
          |
          v
One atomic Host Mutation
          |
          v
Persist + Registry @ revision R2
```

### 0.1 Decisions Not Reopened This Round

- `modelMatch` does case-insensitive regex complete matching against complete Model ID; when including matching, Rule authors must explicitly write preceding/following `.*`, Resolver
  does not auto-complement;
- Existing semantics of Provider group, Provider visibility, Provider/Model enabled remain unchanged;
- Provider/Model order, Builtin-wins, five Source Schema, and `provider-model` specific Rules remain unchanged;
- Model Config, Runtime, and Protocol continue to share `properties.input_format/output_format`;
- Local workspace uses Local Host, remote workspace uses Remote Host; Renderer does not regain configuration authority;
- Does not establish `ModelIdentity`, second Registry, second set of capability DTOs, or new Config Document abstraction.

### 0.2 Non-Goals

- Deferred OpenRouter, OpenCode Zen, Azure, Volcano Ark, AWS Bedrock from Todo 22;
- Client Config global public Service refactoring;
- Telemetry overall design refactoring;
- Off-Peak string errors changed to structured protocol;
- Conversation queue, continuous/replayable, workspace identity, or model selection product lifecycle changes;
- Adding dual-read, compatibility aliases, or unnecessary migrations for currently unreleased branches.

## 1. Confirmed Issues and Target States

| ID  | Current Issue                                                                                                                    | Target State                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| G1  | `accessId` simultaneously enters Account Overlay, Provider Config, Protocol, Credential key, Request Auth, and UI                | Deleted by Todo 24; account service parses current compatible connections by static family/planKind                            |
| G2  | `ForkModelRef { providerId, modelId, variant }` is old `ModelRef` isomorphic alias                                               | Subsequent execution intent directly uses `ModelSelection`, `variant` exits                                                    |
| G3  | `formatModelSelection()` cannot save `maxOutputTokens`, strings still treated as reversible domain format                        | Status, protocol, and persistence only pass structured `ModelSelection`; strings only as Picker/Legacy boundary values         |
| G4  | Model editing submits and immediately closes, rename and config save are two Mutations                                           | Complete Draft submitted via one atomic Host Mutation, Registry observation success closes                                     |
| G5  | When modifying Model ID, no first moving Personal-specific Rule and re-previewing Effective Config                               | Host provides non-persistent Preview; new ID immediately refreshes inheritance results, Personal explicit values unchanged     |
| G6  | UI copies Effective values into Personal Draft, inheritance, not-set, and explicit override confused                             | Draft separates Personal values from Effective Preview, four-state semantics observable, editable, restorable                  |
| G7  | Normal Built-in Provider and Personal-only Provider reuse complete editor                                                        | "Add Supplier" enters simplified editor; "Create Custom Provider" retains complete editor                                      |
| G8  | `adapterCompatibility.reasoningReplay` preserves historical model specials as formal Config dimensions                           | Delete entire Compatibility container; all Adapters only execute canonical replay                                              |
| G9  | Adapter execution files and comments continue using old Registry naming, old Todo completion claims inconsistent with code facts | Naming mechanically zeroed; historical Todos add correction notes, roadmap and Feature Graph synchronized after implementation |

## 2. Access: Replaced by Todo 24

The account connection version and old Active Model invalidation design originally proposed by this Todo have been revoked. Access's sole current contract is in
Todo 24 (this document exists only in official release), key points as follows:

- Built-in fixed `family + planKind`; Account Overlay only projects `enabled` and Start account model members;
- Current account, product, Team scope, and dynamic credentials are managed by account service, each request resolved by current compatible connection;
- Does not save account connection ID or connection version, does not invalidate old Active Model manually due to account changes under same `family + planKind`;
- Local, Remote, and Standalone each use their Environment's account service, failing closed at network front when compatible connection is missing.

## 3. ModelSelection and `ModelRef` Mechanical Zero

### 3.1 Fork Uses Standard `ModelSelection`

Delete public `ForkModelRef` and its `variant`:

```text
Fork / Side Chat / Before-input Fork
    Subsequent need to create Model
          |
          v
    Save ModelSelection
    ├─ providerId
    ├─ modelId
    └─ options.reasoningLevel / maxOutputTokens (when present)
```

Historical messages have actual provider/model/reasoning facts but no complete future choice; that consumer explicitly decides whether it can construct Selection; cannot create another
Ref/Identity type to bypass semantic judgment. `Model.options` is still the bound execution value, cannot be generically reverse-projected to future choice.

### 3.2 Structured Selection is Sole Domain Representation

`modelSelectionSchema` continues to be the sole strict Schema for structured objects. The following positions can only save or transmit objects:

- Protocol commands and responses;
- Session/Task/Automation/Subagent/Repo Wiki and other product states;
- Fork/Compact/Child and other subsequent execution intents;
- Host and Agent model settings, defaults, and submission parameters.

Strings are allowed in only two boundary positions:

1. UI Select control's required Picker Value;
2. Explicitly published Legacy string reading.

Related functions must be named with true semantics as `formatModelPickerValue`, `parseModelPickerValue`, or
`parseLegacyModelSelectionValue`, and must not continue claiming `parse(format(selection))` can recover complete Selection containing `maxOutputTokens`.
Callers must hold structured Selection simultaneously, cannot reconstruct from Picker Value and override complete state.

### 3.3 Comparison Semantics

No unified `sameModelSelection()` or `ModelIdentity` helper is added. Each consumer continues to explicitly compare fields they genuinely care about, maintaining pre-modification behavior:

- When judging whether execution target changes, can compare only `providerId/modelId`;
- When judging whether user choice changes, that product explicitly compares its saved option leaves;
- reasoning does not re-enter identity;
- No change to existing comparison results to reduce duplicate code.

## 4. Settings: Making Model Editing a Real Manual Transaction

### 4.1 Sole Submission Contract

Model editing popup continues using manual save. Host exposes one complete Mutation, input containing at least:

```ts
interface SavePersonalModelDraftInput {
  providerId: string;
  originalModelId: string;
  nextModelId: string;
  personalConfig: ModelConfigObject;
  basedOnRevision: string | number;
}
```

Actual names can follow existing service naming, but semantics cannot be split. Host completes in the same transaction:

1. Validate Provider/Model membership, Builtin conflict, Model ID, and Source Schema;
2. On Personal Model rename, atomically update `modelIds` and `modelOrder`;
3. Move corresponding Personal `provider-model` Rule;
4. Save complete sparse Personal Model Config;
5. Persist and publish Registry revision;
6. Return observable new Host View/revision.

Popup closes only after receiving success response. Validation, persistence, Registry publishing, or revision conflict failures retain Draft and popup, showing explicit errors;
do not compensate-rollback via two calls in Renderer.

### 4.2 Model ID Real-time Preview

Host provides non-persistent, non-Registry mutation Preview:

```text
Original Personal Rule + Local Draft
              |
              +--> Move exact target to nextModelId in preview state
              |
              v
Parse Built-in Rules by nextModelId + Effective Provider api/baseURL
              |
              v
Overlay Personal Draft's explicitly present leaves
              |
              v
Return Effective Preview + validation issues
```

Debounced Preview after modifying Model ID. Old responses must be discarded by request sequence or Draft revision, cannot override newer input. Preview
does not modify Personal file, Provider membership, modelOrder, or formal Registry. Host must re-execute authoritative parsing and validation on save, cannot trust
Renderer Preview.

### 4.3 Draft and Inheritance Facts Separation

Renderer Draft no longer copies Effective values as Personal values. Each field retains at least:

```ts
interface ModelFieldDraft<T> {
  personal: T | null | undefined;
  inherited: T | undefined;
  effective: T | undefined;
}
```

Mechanical establishment of this generic type is not required; can use existing structures per field. Four product semantics that must be maintained are:

| Status                          | Saved Facts                                    | UI                                                                 |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ |
| Upstream has value, no Personal | Do not write Personal                          | Low-emphasis display inherited value                               |
| Upstream no value, no Personal  | Do not write Personal                          | "Not set" / dash                                                   |
| Personal explicit value         | Write corresponding sparse leaves              | Normal emphasis, can restore inheritance                           |
| Personal explicit clear         | Write `null`, only for fields permitting clear | Explicitly display cleared state, not equivalent to not overridden |

Numeric/text inputs use inherited values as placeholder; Boolean/Format use existing-style Toggle Chip/Selectable Tag, distinguishing status by checkmark, dash,
stroke, and low-interference undo entry, cannot rely solely on color. PDF/Audio continues hidden but losslessly preserved. `requiresMfjsToolSchema` placed at editor end.

### 4.4 JSON Slots

Continue retaining three independent JSON editors:

- `optionSpecs.reasoningLevel`;
- `optionSpecs.maxOutputTokens`;
- `reasoningMapping`.

Each editor directly replaces its Personal slot, empty content restores inheritance, no per-key merging within editor. Save uses Provider authoritative Schema validation,
providing at minimum formatting and field path errors; if selected editor can reliably provide row/column, show row/column. UI does not copy Effective JSON to Personal text box,
Effective results use separate low-emphasis preview.

## 5. Settings: Distinguishing Built-in Add vs. Custom Create

Normal Provider Settings maintain two entries:

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

Normal Built-in Provider's API Schema, default Endpoint, and identity come from Built-in Config, not redundantly displayed as normal editable fields in main editing path.
Delete always only deletes Personal Overlay; Built-in Config is never deleted. Personal-only Provider disappears naturally when deleted due to no Built-in base. Provider ID is read-only across all UIs.

Simplified editor and complete editor can share model list, API Key, and test components, but cannot re-expose complete fields by reusing `InlineEditableProviderCard`. Z.ai/BigModel Family keeps fixed Family UI, does not enter these two normal entries, and does not provide Provider disable operations.

## 6. Adapter Compatibility Deletion and Naming Zero

### 6.1 Reasoning replay

Canonical history replay does not need any `reasoningReplay` configuration. Final decision is complete deletion of
`adapterCompatibility`, `reasoningReplay`, and synthetic empty-thinking projection:

```text
Canonical Message
       |
       v
Adapter standard encoding
       |
       v
Complete replay of real reasoning; no deletion, no synthetic empty thinking
```

Model Config Schema, Overlay, Resolver, Registry, Runtime, Built-in Config, Personal Config, and test fixtures must not continue
accepting or propagating Compatibility container. Unpublished historical formats do not add importer; encounter old fields by strict Schema rejection.

### 6.2 Adapter Execution Naming

Current Adapter files actually carry AI SDK Model Execution assembly, no longer business Registry. Completion should:

- Adapter execution files use accurate `model-execution.ts` / factory naming;
- Delete "session registry" "provider registry cache" comments that no longer hold;
- Retain genuinely Adapter-private transport/factory/cache, do not introduce new public abstractions by renaming;
- Do not re-copy business Provider Config, Model Config as Adapter-queryable Registry.

## 7. Impact Brief

### 7.1 Functional Summary

| Field            | Conclusion                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | Consolidate Provider Refactor decided but unimplemented public access, ModelSelection, and Settings transaction gaps                  |
| Capability       | Provider Registry, Account Request Auth, Model Selection, Provider Settings                                                           |
| Change layer     | `draft-default`, `validation`, `commit-effect`, `persistence`, `presentation`                                                         |
| Operating mode   | planning / implementation handoff                                                                                                     |
| Primary seeds    | `ZhipuAccountAccessConfig`, `AccountProviderCredentialService`, `ForkModelRef`, `formatModelSelection`, `ProviderModelMetadataDialog` |
| Out of scope     | Provider expansion, Telemetry refactoring, Conversation recovery, Client Config public Service                                        |

### 7.2 UI Surface Matrix

| User Scenario                 | UI Entry                                   | Draft/Presentation owner                    | Default/Inheritance Source      | Validation and Submission                                    | Authoritative Owner                | Mode Boundary                      |
| ----------------------------- | ------------------------------------------ | ------------------------------------------- | ------------------------------- | ------------------------------------------------------------ | ---------------------------------- | ---------------------------------- |
| Add normal Built-in Provider  | Provider Settings fixed operations         | Renderer selection state; no Provider Draft | Target Host Built-in Config     | Create Personal Overlay                                      | Target Environment Host            | Local/Remote use respective Host   |
| Create Personal-only Provider | Custom creation interface                  | Renderer creation state                     | No default API Schema           | Immediately create incomplete Provider, subsequent auto-save | Target Environment Host            | Above                              |
| Edit Model                    | Larger manual-save popup                   | Renderer Local Draft                        | Host Effective Preview          | One atomic Model Mutation                                    | Personal Config + Registry         | Desktop/Mobile same semantics      |
| Model selection               | Conversation/Automation/Subagent/Repo Wiki | Each product's own Draft                    | Target Host Selection View      | Each commit sink                                             | Each product state/Worker Registry | No unifying each product lifecycle |
| Account connection display    | Family/Usage/Entitlement UI                | Host projection state                       | Account Connection/Availability | Existing login/connection actions                            | Account Service                    | Does not read `accessId`           |

### 7.3 Hierarchy Relations

| Level          | Relation                                                  | Reason                                                                                                     |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| must-inspect   | Account Connection -> Account Overlay -> Request Auth     | Must still resolve by current compatible connection after deleting connection ID, fail-closed when missing |
| must-inspect   | Model editor -> Host Mutation -> Personal Config/Registry | Current step-by-step save drops Draft and produces non-atomic state                                        |
| must-inspect   | Fork/Protocol/Persistence -> ModelSelection               | `ForkModelRef` and strings will continue creating second choice representation                             |
| should-inspect | Usage/Telemetry/Family UI -> Account status               | Current partial display infers connection by `accessId` presence                                           |
| should-inspect | Automation/Subagent/Repo Wiki/Conversation picker         | Shared Picker Value, but state and submission targets must continue separating                             |
| conditional    | Standalone/Remote Host Request Auth                       | Each Environment must use its own account service                                                          |
| invariant-only | desktop continuous / mobile replayable                    | This round does not change stream, snapshot, queue, or recovery semantics                                  |
| invariant-only | Off-Peak                                                  | Continue using normal ModelSelection/Registry/ModelFactory and request-period auth                         |

### 7.4 State Owner and Commit Sink

| State/Fact                                  | Authoritative Owner                      | Mirror/Cache                   | Commit Sink                                       |
| ------------------------------------------- | ---------------------------------------- | ------------------------------ | ------------------------------------------------- |
| Built-in/Personal Provider and Model Config | Target Environment Host Provider Service | Renderer Host View             | Provider Config Repository + Registry publication |
| Model editing Draft                         | Current popup Renderer                   | No persistent cache            | Single Host Model Mutation                        |
| Current account connection and identity     | Account/Credential Services              | Account Provider snapshot      | Existing login, connection, logout flows          |
| Request-period credentials                  | Account Request Auth Service             | Private Credential Store/cache | Each request attempt parsed, no Config written    |
| Future model selection                      | Each product structured `ModelSelection` | Picker Value display only      | Each product's existing submission entry          |
| Current execution model                     | Agent Runtime Active Model               | No reverse editable mirror     | ModelFactory creation                             |

### 7.5 Invariants to Maintain

1. Account-type Provider Config does not save credentials or account identity; API Access can still directly save user-filled API Key;
2. After switching/logging out of account, old Active Model can only use current compatible family/planKind connections, failing at network front otherwise;
3. Local and Remote Environment each parse Provider Registry, account connections, and request credentials;
4. `ModelSelection` only saves explicit choice intent, default options still resolved by ModelFactory;
5. Model editing cancel does not write config, failure does not close popup, success publishes only one final revision;
6. Built-in Models cannot be deleted, Provider IDs cannot be modified, Builtin Config is never deleted by Settings;
7. UI hidden fields PDF/Audio and unedited Personal JSON slots are losslessly preserved;
8. Does not change each model selection entry's state ownership, Queue, Recovery, Off-Peak admission, or Telemetry overall design;
9. Does not restore ModelRef, ModelIdentity, public connection key, or second Registry;
10. Does not move old Registry's config responsibility into new execution/factory abstractions by cleaning up old naming.

### 7.6 Graph Drift Review and Sync Results

Pre-implementation Feature Graph still declares Account Overlay publishing opaque `accessId`, and Todo 05/21 also contains completion results inconsistent with current code.
These graph/spec drifts have been synchronized with this Todo and Todo 24; review scope includes:

- Design Tree Account Access, Request Auth, Model Selection, Settings, and Registry documents;
- Feature Graph Provider Registry, Model Selection, Off-Peak, and Settings nodes and invariants;
- Corrective notes or superseded links for Todo 05, 07, 12–14, 20, 21;
- Final completion results of Todo 00 roadmap.

Synchronization must not elevate implementation temporary trade-offs into design. Unless objectively unachievable, correctness conflicts, or new reliable facts arise, implementation must faithfully execute this Todo; normal implementation
ambiguity decisions use minimal-impact, reversible solutions continuing without blocking goals, discussed after completion.

## 8. Implementation Slices

### Slice A: Failing Tests and Public Contracts

1. Write failing tests for Todo 24 Access contract, ModelSelection options fidelity, and atomic Model Mutation;
2. Establish Settings Draft four-state, Model ID Preview, and Built-in simplified editor component/service contract tests;
3. Supplement regression tests for Local/Remote Host authority, Standalone Request Auth, and Off-Peak invariants.

### Slice B: ModelSelection Zero

1. Change all `ForkModelRef` to `ModelSelection`, delete `variant` conversion;
2. Protocol, persistence, and product states only save structured objects;
3. Explicitly rename Picker/Legacy string helpers and restrict boundaries;
4. Delete duplicate Parser/Formatter, do not add unified comparison helper.

### Slice C: Access Contract

Fully implemented and accepted by Todo 24; this Todo no longer maintains another Access implementation list.

### Slice D: Model Editing Transaction and Preview

1. Add one-time Host Preview and one-time Host Save Mutation;
2. rename, membership, order, specific Rule, and Personal Config submitted in same transaction;
3. Renderer popup waits for success before closing, conflicts/failures retain Draft;
4. Model ID Preview debounced and stale responses rejected;
5. Delete step-by-step helper and optimistic compensation logic after `rename()` then `save()`.

### Slice E: Settings Semantics and Presentation

1. Draft separates Personal values, Inherited Preview, and Effective Preview;
2. Implement inheritance, not-set, explicit override, explicit clear four-state;
3. Three JSON slots reuse authoritative Schema, add formatting and path errors;
4. Normal Built-in Provider uses API Key + Model List simplified editor; Personal-only uses complete editor;
5. `requiresMfjsToolSchema` moved to end, completing Light/Dark, Desktop/Mobile, keyboard, and Chinese/English checks.

### Slice F: Compatibility, Naming, and Document Mechanical Zero

1. Completely delete `adapterCompatibility`, `reasoningReplay`, and synthetic empty-thinking projection;
2. Validate Adapter `model-execution.ts` and comments all use execution/factory naming, do not change transport/factory behavior;
3. Execute mechanical residual search, delete dead helpers, test fixtures, and erroneous comments;
4. Synchronize Design Tree, Feature Graph, Todo status, and superseded relations;
5. Submit Conventional Commits per slice, do not compress all changes into one unreviewable commit.

## 9. Testing and Acceptance

### 9.1 Config, Account, and Request Auth

- Zhipu Account Access Schema does not accept, serialize, or require `accessId`;
- Account Overlay only publishes enabled and Start account model members;
- Individual/Start/Team each can obtain correct credentials from current account service;
- Switching accounts under same Family/Plan re-resolves old Model credentials by current compatible connection;
- Account credential refresh does not hot-change Model's Endpoint, API type, Properties, or Model Selection;
- Credential Store/in-flight cache does not cross-use between different accounts, Providers, Team scopes;
- UI, Usage, Telemetry do not infer account connections by access strings;
- Local, Remote, Standalone, and Off-Peak use their respective Environment account facts.

### 9.2 ModelSelection

- `modelSelectionSchema` fully accepts and preserves `reasoningLevel/maxOutputTokens`;
- Fork/Side Chat/Before-input Fork no longer produces `variant` or Ref alias;
- Picker Value does not override caller's complete Selection options;
- Legacy strings parsed only at explicit importer/codec boundaries;
- Conversation, Automation, Subagent, Repo Wiki comparison and submission semantics maintain original behavior;
- Config default changes not reverse-solidified to historical Selection.

### 9.3 Settings Transaction and Preview

- Open, edit, cancel/X/Esc do not write config;
- Save produces only one Host Mutation and one final Registry revision;
- rename simultaneously updates Personal membership, modelOrder, and exact Rule;
- Save failure, revision conflict, and Registry publishing failure all retain popup and Draft;
- Modifying Model ID first moves Preview Rule, then parses new Built-in default, Personal explicit values retained;
- Preview stale response does not override latest Model ID;
- Upstream has value, upstream no value, Personal override, explicit clear four-state round-trip;
- PDF/Audio and unedited JSON slots preserved losslessly;
- Three JSON editors independently replace, empty content restores inheritance, invalid content prevents save;
- `requiresMfjsToolSchema` at end.

### 9.4 Provider Settings

- "Add Supplier" lists only normal `standard-builtin` un-added candidates;
- After adding, only shows simplified API Key + Model edit main path;
- "Create Custom Provider" creates incomplete `standard-personal` Provider and displays complete editor;
- Deleting any Provider only deletes Personal Overlay; Built-in Config unchanged;
- Family UI, normal ordering, Provider ID, Built-in Model delete permissions, and model enabled behavior maintain original decisions;
- Desktop/Web/Mobile, Zai Light/Zai Dark, keyboard, touch, and Chinese/English pass regression.

### 9.5 Mechanical Zero

At completion at minimum satisfy:

```text
Production public chain accessId                       = 0
ForkModelRef / public isomorphic ModelRef alias     = 0
reasoning identity variant                = 0
Selection string serialization in current write paths      = 0
Step-by-step submission of Model editing after rename then save      = 0
adapterCompatibility / reasoningReplay         = 0
Old Adapter Registry naming and erroneous comments          = 0
```

Allowed search hits must be listed individually in completion records, proving belonging to third-party fields, explicit Legacy read-only boundaries, or historical document references; broad allowlists cannot cover
production residues.

Final execution:

- Related Provider, Services, Shared, Core, Bootstrap, UI unit tests;
- `pnpm typecheck`;
- `pnpm lint`;
- `pnpm fmt:check`;
- Affected Desktop E2E, and Local/Remote Host Provider Settings/Selection regression;
- `pnpm knip` and targeted `rg` mechanical zero checks;
- When necessary `pnpm test:unit:affected` and `pnpm verify:pre-push`.

## 10. Completion Definition

This Todo can only be marked "Completed" when all the following conditions are met:

1. G1–G9 code, tests, and mechanical zero gates all complete;
2. `accessId` has not re-entered Provider Config, Model, Protocol, UI, or public Credential contract under new names;
3. Account switching, logout, credential refresh, and Remote/Standalone requests all have current connection resolution and fail-closed-on-missing evidence;
4. Fork, Picker, Protocol, and Persistence no longer have second ModelSelection representation;
5. Model editing save is one Host Mutation, failure retains Draft, Preview produces no persistence;
6. Built-in simplified editor and Personal-only complete editor分流 by group;
7. Design Tree, Feature Graph, roadmap, and related old Todos synchronized to real implementation, no longer falsely claiming unmet items completed;
8. Required tests, typecheck, Lint, format check, affected E2E, and mechanical residue checks pass;
9. Conventional Commits submitted per reviewable slices, with self-choices and verification evidence preserved in implementation records.

## 11. Implementation Records (2026-08-27)

- ModelSelection uniformly preserves structured `providerId/modelId/options`, Fork, Side Chat, Automation, Subagent, and
  Persistence no longer maintain Ref aliases or reasoning identity variants;
- Model editing save consolidated to one Host Mutation with `basedOnRevision`, rename, membership, order, and precise Personal Rule
  atomically submitted; Preview only returns inherited values and Effective values, no persistence, does not accept Renderer API/Endpoint authority;
- Personal Model Draft changed to truly sparse Overlay: untouched leaves not written, PDF/Audio and JSON slots preserved losslessly; "restore all defaults" takes
  current model ID's new inheritance results as baseline;
- Provider/Model settings page completes intended simplification, ordering, and popup interactions; Provider continuous ordering uses UI optimistic projection, Environment owner changes discard old Pending, not forming second config fact;
- `adapterCompatibility`, `reasoningReplay`, synthetic empty-thinking, and related fixtures/helpers deleted from current production chain;
- Access slice completed by Todo 24 per final decisions, ZAPI retirement by Todo 25.

> Subsequent reverse review supplements: Host Preview and Model Draft atomic save itself completed per this Todo; Personal Match/Exact
> Rule stable group priority, and Resolver and write-side three-segment order helper mechanical normalization, taken by
> [`Todo 28`](./todo-28-model-rule-precedence-and-order-canonicalization.md).

Verification evidence:

- Root `pnpm typecheck` passed; root `pnpm lint` is 0 error (34 workspace-wide pre-existing warnings);
- Model settings directed tests 235/235, UI/Services contract tests 47/47, CLI Provider/Adapter/Bootstrap directed tests
  228/228 passed;
- Root full unit 12,438/12,440 directly passed; only 2 failing Windows ZIP cases are host missing system `zip`, re-run with isolated compatible ZIP
  command 17/17 passed;
- This round's 216 modified files passed directed format check after `oxfmt` correction; root `fmt:check` still blocked by repository pre-existing binary files and Electron upstream
  example HTML parse errors;
- Root `knip` still reports workspace-wide pre-existing unused baseline; directed check reports no this-round new Access, Credential, or UI split symbols;
- Production code mechanical search confirms `ForkModelRef`, `adapterCompatibility`, `reasoningReplay`,
  `anthropic-empty-thinking`, and old Access Type all zero.
