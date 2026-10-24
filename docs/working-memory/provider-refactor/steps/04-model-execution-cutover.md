# M4: Model Execution Chain Consolidation

> Status: Completed; static, unit and OP10 Desktop network E2E gates pass
>
> Date: 2026-08-24
>
> Target design: [`../design/design.md`](../design/design.md)
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/04-model-execution-cutover.md`

## 1. Phase Goal

M4 integrates idle tasks and Subagent special executions into the standard model call chain:

```text
ModelSelection -> Provider Registry -> ModelFactory -> Model -> ModelRequest -> Adapter -> Provider API
```

No second Model, second Registry or universal temporary Provider is created. Normal sessions, idle tasks, Compact and
Subagents share one set of Effective Provider Config, Effective Model Config, ModelFactory, Adapter, Usage and Trace
semantics. The main migration target was the idle task's `turnRuntimeModel` chain (the Host assembled a complete
Runtime Provider snapshot per dispatch, the CLI injected it into the Runtime Overlay, temporarily switched the Session
model and restored it at Turn end); M4 physically deleted it.

## 2. Configuration Foundation (confirmed)

- Provider Config overlay is fixed `zcodeBuiltinProviders.overlay(accountProviders).overlay(personalProviders)`. Account
  only supplements or constrains account-type Built-in Providers and does not read Personal custom Providers;
  Personal takes effect last.
- Model Config Rules are array concatenation (`...zcodeBuiltinModelRules.rules(), ...personalModelRules.rules()`,
  Personal last) acting on the Effective Provider Config:
  `effectiveModelRules.resolve(providerId, modelId, provider.api?.type)` for each model of each provider.
- Provider Config answers which Providers exist, their models, API and access method; Model Config Rules answer model
  capabilities, options and request parameter mappings.

## 3. Provider Visibility

`type ProviderVisibility = "visible" | "hidden"` (default `visible`) replaces `executionOnly`.

- `visible`: appears in Provider Settings and Model Selection candidates. `hidden`: appears in neither.
- `visibility` controls only user-facing display and candidates; it does not express authentication, call
  permission, execution source or Config completeness. A hidden Provider still takes part in normal Provider/Model
  resolution, enters the internal Registry and uses the same ModelFactory; internal product capabilities create it by
  the precise `providerId + modelId` (no "trusted Provider" or separate creation interface).
- `executionOnly` was an unpublished intermediate field, deleted directly with no importer or compatibility reading.

## 4. Access and Credential Boundaries

Provider Config is the assembly input for the model API call; it may save static credentials or stable credential
references but is not a credential center, does not manage dynamic credential lifecycles and does not carry the
server's final authorization decision.

| Access type     | Config saves                                                        | Behavior at request time                                                     |
| --------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `api-key`       | Static `apiKey`                                                     | Adapter uses the Key from Config                                             |
| `zhipu-account` | Stable non-sensitive `accessId`                                     | Account Request Auth Service resolves current dynamic credentials            |
| `request-auth`  | No credentials; declares authentication is supplied at request time | ModelRequest consumes the Request Auth the caller provides at execution time |

`request-auth` is a normal Access type, not bound to `visibility`, idle tasks or "trusted execution"; any Provider can
use it. The execution context puts the Request Auth Source for its scope into `ModelRequestDependencies` when creating
the Model; the public `ModelRequest` gets no credential field.

```text
Config / Registry completeness: access.type = request-auth, api.type, api.baseURL, models[] and Effective Model Config all complete
ModelRequest execution: Source resolves Request Auth -> merge dynamic Headers and send;
  Source not assembled / unresolvable -> typed authentication-missing error before any network request
