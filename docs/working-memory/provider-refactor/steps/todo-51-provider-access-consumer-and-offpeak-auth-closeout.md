# Todo 51: Provider Access Consumption Semantics and Off-Peak Auth Closeout

> Status: Completed
>
> Date: 2026-08-31
>
> Prerequisite: Todo 47, 49 and 50 completed the core contract cutover; this Todo closes the consumer-layer drift,
> duplicated auth assembly and old abstraction residue found in review.

## 1. Goal

The core Provider Config structure is not changed again; every consumer must obey the single established facts:

```text
ZCode Built-in + Account + Personal Provider Config Overlay
  -> Effective Provider Config: enabled (joined to current config), access.type/family/mode (static access),
     access.entitled (Account product eligibility), full call config
       -> Settings View: reads placement/status
       -> Provider Registry: takes only executable Provider/Model
```

Two adjacent chains are also closed: Welcome typed API key only saves a sparse Personal Overlay for the fixed Built-in
API Provider (no custom Provider, no copied Built-in facts, no silent Family Connection Selection change); Off-Peak
keeps using ZCode JWT, Coding Plan project key and Off-Peak Ticket, but Provider/account selection and Request Auth
resolve exactly once and the Desktop Host no longer scans the Settings View to guess the current Coding Plan.

## 2. Confirmed boundaries

### 2.1 `enabled`, `entitled` and `executable`

| Fact                                      | Sole meaning                                                                         | Owner                       | Allowed consumers                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------- |
| `provider.enabled`                        | Provider joined to the current config; normal Built-in sits in the main list or menu | Built-in + Personal Overlay | Settings placement; Resolver's first execution gate                                            |
| `access.entitled`                         | Whether the current account has the matching Account product eligibility             | Account Overlay             | Account status UI; Resolver's Account execution gate                                           |
| `provider.executable` / Registry presence | Provider enabled, entitled, complete and with at least one executable model          | Resolver / Registry         | Model selection, connection test, real execution, internal exact lookup                        |
| Account access descriptor                 | Static `type/family/mode` description                                                | Built-in Provider Config    | Display dispatch, account request material resolution; never turned into a "connected" boolean |

`enabled` must not infer account connected/purchased/entitled, and the mere existence of an Account access
descriptor must not infer entitlement. Renderer does not copy the Resolver formula; it consumes `executable` or the
formal Registry when it needs executability.

### 2.2 Welcome API key writes only a Personal Overlay

User picks BigModel and types a key -> look up Built-in `bigmodel-api` -> save a sparse Personal Provider Overlay
`{ access: { type: "api-key", apiKey: "..." } }` -> Effective Config / Registry refresh.

- `zai-api` / `bigmodel-api` Provider ID, group, Endpoint, API Schema, Built-in models and order keep coming from
  Built-in.
- Welcome never creates a `standard-personal` Provider dynamically and never copies Built-in fields to Personal
  Config.
- Welcome does not write `providerFamilyConnectionSelections`: an existing explicit selection stays; the existence of
  an API key Overlay is not a second authority for the current connection method.
- Welcome's Family domain and post-login default model behavior are unchanged; this Todo does not redesign
  navigation or model selection around API key saving.
- A user switching connection method on the settings page follows that interaction's own contract, not the same
  commit action as Welcome's "save call material".

The generic write entry `savePersonalProvider` actually saves the Personal Config Overlay of any Provider and was
easily misread as only saving `standard-personal` Providers; it is renamed to `savePersonalProviderOverlay`
throughout Facade, Service, Runtime, UI helper, mocks and tests (no alias). The API key convenience function only
merges `access.apiKey` and calls that generic entry, with no separate persistence protocol.

### 2.3 Off-Peak: three request materials and one resolution source

```text
ZCode JWT (current login identity) + Coding Plan Project Key (current Individual/Team plan model request material)
 + Off-Peak Ticket (scheduling admission of this idle execution)  -> Off-Peak Request Auth
```

The roles differ; the Ticket does not replace the Coding Plan key. The existing server Header contract is kept;
billing, quota, Ticket state machine and final authorization are unchanged.

The composition root already used Registry Provider resolution for the Off-Peak Server Client, support state and Mock
Upstream, while Desktop Host dispatch rescanned the Settings View and used the old `provider.enabled` semantics to
find Individual/Team Providers. With Account Providers fixed `enabled=true` the scan hits several Providers at once —
both duplicate implementation and a request-auth resolution failure. Target chain:

```text
Provider Registry + Account Request Auth
  -> composition root creates the single Off-Peak Credential Resolver
       ├─ Server Client / Support
       └─ Host Dispatch(ticketId) -> buildOffPeakRequestAuth
```

