# Todo 26: Zhipu Access Mode Contract Cutover and Pseudo-Universal Protocol Field Retirement

> Status: Completed
>
> Date: 2026-08-27
>
> Prerequisite: Todo 24 completed `accessId`, account creation binding, and request security validation pathname special-case cleanup; this Todo, based on subsequent product decisions,
> replaces Todo 24's `api-key / zhipu-account / execution-provided` three Access types, `planKind`, and
> `challenge / requestSigning / executionProtocol` universal field target structures. Todo 24's account dynamic auth, Account Overlay
> narrowing, private Credential isolation, and server-side final authorization conclusions remain valid.

## 1. Final Decision

Provider Access no longer describes product protocols using a set of seemingly orthogonal, practically only executable specific Zhipu product optional fields. Formal structure retains only two first-level
Access Types:

```ts
type ProviderAccessConfig = ApiKeyAccessConfig | ZhipuAccountAccessConfig;

interface ApiKeyAccessConfig {
  readonly type: "api-key";
  readonly apiKey?: string | null;
  readonly apiKeyManagementUrl?: string | null;
}

type ZhipuAccountMode =
  | "api-key"
  | "start-plan"
  | "individual-coding-plan"
  | "team-coding-plan"
  | "off-peak";

interface ZhipuAccountAccessConfig {
  readonly type: "zhipu-account";
  readonly family?: "zai" | "bigmodel" | null;
  readonly mode?: ZhipuAccountMode | null;
}
```

This round's `mode` is just a regular enum value, not establishing second-level objects, second-level Class, or second-level discriminated union:

```json
{
  "type": "zhipu-account",
  "family": "bigmodel",
  "mode": "team-coding-plan"
}
```

Zhipu product-specific access policies are dispatched only by `access.type + access.mode`; `family` continues providing access system parameters,
Provider API Config continues providing Endpoint and API protocols. The following pseudo-universal options must no longer be exposed or persisted:

```text
planKind
challenge
requestSigning
executionProtocol
execution-provided
```

This is not moving protocol facts back to Provider ID, Model ID, or URL, but making finite, real Zhipu access varieties the formal Config discriminant facts.

## 2. Design Principles

### 2.1 Type and Mode Express Real Access Products

```text
access.type
├─ api-key
│  └─ Ordinary model service static API Key access
│
└─ zhipu-account
   ├─ family = zai | bigmodel
   └─ mode
      ├─ api-key
      ├─ start-plan
      ├─ individual-coding-plan
      ├─ team-coding-plan
      └─ off-peak
```

`zhipu-account` here represents Zhipu account and product access system, including entries with account-provided API Key in fixed Family.
It does not mean Provider Config manages dynamic account credentials; specific API Key, JWT, Ticket, and Team scope are still resolved by current
Environment's Account/Credential Service.

### 2.2 Do Not Create Universal Config Fields for Single Product Behavior

- Official release access security validation belongs only to `zhipu-account/start-plan`;
- ZCode V4 static admission belongs only to `zhipu-account/api-key`, `individual-coding-plan`, and `team-coding-plan`;
- Off-Peak queueing, Ticket expiry, and retry belong only to `zhipu-account/off-peak`;
- Normal `api-key` never automatically enters ZCode V4 by Endpoint, Provider ID, or Model ID;
- Adding real access products creates new `mode` enum, strict Schema branch behavior, and exhaustive tests, does not shove optional fields to all Access.

### 2.3 Config Encapsulates Calls, Does Not Decide Authorization

Provider Config determines how client obtains request material, encapsulates model API calls, and interprets product protocols. It does not prove API Key, account, plan, or model permissions
valid, and does not bear final authorization. Whether current credentials are usable and whether requests are approved are respectively decided by current Environment's account/credential services and model servers.

### 2.4 Built-in Owns Zhipu Static Identity

For fixed Built-in Zhipu Providers:

