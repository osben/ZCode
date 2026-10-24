# Todo 26: Zhipu Access Mode Contract Cutover and Pseudo-Universal Protocol Field Retirement

> Status: Completed
>
> Date: 2026-08-27
>
> Prerequisite: Todo 24 completed `accessId`, account creation binding and request security validation pathname
> special-case cleanup. Based on later product decisions, this Todo replaces Todo 24's `api-key / zhipu-account /
> execution-provided` three Access types, `planKind` and the `challenge / requestSigning / executionProtocol`
> universal field structure. Todo 24's conclusions on account dynamic auth, Account Overlay narrowing, private
> Credential isolation and server-side final authorization remain valid.

## 1. Final Decision

Provider Access no longer describes product protocols with seemingly orthogonal optional fields that only specific
Zhipu products can execute. Only two first-level Access Types remain:

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

`mode` is a regular enum value, not a second-level object, class or discriminated union:

```json
{
  "type": "zhipu-account",
  "family": "bigmodel",
  "mode": "team-coding-plan"
}
```

Zhipu product-specific access policy is dispatched only by `access.type + access.mode`; `family` provides access
system parameters, Provider API Config provides Endpoint and API protocols. These pseudo-universal options must no
longer be exposed or persisted: `planKind`, `challenge`, `requestSigning`, `executionProtocol`,
`execution-provided`. Protocol facts do not move back to Provider ID, Model ID or URL; finite, real Zhipu access
varieties become formal Config discriminant facts.

## 2. Design Principles

### 2.1 Type and mode express real access products

```text
access.type
├─ api-key
│  └─ Ordinary model service static API key access
└─ zhipu-account
   ├─ family = zai | bigmodel
   └─ mode: api-key | start-plan | individual-coding-plan | team-coding-plan | off-peak
```

`zhipu-account` represents the Zhipu account and product access system, including the account-provided API key
entries in fixed Family. Provider Config does not manage dynamic account credentials; API key, JWT, Ticket and Team
scope are resolved by the current Environment's Account/Credential Service.

### 2.2 No universal Config fields for single-product behavior

- Official release access security validation belongs only to `zhipu-account/start-plan`.
- ZCode V4 static admission belongs only to `zhipu-account/api-key`, `individual-coding-plan`,
  `team-coding-plan`.
- Off-Peak queueing, Ticket expiry and retry belong only to `zhipu-account/off-peak`.
- Normal `api-key` never enters ZCode V4 by Endpoint, Provider ID or Model ID.
- A new real access product adds a new `mode` enum value, a strict Schema branch behavior and exhaustive tests; it
  does not push optional fields onto all Access.

### 2.3 Config encapsulates calls, does not decide authorization

Provider Config determines how the client obtains request material, encapsulates model API calls and interprets
product protocols. It does not prove API key, account, plan or model permission valid and bears no final
authorization: usability of current credentials is decided by the current Environment's account/credential services
and approval by the model server.

### 2.4 Built-in owns Zhipu static identity

```text
ZCode Built-in Provider Config: access.type / access.family / access.mode
        v
Account Overlay: does not modify Access; projects enabled; Start also projects account-specific builtinModelIds
        v