- Assemble the Off-Peak credential resolver dependencies once at the Node/Host composition root.
- Local Host dispatch submits only the `ticketId` and obtains this Request Auth; it does not read the Settings View,
  judge the plan or resolve Providers.
- Dynamic credentials stay in Host/Services memory and never enter Renderer, RPC DTOs, Provider Config, Session
  Selection or persistence.
- No method is added to the public `IOffPeakTaskService` that would expose secrets to Renderer/Remote clients; reuse
  the existing host-private capability/lookup boundary or an equivalent narrow private closure at the same
  composition root.
- Off-Peak keeps using the ordinary Registry, standard ModelSelection and formal ModelFactory; no second execution
  Registry.

### 2.4 Family Connection Selection boundary

`ProviderFamilyConnectionSelection` is the explicit settings-page connection choice, not Personal Provider Config
and not a mirror of API key completeness. Whether `kind: "api-key"` should remain is a connection-method product
question not decided here; fixed only: Welcome saving a key does not modify the selection; the Account Overlay may
read the explicit selection to decide the current account connection but cannot treat `enabled` as selection or
entitlement; Provider executability is decided by Effective Config/Registry and selection is no second Registry.

## 3. Problems found

1. **UI still consumed the old `enabled = account connected`:** `connectedAccountProviderIds` collected Account
   Providers by `provider.enabled`; `resolveAccountProviderAccess()` did both descriptor reading and the connected
   boolean; Subscription completion, first entitlement sync, Plan status and quota/usage display treated descriptor
   existence as connected; Coding Plan funnel telemetry reported purchased by `enabled`; comments, variables and
   fixtures still said "Account Overlay enabled". Rule: static description reads `access.type/family/mode`;
   account eligibility reads `access.entitled === true`; execution reads `executable`/Registry; ambiguous
   nullable/Boolean conversions are deleted; no new `AccountProviderState` DTO or second derived state machine.
2. **Off-Peak Host duplicated Provider resolution:** Desktop Host and the Services composition root each kept a
   `resolveAccountProvider`; the Host-side Settings View scan is deleted, one Registry + Account Request Auth source
   remains.
3. **Personal Overlay public interface mis-named:** `savePersonalProvider`, its mutation target and helpers are
   mechanically renamed; the old exports are deleted with no alias.
4. **Old abstractions and dead logic:** delete the unreferenced `ModelProviderFamilyModeSettings`,
   `resolveModelProviderFamilyMode`, `shouldShowModelProviderForFamilyMode` (structured selection has no parallel
   `oauth | apiKey` mode); narrow `loadProviderApiKey` in the Account Connection Resolver, which really only loads
   the Coding Plan project key, to `loadCodingPlanApiKey` (ordinary `api-key` Providers never use it); delete the
   dead branch comparing an Account Provider form API key then refreshing entitlement; clean stale comments/tests
   about the old Account API Provider, Account `enabled`, `accessId` and "Personal Rule decides edit permission".

Feature Graph still described the Account Overlay projecting top-level `enabled`, `accessId` and "enable only the
selected Provider", inconsistent with Todo 49/50 and the Resolver; corrected to: Account Built-in fixed
`enabled=true`, the Account Overlay projects only `builtinModelIds + access.entitled`, dynamic account credentials
are resolved by request-time Services.

## 4. UI surface matrix

| Scenario                            | Display/draft                            | Commit action                                    | Authoritative owner                                | Must isolate                                                 |
| ----------------------------------- | ---------------------------------------- | ------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------ |
| Welcome typed key                   | Local API key draft                      | `savePersonalProviderOverlay`                    | Personal Provider Config                           | No Account Overlay/Family selection, no Built-in copy        |
| Provider Settings pay-as-you-go API | Effective Config + key draft             | Same Overlay save entry                          | Personal Provider Config                           | No Account Request Auth                                      |
| Provider Settings Coding Plan       | Account access/entitlement + plan status | Explicit connection selection/account operations | App Settings + Account Overlay                     | No typed key; no `enabled`-inferred entitlement              |
| Connection test                     | Provider/Model row                       | Flush Provider draft then test formal Model      | Registry/ModelFactory                              | No Model Rule rewrite, no account state guessing             |
| Off-Peak create and dispatch        | Support state + idle selection           | Ticket + host-private Request Auth               | Off-Peak Service + Registry + Account Request Auth | No credential exposure, no ordinary Session Selection change |

