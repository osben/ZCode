# M3.0: Staging Integration and Provider Config Ownership

> Status: Local merge implementation and verification completed; submitted with this merge commit
>
> Last updated: 2026-08-22
>
> Integration baseline: `origin/staging@bcb119437370b74b6460b89975afae2ef5cdea33`

## 1. Goal

M3 needs to accomplish two things simultaneously:

1. Absorb the product capabilities that staging has already added: Video Input, model input type settings, `ox-alpha` reasoning, and others;
2. Migrate the Provider / Model facts still handled by remote configurations, Catalog, Workspace Snapshot, or specific model name hardcoding in staging and old code into the new Provider Config and Model Config Rules system.

This document is the design fact source for this staging integration. The earlier implementation logs only record what was implemented at that time and do not override the new decisions already confirmed in this document.

This round does only local merges and commits per user decision, without pushing or rewriting any remote branches.

## 2. Core Boundaries

The common goal of all configurations is to help ZCode encapsulate a correct model API call: select the Provider, determine the Endpoint and API type, determine the model members, parse the model capabilities and options, and form the final request.

The configuration system does not uniformly exclude "credentials": regular API Providers can directly save static API Keys in the Personal Provider Config. The Config of account-type Providers does not manage account credentials, only expressing the account connection identifier and account-state model members; actual account credentials are parsed and injected by Services at request time, with the model service responsible for the final authentication and authorization decision.

Therefore we must distinguish:

```text
Model Call Configuration
├─ Provider identity, Endpoint, API type, model members
├─ Model capabilities, constraints, options, and reasoning mapping
├─ Static API Key of regular API Provider (allowed)
└─ Account connection identifier

Account Access Execution
├─ Parse account credentials based on the account connection identifier
├─ Inject credentials at request time
└─ The model service ultimately decides whether the account can access the target model
```

Account configuration is not a client-side security boundary. Personal configurations allow the user to make the final override; whether the overridden configuration is truly usable is still determined by the server response.

## 3. Domain Vocabulary

The design layer only retains configuration sources and derived results with business meaning, without introducing additional "configuration document" concepts. The serialization version, file shell, and read/write format belong to implementation details and do not enter the domain model.

### 3.1 Provider Configuration

| Name                           | Suggested Code Name     | Meaning                                                                                  |
| ------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------- |
| ZCode Built-in Provider Config | `zcodeBuiltinProviders` | The Provider static defaults and account Provider declarations provided with the product |
| Account Provider Config        | `accountProviders`      | Account-state supplements or constraints for account-related Providers in the Built-in   |
| Personal Provider Config       | `personalProviders`     | User-defined Providers, and the final override of existing Providers                     |
| Effective Provider Config      | `effectiveProviders`    | The final Provider collection after three-layer Provider config overlay                  |

The `officialProviders` in the current implementation corresponds to `zcodeBuiltinProviders` in the target semantics. Whether the mechanical rename is completed within M3 is decided at the implementation phase, but the new design and tests uniformly use the vocabulary in this document.

### 3.2 Model Configuration

| Name                              | Suggested Code Name      | Meaning                                                                     |
| --------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| ZCode Built-in Model Config Rules | `zcodeBuiltinModelRules` | The model static facts and default behavior rules provided with the product |
| Personal Model Config Rules       | `personalModelRules`     | The user's additional override rules for model facts and behaviors          |
| Effective Model Config Rules      | `effectiveModelRules`    | The final rule sequence after concatenating both rule sets in order         |
| Effective Model Config            | `effectiveModelConfig`   | The model configuration parsed for a final Provider / Model / API type      |

The Provider Config's `models[]` answers "which models does this Provider have and in what display order"; the Model Config Rules answer "how are these models called, what capabilities and constraints do they have". The Model Config Rules are not responsible for adding or removing models from Providers.

## 4. How the Two Configuration Channels Converge