Personal Overlay: only fields its Source Schema allows
```

`family/mode` are not Account Service dynamic state nor general settings options. Account Connection provides only
current login, connection, plan, Team scope and credential state. Personal stays the last overlay layer but gains no
authority to rewrite Built-in `group/family/mode`. Fixed `account:*` Providers' Personal Overlay does not write
`access`; a manually entered API key belongs only to normal `api-key` Providers.

## 3. Built-in Provider Exact Mapping

### 3.1 Regular API Provider (normal settings entries, no ZCode V4)

| Provider ID    | Access                | V4  |
| -------------- | --------------------- | --- |
| `zai-api`      | `{ type: "api-key" }` | No  |
| `bigmodel-api` | `{ type: "api-key" }` | No  |

They keep `group="standard-builtin"`, are managed by the normal "Add Supplier" flow, and are isolated from Family
Provider's Account Connection, account credentials, enabled and fixed ordering.

### 3.2 Family API Key Provider

| Provider ID                | Access                                           | V4  |
| -------------------------- | ------------------------------------------------ | --- |
| `account:zai-api-key`      | `zhipu-account / family=zai / mode=api-key`      | Yes |
| `account:bigmodel-api-key` | `zhipu-account / family=bigmodel / mode=api-key` | Yes |

They belong to the fixed Family UI. Built-in declares only `type/family/mode`; the actual API key is provided by the
current account system and resolved by Account/Credential Service at request time; it is not written to Personal
Config, Account Overlay, Registry or Active Model. (An unreleased intermediate state had these two Providers accept
hand-entered keys saved to Personal Config; that was replaced. Correction in
[`Bugfix 09: Account API Key Ownership Drift Cleanup`](./bugfix-09-account-api-key-ownership-drift.md): Account API
settings, Family mode restore logic and the Welcome hand-filled key entry no longer treat account Providers as normal
API key Providers, and the write boundary mechanically rejects Personal `access` on fixed Account Providers.)

### 3.3 Coding Plan, Start and Off-Peak

| Product entry                          | Access mode              | Static behavior                                                                          |
| -------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| Z.ai / BigModel Start Plan             | `start-plan`             | Official release security validation material chain; no V4                               |
| Z.ai / BigModel Individual Coding Plan | `individual-coding-plan` | Current connection request auth; V4 static admission                                     |
| Z.ai / BigModel Team Coding Plan       | `team-coding-plan`       | Current Team scope and request auth; V4 static admission                                 |
| Z.ai / BigModel Idle Plan              | `off-peak`               | Execution-period JWT, Plan Key, Ticket and Off-Peak failure protocol; no V4              |

Each Provider keeps its exact Provider ID, `group`, `visibility`, Endpoint and model members. Fixed IDs remain for
Provider identity, ModelSelection and task persistence, not for guessing Mode.

## 4. Config, Schema and Overlay

### 4.1 Source Schema ownership

| Source          | Access facts allowed to write                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| ZCode Built-in  | Complete `type`; Zhipu Provider's complete `family + mode`; normal API Provider's Key management entry |
| Account Overlay | Not allowed to write or replace `access`                                                               |
| Personal        | Only normal/Personal `api-key` Provider's API key Access; fixed `account:*` does not allow `access`    |

The formal Schema strictly rejects source-violating fields. The settings page shows no Zhipu `family/mode` editor
and exposes official release security validation, V4 or Off-Peak as no advanced boolean toggle.

### 4.2 Sparse Config, complete Effective

Sparse Config may have allowed leaves default or explicitly `null`; Effective Access must be complete:

```text
api-key
├─ type complete
└─ enabled Provider execution has non-empty API key