High-risk relations: Account Overlay -> Settings/telemetry (`enabled=true, entitled=false` misreported as
connected/purchased); Registry -> Off-Peak Host dispatch (Settings scan hits several Providers, dispatch lacks
credentials); Welcome -> Personal Config (writing selection or copying Built-in makes double facts); Provider
Settings -> connection test (connected/executable gates must not be mixed again); desktop continuous / mobile
replayable and remote workspace invariants unchanged (Provider Registry sync stays, no Remote-private auth source).

## 5. Acceptance

### Provider / Services

- Account Provider `enabled=true, entitled=false`: visible in Settings, absent from Registry; `enabled=true,
entitled=true` and complete: in Registry.
- A present descriptor with `entitled=false` is never interpreted as connected/purchased.
- Account Resolver projects only `builtinModelIds + access.entitled`.
- Individual/Team Coding Plan project keys resolve by the original identity and cache boundary; ordinary
  pay-as-you-go API never calls that chain.

### UI

- Logged out, unpurchased, API failure and explicit entitlement=false do not skip the first sync nor report
  subscription success early.
- Plan status, quota/usage and funnel telemetry no longer read Account Provider `enabled` as entitlement.
- Welcome saving a Z.ai/BigModel key updates only the matching Provider's Personal Overlay; `providerFamilyConnectionSelections`
  is unchanged before and after; the Overlay contains only the user-typed key/existing Personal fields, never
  Built-in Endpoint, Schema, models or group.
- Provider Settings main list/add menu still project only by `enabled`.

### Off-Peak

- With several `enabled=true` Account Providers in the Settings View, the single Registry-entitled Provider still
  produces Request Auth, keeping JWT, Coding Plan key, Ticket and Team identity Headers.
- Start Plan / API key selection / no entitlement / account switch still fail explicitly.
- Support state, Ticket client, real dispatch and Mock Upstream use the same credential resolver; Desktop Host no
  longer imports the Settings View Account Provider selection logic; credentials never enter RPC/Renderer/persistence.

### Mechanical

`rg` / `dep:refs` show the old `savePersonalProvider`, Family mode helpers, Account `loadProviderApiKey` and old
enabled wording at zero; Provider, Services, UI, Desktop Host and CLI directed unit tests; affected E2E (Welcome,
Provider Settings API key, Account entitlement, connection test, Off-Peak); `pnpm typecheck`, `pnpm lint`,
`pnpm test:unit`, changed-file format check, `git diff --check`.

Completion: `enabled`, `entitled`, `executable` each have one meaning in production code, tests and docs; UI never
infers Account connected/purchased from `enabled` or descriptor existence; Welcome saves only the fixed Built-in API
Provider's Personal Overlay; the Personal Overlay public interface name is unambiguous; Off-Peak uses the existing
three request materials with one Registry/Account Request Auth resolution implementation; the Desktop Host has no
Account Provider scan and dynamic credentials never cross the Host-private boundary; dead Family mode, wrong Coding
Plan key naming, invalid entitlement refresh and stale doc facts are zero.

## 6. Outcome (2026-08-31)

- Renderer's Account access helper, plan navigation, status cards, quota refresh and funnel telemetry interpret only
  `access.entitled === true` as entitlement.
- `savePersonalProvider` is renamed `savePersonalProviderOverlay` (no alias) from Config Service and Facade through
  Services and UI helper.
- Welcome's Z.ai/BigModel key writes only the sparse Personal Overlay of the fixed Built-in API Provider, keeps
  existing Personal fields, copies nothing from Built-in and does not rewrite the connection selection.
- Account Connection Resolver's credential dependency is named `loadCodingPlanApiKey`.
- Desktop Host's Settings View Account Provider rescan is deleted; the Services composition root exposes the single
  Registry-backed Off-Peak Request Auth builder through a Host-private WeakMap, reusing the formal Account Request
  Auth and three request materials, outside RPC, Renderer, Config and persistence.
- Unreferenced `ModelProviderFamilyModeSettings`, the default mode and old filter helpers are deleted; the still-used
  connection selection types stay. `x-zcode-session-type` stays a request-level attribution fact outside
  Provider/Model Config.
- Verification: Provider/Services/UI directed tests, root `typecheck`, `lint`, the 41 changed files' format check and
  `git diff --check` passed; old-symbol scan passed; full unit `12749 passed / 25 skipped / 2 failed` (the V4 model
  trigger display text assertion and the CUA permission broker stable identity assertion, both unrelated and
  independently reproducible); repo-wide `fmt:check` still blocked by pre-existing Electron example HTML and
  `apps/zcode-cli/tests/gb2312.js`.
