# 07 Account Connection Selection and Access Context Closure

> Status: Completed
>
> Date: 2026-08-24
>
> Source review: [`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> Target design: [`../design/registry/configuration.md`](../design/registry/configuration.md),
> [`../design/registry/runtime.md`](../design/registry/runtime.md),
> [`../design/registry/model-creation.md`](../design/registry/model-creation.md)
>
> Prerequisite: [`todo-03-provider-model-ownership-and-property-totality.md`](./todo-03-provider-model-ownership-and-property-totality.md)
> establishes the unique Registry complete type boundary; this task strengthens structured `zhipu-account` access and
> integrity in place.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-07-account-connection-selection-and-access-context-cutover.md`

## 0. Actual Deliverables

- Settings save only `providerFamilyConnectionSelections`; the old mode/selected-key dual state is out of the formal
  production chain.
- Start, Individual and Team are declared by Built-in Providers themselves with fixed `family + planKind`; the Account
  Resolver produces the complete Account Overlay from structured selection with no runtime Provider-ID-to-plan table.
- An enabled Account Provider's complete Access is fixed into the Registry/Active Model; request authentication consumes
  only that structure; `accessId` stays opaque to consumers.
- Off-Peak and Official MCP consume complete Account Access (no connection-key parsing, no scoped/unscoped ID
  comparison).
- Account `accessId`, credential caching, account switch invalidation and Team scope are handled by the same
  Credential/Auth chain.
- Old Settings fields and old string keys exist only in tests / one-time migration inputs and never enter current
  AppSettings, Protocol, Registry or Request Auth.

## 1. Objective

Converge Provider Family user connection selection, Account Connection facts, Account Built-in Provider Config and
request-period authentication into one structured chain; delete `selectedConnectionKey` and the implicit protocols
formed by parsing `accessId` strings. Before: AppSettings `modelProviderFamilyModes[family]` +
`modelProviderFamilySelectedKeys[family]` (`preset:/coding-plan:/team-plan:` strings) were each parsed / matched /
rebased / `startsWith`-ed by Account Resolver, Settings / Usage, Off-Peak / MCP and Task / Session, and scoped
`accessId` re-encoded account identity. Target: `AppSettings.providerFamilyConnectionSelections` (structured intent) ->
Account Connection Resolver (current account as internal fact, entitlement / availability, selected structured
connection) -> Account Connection Result (status, resolved access `{ family, planKind, Team scope?, opaque accessId }`,
models?) -> Account Built-in Provider Config -> Registry / Model fixed Account Access, Request Auth, Off-Peak, Official
MCP. This is not renaming `selectedConnectionKey` nor moving the string parser into a helper: Settings save structured
intent only, the Resolver is the sole interpreter, and execution consumers read the Account Access already resolved in
Provider Config. Todo 03's `RegistryProviderConfig` first narrows on the then-existing Access Schema; this task changes
`ZhipuAccountAccessConfig` and synchronously expands `CompleteProviderAccessConfig`, `requireComplete` and the complete
serialization contract.

## 2. Confirmed Decisions

**2.1 Structured single field for user selection.** `modelProviderFamilyModes` and `modelProviderFamilySelectedKeys` are
replaced by

```ts
type ProviderFamilyConnectionSelection =
  | { kind: "api-key"; providerId: string }
  | { kind: "start-plan" }
  | { kind: "individual-coding-plan" }
  | { kind: "team-coding-plan"; productId: string; organizationId: string; projectId: string };
interface AppSettings {
  providerFamilyConnectionSelections?: Partial<Record<ProviderFamilyDomain, ProviderFamilyConnectionSelection>>;
}
```

`kind` already contains API Key/OAuth and plan form (no separate mode). `providerFamilyDomain` keeps expressing the
currently activated Provider Family (not deleted or merged here). Account Plan selection stores no Built-in Provider ID
and does not infer plan from it: Family, `kind` and Team Scope are structured inputs for the Resolver; API Key selection
keeps the user's actually selected Provider ID; the current logged-in account participates in resolution inside the
Account Connection Service and never enters Settings or Provider Config.

**2.2 Start, Individual and Team are independent Built-in Providers** (each with fixed `access.family` and
`access.planKind`; none morphs between Individual and Team). Normal Settings flow selects one mutually exclusive account
connection within a Family; the Account Built-in Overlay supplements Access for Providers matching `family + planKind`
and sets them enabled, while other account Providers are set disabled; the Resolver scans Built-in-declared Access with
no Start/Individual/Team Provider ID mapping table. Individual and Team may declare the same model ID (Registry identity
stays `providerId + modelId`; only one Provider is enabled normally, so Selection shows only models under the current
connection; users may enable several via Personal Config by normal Config semantics with no source permission checks).
Built-in identities: `builtin:zai-start-plan`, `builtin:zai-individual-coding-plan`, `builtin:zai-team-coding-plan`,
`builtin:bigmodel-start-plan`, `builtin:bigmodel-individual-coding-plan`, `builtin:bigmodel-team-coding-plan`. Old
`builtin:*-coding-plan` exists only in the one-time Settings/Personal/Selection importer: it maps to the new Provider
when Individual vs Team is clear from the same structured selection; unidentifiable manual configurations produce clear
diagnostics, are not copied to both Providers, and no runtime alias is kept (importer and old ID constants are deleted
after the mandatory upgrade window).

**2.3 Account Connection is the connection-fact authority.** The Resolver reads current Family, structured selection,
logged-in account identity, entitlement, Credential Port and Plan API, and outputs per-Provider results:
`{ providerId, status: "available", access: CompleteZhipuAccountAccessConfig, models? }` or
`{ providerId, status: "unavailable" }`. Renderer, Usage, Off-Peak, Official MCP, Task and Session no longer interpret
Settings strings.

**2.4 Provider Config fixes structured Account Access:**

```ts
type ZhipuAccountAccessConfig =
  | { type: "zhipu-account"; accessId?: string | null; family: "zai" | "bigmodel";
      planKind: "start-plan" | "individual-coding-plan" }
  | { type: "zhipu-account"; accessId?: string | null; planKind: "team-coding-plan"; family: "zai" | "bigmodel";
      productId?: string | null; organizationId?: string | null; projectId?: string | null };
```

ZCode Built-in Provider Config declares fixed `family + planKind` first (Team Scope and every Plan's `accessId` may be
null); the Resolver combines them with Settings selection, current account and entitlement; the Account Built-in
Provider Config replaces the same Plan's Access with the complete one. The Registry requires an enabled Account
Provider's `accessId` non-null (Team also complete Scope). The Account Built-in Provider Config is an immutable snapshot
of execution-required Account Access; `accessId` is a stable non-sensitive connection identity that consumers must treat
as opaque (no recognizing Plan, Family, Team Scope or account identity from it). Current account identity is generated,
looked up and invalidated only inside the Account Connection Service; an account switch invalidates old `accessId`
credential acquisition; `accountIdentity` is not copied into Provider Config. The existing accessId byte format and
Credential Store key may stay (avoiding unnecessary credential migration); keeping the format does not permit continued
parsing, and after the compatibility window only truly needed old-format migration code remains in the Account
Source/Importer at one retirement point.

**2.5 UI editability is not Schema permission.** The settings page may hide Account Access or show Built-in fields
read-only, yet the Config Schema does not forbid users from writing them manually (Personal keeps using the general
overall Overlay). Schema and Registry check only structure, discriminant and Effective Config completeness, not whether
`accessId` or account fields originated from the Account Built-in Source; structurally complete but business-invalid
connections fail at Request Auth or server-side authentication; no Source permission system.

**2.6 Off-Peak and Official MCP belong to this task.** Both re-read Settings and parsed `selectedConnectionKey`; both
migrate to Account Connection / Effective Account Access (not left to M4). Off-Peak had an explicit bug candidate:
production `accessId` carries account scope while `selectedConnectionKey` does not, and the code compared them directly,
wrongly judging valid connections unavailable; the comparison is deleted without a "de-scope-then-compare" helper.

## 3. Impact Scope

`modelProviderFamilySelectedKeys` / `selectedConnectionKey` appeared in at least 37 non-test files (18 UI, 11 Services,
5 Shared, 3 Desktop).

| Scope                      | Previous responsibility                              | Target                                           |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| AppSettings / Schema       | Persist mode and string key                          | Single structured selection                      |
| Provider Settings          | Navigation, switch, restore, pending state           | Edit structured selection                        |
| Account Resolver           | Parse Plan/Team key and generate accessId            | Look up connection by Access fields              |
| Request Auth               | Identify Plan, account, Team Scope from accessId     | Consume complete Account Access                  |
| Usage / Entitlement        | Query context from selected key                      | Consume Account Connection View                  |
| Session / Task / Repo Wiki | Layer-by-layer passthrough of selected keys          | Delete passthrough; use Registry/Account Service |
| Off-Peak                   | Parse Settings, compare two IDs                      | Consume current Account Access                   |
| Official MCP               | Re-parse Plan and Team Scope                         | Consume current Account Access                   |
| Desktop remote host        | Temporarily construct selected key map for Team Key  | Pass structured Account Access directly         |

UI surface: switching API Key/plan connection happens in Provider Settings (local pending selection -> AppSettings,
single submit of structured selection; Personal Provider Config unchanged); viewing the current connection uses the
Account Connection View (no accessId/key parsing; dynamic quotas stay out of the Registry); the Composer model control
shows candidates from the Registry only and never switches connections; the Off-Peak entry's Host consumes Account
Access (credentials never to the Renderer); OAuth login restore writes structured selection (Settings mount does not
reorder valid selections). Automation, Subagent and Repo Wiki only share Registry model candidates and own no Account
Connection selection (the selected-key passthrough there was bridge code to delete).

State owners: user connection selection intent = AppSettings structured selection (`setting.json`; consumers: Account
Resolver, Settings UI); current account identity and entitlement = OAuth/Account/Plan services (their existing caches);
currently available Account Connection = Account Provider Service (last-known-good Account Source; Registry, Account
Views); Provider execution Account Access = Effective Provider Config / Model (Registry revision / Active Model; Request
Auth); API Key/JWT/Team Secret = Credential / Request Auth service (existing Credential Store; single request attempt);
Off-Peak Ticket/Auth = Off-Peak execution context (current dispatch memory; idle Model request-auth).

Impact brief: change layers `persistence`, `option-source`, `validation`, `commit-effect`; primary seeds
`AccountProviderConnectionResolver`, `AppSettings`, `resolveOffPeakCredentials`, `resolveOfficialMcpCredentials`; out of
scope: plan product logic, remote Provisioning, Credential center refactoring, Queue/Recovery, Model selection lifecycle.
Must-inspect: AppSettings -> Provider Settings -> Account Resolver; Account Resolver -> Account Built-in Config ->
Registry; Active Model -> Request Auth (an old Model cannot follow a new account); Account Access -> Off-Peak / Official
MCP. should-inspect: Usage / Entitlement / Sidebar. conditional: Local/Remote Host Account Source (the remote Environment
uses its own). invariant-only: desktop continuous / mobile replayable. No callable codegraph existed; semantic graphs
plus precise `rg` call-site review were used, with symbol-level evidence from `dep:refs` and TypeScript.

## 4. Implementation Order

- **A Tests freeze and structured selection:** failing tests for API Key, Start, Individual, Team project selection and
  restart recovery; define structured selection and strict Schema in Shared; AppSettings gets the single
  `providerFamilyConnectionSelections`; Provider Settings pending state, save, OAuth callback restore and default
  initialization submit a complete selection once; keep `providerFamilyDomain` independent.
- **B Account Connection and Provider Access:** separate Start/Individual/Team Built-in Providers per Family (delete the
  shared Individual/Team Provider), fixed `access.family + access.planKind`, Team Effective Access carrying complete
  Scope; the Resolver looks up connections by structured Access and selection (no ID mapping table);
  `AccountProviderConnectionResult.available` returns complete `ZhipuAccountAccessConfig`; the Service internally
  generates and invalidates opaque accessId from the current account (no `accountIdentity` projection into Config); the
  Account Built-in Config projects complete Access, optional `builtinModelIds` and `enabled=true` for the selected
  Provider (other Account Providers in the same exclusive range `enabled=false`); the Resolver publishes the whole result
  atomically on success and on external dependency failure the Service keeps the entire previous Snapshot (no partial
  LKG; per-Provider `unknown + previousProviders` half-recovery branches deleted; no new Family/Provider fault isolation
  protocol); `validateComplete` / `requireComplete` check structure, not field origin or real entitlement;
  ModelFactory/Model store complete Account Access as-is.
- **C Request Auth and consumers:** Request Auth selects the authentication flow by `family + planKind` and obtains
  dynamic material by opaque accessId; Team Key/Header uses the explicit Scope from Access; delete Family/Plan to
  Built-in Provider ID hardcoding in Request Auth and the Resolver; Usage, Entitlement, Reset, Sidebar and Provider
  Settings use the Account Connection View; the Host no longer decides whether official-version safety check is needed by
  a `start-plan:` prefix (Request Auth uses existing typed interaction/error boundaries); the Credential Store keeps its
  current key built from the complete accessId (migrate only if tests prove necessary).
- **D Delete cross-layer selection passthrough:** selected-key parameters removed from ZCodeTask, ZCodeSession, Agent,
  workspace prepare, Repo Wiki and thought catalog; Runtime obtains execution Access only from Provider/Model in the
  Registry; the Renderer modifies selection only in Provider Settings (never stuffed into ModelSelection or Session
  state); a Remote Workspace keeps producing Account Built-in Config from the target Environment's Account Source.
- **E Off-Peak and Official MCP:** Off-Peak obtains current valid Individual/Team Account Access (Start/API Key continue
  to be refused by product rules); direct comparison of scoped accessId and unscoped selected key deleted;
  `OffPeakCredentialSnapshot` and `OffPeakCodingPlanSupport` drop `selectedConnectionKey`; Official MCP uses the same
  Account Access to judge Individual/Team scope; before/after credential parsing consistency checks continue but compare
  Account Source revision/structured connections rather than concatenating two-generation credentials; the Renderer
  receives no JWT, API Key, Team Secret or other dynamic credentials.
- **F Migration and mechanical deletion:** the Repository executes a one-time mode/key -> structured selection migration
  when reading old AppSettings (only identifiable `preset:`, `coding-plan:` and complete `team-plan:`; damaged values
  not guessed); old general `builtin:*-coding-plan` Provider IDs migrate to the Individual or Team ID from the same
  structured selection across Settings, Personal Provider key and still-recovering persisted ModelSelection (ambiguous
  manual configurations report diagnostics, never copied to both); no dual-write of old fields and no long-term dual-read
  in business code; migration functions, old schema fields and parser/matcher tests are deleted after the mandatory
  upgrade window; connection-key create/parse/matches/rebase helpers and call-site-less legacy accessId parsers deleted.

## 5. Tests

- **Settings and migration:** API Key, Start, Individual, Team selection strict round-trip; atomic migration of mode and
  selected key into one structured value; Team migration preserves product/organization/project; damaged old keys do
  not guess Plan or Team Scope; OAuth callback updates only the target Family; Settings mount does not override
  still-valid saved selections; one connection switch means no mode/key partial update; old general Coding Plan Provider
  ID migrates to Individual or Team by explicit selection (ambiguous input neither guessed nor dual-written).
- **Account Provider and Registry:** Start, Individual, Team each correspond to an independent Built-in Provider (plan
  type never morphs); Team carries complete product/organization/project; the Resolver finds accessId by structured
  family/planKind/Team Scope with no Provider ID mapping table; normal Individual selection enables only the Individual
  Provider and Team only the Team Provider; Token/Runtime Key refresh does not change Account Access while account or
  Team project switch produces new Access; refresh success publishes atomically and any external dependency failure keeps
  the whole previous Snapshot; Personal can completely override access (no source qualification checks); manually written
  structurally complete fake access passes Config completeness and fails at Request Auth or server-side; an enabled
  Account Provider missing accessId, or Team missing Scope, cannot enter the Registry.
- **Request Auth, Off-Peak, MCP:** Start, Individual, Team Request Auth does not parse accessId strings; an old accessId
  cannot obtain new account credentials after account switch and fails before the network; Team Header/Key uses the
  explicit Scope; Off-Peak's scoped Account Access parses normally (no erroneous `connection_unavailable`); connection
  switching during credential parsing retries the whole parse without mixing generations; Official MCP Individual/Team
  scope matches Account Access; Start/API Key product gates for Off-Peak/MCP unchanged; Renderer-visible support/outcome
  holds no Secrets.
- **Multi-platform and regression:** Desktop, Web and mobile settings pages use the same Setting Service; Local/Remote
  Environment generate their own Account Built-in Config; Composer, Automation, Subagent and Repo Wiki candidates still
  come from the Registry with each Draft/commit sink unchanged; desktop continuous, mobile replayable, Queue, snapshot and
  workspace identity unchanged; an already-created Active Model keeps old Access after global account/connection switches.

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

## 6. Non-Goals

Plan SKU, purchase, discounts, quotas or server-side authorization product logic; dynamic API Key, JWT, Team Secret,
one-time security verification Header or Ticket in Provider Config; a unified Credential Center; ModelSelection, Session
Selection, App Recent or Active Model lifecycle; remote Provisioning, remote settings or login product capabilities;
Queue, continuous/replayable, snapshot or workspace identity; changing the existing accessId byte format or Credential
Store key; Source permission or "prohibit writing account accessId" validation for manual configurations; Badge, Label
or plan display copy in Account Access.

## 7. Completion Conditions

Mechanical zero: `AppSettings.modelProviderFamilyModes`; `AppSettings.modelProviderFamilySelectedKeys`;
`selectedConnectionKey` in production domain/protocols; Family selected-key passthrough from Task/Session/Repo
Wiki/workspace prepare; business code creating/parsing/matching Team/Coding/Preset connection keys; UI/Host/Off-Peak/MCP
reverse-decoding Plan/Family/Team/account identity from accessId; Account Resolver / Request Auth Built-in Provider ID
plan mapping; old general `builtin:*-coding-plan` Provider IDs in formal Config/Registry;
`provider.accessId !== selection.selectedConnectionKey`; OffPeak support/snapshot `selectedConnectionKey`; an enabled
`zhipu-account` missing complete family/planKind/accessId/Team Scope: all 0. (A generic Select component's internal
React option `key` is out of scope; prohibited is using string keys as a cross-Settings/Services/Protocol/Runtime
account connection protocol.)

Behavior: user connection selection has one structured persisted state; the Account Connection Resolver is the sole
interpreter from selection intent to account connection facts; the Account Built-in Provider Config is the unique static
snapshot of execution-required Account Access; Start, Individual and Team are fixed-type independent Built-in Providers
with only the current selection enabled in the normal flow; Request Auth, Off-Peak and Official MCP consume the same
structured Account Access; every consumer treats accessId as opaque; UI editability does not change Personal Schema
expressibility; account/connection switches never silently move already-created Models to another credential set; no
new-old dual-write, dual-read or long-term compatibility DTOs.

Verification: `pnpm test:unit:affected`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm knip`; mechanical zero
via `pnpm dep:refs`, TypeScript and `rg`; Desktop E2E for Provider Settings, OAuth reconnection, Team project switching
and Off-Peak entry plus mobile Web responsive check for UI changes; if remote environments cannot be fully verified, the
commit notes list the Local/Remote Account Source impact scope and pending evidence. Record the sole importer boundary
still inside the mandatory upgrade window; independent Conventional Commit.