```text
Provider Configuration Path                            Model Rules Path

ZCode Built-in Provider Config                    ZCode Built-in Model Config Rules[]
              |                                            |
              v                                            |
     overlay Account Provider Config                       +
              |                                            |
              v                                            v
    overlay Personal Provider Config             Personal Model Config Rules[]
              |                                            |
              v                                            v
     Effective Provider Config                 Effective Model Config Rules[]
              |                                            |
              +----------------------+---------------------+
                                     |
                                     |  For each model in final provider.models[]
                                     |  Use final providerId / modelId / api.type
                                     v
                          Effective Model Config
                                     |
                                     v
                              Provider Registry
                                     |
                                     v
                            Encapsulate the final model API call
```

Here we only emphasize three truly meaningful derived concepts: the Effective Provider Config, the Effective Model Config Rules, and the Effective Model Config. Loading snapshots, last-successful values, parse caches, and other intermediate states continue as implementation details and are not elevated to domain concepts.

## 5. Provider Override Rules

The final order is fixed as:

```ts
effectiveProviders = zcodeBuiltinProviders.overlay(accountProviders).overlay(personalProviders);
```

The priority is:

```text
Personal > Account > ZCode Built-in
```

### 5.1 Account's Responsibility Boundary

The Account Provider Config only handles account-type Providers already declared in the ZCode Built-in Provider Config:

- It can supplement the account connection identifier;
- It can override the `models[]` of that Provider when the account interface actually returns a model set;
- It does not provide the model's context, modalities, reasoning, max output, and other static capabilities;
- It does not read, constrain, or rewrite custom Providers created by Personal;
- It does not save or manage account credentials.

Therefore the Account Provider Service's input must be the ZCode Built-in Provider Config, not the Provider collection already overlaid with Personal.

### 5.2 Why Personal Takes Effect Last

The Personal Provider Config is the user's final expression of the local call encapsulation. It can create new regular API Providers, or override existing Providers' Endpoint, API type, model members, or static API Key.

The Account layer provides account-state facts, but does not bear client-side mandatory authorization. Even if Personal ultimately overrides the model set returned by the account, the server still performs the final authentication and authorization on the actual request.

### 5.3 The Override Semantics of `models[]`

The `models[]` is the Provider member list, using whole-list override, without implicit intersection:

```text
Built-in Provider.models
└─ Static/default model members

Account Provider.models (when present)
└─ Dynamic model members returned by the current account interface, whole-list override of Built-in

Personal Provider.models (when present)
└─ The user's final declared model members, whole-list override of Account/Built-in
```

No additional `allowedModelIds` is introduced as a second Registry semantics, nor is the Account models interpreted as an authorization whitelist on the client side.

## 6. Merging and Parsing of Model Config Rules

The two groups of Model Config Rules are concatenated as arrays, with Personal rules last:

```ts
effectiveModelRules = new ModelConfigRules([
  ...zcodeBuiltinModelRules.rules(),
  ...personalModelRules.rules(),
]);
```

Rules match in order; fields matched later override the same-name fields already given by previous rules. The parsing object must come from the Effective Provider Config:

```text
effectiveModelRules.resolve(
  effectiveProvider.id,
  modelId,
  effectiveProvider.api.type,
)
```

This ensures that Personal's final override of the Provider API type also enters the corresponding model rule branch. You cannot first parse the model rules by the Built-in Provider, then overlay the Account or Personal Provider.

The model static facts include but are not limited to:

- context window, max output tokens;
- input capabilities such as image, video, PDF;
- available reasoning tiers, default tier;
- the reasoning parameter mapping under the API Schema;
- registry metadata such as model sorting or priority.

This round does not add Account Model Config Rules. The account interface only affects the Provider connection state and model members, without delivering model static capabilities.

## 7. Account Interfaces and Start Plan

The current actual differences in the account availability interface are as follows:

| Account Type        | availability Source            | Returns Dynamic Model ID      |
| ------------------- | ------------------------------ | ----------------------------- |
| Z.AI Start Plan     | `/billing/balance`             | Yes                           |
| BigModel Start Plan | `/billing/balance`             | Yes                           |
| Coding Plan         | `/subscription/list`           | No, returns availability only |
| Team Plan           | customer / project / quota API | No, returns availability only |

The Start Plan extracts `model:<id>` from the balance bucket's `capabilities`, performs case-insensitive deduplication, and forms the Account Provider `models[]`. The interface returns the set of models currently visible to the account; you cannot hardcode "the Start Plan can only use one model" based on this.

The current old compatibility, when the balance bucket has no `model:` capability, treats `show_name` as the model ID. The `show_name` is more of a display field, but before the server contract is further clarified, this round retains the compatibility without expanding it to a new model identity rule.

Since the Coding Plan and Team Plan do not return dynamic model sets, the `models[]` of these Built-in Providers cannot be cleared. The Start Plan also retains the Built-in default members, to ensure there is still a clear product default value when availability does not currently return the model ID; when the Account `models[]` is present, the whole-list override applies.

## 8. `/client/configs` Ownership Consolidation

`/api/v1/client/configs` is a general remote product configuration center, not an authentication service. The authentication-related interfaces may collaborate with it, but this does not mean the Provider / Model static facts within it should continue to be treated as the account authentication result.

### 8.1 `builtinProviders` and `providers`

Both express the same kind of Provider configuration authority, just different protocol generations:

- `builtinProviders`: the newer normalized structure, mainly containing Provider metadata and model IDs;
- `providers`: the old monolithic compatibility structure, mixing Provider and model configurations;
- The current staging prioritizes using `builtinProviders` when it is non-empty, with `providers` only as a fallback.

The goal is not to long-term retain two entry points, but to migrate the still-valid static facts into the ZCode Built-in Provider Config and ZCode Built-in Model Config Rules, then delete the remote Provider sync and old protocol fallback.

### 8.2 Field Migration Decision

| Remote Config                            | Current Usage                                          | M3 Target                                                                               |
| ---------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `builtinProviders`                       | Provider ID, name, model members, Endpoint, API Schema | Migrated to ZCode Built-in Provider Config, then delete the remote entry                |
| `providers`                              | Old protocol's Provider + Model mixed config           | Delete the compatibility entry after migrating to the existing system                   |
| `builtinModels`                          | context, max output, modalities, reasoning, priority   | Migrated to ZCode Built-in Model Config Rules                                           |
| `magic_name`                             | Match reasoning strategy by model name                 | Delete the remote matcher; write the effective behavior as a general Model Config Rules |
| `offPeak.allowed_models`                 | Idle task model whitelist                              | No longer the model fact authority; static members enter the Built-in Provider Config   |
| `modelContextBudget.strategy`            | Agent context budget gray release                      | Unrelated to model config; do not touch this round                                      |
| Products, plans, discounts               | SKU, display, and commercial config                    | Continues to be managed by the independent remote product                               |
| Security verification flags, forceUpdate | Risk control and release policies                      | Continues to be managed remotely                                                        |
| computerUse, feature flags               | Product gray release                                   | Continues to be managed remotely                                                        |

The `apiKey` field in the old remote Provider type does not need a separate migration design: the real access method is already handled by the existing access system; this legacy field is deleted together with the old protocol.

## 9. Delete Specific Model Hardcoding

This consolidation does not only handle `ox-alpha`. All old code that "recognizes the specific model ID, then decides the reasoning tier, default value, or request parameters" should exit.

The target structure is:

```text
Specific model static behaviors
└─ ZCode Built-in / Personal Model Config Rules
             |
             v
      Effective Model Config
             |
             v
General API Adapter serializes requests according to configuration
```

The Adapter can retain protocol-level mappings, such as:

- Anthropic Messages' `output_config.effort`, adaptive thinking;
- OpenAI Chat Completions / Responses' reasoning parameters;
- The serialization differences of different API Schemas for the same common option.

The Adapter no longer has the product strategy of "which reasoning intensities should a specific model use."

The term "wire" here is just common network engineering terminology, referring to the final HTTP request body sent over the network to the model service; there is no special `wire()` domain function in the Provider reasoning chain. The existing `*-wire.test.ts` intercepts the final request body to prove that the configuration still produces the real request behavior verified by staging after passing through the general Adapter.

The current behavior that needs to be retained for `ox-alpha` is:

```text
reasoning levels = low / high / max
default = max
openai-chat-completions -> reasoningEffort
anthropic-messages      -> adaptive thinking + effort
openai-responses        -> currently not enabling dedicated reasoning
```

These behaviors are written into the ZCode Built-in Model Config Rules; the helpers that identify by model name, the remote regex matcher, the Default Policy special case, and the Catalog special case are deleted. The rules themselves can use the general model match expression, which is simply a declarative matching condition, not a model special case in business code.

## 10. Idle Task Boundaries

The latest goal for idle tasks is to separate "model static facts" from "single-execution access materials":

```text
ZCode Built-in Provider Config + ZCode Built-in Model Config Rules
└─ The static Provider / Model facts of `builtin:offpeak-idle-plan`

Execution context
└─ The request inputs needed for a single idle turn: Request Auth / ticket / attribution, etc.
```

`builtin:offpeak-idle-plan` is a complete Built-in Provider with `visibility: "hidden"`. It enters the same Registry, but is hidden by the Settings and Model Selection Facade; internal idle capabilities create normal Models by precise `providerId/modelId`. It does not overwrite the Session's permanent model. The `enable_offpeak_task` can continue as the remote product gray release; the `allowed_models` no longer bears the Registry model fact.

The Provider Config must declare the complete `api.type`, production Endpoint, model members, and static model facts, and use `access.type = "request-auth"` to express the request-period injection of dynamic authentication. When the Request Auth is missing, the Model fails explicitly before the network request. The `visibility` does not represent trust, permissions, or completeness exemptions.

This round incorporates the static Provider / Model information brought by staging into the existing configuration system, without conveniently rewriting the entire idle task state machine, and without handling `modelContextBudget.strategy`.

## 11. How Staging Product Capabilities Are Absorbed

### 11.1 Video Input

Retain staging's video attachment recognition, upload, persistence, recovery, Tool Result projection, request conversion, budget, desensitization, and error handling. Whether a model supports Video is only read from the model properties in the Effective Model Config, no longer supplemented by the old Catalog, Workspace Snapshot, or Runtime fallback.

### 11.2 Model Input Type Settings

Retain Text fixed, Image/Video switchable, output Text fixed, context/max output defaults, and the theme, internationalization, keyboard, and accessibility intent. The settings are saved to the Personal Model Config Rules.

Do not introduce `modalitiesConfigured`. The three-state of the rule field is sufficient to express:

```text
undefined -> Personal has no opinion on this capability
false     -> Personal explicitly disables
true      -> Personal explicitly enables
```

Undisplayed PDF and Audio capabilities cannot be silently rewritten by the page save. The Audio enters the complete Model Property contract, but this round does not add an attachment entry, content block projection, or Provider encoding; the detailed structure is documented at
[`../design/model/input-output-format.md`](../design/model/input-output-format.md).

### 11.3 Effective Lifecycle

After the Provider or Model settings are saved, update the Registry revision, but do not hot-update already-created Active Models. The next Model creation reads the new configuration. The Video, reasoning, Endpoint, API Key, and other model options all follow the same lifecycle.

### 11.4 Local / Remote

```text
Local Environment  -> Uses the local Config / Registry
Remote Environment -> Uses its own Config / Registry
```