```

Hidden Providers get no validation exemption for `access` or `baseURL`.

## 5. Idle Built-in Provider

`builtin:offpeak-idle-plan` is a normal ZCode Built-in Provider, user-invisible, with request-period authentication:

```json
{
  "label": "Idle plan",
  "visibility": "hidden",
  "access": { "type": "request-auth" },
  "api": {
    "type": "anthropic-messages",
    "baseURL": "https://zcode.z.ai/api/v1/off-peak/anthropic"
  },
  "models": ["GLM-5.2", "GLM-5-Turbo"]
}
```

The production Endpoint is a static fact of the Built-in Provider Config; tests and mocks rewrite configuration by
injecting a test Built-in Config Source (never by putting the Endpoint into the single-Turn payload). Context, max
output, input/output format, reasoning levels and reasoning mapping come from ZCode Built-in Model Config Rules; the
Host no longer infers by modelId, Provider family or remote `builtinModels`. `enable_offpeak_task` may remain the idle
task product gray release; remote `allowed_models` is no longer Provider.models, capability or Registry fact source,
and the server may still do its own final admission at the ticket or model request boundary.

## 6. Idle Submission

The idle task is a normal Core Submission with execution-period context. Host / Scheduler supplies prompt,
attachments, mode, the idle `ModelSelection`, execution-scoped Request Auth, Off-Peak Ticket and an optional Subagent
Model override; Core Submission -> Registry / ModelFactory -> Loop Active Model. The Submission has exactly one
`ModelSelection`; Request Auth, Ticket, Off-Peak attribution and Subagent override are extra context and never create a
second model binding, Selection or complete Provider/Model Config. The execution context:

- carries no Provider/Model static facts;
- does not write Session Selection;
- does not enter Personal Config, Registry View or Session persistence;
- does not enter the normal user busy queue, Guide or held queue;
- never writes Secrets, Tickets or plaintext to logs, Telemetry or conversation events.

## 7. Session Selection and Active Model

The idle task never modifies and then restores the user's Session Selection (user model U): while the idle Turn runs,
Session Selection stays U and the Loop Active Model is I; when it ends the Model I lifecycle ends and Selection is
still U; the next normal Submission creates a Model from U. M4 deletes the whole "save previous model -> temporary
`setModel` -> restore in `finally`" state machine. The Active Model is the single model execution fact of the Loop; the
Session Selection only says what model later normal main executions use.

Idle dispatch is accepted only when the Session can start-now. On a busy race the Core returns a typed admission
rejection and the Scheduler re-dispatches later; idle Request Auth/Ticket never enters the normal CommandInbox/FIFO. A
user's supplementary input during the idle Turn enters the existing normal queue and, after the idle Turn terminal,
executes with its saved normal Submission and the user's Session Selection (no idle Provider, Request Auth, Ticket or
attribution inherited).

## 8. Compact, Subagent, Goal, Background

- **Automatic Compact** belongs to the current Loop and uses the current Active Model (same Provider, Model Config,
  Options, request-period authentication context). It does not read Session Selection nor receive a
  `TurnExecutionModel` snapshot. **Manual Compact** is a new normal Submission and creates the Model from that
  Submission's ModelSelection.
- **Subagent Selection priority:** Core Server Submission override > Subagent Profile Selection > Parent Loop Active
  Selection. Each Child creates its own Model through the same Registry/ModelFactory (Parent and Child do not share a
  mutable Model). The idle task uses the common Core Server override to fix the allowed Foreground Child to this
  round's idle Selection and passes this round's Request Auth/Ticket context to the Child's model request, so Explore,
  general-purpose and custom Foreground Children all use the idle Provider, model and dynamic access materials (never
  another Provider from the Profile). A Background Child is fail-closed by Tool Policy before any model request.
- **Goal and Background.** A normal Background task obtains its own Model at start and keeps it for its lifecycle; the
  new main Loop awakened after it uses the Session Selection at that time. Each automatic Goal continuation round is a
  new main Loop using the Session Selection at that time; neither writes its model back to Session Selection.

## 9. Permission / Elicitation (D44)

Permission/elicitation uses the normal Session's blocking interaction, and the same automatic Turn continues after the
response, still using the idle Active Model; the Off-Peak task stays running on approve / deny / skip. M4 adds no
`awaiting_approval` idle state, no switch to the user's Provider after approval and no mid-turn Provider handoff; only
after the current automatic Turn ends can a normal user Submission use the user's Session Selection.

## 10. Ticket Expiry, Cancellation, Re-dispatch

Ticket, task queuing, resumption and settlement belong to the Off-Peak Scheduler/Repo and never enter Provider Config
or Registry. Ticket expiry or dispatch failure ends the current automatic Turn; the Scheduler keeps the Task, Session
and transcript, re-obtains a Ticket, dispatches a new Core Submission, and the Registry / ModelFactory creates a new
Idle Model. After success, failure, cancellation, preemption, ticket expiry or process restart the old Request Auth
cannot enter the next dispatch. Ticket retrieval, rearrangement, the 3-hour timebox and continuation stay in the
current Off-Peak domain implementation.

## 11. Registry and Facade

There is one complete Registry holding visible and hidden Providers. The Settings Facade and Selection Facade project
only visible; internal exact lookup / create is shared. The visibility filter belongs to the Facade and does not
change Registry members or ModelFactory. There is no special Model creation interface, Execution Registry,
execution-scoped Provider Source or temporary Registry injection.

## 12. Adapters and Attribution

A `request-auth` Model obtains dynamic authentication materials from this round's scope Request Auth Source before each
real request and merges them with the static Headers in Provider Config. Missing materials fail before the network
request; Retry can only continue or refresh materials within the current valid execution context. Usage, Trace and
errors attribute to the actual Model (`providerId = builtin:offpeak-idle-plan`, `modelId` = this round's idle model).
`offPeakTaskId`, Ticket ID and run type are task/execution dimensions and neither replace Model identity nor attribute
the user's queue items to the idle Provider.

## 13. State Ownership

| State or fact                            | Authority owner                                       | Lifecycle                   | Must not write                                |
| ---------------------------------------- | ----------------------------------------------------- | --------------------------- | --------------------------------------------- |
| Provider static facts                    | Effective Provider Config                             | Config revision             | Static snapshot in the Turn payload           |
| Model static facts                       | Effective Model Config                                | Config revision             | Host hardcode, modelId special case           |
| The user's subsequent main model         | Session Selection                                     | Session                     | The idle execution context                    |
| The current execution model              | Loop Active Model                                     | Loop                        | Session persistent preference                 |
| Account connection identity              | Account Provider Config `accessId`                    | Account connection          | API Key/JWT/Header                            |
| Account dynamic credentials              | Account Request Auth Service                          | Request attempt             | Provider Config                               |
| Idle dynamic credentials and Ticket      | Off-Peak Scheduler / Request Auth context             | Valid dispatch              | Config, Registry View, Session snapshot, logs |
| Queue, Ticket, task and resumption state | CLI CommandInbox / Off-Peak Scheduler / Off-Peak Repo | Their own domain lifecycles | The Registry                                  |

## 14. UI Surface Matrix

| Scenario                  | Candidate/config source                          | Visibility and validation                              | Submission/execution owner   | Must isolate                            |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------ | ---------------------------- | --------------------------------------- |
| Provider Settings         | Settings Facade                                  | Only `visibility=visible`                              | Personal Config Repository   | Hidden Provider, Session Selection      |
| Conversation Model Picker | Selection Facade                                 | Only complete, enabled, visible models                 | Composer/Submission          | Hidden Provider, Active Model           |
| Off-Peak Creation Page    | Product projection of the Built-in idle Provider | Product gray release; not a Registry fact source       | Off-Peak Service/Scheduler   | Personal Config, normal model selector  |
| Off-Peak Automatic Turn   | Precise idle ModelSelection                      | Core start-now admission                               | CLI Loop Active Model        | Session Selection, normal Queue         |
| Subagent Settings         | Visible Registry candidates / Profile            | Saves the Profile, does not change the current Session | Subagent Config/Markdown     | Off-Peak single-turn override           |
| Off-Peak Foreground Child | Current idle override                            | Background rejected by Tool Policy                     | Child Runtime / ModelFactory | Profile's other Provider, Session state |

## 15. Invariants

- Provider overlay is always Built-in -> Account -> Personal; Model Rules always Built-in + Personal on the Effective
  Provider.
- `visibility` affects only the user View, not completeness, Access or ModelFactory; all Providers must have their own
  complete Access, API, Endpoint, models and Model Config.
- `request-auth` fails before the network when request-period credentials are missing.
- The idle task never modifies then restores Session Selection; Automatic Compact uses the current Loop Active Model.
- Each Subagent creates its own Model; the idle Foreground Child uses the common override.
- The same idle Turn keeps using the idle Model after permission approve/deny.
- User busy input enters the unique CLI Queue and uses its normal Submission after the idle Turn ends.
- Provider refactoring does not change desktop continuous, web remote replayable or workspace identity semantics.

## 16. Old Production Structures Deleted

Audited at completion with `dep:refs`, `rg` and `knip`: `ProviderConfig.executionOnly`; `sendText.turnRuntimeModel`; the
complete `ZCodeModelRuntimeConfig` for idle purposes; `buildOffPeakTurnRuntimeModel`; `TurnExecutionModel`;
`ExecutionScopedModelSource` / `createTurnExecutionModelSource`; the Turn Runtime Model Overlay; temporary Provider
Registry projection and replacement; `applyTurnRuntimeModel` / `clearTurnRuntimeModel`; `previousModel`, temporary
`setModel` and restore `finally`; Compact/Subagent reading the old Turn snapshot; the Host's repeated assembly of
Endpoint, properties, reasoning and model constraints. Also `runtime-model-factory.ts`, `turn-model-overlay.ts`,
`turn-execution-model-source.ts` and the Session Facade / V4 Bridge apply, clear, set/restore interfaces. If an old
public type still had non-idle consumers, prove each consumer's semantics before migrating (no batch delete by type
name).

## 17. Implementation Order

- **M4.1 Config, Visibility, Access.** Failing tests first; migrate `executionOnly` to `visibility` (Facade filters);
  add `request-auth` Access and completeness check; complete `builtin:offpeak-idle-plan` Access, Endpoint, models and
  Built-in Model Rules; the Registry includes the complete hidden Provider while normal Settings/Selection Views do not
  project it.
- **M4.2 Standard Model creation and request authentication.** Internal idle calls use the Registry lookup/ModelFactory
  by precise Selection; Model/Adapter support call-level Request Auth; missing Request Auth returns the typed error and
  dynamic materials never enter Config or Registry; generate/stream, Retry, Usage and Trace share one Adapter
  boundary.
- **M4.3 Switch idle production dispatch.** The Host no longer builds `turnRuntimeModel`; the Core Submission carries
  the standard Selection and minimal execution context; CLI admission creates the Idle Active Model directly (no
  temporary `setModel`); Automatic Compact, Foreground Subagent and permission continuation use the formal Active
  Model/Selection; Ticket expiry, cancellation, failure and success end the execution context along the existing
  Off-Peak state machine.
- **M4.4 Delete dual-track.** Delete Runtime Overlay, Turn snapshot, temporary Registry injection and restore state
  machine; delete the Host's repeated Provider/Model static fact assembly; reference audit confirms no production
  consumer reads facts from the old Runtime Model; update Design, Feature Graph, Off-Peak/Subagent spec and test
  matrix.

## 18. Acceptance Cases

| Case  | Setup                                                 | Action                                               | Assertions                                                                                | Evidence layer    |
| ----- | ----------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------- |
| M4-01 | Hidden idle Provider fully configured                 | Read Settings/Selection/Registry                     | Two user Views exclude idle; Registry can look it up exactly                              | domain unit       |
| M4-02 | `request-auth` Provider has no call-level credentials | generate/stream                                      | Typed authentication-missing error before the network; no request sent                    | adapter unit      |
| M4-03 | Idle Session's user Selection = U                     | Dispatch idle Selection = I                          | Active Model = I; Session Selection still U                                               | protocol/runtime  |
| M4-04 | Idle Turn running                                     | User sends a normal prompt                           | Input enters the unique Queue; after terminal uses U                                      | protocol/network  |
| M4-05 | Idle Turn triggers Automatic Compact                  | Compact request                                      | Request uses I, idle Endpoint and current Request Auth                                    | runtime/network   |
| M4-06 | Profiles configure other models                       | Idle parent turn starts multiple Foreground Children | Children each create their Model but all use the idle override; Background has no request | runtime/network   |
| M4-07 | Idle Turn requests permission                         | approve / deny                                       | Off-Peak task stays running; same Turn still hits the idle Endpoint                       | protocol/network  |
| M4-08 | Current Ticket becomes invalid                        | Scheduler re-obtains ticket and resumes              | New dispatch, new Model, new dynamic materials; Session/transcript continues              | service/runtime   |
| M4-09 | Idle Turn ends                                        | User continues the normal conversation               | Uses U; no idle Header, Ticket or attribution leakage                                     | network/telemetry |

No full Cartesian product over theme, language, OS, Provider family, workspace type or delivery kind: shared
Core/Adapter behavior is proven by focused tests; Desktop continuous uses the existing Off-Peak representative E2E;
Mobile replayable only verifies the protocol fields do not enter recovery state (no new idle mobile product
capability).

## 19. Completion Gate

M4 is complete only when: idle Provider/Model static facts enter execution only from Effective Config/Rules; Hidden is
only user-visible and does not bypass Config completeness and Access; the idle Model is created through the standard
Registry/ModelFactory; idle Request Auth/Ticket does not enter Config, Registry View or Session persistence; the idle
task does not modify or restore Session Selection; Compact, Subagent and permission keep the inheritance semantics
above; the `turnRuntimeModel`, Runtime Overlay, Turn snapshot and restore production chain are physically gone; Usage,
Trace and errors attribute to the actual Model; relevant unit tests, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`
and affected E2E pass.

