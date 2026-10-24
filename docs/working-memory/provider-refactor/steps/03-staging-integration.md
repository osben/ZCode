# M3.0: Staging Integration and Provider Config Ownership

> Status: Local merge implementation and verification completed; submitted with this merge commit
>
> Last updated: 2026-08-22
>
> Integration baseline: `origin/staging@bcb119437370b74b6460b89975afae2ef5cdea33`
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/03-staging-integration.md`

## 1. Goal

1. Absorb the product capabilities staging already added: Video Input, model input type settings, `ox-alpha`
   reasoning, and others.
2. Migrate the Provider / Model facts still handled by remote configuration, Catalog, Workspace Snapshot or specific
   model-name hardcoding in staging and old code into the new Provider Config and Model Config Rules system.

This document is the design fact source for this integration; earlier implementation logs record only what was done
then and do not override the decisions here. Per user decision this round does only local merges and commits (no push,
no rewriting of remote branches); how the remote branch is handled later is the user's separate decision.

## 2. Core Boundaries

All configuration helps ZCode encapsulate a correct model API call: select Provider, determine Endpoint and API type,
model members, capabilities and options, and form the final request. The configuration system does not exclude
credentials uniformly: regular API Providers may save static API Keys in Personal Provider Config. Account-type
Provider Config does not manage account credentials; it expresses only the account connection identifier and
account-state model members, and Services resolve and inject actual credentials at request time.

```text
Model Call Configuration: Provider identity, Endpoint, API type, model members; model capabilities, constraints,
  options, reasoning mapping; static API Key of a regular API Provider (allowed); account connection identifier
Account Access Execution: resolve credentials from the account connection identifier; inject at request time;
  the model service ultimately decides whether the account can access the target model
```

Account configuration is not a client-side security boundary. Personal configuration allows the user's final
override; whether it is usable is decided by the server response.

## 3. Domain Vocabulary

Only configuration sources and derived results with business meaning are kept; serialization version, file shell and
read/write format are implementation details.

Provider configuration:

| Name                           | Suggested code name     | Meaning                                                                |
| ------------------------------ | ----------------------- | ---------------------------------------------------------------------- |
| ZCode Built-in Provider Config | `zcodeBuiltinProviders` | Provider static defaults and account Provider declarations shipped with the product |
| Account Provider Config        | `accountProviders`      | Account-state supplements or constraints for account-related Built-in Providers |
| Personal Provider Config       | `personalProviders`     | User-defined Providers and final override of existing Providers        |
| Effective Provider Config      | `effectiveProviders`    | Final Provider collection after three-layer overlay                    |

The current code's `officialProviders` corresponds to `zcodeBuiltinProviders`; whether the mechanical rename happens
in M3 is decided at implementation, but new design and tests use this vocabulary.

Model configuration:

| Name                              | Suggested code name      | Meaning                                                               |
| --------------------------------- | ------------------------ | --------------------------------------------------------------------- |
| ZCode Built-in Model Config Rules | `zcodeBuiltinModelRules` | Model static facts and default behavior rules shipped with the product |
| Personal Model Config Rules       | `personalModelRules`     | User's additional override rules for model facts and behaviors        |
| Effective Model Config Rules      | `effectiveModelRules`    | Final rule sequence after concatenating both sets in order            |
| Effective Model Config            | `effectiveModelConfig`   | Model configuration resolved for a final Provider / Model / API type  |

Provider Config `models[]` answers "which models and in what display order"; Model Config Rules answer "how they are
called and what capabilities and constraints they have" and never add or remove models.

## 4. Convergence of the Two Channels

```text
ZCode Built-in Provider Config -> overlay Account Provider Config -> overlay Personal Provider Config
  -> Effective Provider Config -+
ZCode Built-in Model Config Rules[] + Personal Model Config Rules[] -> Effective Model Config Rules[] -+
  for each model in final provider.models[], with final providerId / modelId / api.type
  -> Effective Model Config -> Provider Registry -> final model API call