Media attachments and Submissions can pass through the remote control protocol, but the Desktop does not distribute the local Provider Config, account credentials, or Registry Snapshot as remote execution facts.

## 12. Post-Integration Implementation Results

| Area                           | M3 Result                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider overlay               | Fixed as `built-in -> account -> personal`                                                                                                 |
| Account Provider Service input | Only reads the ZCode Built-in Provider Config; does not read Personal                                                                      |
| Model rules                    | Two concatenated arrays: ZCode Built-in + Personal, with Personal last                                                                     |
| Model rules parsing object     | Uses the Effective Provider's final `providerId / modelId / api.type`                                                                      |
| `/client/configs`              | Delete the Provider / Model static facts, the old protocol fallback, and `magic_name` parsing                                              |
| reasoning                      | Specific model strategies enter the Built-in Rules; the Adapter only retains protocol-level serialization                                  |
| OffPeak                        | The hidden Built-in Provider enters the normal Registry; Request Auth injected per request                                                 |
| Video                          | The capability is only read from the Effective Model Config; media processing, persistence, and request conversion retain staging behavior |
| Model settings                 | Text is fixed, Image / Video is editable, saved as the Personal Model Config Rules                                                         |

If older documents still record the Account taking effect last, remote fact sync, or specific model hardcoding, they can only serve as historical implementation records, not as the current semantic basis.

## 13. Impact Scope and Invariants

This change belongs to `option-source + validation + persistence + commit-effect` and does not directly change the conversation protocol, queue, or replay semantics.

| Level          | Impact Area                                                      | Reason                                                                  |
| -------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| must-inspect   | `packages/provider` resolver, Account Provider Service, Registry | Config override and final fact owner                                    |
| must-inspect   | `/client/configs` Provider / Model sync                          | The old remote fact source needs to exit                                |
| must-inspect   | CLI ModelFactory, reasoning policy, API adapters                 | Model Rules must generate the same final request                        |
| must-inspect   | OffPeak execution-scoped model source                            | The boundary between static config and single-turn access materials     |
| should-inspect | Provider Settings, model selection candidates                    | Both consume the Registry, but with different save semantics            |
| should-inspect | Start/Coding/Team Plan availability                              | Only the Start Plan returns dynamic model IDs                           |
| conditional    | Video / modality settings                                        | The new staging capability enters the Effective Model Config            |
| invariant-only | desktop continuous / mobile replayable                           | The Provider consolidation cannot change the message recovery semantics |
| invariant-only | local / remote workspace                                         | The remote environment continues to have its own execution config       |

Must maintain:

1. The Personal Provider Config takes effect last;
2. The Account only constrains the account-type Providers in the Built-in, without touching custom Providers in Personal;
3. The Personal Model Config Rules are after the ZCode Built-in Rules;
4. The Model Rules parse the final API type of the Effective Provider Config;
5. The `models[]` is the Provider's whole-list override, without silently being changed to an authorization intersection;
6. The regular API Provider can still save the static API Key; the account-type Provider Config does not manage account credentials;
7. The server is always the final authentication and authorization authority;
8. Already-created Active Models are not hot-updated by settings;
9. The Desktop does not distribute the local Provider/credential Snapshot to the Remote Environment;
10. Do not restore the old Provider Store, Catalog, Workspace Snapshot, or Runtime fallback as the model fact source.

## 14. Implementation Order

M3 executes in the following order:

1. First write the decisions in this document as the Provider resolver, Account Service, Model Rules, and wire layer tests;
2. Execute the staging integration method decided by the user, retaining the staging product implementations outside the Provider domain;
3. Translate the staging's Provider / Model static facts to the Built-in Config and Model Rules;
4. Integrate Video and the input/output format UI, without restoring the old Store, Catalog, or Snapshot;
5. Delete the `/client/configs` Provider/Model sync, the old protocol fallback, and specific model hardcoding;
6. Consolidate the OffPeak's static fact source; the complete Provider enters the Registry, and the access materials are injected per request;
7. Use a reference audit to confirm that the old entries and model special cases have exited;
8. Update architecture documents that still use the old hierarchical order.