## 20. Explicitly Excluded

Remote Provisioning, remote settings, remote login and cross-Environment config sync; Account Provider identity,
entitlement and plan topology refactoring; Management Service distributing the Built-in Config;
`modelContextBudget.strategy`; Off-Peak UI redo; Queue, snapshot, reconnect and continuous/replayable semantics
changes; Audio content block, attachment entry or Provider encoding.

## 21. Impact Brief (summary)

Change layers: option-source, validation, commit-effect, persistence, recovery invariant. Primary seeds:
`ProviderConfigResolver`, `buildOffPeakRequestAuth`, `sessionFlowHandlers`, `agentHandler`. Shared vs deliberately
different: all Models come from the same Registry/ModelFactory (hidden Provider not in the user Facade); all Providers
do completeness and Adapter validation (`request-auth` additionally needs call-level credentials, and visibility is
never an authentication exemption); all Loops hold the Active Model (idle start-now does not write Session Selection);
each Child creates its own Model (idle Foreground Child forced to the idle override, Background rejected); Config
holds static facts and Session holds the normal Selection (Ticket/Auth belongs to one dispatch only).

Key relationships: Off-Peak scheduler dispatches Selection + context to CLI admission (old code
`offPeakRuntimeModel.ts`, `session-flow.ts`); hidden Built-in Provider creates through Registry/ModelFactory
(Registry Design §§3, 11); the idle Active Model is inherited by Automatic Compact (Execution Design §8.1); the idle
execution context overrides the Foreground Child (OP10, Execution Design §8.2); the permission response continues the
same idle Turn (D44, OP03, Execution Design §9); Request Auth validates before Adapter network I/O; M4 must not mutate
desktop/mobile delivery nor own Remote Provisioning.