```text
ZCode Built-in Provider Config
├─ access.type
├─ access.family
└─ access.mode
        |
        v
Account Overlay
├─ Does not modify Access
├─ Projects enabled for account state
└─ Start additionally projects account-specific builtinModelIds
        |
        v
Personal Overlay
└─ Only overrides User fields allowed by its Source Schema
```

`family/mode` are not Account Service dynamic state, nor settings page universal options. Account Connection provides only current login, current connection, plan,
Team scope, and credential state. Personal continues as the last overlay layer, but does not thereby gain authority to rewrite Built-in `group/family/mode` source-specific facts. Fixed `account:*` Provider
Personal Overlay does not write `access`; manually entered API Key belongs only to normal
`api-key` Providers.

## 3. Built-in Provider Exact Mapping

### 3.1 Regular API Provider

The following Providers are normal settings entries, not using ZCode V4:

| Provider ID    | Access                | V4  |
| -------------- | --------------------- | --- |
| `zai-api`      | `{ type: "api-key" }` | No  |
| `bigmodel-api` | `{ type: "api-key" }` | No  |

They continue maintaining `group="standard-builtin"`, managed by normal "Add Supplier" flow, isolated from Family Provider's Account Connection,
account credentials, enabled, and fixed ordering.

### 3.2 Family API Key Provider

| Provider ID                | Access                                           | V4  |
| -------------------------- | ------------------------------------------------ | --- |
| `account:zai-api-key`      | `zhipu-account / family=zai / mode=api-key`      | Yes |
| `account:bigmodel-api-key` | `zhipu-account / family=bigmodel / mode=api-key` | Yes |

They belong to fixed Family UI. Built-in only declares `type/family/mode`; actual API Key provided by current account system,
parsed by Account/Credential Service at request period, not written to Personal Config, Account Overlay, Registry, or Active Model.

Current unreleased implementation made these two `account:*` Providers also manually input API Key, and saved Key to Personal
Config. This is the intermediate state this Todo needs to directly replace, not the target product contract.

Implementation correction see [`Bugfix 09: Account API Key Ownership Drift Cleanup`](./bugfix-09-account-api-key-ownership-drift.md): Account API
settings page, Family mode restore logic, and Welcome hand-filled Key entry no longer treat account Providers as normal API Key
Providers, write boundary mechanically rejects fixed Account Provider's Personal `access` simultaneously.

### 3.3 Coding Plan, Start, and Off-Peak

| Product Entry                          | Access Mode              | Static Behavior                                                                          |
| -------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| Z.ai / BigModel Start Plan             | `start-plan`             | Official release security validation material chain; does not enter V4                   |
| Z.ai / BigModel Individual Coding Plan | `individual-coding-plan` | Current connection request auth; has V4 static admission                                 |
| Z.ai / BigModel Team Coding Plan       | `team-coding-plan`       | Current Team scope and request auth; has V4 static admission                             |
| Z.ai / BigModel Idle Plan              | `off-peak`               | Execution-period JWT, Plan Key, Ticket, and Off-Peak failure protocol; does not enter V4 |

Each Provider retains existing precise Provider ID, `group`, `visibility`, Endpoint, and model members. Fixed IDs continue for Provider identity,
ModelSelection, and task persistence, not used to guess Mode.

## 4. Config, Schema, and Overlay

### 4.1 Source Schema Ownership

| Source          | Access facts allowed to write                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| ZCode Built-in  | Complete `type`; Zhipu Provider's complete `family + mode`; normal API Provider's Key management entry      |
| Account Overlay | Not allowed to write or replace `access`                                                                    |
| Personal        | Only normal/Personal `api-key` Provider's API Key Access; fixed `account:*` does not allow writing `access` |

Formal Schema must strictly reject source-violating fields. Settings page does not display Zhipu `family/mode` editor, nor expose official release security validation, V4, or Off-Peak as
advanced boolean toggles.

### 4.2 Sparse Config and Complete Effective

This round does not establish second-level Mode union. Sparse Config can still have allowed leaves default or explicitly `null`, but Effective Access must be complete:

```text
api-key
├─ type complete
└─ enabled Provider execution has non-empty API Key

zhipu-account/all Modes
├─ family complete
├─ mode complete
└─ no apiKey/apiKeyManagementUrl config fields exist
```

Account dynamic credential missing does not make static Provider Config structure incomplete; real requests fail at network front by Request Auth.

### 4.3 Overlay Rules

- Among Sources allowing `access` writing, when outer `access.type` matches, Overlay by that Access Class leaves;
- Normal/Personal Provider's outer `access.type` mismatch replaces entire Access branch;
- `mode` is regular enum leaf, no second-level merging or second-level replacement protocol;
- Fixed Built-in Zhipu Provider's `access` declared only by Built-in, Account/Personal produce no Access Overlay;
- Effective Config not independently persisted, cannot reverse-write back to Built-in, Account, or Personal Source.

## 5. Runtime-Only Dispatch

```text
Effective Provider Access
          |
          v
Active Model freezes type/family/mode
          |
          v
Each request attempt dispatches to unique Handler by type/mode
```

### 5.1 Regular API Key

```text
type=api-key
└─ Uses static API Key from Config
   └─ Ordinary Transport, does not enter ZCode V4
```

### 5.2 Family API Key

```text
type=zhipu-account, mode=api-key
├─ Parse account-provided API Key from current Family Account/Credential Service
├─ Does not read Personal Provider API Key
└─ Has ZCode V4 static admission
```

### 5.3 Start, Individual, and Team

```text
mode=start-plan
└─ Current compatible Start connection + official release security validation materials

mode=individual-coding-plan
└─ Current compatible Individual connection + Coding Plan Key + V4 static admission

mode=team-coding-plan
└─ Same current connection parsing product/org/project + Team Key + V4 static admission
```

Old Active Model only freezes static `type/family/mode`, each request allowing account service to parse material by current compatible connection and its own cache/refresh strategy. It does not bind
creation-time account, Team project, credentials, or connection version.

### 5.4 Off-Peak

```text
type=zhipu-account, mode=off-peak
├─ family directly from Access, not derived from provider.group
├─ Current compatible Individual/Team connection
├─ This execution injects JWT + Coding Plan Key + Ticket + Team Headers
└─ Adapter enables Off-Peak queueing, Ticket expiry, and resumption semantics
```

Off-Peak must parse Team scope and credentials from the same connection selection, and re-read or fail when account/selection changes, cannot splice two generations of materials.

### 5.5 ZCode V4

V4 static admission determined only by the following mode set:

```text
zhipu-account/api-key
zhipu-account/individual-coding-plan
zhipu-account/team-coding-plan
```

Official release request security validation dynamic release switch and protocol implementation unchanged (details maintained only in official release). Do not restore URL, pathname, Provider ID, or Model ID inference.

## 6. Account, Credential, and Authorization Boundaries

| Status or Fact                                     | Authoritative Owner                       | Enters Provider Config?        |
| -------------------------------------------------- | ----------------------------------------- | ------------------------------ |
| Built-in `type/family/mode`                        | ZCode Built-in Provider Config            | Yes                            |
| Current account, login state, and current Family   | Current Environment Account Service       | No                             |
| Current plan connection                            | Account Connection Selection              | No                             |
| Team product/org/project                           | Account Connection Selection              | No                             |
| Account identity and Credential Store physical Key | Credential Service private implementation | No                             |
| Account `enabled` and Start model projection       | Account Overlay                           | Yes, corresponding fields only |
| Manually entered normal API Key                    | Personal Provider Config                  | Yes, `api-key` only            |
| Account-provided API Key/JWT/Ticket/Headers        | Account/Credential/Request Auth           | No                             |
| V4 dynamic release switch                          | Remote Runtime Config                     | No                             |
| Final authorization result                         | Model server                              | No                             |

Production public Config, Registry, Active Model, Protocol, and UI must not re-introduce `accessId`, `accountConnectionVersion`,
`bindingId`, or account identity mirrors. Account/Credential Service can retain account isolation, LKG scope, physical Credential Key, and single-flight
required private identity; these internal keys must not cross into model static config.