```

Only three derived concepts are domain concepts: Effective Provider Config, Effective Model Config Rules, Effective
Model Config. Loading snapshots, last-successful values and parse caches are implementation details.

## 5. Provider Override Rules

```ts
effectiveProviders = zcodeBuiltinProviders.overlay(accountProviders).overlay(personalProviders);
```

Priority: Personal > Account > ZCode Built-in.

1. **Account responsibility.** Account Provider Config handles only account-type Providers already declared in the
   Built-in: it may supplement the account connection identifier and override that Provider's `models[]` when the
   account interface returns a model set; it provides no static capabilities (context, modalities, reasoning, max
   output); it neither reads nor rewrites Personal custom Providers; it saves no credentials. The Account Provider
   Service input is the ZCode Built-in Provider Config, not the Personal-overlaid collection.
2. **Why Personal last.** Personal is the user's final expression of local call encapsulation: new regular API
   Providers, or override of Endpoint, API type, model members or static API Key. Even if Personal overrides the
   account's model set, the server performs final authentication and authorization on the actual request.
3. **`models[]` is whole-list override, no implicit intersection:** Built-in static/default members; Account
   `models` (when present, from the current account interface) overrides Built-in whole; Personal `models` (when
   present) overrides Account/Built-in whole. No `allowedModelIds` second semantics; Account models are never a
   client-side authorization whitelist.

## 6. Model Config Rules Merge and Resolution

```ts
effectiveModelRules = new ModelConfigRules([
  ...zcodeBuiltinModelRules.rules(),
  ...personalModelRules.rules(),
]);
```

Rules match in order and later matches override same-name fields. The resolution object comes from the Effective
Provider Config:

```text
effectiveModelRules.resolve(effectiveProvider.id, modelId, effectiveProvider.api.type)
```

so a Personal override of the Provider API type also enters the matching model rule branch (never resolve model rules
by the Built-in Provider and then overlay Account/Personal Provider). Model static facts include context window and
max output tokens; input capabilities (image, video, PDF); reasoning tiers and default; reasoning parameter mapping
under the API Schema; registry metadata such as sorting or priority. No Account Model Config Rules are added; the
account interface affects only connection state and model members.

## 7. Account Interfaces and Start Plan

| Account type        | availability source            | Returns dynamic model ID      |
| ------------------- | ------------------------------ | ----------------------------- |
| Z.AI Start Plan     | `/billing/balance`             | Yes                           |
| BigModel Start Plan | `/billing/balance`             | Yes                           |
| Coding Plan         | `/subscription/list`           | No (availability only)        |
| Team Plan           | customer / project / quota API | No (availability only)        |

- Start Plan extracts `model:<id>` from the balance bucket's `capabilities`, deduplicates case-insensitively and forms
  the Account Provider `models[]`. The interface returns the models currently visible to the account; never hardcode
  "the Start Plan can only use one model".
- Old compatibility: when a balance bucket has no `model:` capability, `show_name` is treated as the model ID.
  `show_name` is more of a display field, but until the server contract is clearer this compatibility is kept and
  not extended into a new model identity rule.
- Coding Plan and Team Plan return no dynamic set, so the Built-in `models[]` of those Providers cannot be cleared.
  Start Plan also keeps Built-in default members so a clear product default exists when availability returns no model
  ID; when Account `models[]` is present the whole-list override applies.

## 8. `/client/configs` Ownership

`/api/v1/client/configs` is a general remote product configuration center, not an authentication service; Provider /
Model static facts inside it must not continue to be treated as account authentication results.

`builtinProviders` (newer normalized structure: Provider metadata and model IDs) and `providers` (old monolithic
Provider + model structure) express the same authority in different protocol generations; staging preferred
`builtinProviders` when non-empty and used `providers` as fallback. The goal is to migrate still-valid static facts
into the ZCode Built-in Provider Config and Built-in Model Config Rules, then delete the remote Provider sync and old
protocol fallback.

| Remote config                            | Current usage                                          | M3 target                                                                            |
| ---------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `builtinProviders`                       | Provider ID, name, model members, Endpoint, API Schema | Migrate to ZCode Built-in Provider Config, then delete the remote entry              |
| `providers`                              | Old Provider + Model mixed config                      | Delete the compatibility entry after migration                                       |
| `builtinModels`                          | context, max output, modalities, reasoning, priority   | Migrate to ZCode Built-in Model Config Rules                                         |
| `magic_name`                             | Match reasoning strategy by model name                 | Delete the remote matcher; write effective behavior as general Model Config Rules    |
| `offPeak.allowed_models`                 | Idle task model whitelist                              | No longer model fact authority; static members enter the Built-in Provider Config    |
| `modelContextBudget.strategy`            | Agent context budget gray release                      | Unrelated to model config; untouched                                                 |
| Products, plans, discounts               | SKU, display, commercial config                        | Stays managed by the independent remote product                                      |
| Security verification flags, forceUpdate | Risk control and release policies                      | Stays managed remotely                                                               |
| computerUse, feature flags               | Product gray release                                   | Stays managed remotely                                                               |

The legacy `apiKey` field of the old remote Provider type needs no migration design (the real access method is in the
existing access system); it is deleted with the old protocol.

## 9. Delete Specific Model Hardcoding

All old code that recognizes a specific model ID and then decides reasoning tier, default or request parameters exits.
Specific model static behavior lives in Built-in / Personal Model Config Rules -> Effective Model Config -> a general
API Adapter that serializes according to configuration. The Adapter keeps only protocol-level mappings (Anthropic
Messages `output_config.effort` and adaptive thinking; OpenAI Chat Completions / Responses reasoning parameters;
serialization differences between API Schemas for the same common option) and has no product strategy about which
reasoning intensities a model uses.

"Wire" here means the final HTTP request body sent to the model service; there is no `wire()` domain function in the
Provider reasoning chain. Existing `*-wire.test.ts` intercept the final request body to prove configuration still
yields the behavior staging verified after passing the general Adapter.

Behavior to retain for `ox-alpha`:

```text
reasoning levels = low / high / max
default = max
openai-chat-completions -> reasoningEffort
anthropic-messages      -> adaptive thinking + effort
openai-responses        -> currently not enabling dedicated reasoning
```

These are written into the ZCode Built-in Model Config Rules; model-name helpers, the remote regex matcher, the
Default Policy special case and the Catalog special case are deleted. Rules may use the general model match
expression (a declarative condition, not a business-code model special case).

## 10. Idle Task Boundaries

Separate model static facts from single-execution access materials: ZCode Built-in Provider Config + Built-in Model
Config Rules hold the static facts of `builtin:offpeak-idle-plan`; the execution context holds the single-turn request
inputs (Request Auth / ticket / attribution).

`builtin:offpeak-idle-plan` is a complete Built-in Provider with `visibility: "hidden"`. It enters the same
Registry but is hidden by the Settings and Model Selection Facades; internal idle capabilities create normal Models by
precise `providerId/modelId`; it never overwrites the Session's permanent model. `enable_offpeak_task` can stay a
remote product gray release; `allowed_models` no longer carries Registry model facts. The Provider Config declares the
complete `api.type`, production Endpoint, model members and static model facts, and uses
`access.type = "request-auth"` for request-period dynamic authentication. When Request Auth is missing the Model fails
explicitly before the network request. `visibility` is not a trust, permission or completeness exemption. The idle
task state machine is not rewritten and `modelContextBudget.strategy` is not handled.

## 11. Absorbing Staging Product Capabilities

- **Video Input.** Keep staging's video attachment recognition, upload, persistence, recovery, Tool Result projection,
  request conversion, budget, desensitization and error handling. Whether a model supports Video is read only from the
  Effective Model Config (no old Catalog, Workspace Snapshot or Runtime fallback).
- **Model input type settings.** Keep Text fixed, Image/Video switchable, output Text fixed, context/max output
  defaults, and the theme, i18n, keyboard and accessibility intent; save to Personal Model Config Rules. No
  `modalitiesConfigured`: the three-state rule field suffices (`undefined` Personal has no opinion; `false` explicitly
  disabled; `true` explicitly enabled). Undisplayed PDF and Audio capabilities must not be silently rewritten by the
  page save. Audio enters the complete Model Property contract but this round adds no attachment entry, content-block
  projection or Provider encoding (details in [`../design/model/input-output-format.md`](../design/model/input-output-format.md)).
- **Effective lifecycle.** After Provider or Model settings are saved the Registry revision updates but already-created
  Active Models are not hot-updated; the next Model creation reads the new configuration (Video, reasoning, Endpoint,
  API Key and other options alike).
- **Local / Remote.** Local Environment uses local Config / Registry; Remote Environment uses its own. Media
  attachments and Submissions pass through the remote control protocol, but the Desktop does not distribute local
  Provider Config, account credentials or Registry Snapshot as remote execution facts.

## 12. Post-Integration Results

| Area                           | M3 result                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| Provider overlay               | Fixed as `built-in -> account -> personal`                                                         |
| Account Provider Service input | Reads only the ZCode Built-in Provider Config; not Personal                                        |
| Model rules                    | Two concatenated arrays: ZCode Built-in + Personal, Personal last                                  |
| Model rules resolution object  | Effective Provider's final `providerId / modelId / api.type`                                       |
| `/client/configs`              | Provider / Model static facts, old protocol fallback and `magic_name` parsing deleted              |
| reasoning                      | Specific model strategies in Built-in Rules; Adapter keeps protocol-level serialization only       |
| OffPeak                        | Hidden Built-in Provider in the normal Registry; Request Auth injected per request                 |
| Video                          | Capability read only from Effective Model Config; media processing/persistence/conversion as staging |
| Model settings                 | Text fixed, Image / Video editable, saved as Personal Model Config Rules                           |

Older documents recording Account taking effect last, remote fact sync or specific-model hardcoding are historical
only.

## 13. Impact Scope and Invariants

The change is `option-source + validation + persistence + commit-effect`; it does not directly change conversation
protocol, queue or replay semantics.

| Level          | Impact area                                                      | Reason                                                              |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| must-inspect   | `packages/provider` resolver, Account Provider Service, Registry | Config override and final fact owner                                |
| must-inspect   | `/client/configs` Provider / Model sync                          | Old remote fact source must exit                                    |
| must-inspect   | CLI ModelFactory, reasoning policy, API adapters                 | Model Rules must produce the same final request                     |
| must-inspect   | OffPeak execution-scoped model source                            | Boundary between static config and single-turn access materials     |
| should-inspect | Provider Settings, model selection candidates                    | Both consume the Registry with different save semantics             |
| should-inspect | Start/Coding/Team Plan availability                              | Only Start Plan returns dynamic model IDs                           |
| conditional    | Video / modality settings                                        | New staging capability enters the Effective Model Config            |
| invariant-only | desktop continuous / mobile replayable                           | Provider consolidation cannot change message recovery semantics     |
| invariant-only | local / remote workspace                                         | Remote environment keeps its own execution config                   |

Must maintain:

1. Personal Provider Config takes effect last.
2. Account constrains only account-type Built-in Providers, never Personal custom Providers.
3. Personal Model Config Rules come after ZCode Built-in Rules.
4. Model Rules resolve the final API type of the Effective Provider Config.
5. `models[]` is a whole-list override, never silently an authorization intersection.
6. Regular API Providers can still save a static API Key; account-type Provider Config does not manage credentials.
7. The server is always the final authentication and authorization authority.
8. Already-created Active Models are not hot-updated by settings.
9. The Desktop does not distribute the local Provider/credential Snapshot to the Remote Environment.
10. Do not restore the old Provider Store, Catalog, Workspace Snapshot or Runtime fallback as a model fact source.

## 14. Implementation Order

1. Write these decisions as tests for the Provider resolver, Account Service, Model Rules and wire layer.
2. Execute the staging integration method the user decided, retaining staging product implementations outside the
   Provider domain.
3. Translate staging's Provider / Model static facts into Built-in Config and Model Rules.
4. Integrate Video and the input/output format UI without restoring old Store, Catalog or Snapshot.
5. Delete `/client/configs` Provider/Model sync, old protocol fallback and specific model hardcoding.
6. Consolidate the OffPeak static fact source (complete Provider in the Registry, access materials injected per
   request).
7. Reference audit confirms old entries and model special cases exited.
8. Update architecture documents still using the old layer order.

## 15. Acceptance

- Provider overlay order is Built-in -> Account -> Personal; the Account Service does not read Personal Providers.
- Model Rules are the ZCode Built-in + Personal array concatenation and act on the Effective Provider.
- Start Plan's dynamic model set correctly overrides the Built-in default set; Coding/Team Plan keep Built-in models.
- Regular API Key and account credentials each follow the correct config/resolution path.
- `/client/configs` no longer distributes Provider / Model Registry static facts; all specific-model reasoning
  hardcodes are deleted; final HTTP request behavior of `ox-alpha` and other supported models has not regressed.
- OffPeak static model facts come from Built-in/Rules; single-turn access materials are not persisted as a normal
  Provider.
- Video, Image and other capabilities come from the Effective Model Config.
- Current Active Model, Local/Remote ownership and desktop/mobile message semantics are unchanged.
- Typecheck, Lint, and Provider/Registry/Account/Adapter wire/OffPeak/Settings tests pass.

## 16. Implementation Record

Done with `origin/staging@bcb119437370b74b6460b89975afae2ef5cdea33` as the local merge baseline:

- Provider resolver and Account Provider Service consolidated as Built-in -> Account -> Personal.
- Reasoning behavior of `ox-alpha`, `GLM-x-preview-f` and `x-preview-f-free` entered the Built-in Rules; the Default
  Policy no longer synthesizes Registry static facts by model name.
- `/client/configs` Provider / Model fact parsing, sync and remote matcher deleted.
- `builtin:offpeak-idle-plan` currently provides static members as an unpublished `executionOnly` intermediate
  implementation; M4 changes it to the general `visibility: "hidden"`, complete Endpoint and `request-auth` without
  keeping the intermediate field.
- Video, Image and reasoning consume only the Effective Model Config; staging's Video, model modality editing and
  other out-of-Provider-scope product changes are retained.

Verification: `pnpm typecheck` passed; `pnpm --dir apps/zcode-cli -r --if-present typecheck` passed; `pnpm lint` 0
errors (39 pre-existing staging warnings); Provider / Account / Registry / OffPeak / Settings focused tests (9 files,
117 tests), CLI Video / reasoning / Registry (13 files, 185), settings conflict consolidation (5 files, 93) passed;
`pnpm test:unit` 12,296 pass, 25 skip, 30 fail (failures only in 7 Windows packaging, macOS notarization and CUA
native environment test files, no intersection with this change); `oxfmt --check` on 78 changed files and
`git diff --check` passed. Repository-level `pnpm fmt:check` stays blocked by the existing binary
`apps/zcode-cli/tests/gb2312.js` and the Electron HTML parse-failure fixture, so the format check of actual changed
files is the gate. This round generated only a local merge commit.