Graph/doc drift corrected: the Feature Graph's old code seeds pointing at the deleted dual-track were changed to the
live Request Auth, dispatch, Submission and Registry Model Runtime seeds; the Provider Registry invariant now says the
server makes the final authorization decision (Config only assembles access materials); OP03 previously recorded a
switch to the user's Provider after approval, which contradicts Off-Peak spec D44, and the case catalog and coverage
matrix were synchronized. There were no unresolved issues changing M4 scope; protocol field physical names, the typed
error enum and the Request Auth Port signature are implementation details. No callable codegraph existed, so the
review used declared seeds, `rg` exact references and depth-2 manual call-graph checks; the completion gate used
`dep:refs`, `knip` and affected tests.

Planning boundary decisions: Provider visibility is general `visible/hidden` (Facade filtering only, no permission,
trust or completeness exemption); Access `request-auth` is request-level dynamic authentication (pre-network missing
validation and Retry lifecycle; no Secret persistence or Account sync); idle uses one standard ModelSelection through
the same Registry/Factory/Model; idle writes and recovers nothing in Session state; permission continues the same idle
Turn (approve/deny/skip, D44); Foreground Child idle override, Background rejected (OP10). Dimensions included:
visibility, request auth present/absent/expired, admission idle/busy race, child foreground/background, permission
approve/deny/skip, delivery desktop continuous/web replayable (isolation proof only). Not expanded: provider family,
workspace kind, OS, theme, locale. E2E reuses the Off-Peak mock gateway: OPA proves the idle endpoint is still hit
after permission; OPS proves Foreground Child inheritance and Background rejection; OPB proves normal user input and
the terminal-state conversation inherit no idle Provider/Auth/attribution.