## 15. Acceptance

Completing the implementation requires demonstrating:

- The Provider overlay order is Built-in -> Account -> Personal;
- The Account Service does not read Personal Providers;
- The Model Rules are the ZCode Built-in + Personal array concatenation, and they act on the Effective Provider;
- The Start Plan's dynamic model set correctly overrides the Built-in default set; the Coding/Team Plan still retains the Built-in models;
- The regular API Key and account credentials each follow the correct config/parsing path;
- The `/client/configs` no longer distributes the Provider / Model Registry static facts;
- All specific model reasoning hardcodes have been deleted;
- The final HTTP request behavior of `ox-alpha` and other supported models has not regressed;
- The OffPeak's static model facts come from the Built-in/Rules; the single-turn access materials are not persisted as a normal Provider;
- The Video, Image, and other capabilities come from the Effective Model Config;
- The current Active Model, the Local/Remote ownership, and the desktop/mobile message semantics remain unchanged;
- The typecheck, Lint, and the Provider/Registry/Account/Adapter wire/OffPeak/Settings related tests pass.

This round's integration topology has been decided as a local merge; how the remote branch is subsequently handled is still decided separately by the user, and is not part of this submission.

## 16. Implementation Record

This round completed implementation using `origin/staging@bcb119437370b74b6460b89975afae2ef5cdea33` as the local merge baseline:

- The Provider resolver and the Account Provider Service have been consolidated by Built-in -> Account -> Personal;
- The reasoning behavior of `ox-alpha`, `GLM-x-preview-f`, and `x-preview-f-free` enters the Built-in Rules;
- The Default Policy no longer synthesizes Registry static facts by model name;
- The `/client/configs` Provider / Model fact parsing, sync, and remote matcher have been deleted;
- The `builtin:offpeak-idle-plan` currently provides static members as an unpublished `executionOnly` intermediate implementation; M4 changes it to the general `visibility: "hidden"`, the complete Endpoint, and `request-auth`, without retaining this intermediate field;
- The Video, Image, and reasoning only consume the Effective Model Config;
- The staging's Video, model modality editing, and other Provider out-of-scope product changes are retained.

### 16.1 Verification Results

| Verification Scope                                                    | Result                                                                                                                                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                      | Passes                                                                                                                                                                                                |
| `pnpm --dir apps/zcode-cli -r --if-present typecheck`                 | Passes; all CLI workspace packages with a typecheck script pass                                                                                                                                       |
| `pnpm lint`                                                           | Passes; 0 error, 39 pre-existing staging warnings                                                                                                                                                     |
| Provider / Account / Registry / OffPeak / Settings focused unit tests | 9 files, 117 tests pass                                                                                                                                                                               |
| CLI Video / reasoning / Registry focused unit tests                   | 13 files, 185 tests pass                                                                                                                                                                              |
| Provider settings conflict consolidation focused unit tests           | 5 files, 93 tests pass                                                                                                                                                                                |
| `pnpm test:unit`                                                      | 12,296 pass, 25 skip, 30 fail; failures only occur in 7 Windows packaging, macOS notarization, and CUA native environment test files, with no intersection with this round's Provider / Model changes |
| `oxfmt --check` for this round's 78 modified/new files                | Passes                                                                                                                                                                                                |
| `git diff --check`                                                    | Passes                                                                                                                                                                                                |

The repository-level `pnpm fmt:check` is still blocked by the existing binary `apps/zcode-cli/tests/gb2312.js` and the Electron HTML fixture used to test parse failures, so this round uses the format check of the actual modified/new files as the change gate, without rewriting these unrelated fixtures.

This round only generates a local merge commit, without pushing or rewriting remote branches.