zhipu-account / all Modes
├─ family complete
├─ mode complete
└─ no apiKey/apiKeyManagementUrl config fields exist
```

A missing account dynamic credential does not make static Provider Config incomplete; real requests fail before the
network in Request Auth.

### 4.3 Overlay rules

- Among Sources allowed to write `access`, when outer `access.type` matches, Overlay by that Access class's leaves.
- For normal/Personal Providers, a mismatching outer `access.type` replaces the whole Access branch.
- `mode` is a regular enum leaf; no second-level merge or replacement protocol.
- A fixed Built-in Zhipu Provider's `access` is declared only by Built-in; Account/Personal produce no Access
  Overlay.
- Effective Config is not persisted independently and is never written back to Built-in, Account or Personal Source.

## 5. Runtime-Only Dispatch

```text
Effective Provider Access -> Active Model freezes type/family/mode -> each request attempt dispatches to a unique Handler by type/mode
```

- `type=api-key`: static API key from Config, ordinary Transport, no V4.
- `type=zhipu-account, mode=api-key`: resolve the account-provided key from the current Family Account/Credential
  Service; never read the Personal Provider key; V4 static admission.
- `mode=start-plan`: current compatible Start connection + official release security validation materials.
- `mode=individual-coding-plan`: current compatible Individual connection + Coding Plan Key + V4 static admission.
- `mode=team-coding-plan`: same current connection resolving product/org/project + Team Key + V4 static admission.
- `mode=off-peak`: `family` comes from Access (not derived from `provider.group`); current compatible
  Individual/Team connection; this execution injects JWT + Coding Plan Key + Ticket + Team Headers; the Adapter
  enables Off-Peak queueing, Ticket expiry and resumption. Off-Peak resolves Team scope and credentials from the same
  connection selection and re-reads or fails when account/selection changes; it never splices two generations of
  material.

The old Active Model freezes only static `type/family/mode`; each request lets the account service resolve material
by current compatible connection with its own cache/refresh strategy. It does not bind creation-time account, Team
project, credentials or connection version.

V4 static admission is determined only by the mode set `zhipu-account/api-key`, `zhipu-account/individual-coding-plan`,
`zhipu-account/team-coding-plan`. The official release request security validation dynamic switch and protocol
implementation are unchanged (details maintained only in official release). No URL, pathname, Provider ID or Model ID
inference.

## 6. Account, Credential and Authorization Boundaries

| Status or fact                                     | Authoritative owner                       | Enters Provider Config?        |
| -------------------------------------------------- | ----------------------------------------- | ------------------------------ |
| Built-in `type/family/mode`                        | ZCode Built-in Provider Config            | Yes                            |
| Current account, login state, and current Family   | Current Environment Account Service       | No                             |
| Current plan connection                            | Account Connection Selection              | No                             |
| Team product/org/project                           | Account Connection Selection              | No                             |
| Account identity and Credential Store physical key | Credential Service private implementation | No                             |
| Account `enabled` and Start model projection       | Account Overlay                           | Yes, corresponding fields only |
| Manually entered normal API key                    | Personal Provider Config                  | Yes, `api-key` only            |
| Account-provided API key/JWT/Ticket/Headers        | Account/Credential/Request Auth           | No                             |
| V4 dynamic release switch                          | Remote Runtime Config                     | No                             |
| Final authorization result                         | Model server                              | No                             |

Production public Config, Registry, Active Model, Protocol and UI must not re-introduce `accessId`,
`accountConnectionVersion`, `bindingId` or account identity mirrors. Account/Credential Service may keep private
account isolation, LKG scope, physical Credential key and single-flight identity, but these never cross into static
model config. Account last-known-good is reused only within the same private account scope; after the account scope
changes an old Account Overlay must not keep providing enabled or the Start model set, and a failed new-state
resolution waits or fails closed.

## 7. Environment Boundaries

Each execution Environment independently owns Provider and account facts:
Environment Built-in/LKG + Environment Account Overlay + Environment Personal Config -> Environment Registry / Active
Model -> Environment Account/Credential Service. Desktop Local, SSH, WSL, Docker and Standalone Server execute by the
target Environment's local facts; Desktop does not push local Provider Registry or account config to remote. Remote
Provisioning, workspace identity, desktop continuous, mobile replayable, Session/Task Queue, Snapshot and recovery
are unchanged.

## 8. UI Surface Matrix

| Scenario                        | Display/Draft source                        | Submission or run owner           | Behavior                                                          | Must isolate                                 |
| ------------------------------- | ------------------------------------------- | --------------------------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| Normal Provider settings        | Personal API key Draft                      | Provider Settings Service         | `zai-api/bigmodel-api` keep normal API key, no V4                 | Does not enter Family Account process        |
| Z.ai/BigModel Family API key    | Account Connection and credential state     | Account/Credential + Request Auth | Built-in Mode fixed to `api-key`, no hand-filled key              | Does not write Personal access               |
| Start login and request         | Account Connection + security validation UI | Account/Request Auth              | Enters security validation only by `mode=start-plan`              | Does not affect normal API key               |
| Individual/Team request         | Account Connection                          | Request Auth + Adapter            | Resolves current key by Mode, has V4 admission                    | Does not freeze account or Team scope        |
| Off-Peak creation and execution | Fixed Provider Selection + current account  | Off-Peak Service + Adapter        | Executes by `mode=off-peak`                                       | Does not pollute normal Session Selection    |
| Usage/Entitlement               | Account/Subscription Service                | Usage Services                    | Does not reverse-deduce dynamic product state from Effective Access | Does not change refresh and billing strategy |

Implementation record (2026-08-27): Provider Config and Runtime consolidated to `api-key | zhipu-account`, static
Zhipu access uses `family + mode`; Built-in, Provider Schema, Registry, Active Model, Adapter and Bootstrap deleted
`execution-provided`, static `planKind`, `challenge`, `requestSigning`, `executionProtocol`. Account Overlay projects
only `enabled` and the Start account model set; fixed `account:*` Personal Source strictly rejects `access`. Dynamic
`ZCodeAccountAccess.planKind` still expresses the current account connection resolution result, not a Provider
Config static field. Off-Peak keeps fixed Provider ID, Group and runtime Ticket/retry semantics, driven by
`access.type=zhipu-account + mode=off-peak`. Provider, Provider Node, Services, Adapter and Bootstrap directed
regressions passed; Adapter full run had 2 pre-existing failures (process descendant cleanup, Session Store old
expected shape).

## 9. Acceptance Cases

### 9.1 Config and Source boundaries

- Two first-level Access Types: strict parsing, Overlay, `null`, JSON round-trip.
- `zhipu-account.mode` five enum values fully parsed.
- Formal Schema rejects `planKind/challenge/requestSigning/executionProtocol/execution-provided`.
- Account Schema rejects `access`; Personal Schema rejects any `access` for fixed `account:*`.
- All Modes of `zhipu-account` reject `apiKey/apiKeyManagementUrl`.
- Effective Access missing `family/mode` cannot enter Registry.

### 9.2 Built-in mapping

- `zai-api/bigmodel-api` are normal `api-key` and do not enter V4.
- The two Family API Key Providers are `zhipu-account/api-key`.
- Start, Individual, Team and Off-Peak Z.ai/BigModel Providers all declare correct Family/Mode.
- Built-in JSON contains no real API key and no old protocol fields.

### 9.3 Runtime vertical proof

- Normal API key uses the static key, ordinary Transport.
- Family API key resolves the key from the current Account/Credential Service, does not read Personal Config, and
  enters request security validation only when the dynamic switch is on.
- Manual `zai-api/bigmodel-api` does not call Account Request Auth and never enters security validation even with the
  switch on.
- Start enters only the official release access security validation chain.
- Individual/Team each resolve the current compatible connection and enter security validation by dynamic switch.
- Team account or project switching uses the currently resolved scope/key.
- Off-Peak injects JWT/Key/Ticket, enables existing queue/expiry semantics, does not enter security validation.
- Fails before the network when the current connection is incompatible or material is missing.
- A Registry update affects only later-created Models; old Model static Access is unchanged but can resolve current
  compatible credentials.

### 9.4 State and cross-Environment

- Same-account refresh failure can keep LKG; after account switching a refresh failure must not reuse the old
  account's Overlay.
- Account Overlay and the matching Built-in revision are published atomically.
- Local, SSH/WSL/Docker and Standalone use the target Environment's Provider/Account services.
- ModelSelection, normal queue, Off-Peak task identity and desktop/mobile recovery boundaries are unchanged.

## 10. Mechanical Zero

```text
access.planKind                                  = 0
access.challenge                                 = 0
access.requestSigning                            = 0
access.executionProtocol                         = 0
Access Type execution-provided                   = 0
ProviderAccessProtocolInput                      = 0
ExecutionProvidedAccessConfig                    = 0
Production public chain accessId                 = 0
Production public chain accountConnectionVersion = 0
Inferring Access family from provider.group      = 0
Inferring V4 or Mode from URL/path/Provider ID/Model ID = 0
zai-api / bigmodel-api V4 admission              = 0
ZhipuAccountAccessConfig.apiKey                  = 0
ZhipuAccountAccessConfig.apiKeyManagementUrl     = 0
Fixed account:* Personal access                  = 0
Parsing account API key from Personal Config     = 0
```

Allowed retention: historical implementation docs' old field evidence; Credential Service private account identity,
physical key and LKG scope; official release request security validation dynamic switch and internal protocol state;
Off-Peak fixed Provider ID, task ID, Ticket marker and existing state machine; Account Connection's own connection
selection `kind` (never re-projected as Provider `planKind`). Exceptions are audited item by item; broad allowlists
may not hide production residues.

## 11. Non-Goals and Invariants

Not handled: Remote Provisioning; Provider Release business-integrity release gate; real account and official
artifact unified manual verification; structuring Off-Peak string errors; Model Properties, Reasoning, model
selection, queue or recovery refactoring; a second-level Mode discriminated union (design separately only when a
real Mode-specific structural extension appears).

Invariants:

1. Provider Overlay order stays ZCode Built-in -> Account -> Personal.
2. Account Overlay constrains only Built-in Zhipu Providers, never Personal-only Providers.
3. Personal is the last override layer for allowed fields but cannot break Source Schema to rewrite Built-in-specific
   identity.
4. Provider Config does not manage dynamic account credentials nor bear server-side final authorization.
5. Active Model static facts are immutable; request-time account material resolves by the current compatible
   connection.
6. `provider.group` is only display classification; `access.family` is only the Zhipu access system.
7. Normal `zai-api/bigmodel-api` save a manual key and have no V4; Family API key Providers use only the
   account-provided key and can enter V4.
8. Off-Peak fixed ID, group, hidden visibility and task selection identity are retained.
9. No new second Registry, Access capability DTO, credential center or execution-specific Model.

## 12. Completion Definition

Two first-level Access Types and the Zhipu Mode enum are in formal Config, Schema, Registry, Protocol and Adapter; all
Built-in Providers are on the correct type and Mode (regular Z.ai/BigModel API exits V4, Family API key uses account
credential source); Account Overlay, Request Auth, official release security validation and Off-Peak dispatch only by
`type/mode`; old universal protocol fields and `execution-provided` are mechanically zero in production; Account
private LKG scope prevents cross-account reuse without re-introducing public account binding into the model chain;
Environment-local Provider/Account authority and Overlay atomicity are unchanged; current Design, Feature Graph and
Todo 24 superseded notes match the implementation; Provider, Provider Node, Services, Shared, Adapter, Bootstrap, UI
directed tests, `pnpm typecheck`, `pnpm lint`, format checks, `pnpm knip`, mechanical residue checks and affected
regression (normal API key, Family API key, Start, Individual, Team, Off-Peak, Remote Environment) pass.