## 23. Implementation Results

### 23.1 Final command boundary

```text
sendText
|- modelSelection { providerId, modelId, options }
`- modelExecution
   |- selectionScope = execution
   |- requestAuth { apiKey?, headers? }
   `- subagents { foregroundModel = submission, background = deny }
```

The strict protocol rejects Endpoint, Provider Config, Model Config or properties in `modelExecution`, which is only
accepted for start-now admission of an idle Session (never the busy Queue, Guide or held Queue).

### 23.2 Standard execution chain

Host idle ModelSelection + Request Auth -> Core Submission -> Provider Registry / ModelFactory -> Loop Active Model ->
Automatic Compact and Foreground Child (Child ModelFactory). An execution-scoped Submission skips the Session model
pre-check and the Session restore warning and validates through its own precise Selection in the standard
Registry/ModelFactory; a normal Submission keeps the original Session model pre-check.

### 23.3 Mock and credential boundaries

The `ZCODE_OFFPEAK_MOCK=1` Desktop E2E derives a test Official Config from the formal `official.json`, rewriting only
`builtin:offpeak-idle-plan.api.baseURL` to the in-process mock gateway and injecting it into Host and Worker through
the Official Config Source path. The command ledger persists only normal input intent, attachments and Selection;
`requestAuth` never enters the input ledger, conversation events, Session snapshot or repo sidecar; production logs
record only command lifecycle, ID and length.