Account last-known-good can only be reused within the same private account scope. When account scope has changed, old account Overlay must not continue providing enabled or
Start model set; waiting or fail-closed when new state parsing fails.

## 6.1 Implementation Results (2026-08-27)

- Provider Config and Runtime consolidated to `api-key | zhipu-account`, static Zhipu access uses `family + mode`.
- Built-in, Provider Schema, Registry, Active Model, Adapter, and Bootstrap deleted
  `execution-provided`, `planKind` static fields, `challenge`, `requestSigning`, and `executionProtocol`.
- Account Overlay only projects `enabled` and Start account model set; fixed `account:*` Provider Personal Source
  strictly rejects `access`.
- Dynamic `ZCodeAccountAccess.planKind` still expresses current account connection parse result, not Provider Config static field.
- Off-Peak retains fixed Provider ID, Group, and runtime Ticket/retry semantics; special behavior driven by
  `access.type=zhipu-account + mode=off-peak`.
- Passed Provider, Provider Node, Services, Adapter, and Bootstrap directed regression; Adapter full remaining 2 pre-existing failures (process descendant cleanup, Session Store old expected shape).

## 7. Environment Boundaries

Each execution Environment independently owns Provider and account facts:

```text
Environment Built-in/LKG
        +
Environment Account Overlay
        +
Environment Personal Config
        |
        v
Environment Registry / Active Model
        |
        v
Environment Account/Credential Service
```

Desktop Local, SSH, WSL, Docker, and Standalone Server all execute by target Environment local facts. Desktop does not push local
Provider Registry or account config to remote. This Todo does not change Remote Provisioning, workspace identity, desktop continuous, mobile
replayable, Session/Task Queue, Snapshot, or recovery semantics.

## 8. UI Surface Matrix

| User Scenario                   | Display/Draft Source                        | Submission or Run Owner           | This Todo Behavior                                                  | Must Isolate                                 |
| ------------------------------- | ------------------------------------------- | --------------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| Normal Provider settings        | Personal API Key Draft                      | Provider Settings Service         | `zai-api/bigmodel-api` maintains normal API Key, no V4              | Does not enter Family Account process        |
| Z.ai/BigModel Family API Key    | Account Connection and credential state     | Account/Credential + Request Auth | Built-in Mode fixed to `api-key`, no hand-filled Key                | Does not write Personal access               |
| Start login and request         | Account Connection + security validation UI | Account/Request Auth              | Only enters security validation by `mode=start-plan`                | Does not affect normal API Key               |
| Individual/Team request         | Account Connection                          | Request Auth + Adapter            | Parses current Key by Mode, has V4 admission                        | Does not freeze account or Team scope        |
| Off-Peak creation and execution | Fixed Provider Selection + current account  | Off-Peak Service + Adapter        | Executes by `mode=off-peak`                                         | Does not pollute normal Session Selection    |
| Usage/Entitlement               | Account/Subscription Service                | Usage Services                    | Does not reverse-deduce dynamic product state from Effective Access | Does not change refresh and billing strategy |

## 9. Implementation Slices

### Slice A: Formal Design and Failing Tests

1. Update configuration, runtime, settings, model creation, and access protocol Design with this Todo's two-level `type + mode enum`;
2. Mark Todo 24's three Access Types and universal protocol field structures as superseded by this Todo;
3. Update Feature Graph old invariants for `accessId`, universal protocol fields, and `request-auth`;
4. First add strict Schema, Source ownership, Built-in mapping, and runtime Mode dispatch failing tests.

### Slice B: Config, Schema, and Built-in

