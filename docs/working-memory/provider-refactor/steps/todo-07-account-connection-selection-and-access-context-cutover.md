# 07 Account Connection Selection and Access Context Closure

> Status: Completed
>
> Date: 2026-08-24
>
> Source review: [`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> Target design: [`../design/registry/configuration.md`](../design/registry/configuration.md)、
> [`../design/registry/runtime.md`](../design/registry/runtime.md)、
> [`../design/registry/model-creation.md`](../design/registry/model-creation.md)
>
> Prerequisite: [`todo-03-provider-model-ownership-and-property-totality.md`](./todo-03-provider-model-ownership-and-property-totality.md)
> must first establish unique Registry complete type boundary; this task strengthens structured `zhipu-account` access and integrity in-place.

## 0. Actual Deliverables

- Settings now only save `providerFamilyConnectionSelections`; old mode/selected-key dual state exits formal production chain;
- Start, Individual, Team declared by Built-in Provider themselves with fixed `family + planKind`; Account Resolver produces complete Account Overlay by structured
  selection, without maintaining runtime Provider ID to plan mapping table;
- Enabled Account Provider's complete Access fixed into Registry/Active Model; request authentication only consumes that structure,
  `accessId` remains opaque to consumers;
- Off-Peak and Official MCP now consume complete Account Access, no longer parsing connection keys or comparing scoped/unscoped IDs;
- Account accessId, credential caching, account switch invalidation, and Team scope handled by the same Credential/Auth chain;
- Old Settings fields and old string keys only exist in tests/one-time migration inputs; do not enter current AppSettings, Protocol, Registry, or
  Request Auth.

## 1. Task Objective

Converge Provider Family user connection selection, Account Connection facts, Account Built-in Provider Config, and request-period
authentication into a single structured chain. Delete `selectedConnectionKey` and implicit protocols formed by `accessId` string parsing.

```text
Current

AppSettings
├─ modelProviderFamilyModes[family]
└─ modelProviderFamilySelectedKeys[family]
          |
          | preset:/coding-plan:/team-plan: strings
          +--------------------+----------------------+------------------+
          |                    |                      |                  |
          v                    v                      v                  v
Account Resolver       Settings / Usage       Off-Peak / MCP       Task / Session
          |                    |                      |                  |
          `-------- 各自 parse / match / rebase / startsWith -----------'
                               |
                               v
                  scoped accessId re-encodes account identity

Target

AppSettings.providerFamilyConnectionSelections
          |
          | structured user selection intent
          v
Account Connection Resolver
├─ current account (internal fact)
├─ entitlement / availability
└─ selected structured connection
          |
          v
Account Connection Result
├─ status
├─ resolved access { family, planKind, Team scope?, opaque accessId }
└─ models?
          |
          v
Account Built-in Provider Config
          |
          +--> Registry / Model fixed Account Access
          +--> Request Auth
          +--> Off-Peak
          `--> Official MCP
```

This task is not renaming `selectedConnectionKey`, nor concentrating the current string parser into another helper. Target is for
Settings to only save structured selection intent, for Account Connection Resolver to be the sole interpreter, and for execution consumers to directly read
Account Access already resolved in Provider Config.

Todo 03 does not prematurely implement this task's structured account Access, nor create temporary Account Access DTO. Todo 03's
`RegistryProviderConfig` first narrows based on Access Schema existing at that time; this task modifies `ZhipuAccountAccessConfig`
while synchronously expanding the same `CompleteProviderAccessConfig`, `requireComplete`, and complete serialization contract.

## 2. Confirmed Decisions

### 2.1 User Selection Uses Structured Single Field

Delete two pieces of must-atomically-maintained Settings state:

- `modelProviderFamilyModes`;
- `modelProviderFamilySelectedKeys`.

Replace with:

```ts
type ProviderFamilyConnectionSelection =
  | { kind: "api-key"; providerId: string }
  | { kind: "start-plan" }
  | { kind: "individual-coding-plan" }
  | {
      kind: "team-coding-plan";
      productId: string;
      organizationId: string;
      projectId: string;
    };

interface AppSettings {
  providerFamilyConnectionSelections?: Partial<
    Record<ProviderFamilyDomain, ProviderFamilyConnectionSelection>
  >;
}
```

`kind` already contains API Key/OAuth and specific plan forms; no need to maintain independent mode. `providerFamilyDomain` continues expressing currently activated
Provider Family; do not delete or merge in this task.

Account Plan selection does not save Built-in Provider ID, nor infer plan from Built-in Provider ID. Outer Family, `kind`,
and Team Scope are structured inputs for Account Connection Resolver to look up connections; API Key selection retains user's actually selected
Provider ID. Current logged-in account participated in resolution by Account Connection Service internally; does not enter Settings or Provider Config.

### 2.2 Start, Individual, and Team Are Independent Built-in Providers

Same Family's Start Plan, Individual Coding Plan, and Team Coding Plan respectively defined as independent ZCode Built-in
Providers. Each Provider's `access.family` and `access.planKind` fixed; no Coding Plan Provider
can morph between Individual and Team at runtime.

Normal Settings flow selects only one connection among mutually exclusive accounts within same Family; Account Built-in Overlay only supplements Access for Providers matching
`family + planKind` and sets them enabled; other account Providers set disabled. Resolver scans Built-in Provider declared Access itself, without maintaining Start/Individual/Team Built-in Provider ID mapping table.

Individual and Team can declare the same model ID; Registry identity is still `providerId + modelId`. Normal selection flow only
one Provider enabled, so Selection only shows models under current connection. Users manually enable multiple Providers through Personal Config following normal Config
semantics; no source permission checks added.

Target Built-in identities use explicit names, not retaining "one Coding Plan Provider simultaneously representing two Plans" formal semantics:

```text
builtin:zai-start-plan
builtin:zai-individual-coding-plan
builtin:zai-team-coding-plan

builtin:bigmodel-start-plan
builtin:bigmodel-individual-coding-plan
builtin:bigmodel-team-coding-plan
```

Old `builtin:*-coding-plan` only exists in one-time Settings/Personal/Selection importer. Migrator can map to corresponding new Provider when able to clearly distinguish Individual or Team from same structured selection; unidentifiable manual configurations produce clear diagnostics; do not
copy to both Providers; do not retain runtime aliases long-term. Delete importer and old ID constants after mandatory upgrade window ends.

### 2.3 Account Connection Is Connection Fact Authority

Account Connection Resolver reads current Family, structured selection, logged-in account identity, entitlement, Credential Port, and Plan
API, outputting per-Provider differentiated results:

```ts
type AccountProviderConnectionResult =
  | {
      providerId: string;
      status: "available";
      access: CompleteZhipuAccountAccessConfig;
      models?: readonly string[];
    }
  | {
      providerId: string;
      status: "unavailable";
    };
```

Renderer, Usage, Off-Peak, Official MCP, Task, and Session no longer interpret Settings strings themselves.

### 2.4 Provider Config Fixed Structured Account Access

`zhipu-account` Access target structure:

```ts
type ZhipuAccountAccessConfig =
  | {
      type: "zhipu-account";
      accessId?: string | null;
      family: "zai" | "bigmodel";
      planKind: "start-plan" | "individual-coding-plan";
    }
  | {
      type: "zhipu-account";
      accessId?: string | null;
      planKind: "team-coding-plan";
      family: "zai" | "bigmodel";
      productId?: string | null;
      organizationId?: string | null;
      projectId?: string | null;
    };
```

ZCode Built-in Provider Config first declares fixed `family + planKind`; Team's specific Scope and all Plans'
`accessId` can be null. Account Connection Resolver uses these fields with Settings selection, current account, and entitlement to look up connections;
Account Built-in Provider Config entirely replaced with complete Access for same Plan. Registry requires enabled Account
Provider's `accessId` non-null; Team also requires complete Scope.

Account Built-in Provider Config is an immutable snapshot of execution-required Account Access. `accessId` is stable, non-sensitive
connection identity, but consumers must treat it as opaque value; cannot recognize Plan, Family, Team Scope, or account identity from it.
Current account identity only generated, looked up, and invalidated by Account Connection Service internally; account switch invalidates old
`accessId` credential acquisition; do not copy `accountIdentity` into Provider Config.

This task can temporarily maintain existing accessId byte format and Credential Store key, avoiding unnecessary credential migration; "maintain existing
format" does not constitute permission to continue parsing that format. After compatible window ends, only old format
migration code truly needed within Account Source/Importer can be retained to unified retirement point.

### 2.5 UI Editability Not Schema Permission

Settings page may not display Account Access, or may set Built-in fields read-only, but Config Schema therefore does not prohibit users from manually
writing these fields. Personal continues using general overall Overlay:

```text
UI does not provide Account Access editing
        !=
Personal Schema prohibits expressing Account Access
```

Schema and Registry only check structure, discriminant, and Effective Config completeness; do not check whether `accessId` or account
Access fields originated from Account Built-in Source. When users manually write structurally complete but business-invalid connections, fail at
Request Auth or server-side authentication; do not add Source permission system.

### 2.6 Off-Peak and Official MCP Belong to This Task

Off-Peak and Official MCP currently both re-read Settings and parse `selectedConnectionKey`. This task migrates both to
Account Connection / Effective Account Access; does not leave to M4 or other tasks.

Off-Peak currently has an explicit bug candidate: production Account Provider's `accessId` carries account scope, while
`selectedConnectionKey` does not; the code directly comparing both incorrectly judges valid connections as unavailable. Target implementation deletes this comparison; does not add "de-scope-then-compare" compatibility
helper.

## 3. Current Facts and Impact Scope

Current precise text scan shows `modelProviderFamilySelectedKeys` or `selectedConnectionKey` appears in at least 37 non-test
files: 18 UI, 11 Services, 5 Shared, 3 Desktop.

| Scope                      | Current Responsibilities                             | Target                                           |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| AppSettings / Schema       | Persist mode and string key                          | Single structured selection                      |
| Provider Settings          | Navigation, switch, restore, and pending state       | Edit structured selection                        |
| Account Resolver           | Parse Plan/Team key and generate accessId            | Look up connection by Access fields              |
| Request Auth               | Identify Plan, account, and Team Scope from accessId | Consume complete Account Access                  |
| Usage / Entitlement        | Generate query context from selected key             | Consume Account Connection View                  |
| Session / Task / Repo Wiki | Layer-by-layer passthrough of selected keys          | Delete passthrough; use Registry/Account Service |
| Off-Peak                   | Parse Settings, compare two IDs                      | Consume current Account Access                   |
| Official MCP               | Re-parse Plan and Team Scope                         | Consume current Account Access                   |
| Desktop remote host        | Temporarily construct selected key map for Team Key  | Pass structured Account Access directly          |

### 3.1 UI Surface Matrix

| User Scenario                    | UI Entry                  | Draft/Display Owner     | Submit Sink           | This Task Changes                  | Isolation Boundary                               |
| -------------------------------- | ------------------------- | ----------------------- | --------------------- | ---------------------------------- | ------------------------------------------------ |
| Switch API Key/Plan connection   | Provider Settings         | Local pending selection | AppSettings           | Single submit structured selection | Do not change Personal Provider Config           |
| View current connection and plan | Provider Settings / Usage | Account Connection View | None or Usage request | Do not parse accessId/key          | Dynamic quotas do not enter Registry             |
| Select model                     | Composer model control    | Composer Draft          | Session/Task command  | Candidates only from Registry      | Do not switch connections in model selector      |
| Create off-peak task             | Off-Peak entry            | Off-Peak support view   | Off-Peak service      | Host consumes Account Access       | Do not send credentials to Renderer              |
| OAuth login restore              | Root callback             | AppSettings             | Setting Service       | Write structured selection         | Settings mount does not reorder valid selections |

Automation, Subagent, and Repo Wiki only share Registry model candidates; do not own Account Connection selection. Current code passthrough selected keys
to these paths is bridge code awaiting deletion, not representing product semantics.

### 3.2 State Owner and Commit Sink

| State/Fact                                 | Authoritative Owner               | Persistence/Cache                | Consumers                     |
| ------------------------------------------ | --------------------------------- | -------------------------------- | ----------------------------- |
| User's current connection selection intent | AppSettings structured selection  | `setting.json`                   | Account Resolver, Settings UI |
| Current account identity and entitlement   | OAuth/Account/Plan services       | Their respective existing caches | Account Resolver              |
| Currently available Account Connection     | Account Provider Service          | last-known-good Account Source   | Registry, Account Views       |
| Provider execution Account Access          | Effective Provider Config / Model | Registry revision / Active Model | Request Auth                  |
| API Key/JWT/Team Secret                    | Credential / Request Auth service | Existing Credential Store        | Single request attempt        |
| Off-Peak Ticket/Auth                       | Off-Peak execution context        | Current dispatch memory          | idle Model request-auth       |

## 4. Impact Brief

| Field            | Conclusion                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | Delete account connection string protocol and cross-layer passthrough; unify selection, Provider Access, and request authentication |
| Capability       | Provider Registry, Plan Entitlements, Provider Settings, Off-Peak, Official MCP                                                     |
| Change layer     | `persistence`, `option-source`, `validation`, `commit-effect`                                                                       |
| Operating mode   | implementation-handoff                                                                                                              |
| Primary seeds    | `AccountProviderConnectionResolver`, `AppSettings`, `resolveOffPeakCredentials`, `resolveOfficialMcpCredentials`                    |
| Out of scope     | Plan product logic redo, remote Provisioning, Credential center refactoring, Queue/Recovery, Model selection lifecycle              |

| Level          | Relationship                                            | Reason                                                                         |
| -------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| must-inspect   | AppSettings -> Provider Settings -> Account Resolver    | selection's persistence/commit main chain                                      |
| must-inspect   | Account Resolver -> Account Built-in Config -> Registry | Structured connection fact's unique projection chain                           |
| must-inspect   | Active Model -> Request Auth                            | Old Model cannot follow new account on switch                                  |
| must-inspect   | Account Access -> Off-Peak / Official MCP               | Currently re-parses strings; off-peak has ID comparison gap                    |
| should-inspect | Usage / Entitlement / Sidebar                           | Currently rebuilds product context from selected key/accessId                  |
| conditional    | Local/Remote Host Account Source                        | Remote Environment must use its own Account Source                             |
| invariant-only | desktop continuous / mobile replayable                  | This task does not change task/session/stream recovery semantics               |
| evidence-only  | Existing connection-key helper tests                    | Only proves old protocol behavior, not that old abstraction should be retained |

Feature graph already records Account Connection source authority, Provider execution snapshots, and UI/Schema decoupling invariants. Current environment has no callable
codegraph tool; this impact scope uses semantic graphs and precise `rg` call site reviews; evidence at symbol level must be supplemented by `dep:refs`, TypeScript
before implementation.

## 5. Implementation Scope and Order

### Step A: Tests Freeze and Structured Selection

- Write failing tests first for API Key, Start, Individual, Team project selection and restart recovery;
- Define structured selection and strict Schema in Shared;
- AppSettings changed to single `providerFamilyConnectionSelections`;
- Provider Settings pending state, save, OAuth callback restore, and default initialization submit complete selection once;
- `providerFamilyDomain` kept independent.

### Step B: Account Connection and Provider Access

- Define Start, Individual, Team Built-in Providers separately for each Family; delete Individual/Team shared Provider;
- Each Provider fixedly declares `access.family + access.planKind`; Team Effective Access additionally carries complete Scope;
- Account Resolver looks up connections by structured Access and selection; no Built-in Provider ID mapping table;
- `AccountProviderConnectionResult.available` returns complete `ZhipuAccountAccessConfig`;
- Account Connection Service internally generates and invalidates opaque accessId using current account; does not project accountIdentity into Config;
- Account Built-in Config projects complete Access, optional builtinModelIds, and enabled=true for selected Provider; other Account Providers in same mutually exclusive range projected with enabled=false;
- Account Resolver atomically publishes entire result on success; on external dependency failure, Service retains entire previous version Snapshot, no partial LKG;
- Delete per-Provider `unknown + previousProviders` half-recovery branches; do not add new Family/Provider fault isolation protocol;
- `validateComplete` / `requireComplete` validates structural completeness, not field origin or real entitlement;
- ModelFactory/Model fixedly stores complete Account Access as-is.

### Step C: Request Auth and Consumer Closure

- Request Auth selects authentication flow by `family + planKind`; obtains corresponding dynamic material by opaque accessId;
- Team Key/Header uses explicit Scope from Access, does not parse accessId;
- Delete Family/Plan to Built-in Provider ID hardcoded mapping from Request Auth and Account Resolver;
- Usage, Entitlement, Reset, Sidebar, and Provider Settings use Account Connection View;
- Host no longer determines whether official version safety check needed by `start-plan:` prefix; Request Auth expresses through existing typed interaction/error boundaries;
- Maintain Credential Store current construction key using complete accessId; migrate only if tests prove necessary.

### Step D: Delete Cross-Layer Selection Passthrough

- Delete selected keys parameters from ZCodeTask, ZCodeSession, Agent, workspace prepare, Repo Wiki, thought catalog;
- Runtime only obtains execution Access from Provider/Model in Registry;
- Renderer only modifies selection in Provider Settings; does not stuff into ModelSelection or Session state;
- Remote Workspace continues to produce Account Built-in Config from target Environment's Account Source.

### Step E: Off-Peak and Official MCP

- Off-Peak obtains current valid Individual/Team Account Access; Start/API Key continue refusing by product rules;
- Delete direct comparison of scoped accessId and unscoped selected key;
- `OffPeakCredentialSnapshot`, `OffPeakCodingPlanSupport` delete `selectedConnectionKey`;
- Official MCP uses same Account Access to judge Individual/Team scope;
- Credential parsing before/after consistency checks continue, but compare Account Source revision/structured connections, not concatenate two-generation credentials;
- Renderer does not receive JWT, API Key, Team Secret, or other dynamic credentials.

### Step F: Migration and Mechanical Deletion

- Repository executes one-time mode/key -> structured selection migration when reading old AppSettings;
- Only migrate identifiable `preset:`, `coding-plan:`, and complete `team-plan:`; damaged values not guessed;
- Migrate old general `builtin:*-coding-plan` Provider ID to Individual or Team ID based on same structured selection;
- Migrate Settings, Personal Provider key, and still-recovering persisted ModelSelection; ambiguous manual configurations report diagnostics; do not copy to both new Providers;
- No dual-write old fields; no long-term dual-read in formal business code;
- Delete migration functions, old schema fields, and parser/matcher tests after mandatory upgrade compatibility window ends;
- Delete connection-key create/parse/matches/rebase helpers and call-site-less legacy accessId parser.

## 6. Tests First

### 6.1 Settings and Migration

1. API Key, Start, Individual, Team selection strict round-trip;
2. Atomic migration of mode and selected key into single structured value;
3. Team migration preserves product/organization/project;
4. Damaged old keys do not guess Plan or Team Scope;
5. OAuth callback only updates target Family; other Family selections unchanged;
6. Settings mount does not override still-valid saved selections;
7. User switches connections once; no mode/key partial update state.
8. Old general Coding Plan Provider ID migrated to Individual or Team based on explicit selection; ambiguous inputs not guessed or dual-written.

### 6.2 Account Provider and Registry

1. Start, Individual, Team each correspond to independent Built-in Provider; Plan type does not morph at runtime;
2. Team additionally produces complete product/organization/project;
3. Resolver can look up accessId by structured family/planKind/Team Scope without Built-in Provider ID mapping table;
4. Normal Individual selection enables only Individual Provider; Team selection enables only Team Provider;
5. Token/Runtime Key refresh does not change Account Access; account or Team project switch produces new Access;
6. Account refresh success atomically publishes entire result; any external dependency failure keeps entire previous version Snapshot unchanged;
7. Personal can completely override access; no source qualification checks;
8. Manually written fake access structures pass Config completeness when structurally complete; Request Auth or server-side failure;
9. Enabled Account Provider missing accessId, or Team missing Scope, cannot enter Registry.

### 6.3 Request Auth, Off-Peak, and MCP

1. Start, Individual, Team Request Auth does not parse accessId strings;
2. Old accessId cannot obtain new account credentials after account switch and fails before network;
3. Team Header/Key uses explicit Scope from Access;
4. Off-Peak's scoped Account Access parsed normally, no longer triggering erroneous `connection_unavailable`;
5. Entire retry when connection switching occurs during credential parsing; no mixing of two-generation credentials;
6. Official MCP Individual/Team scope consistent with Account Access;
7. Start/API Key's existing product gates for Off-Peak/MCP unchanged;
8. Renderer-visible support/outcome does not contain Secrets.

### 6.4 Multi-Platform and Regression

1. Desktop, Web, mobile settings pages use same Setting Service for same selection;
2. Local/Remote Environment generates Account Built-in Config themselves;
3. Composer, Automation, Subagent, Repo Wiki candidates still from Registry; each Draft/commit sink unchanged;
4. Desktop continuous, mobile replayable, Queue, snapshot, workspace identity: no protocol semantic changes;
5. Already-created Active Model retains old Access after global account/connection switches; cannot silently follow.

Stable Case IDs:

| Case ID | Setup                                          | Action                                         | Assertions                                                                            |
| ------- | ---------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| AC-01   | Save Team selection                            | Restart Settings                               | organization/project recovered as-is; no string parse                                 |
| AC-02   | Account A creates Model                        | Request old Model after switching to Account B | Identity mismatch before network; does not use B credentials                          |
| AC-03   | Team project P1 Active                         | Switch to P2                                   | Old Model retains P1; new Model uses P2                                               |
| AC-04   | Personal writes fake Account Access            | Create and request Model                       | Schema does not reject by source; Request Auth clearly fails                          |
| AC-05   | Valid scoped Account Access                    | Create Off-Peak ticket                         | Not compared to unscoped key; obtains dual credentials normally                       |
| AC-06   | Connection switching during credential parsing | Parse Off-Peak/MCP                             | Do not mix two-generation JWT/API Key/scope                                           |
| AC-07   | Remote Environment                             | Sync/refresh Providers                         | Use remote Account Source; do not read local selection for execution                  |
| AC-08   | Both Individual and Team Providers exist       | Switch structured connection selection         | Only matching Provider enabled; model candidates only appear under current connection |

## 7. Non-Goals

- Redo plan SKU, purchase, discounts, quotas, or server-side authorization product logic;
- Put dynamic API Key, JWT, Team Secret, one-time security verification Header, or Ticket into Provider Config;
- Establish unified Credential Center;
- Change ModelSelection, Session Selection, App Recent, or Active Model lifecycle;
- Change remote Provisioning, remote settings, or login product capabilities;
- Change Queue, continuous/replayable, snapshot, or workspace identity;
- Change existing accessId byte format or Credential Store key due to this task;
- Add Source permission or "prohibit writing account accessId" special validation for user manual configurations;
- Put Badge, Label, plan display copy into Account Access.

## 8. Completion Conditions

Mechanical zero:

```text
AppSettings.modelProviderFamilyModes                                   = 0
AppSettings.modelProviderFamilySelectedKeys                            = 0
selectedConnectionKey in production domain/protocols                   = 0
Family selected keys passthrough from Task/Session/Repo Wiki/workspace prepare = 0
Business code create/parse/matches Team/Coding/Preset connection key   = 0
UI/Host/Off-Peak/MCP reverse-decoding Plan/Family/Team/account identity from accessId = 0
Account Resolver / Request Auth's Built-in Provider ID plan mapping  = 0
Old general builtin:*-coding-plan Provider ID in formal Config/Registry = 0
provider.accessId !== selection.selectedConnectionKey                = 0
OffPeak support/snapshot selectedConnectionKey                       = 0
enabled zhipu-account missing complete family/planKind/accessId/Team Scope = 0
```

Generic Select component's internal React option identity `key` not in zero scope; prohibited is using string keys as cross-
Settings, Services, Protocol, Runtime account connection protocol.

Behavioral acceptance:

- User connection selection has only one structured persisted state;
- Account Connection Resolver is the sole interpreter of selection intent to account connection facts;
- Account Built-in Provider Config is the unique static snapshot of execution-required Account Access;
- Start, Individual, Team are fixed-type independent Built-in Providers; normal flow enables only current selection;
- Request Auth, Off-Peak, and Official MCP consume same structured Account Access;
- accessId treated as opaque identity by all consumers;
- UI editability does not change Personal Schema expressibility;
- Account/connection switches do not let already-created Models silently switch to another set of credentials;
- No new-old dual-write, dual-read, or long-term compatibility DTOs.

## 9. Verification and Commit

At minimum, execute:

```bash
pnpm test:unit:affected
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm knip
```

Verify mechanical zero items with `pnpm dep:refs`, TypeScript, and `rg`. Execute Provider Settings, OAuth reconnection, Team
project switching, and Off-Peak entry related Desktop E2E for UI changes; check mobile Web responsive behavior. If remote environments cannot be fully verified,
commit notes must list the impact scope of Local/Remote Account Source and pending evidence.

Update this Todo's status and actual deliverables upon completion; record the sole importer boundary still in mandatory upgrade window; commit with independent Conventional
Commit.