### 23.4 Verification (2026-08-24)

- `pnpm typecheck` passed (Desktop Host, E2E types, CLI Contracts/Core/Bootstrap builds); `pnpm lint` passed (39
  pre-existing warnings, 0 new errors).
- M4 focused tests passed: 5 files / 135 tests (root), 7 files / 109 tests (CLI); Compact 7 files / 168; Registry/Adapter
  2 files / 19; final sealing re-run 10 files / 189 tests (Adapter, Core lifecycle, Bootstrap, Provider Selection,
  Services, Desktop Bundle); `typecheck:e2e`, OP10 fixture check and format check passed.
- `test:unit:affected` escalated to a full run (staging baseline includes deleted files): 1445 of 1454 files and 12,298
  tests passed; the only M4-related failure (M2 guard still permitting the old Overlay) passes after tightening the
  guard; the other 30 are baseline failures (Linux missing `zip`, macOS notarization/CUA native fixture mismatch).
- Full-workspace `fmt:check` stays blocked by the vendored Electron HTML and GB2312 fixture; `oxfmt --check` of 65 changed
  files and `git diff --check` passed. `dep:refs` confirms live references of `buildOffPeakRequestAuth`,
  `ApiProviderModelRuntime`, `applySubmissionExecutionState`; the old dual-track production symbol search is zero.
  Full-workspace `knip` and Feature Graph integrity still have pre-existing drift outside this change (M4 nodes
  resolve).
- OP10 representative Desktop E2E passed in an isolated Xvfb environment (1 spec / 1 test, 26.5 s): parent turn and
  Foreground Child use the same idle Selection and request authentication; Background Child rejected; after idle
  completion the normal Prompt of the same Session restores the user-configured DeepSeek Model; real requests reach the
  network proxy.

Three integration boundaries found and corrected during acceptance:

1. The Protocol Agent, like CLI/TUI, reads the Environment-level Model Selection Config; the explicit configured
   default can reference the hidden Provider; only the user fallback when no explicit selection exists skips hidden
   candidates.
2. The Desktop main/host/scheduler bundle inlines `@zcode/provider` and `@zcode/provider-node` so the Electron worker
   does not parse non-existent `.js` files from the TypeScript source export in a clean execution environment.
3. The Adapter consumes the Host's account runtime-header Port only when the Active Model binds `accountAccessId`; a
   normal API-key Model uses static access materials from Provider Config; a `request-auth` Model uses the request auth
   source frozen at creation time.

Reproduction command:

```text
ZCODE_E2E_CONTAINER=1 \
ZCODE_E2E_SPEC=./test/e2e/conversation-session/manual-review/pending/\
conversation-session-offpeak-subagent-model-inheritance.test.ts \
pnpm --filter @zcode/desktop test:e2e:serial
```