1. Delete universal protocol fields from `ApiKeyAccessConfig`;
2. Use `family + mode enum` in `ZhipuAccountAccessConfig`, delete `planKind`;
3. Delete `ExecutionProvidedAccessConfig` and `ProviderAccessProtocolInput`;
4. Update Source Schema, Overlay, serialization, Personal projection, and integrity validation;
5. Migrate all Built-in Providers; `zai-api/bigmodel-api` explicitly maintains normal API Key and no V4;
6. Family API Key, Individual, Team, Start, and Off-Peak write accurate Mode;
7. `ZhipuAccountAccessConfig` does not declare API Key fields, Personal Source does not allow writing `access` for fixed `account:*`.

### Slice C: Account and Request-Period Auth

1. Account Resolver handles only `zhipu-account`, exhausts availability by `mode`; Start additionally projects account model set;
2. Account Overlay no longer recognizes `execution-provided`, `planKind`, or universal protocol fields;
3. Request Auth parses current connection by `family + mode`; `mode=api-key` takes account-provided API Key, does not read Personal Config;
4. Team and Off-Peak maintain same-selection scope/credential consistency;
5. Account LKG adds or retains private account scope anti-cross-use, not entering public chain.

### Slice D: Protocol, Active Model, and Adapter

1. Shared/Agent Protocol uses same `type/family/mode` structure;
2. Active Model freezes complete Effective Access as-is, creates no capability DTO;
3. Adapter selects static Key, Request Auth, official release security validation, and Off-Peak Handler by Mode;
4. Delete runtime consumption of `requestSigning`, `challenge`, `executionProtocol`, `execution-provided`;
5. Retain V4 dynamic rollout and Signer protocol implementation, do not restore any URL/ID/path business judgment.

### Slice E: Services, UI, and Cleanup

1. Official release security validation UI changed to recognize `zhipu-account/start-plan`;
2. Family UI only displays Built-in Mode corresponding product entries, does not provide Mode or API Key editing controls;
3. Existing Family login API Key form no longer persists Personal API Key to `account:*`; manual Key enters only normal
   `zai-api/bigmodel-api` Provider's Personal Config;
4. Off-Peak selection continues using fixed Provider ID, access behavior only looks at Mode;
5. Usage/Entitlement continues reading Account/Subscription, does not reverse-deduce dynamic state from Access;
6. Synchronize current Design, Feature Graph, step index, and Todo 24 superseded notes.

## 10. Test Plan and Acceptance Cases

### 10.1 Config and Source Boundaries

- Two first-level Access Types strict parsing, Overlay, `null`, and JSON round-trip;
- `zhipu-account.mode` five enum values fully parsed;
- Formal Schema rejects `planKind/challenge/requestSigning/executionProtocol/execution-provided`;
- Account Schema rejects `access`; Personal Schema rejects writing any `access` for fixed `account:*`;
- All Modes of `zhipu-account` reject `apiKey/apiKeyManagementUrl`;
- Effective Access missing `family/mode` cannot enter Registry.

### 10.2 Built-in Mapping

- `zai-api/bigmodel-api` are normal `api-key` and do not enter V4;
- Two Family API Key Providers are `zhipu-account/api-key`;
- Start, Individual, Team, Off-Peak Z.ai/BigModel Providers all declare correct Family/Mode;
- Built-in JSON does not contain real API Key and old protocol fields.

### 10.3 Runtime Vertical Proof

- Normal API Key uses static Key, ordinary Transport;
- Family API Key parses Key from current Account/Credential Service, does not read Personal Config, only enters request security validation when dynamic switch enabled;
- Manual `zai-api/bigmodel-api` does not call Account Request Auth, does not enter security validation even when dynamic switch enabled;
- Start only enters official release access security validation chain;
- Individual/Team each parses current compatible connection and enters security validation by dynamic switch;
- Team account or project switching uses current parsed scope/key;
- Off-Peak injects JWT/Key/Ticket, enables existing queue/expiry semantics, does not enter security validation;
- Fails at network front when current connection incompatible or material missing;
- Registry update only affects subsequently created Models, old Model static Access unchanged but can parse current compatible credentials.

### 10.4 State and Cross-Environment

- Same account refresh failure can retain LKG; account switching refresh failure must not reuse old account Overlay;
- Account Overlay and corresponding Built-in revision atomically published;
- Local, SSH/WSL/Docker, and Standalone use target Environment's Provider/Account services;
- ModelSelection, normal queue, Off-Peak task identity, and desktop/mobile recovery boundaries unchanged.

## 11. Mechanical Zero

At production public chain must at minimum satisfy:

```text
access.planKind                              = 0
access.challenge                             = 0
access.requestSigning                        = 0
access.executionProtocol                     = 0
Access Type execution-provided               = 0
ProviderAccessProtocolInput                  = 0
ExecutionProvidedAccessConfig                = 0
Production public chain accessId                            = 0
Production public chain accountConnectionVersion            = 0
Inferring Access family from provider.group           = 0
Inferring V4 or Mode from URL/path/Provider ID/Model ID = 0
zai-api / bigmodel-api V4 admission              = 0
ZhipuAccountAccessConfig.apiKey                   = 0
ZhipuAccountAccessConfig.apiKeyManagementUrl      = 0
Fixed account:* Personal access               = 0
Parsing account API Key from Personal Config            = 0
```

Allowed retention:

- Historical implementation document old field evidence;
- Credential Service private account identity, physical Key, and LKG scope;
- Official release request security validation dynamic switch and internal protocol state;
- Off-Peak fixed Provider ID, task ID, Ticket marker, and existing state machine;
- Account Connection's own connection selection `kind`, but must not re-project as Provider `planKind`.

Mechanical checks must audit exceptions item by item, cannot hide production residues with broad allowlists.

## 12. Non-Goals and Invariants

This Todo does not handle:

- Remote Provisioning;
- Provider Release business integrity release gate;
- Real account and official artifact unified manual verification;
- Off-Peak string error protocol structuring;
- Model Properties, Reasoning, model selection, queue, or recovery refactoring;
- Second-level Mode discriminated union; only design separately when real Mode-specific structural extension needs arise.

Must maintain:

1. Provider Overlay order still ZCode Built-in -> Account -> Personal;
2. Account Overlay only constrains Built-in Zhipu Providers, does not handle Personal-only Providers;
3. Personal is the last override layer for allowed fields, but cannot break Source Schema to rewrite Built-in-specific identity;
4. Provider Config does not manage dynamic account credentials, does not bear server-side final authorization;
5. Active Model static facts immutable, request-period account material allowed to parse by current compatible connection;
6. `provider.group` only responsible for display classification, `access.family` only responsible for Zhipu access system;
7. Normal `zai-api/bigmodel-api` saves manual Key and has no V4; Family API Key Provider only uses account-provided Key and can enter V4;
8. Off-Peak fixed ID, group, hidden visibility, and task selection identity continue retained;
9. No new second Registry, Access capability DTO, credential center, or execution-specific Model.

## 13. Completion Definition

Completion requires all the following conditions met:

1. Two first-level Access Types and Zhipu Mode enum enter formal Config, Schema, Registry, Protocol, and Adapter;
2. All Built-in Providers migrated to correct type and Mode, regular Z.ai/BigModel API explicitly exits V4, Family API Key
   explicitly changed to account credential source;
3. Account Overlay, Request Auth, official release security validation, Off-Peak all dispatch only by `type/mode`;
4. Old universal protocol fields and `execution-provided` production mechanical zero completed;
5. Account private LKG scope prevents cross-account reuse, but no public account binding re-enters model chain;
6. Environment-local Provider/Account authority and existing Overlay atomicity unchanged;
7. Current Design, Feature Graph, Todo 24 superseded notes, and implementation facts consistent;
8. Provider, Provider Node, Services, Shared, Adapter, Bootstrap, UI directed tests passed;
9. `pnpm typecheck`, `pnpm lint`, related format checks, `pnpm knip`, and mechanical residue checks passed;
10. Affected normal API Key, Family API Key, Start, Individual, Team, Off-Peak, and Remote Environment regression passed,
    submitted with Conventional Commit.
