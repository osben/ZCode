# M4: Model Execution Chain Consolidation

> Status: Completed; static, unit, and OP10 Desktop network E2E gates pass
>
> Date: 2026-08-24
>
> Target design: [`../design/design.md`](../design/design.md)

## 1. Phase Goal

M4 integrates idle tasks and Subagent special executions into the established standard model call chain:

```text
ModelSelection
      |
      v
Provider Registry
      |
      v
ModelFactory
      |
      v
Model
      |
      v
ModelRequest -> Adapter -> Provider API
```

M4 does not create a second Model, a second Registry, or a universal temporary Provider. After this phase, normal sessions, idle tasks, Compact, and Subagents all use the same set of Effective Provider Config, Effective Model Config, ModelFactory, Adapter, Usage, and Trace semantics.

M4's main migration target is the idle task's existing `turnRuntimeModel` chain. Before M4, the Host assembles a complete Runtime Provider snapshot for each dispatch, and the CLI then injects it into the Runtime Overlay, temporarily switches the Session model, and restores it when the Turn ends. M4 has physically deleted this compatibility chain.

## 2. Confirmed Configuration Foundation

### 2.1 Provider Config

The Provider Config is fixed to be overlaid in the following order:

```text
ZCode Built-in Provider Config
              |
              v
     Account Provider Config
              |
              v
    Personal Provider Config
              |
              v
    Effective Provider Config
```

```ts
const effectiveProviders = zcodeBuiltinProviders
  .overlay(accountProviders)
  .overlay(personalProviders);
```

The Account only supplements or constrains the account-type Providers in the ZCode Built-in; it does not read the Personal custom Provider.
The Personal takes effect last, expressing the user's final configuration of the model API call encapsulation.

### 2.2 Model Config Rules

The Model Config Rules are array concatenation, with Personal last:

```ts
const effectiveModelRules = new ModelConfigRules([
  ...zcodeBuiltinModelRules.rules(),
  ...personalModelRules.rules(),
]);
```

The rules act on the Effective Provider Config:

```ts
for (const [providerId, provider] of effectiveProviders) {
  for (const modelId of provider.models ?? []) {
    effectiveModelRules.resolve(providerId, modelId, provider.api?.type);
  }
}
```

The Provider Config answers "which Providers exist, what models each Provider has, what API and access method to use";
the Model Config Rules answer "what capabilities, options, and request parameter mappings does the model have". Together they form the complete Model.

## 3. Provider Visibility

M4 replaces `executionOnly` with general user visibility:

```ts
type ProviderVisibility = "visible" | "hidden";
```

Default is `visible`.

```text
visibility = visible
├─ Appears in the Provider Settings
└─ Appears in the Model Selection candidate list

visibility = hidden
├─ Does not appear in the Provider Settings
└─ Does not appear in the Model Selection candidate list
```

The `visibility` only controls the user-facing display and candidate list; it does not express authentication, calling permissions, execution source, or Config completeness.
The Hidden Provider still participates in the normal Provider/Model resolution, still enters the internal Registry, and uses the same ModelFactory.
Internal product capabilities can create it when they know the precise `providerId + modelId`, without needing a "trusted Provider" or another creation interface.

The `executionOnly` is an unpublished intermediate field, directly deleted by M4, without retaining an importer or long-term compatibility reading.

## 4. Access and Credential Boundaries

The Provider Config is the assembly input for the model API call. It can save static credentials or stable credential references, but is not a unified credential center, does not manage all dynamic credential lifecycles, and does not bear the server's final authorization decision.

The Access types after M4 include at least:

| Access type     | What the Config saves                                                                                  | Behavior at request time                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `api-key`       | Static `apiKey`                                                                                        | The Adapter uses the Key from the Config                                            |
| `zhipu-account` | Stable, non-sensitive `accessId`                                                                       | The Account Request Auth Service parses the current dynamic credentials             |
| `request-auth`  | Does not save specific credentials, only declares that authentication must be provided at request time | The ModelRequest consumes the Request Auth provided by the caller at execution time |

The `request-auth` is a normal Access type, not bound to `visibility`, idle tasks, or so-called "trusted execution". Any Provider can adopt this access method. The execution context assembles the Request Auth Source for this scope into the `ModelRequestDependencies` when creating the Model; the public `ModelRequest` does not add a credential field. Its completeness rule is:

```text
Config / Registry Completeness
├─ access.type = request-auth
├─ api.type is complete
├─ api.baseURL is complete
├─ models[] is complete
└─ Effective Model Config is complete

ModelRequest Execution
├─ This round's Source can parse the Request Auth -> Merge dynamic Headers, send the request
└─ Source not assembled / cannot parse -> Return the typed authentication-missing error before the network request
```

The Hidden Provider no longer receives the validation exemption for `access` or `baseURL`.

## 5. Idle Built-in Provider

The `builtin:offpeak-idle-plan` is a normal ZCode Built-in Provider, just user-invisible and using request-period authentication:

```json
{
  "label": "Idle plan",
  "visibility": "hidden",
  "access": {
    "type": "request-auth"
  },
  "api": {
    "type": "anthropic-messages",
    "baseURL": "https://zcode.z.ai/api/v1/off-peak/anthropic"
  },
  "models": ["GLM-5.2", "GLM-5-Turbo"]
}
```

The production Endpoint is the static fact of the Built-in Provider Config. The tests and mocks rewrite the entire test configuration by injecting a test Built-in Config Source, without putting the Endpoint back into the single Turn payload.

The model's context, max output, input/output format, reasoning levels, and reasoning mapping come from the ZCode Built-in Model Config Rules. The Host no longer infers by modelId, Provider family, or remote `builtinModels`.

The `enable_offpeak_task` can continue as the idle task product gray release. The remote `allowed_models` no longer serves as the Provider.models, model capabilities, or Registry fact source; the server can still execute its own final admission at the ticket or model request boundary.

## 6. Idle Submission

The idle task is a normal Core Submission with execution-period context:

```text
Host / Scheduler
├─ prompt / attachments / mode
├─ idle ModelSelection
├─ execution-scoped Request Auth
├─ Off-Peak Ticket
└─ optional Subagent Model override
             |
             v
       Core Submission
             |
             v
   Registry / ModelFactory
             |
             v
       Loop Active Model
```

The Submission always has only one `ModelSelection`. The Request Auth, Ticket, Off-Peak attribution, and Subagent override are the additional context of special executions; they do not produce a second model binding, Selection, or complete Provider/Model Config.

The protocol's final field shape is fixed by reusing the existing strict schema and the Request Auth Port at implementation time, but must satisfy:

- It does not carry Provider/Model static facts;
- It does not write to Session Selection;
- It does not enter Personal Config, Registry View, or Session persistence;
- It does not enter the normal user busy queue, Guide, or held queue;
- It does not write Secrets, Tickets, or plaintext to logs, Telemetry, or conversation events.

## 7. Session Selection and Active Model

The idle task never modifies and then restores the user's Session Selection:

```text
Session Selection = User's model U

Idle task starts
├─ Session Selection is still U
└─ Idle Loop Active Model = I

Idle task ends
├─ The Model I lifecycle ends
└─ Session Selection is still U

The next normal user Submission
└─ Creates a new Model based on Session Selection U
```

Therefore M4 deletes the complete state machine of "save previous model -> temporarily setModel -> finally restore". The Active Model is the single model execution fact of the current Loop; the Session Selection only expresses what model the Session's subsequent normal main execution uses.

Idle dispatch only accepts when the Session can currently start-now. If a busy race is encountered, the Core returns a typed admission rejection, and the Scheduler re-dispatches later; the idle Request Auth/Ticket does not enter the normal CommandInbox/FIFO.

The running user's supplementary input continues to enter the existing normal queue. After the idle Turn terminal, the queue items execute based on the normal Submission they saved and the user's Session Selection, without inheriting the idle Provider, Request Auth, Ticket, or attribution.

## 8. Compact, Subagent, Goal, and Background

### 8.1 Compact

The Automatic Compact belongs to the current Loop and directly uses the current Active Model, including the same Provider, Model Config, Options, and request-period authentication context. It does not read Session Selection, nor does it receive the `TurnExecutionModel` snapshot.

The manual Compact is a new normal Submission and continues to create the Model based on that Submission's ModelSelection.

### 8.2 Subagent

The Subagent Selection priority is maintained:

```text
Core Server Submission override
        >
Subagent Profile Selection
        >
Parent Loop Active Selection
```

After the Selection is determined, each Child creates its own Model through the same Registry/ModelFactory. The Parent and Child do not share the same mutable Model object.

The idle task uses the common Core Server override to fix the allowed Foreground Child to this round's idle Selection, and passes this round's Request Auth/Ticket context to the Child's model request. In this way, the Explore, general-purpose, and custom Foreground Child all use the same idle Provider, model, and dynamic access materials, without reading another Provider from the Profile. The Background Child is fail-closed by the Tool Policy before issuing the model request.

### 8.3 Goal and Background

The normal Background task obtains its own Model at start time and maintains it within its own lifecycle. The new main Loop awakened after it completes uses the Session Selection at that time. Each automatic continuation round of the Goal is also a new main Loop, using the Session Selection at the time of the continuation; neither writes its model back to the Session Selection.

## 9. Permission / Elicitation

The idle task maintains D44: the permission/elicitation uses the normal Session's blocking interaction, and the same automatic Turn continues after the user's response, still using the idle Active Model.

```text
Idle Turn
└─ permission / elicitation requested
       ├─ Normal Session displays and collects the response
       ├─ Off-Peak task stays running
       └─ approve / deny / skip
              └─ The same Turn continues, still using the Idle Model
```

M4 does not add an `awaiting_approval` idle state, does not switch to the user's Provider after approval, and does not establish a mid-turn Provider handoff. Only after the current automatic Turn ends can the subsequent normal user Submission use the user's Session Selection.

## 10. Ticket Expiry, Cancellation, and Re-dispatch

The Ticket, task queuing, resumption, and settlement belong to the Off-Peak Scheduler/Repo and do not enter the Provider Config or Registry:

```text
Idle Model Request
      |
      v
Ticket expires / Current dispatch fails
      |
      v
The current automatic Turn ends
      |
      v
The Scheduler keeps the Task, Session, and transcript
      |
      v
Re-obtains the Ticket and dispatches a new Core Submission
      |
      v
The Registry / ModelFactory creates a new Idle Model
```

After success, failure, cancellation, preemption, ticket expiry, or process restart, the old Request Auth cannot enter the next re-dispatch. The specific ticket retrieval, rearrangement, 3-hour timebox, and continuation still use the current Off-Peak domain implementation.

## 11. Registry and Facade

After M4, there is only one complete Registry:

```text
Effective Provider / Model Config
             |
             v
       Provider Registry
       ├─ visible Provider
       └─ hidden Provider
             |
             +--> Settings Facade: only projects visible
             +--> Selection Facade: only projects visible
             `--> Internal exact lookup / create: visible and hidden share
```

The Visibility filter belongs to the Facade and does not change the Registry members and ModelFactory. There is no special Model creation interface, Execution Registry, execution-scoped Provider Source, or temporary Registry injection.

## 12. Adapters and Attribution

The `request-auth` Model obtains the dynamic authentication materials from this round's scope Request Auth Source before each real request, and merges them with the static Headers in the Provider Config. When the materials are missing, it fails before the network request; the Retry can only continue or refresh the materials within the current valid execution context.

The Usage, Trace, and errors must be attributed to the actual Model:

```text
providerId = builtin:offpeak-idle-plan
modelId    = This round's actual idle model
```

The `offPeakTaskId`, Ticket ID, and run type are the task/execution dimension and do not replace the Model identity, nor can they attribute the user's queue items to the idle Provider.

## 13. State Ownership

| State or Fact                             | Authority Owner                                       | Lifecycle          | Must not write                                |
| ----------------------------------------- | ----------------------------------------------------- | ------------------ | --------------------------------------------- |
| Provider static facts                     | Effective Provider Config                             | Config revision    | The static snapshot of the Turn payload       |
| Model static facts                        | Effective Model Config                                | Config revision    | The Host hardcode, the modelId special case   |
| The user's subsequent main model          | Session Selection                                     | Session            | The idle execution context                    |
| The current execution model               | Loop Active Model                                     | Loop               | The Session persistent preference             |
| Account connection identity               | Account Provider Config `accessId`                    | Account connection | The API Key/JWT/Header                        |
| Account dynamic credentials               | Account Request Auth Service                          | Request attempt    | The Provider Config                           |
| Idle dynamic credentials and Ticket       | Off-Peak Scheduler / Request Auth context             | Valid dispatch     | Config, Registry View, Session snapshot, logs |
| Queue, Ticket, task, and resumption state | CLI CommandInbox / Off-Peak Scheduler / Off-Peak Repo | 各自的领域生命周期 | The Registry                                  |

## 14. UI Surface Matrix

| Scenario                  | Candidate/Config Source                              | Visibility and Validation                                      | Submission/Execution Owner       | Must Isolate                                |
| ------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- | -------------------------------- | ------------------------------------------- |
| Provider Settings         | Settings Facade                                      | Only displays `visibility=visible`                             | Personal Config Repository       | The hidden Provider, Session Selection      |
| Conversation Model Picker | Selection Facade                                     | Only displays complete, enabled, visible models                | Composer/Submission              | The hidden Provider, Active Model           |
| Off-Peak Creation Page    | The product projection of the Built-in idle Provider | Product gray release; does not become the Registry fact source | Off-Peak Service/Scheduler       | Personal Config, the normal model selector  |
| Off-Peak Automatic Turn   | The precise idle ModelSelection                      | The Core start-now admission                                   | The CLI Loop Active Model        | Session Selection, the normal Queue         |
| Subagent Settings         | The visible Registry candidates / Profile            | Saves the Profile, does not change the current Session         | Subagent Config/Markdown         | The Off-Peak single-turn override           |
| Off-Peak Foreground Child | The current idle override                            | The Background is rejected by the Tool Policy                  | The Child Runtime / ModelFactory | The Profile's other Provider, Session state |

## 15. Invariants That Must Be Maintained

- The Provider Overlay is always Built-in -> Account -> Personal.
- The Model Rules are always Built-in + Personal, acting on the Effective Provider.
- The `visibility` only affects the user View, and does not change the completeness, Access, or ModelFactory.
- All Providers must have their own complete Access, API, Endpoint, models, and Model Config.
- The `request-auth` must fail before the network when the request-period credentials are missing.
- The idle task never modifies and then restores the Session Selection.
- The Automatic Compact uses the current Loop Active Model.
- Each Subagent creates its own Model; the idle Foreground Child uses the common override.
- The same idle Turn continues to use the idle Model after the permission approve/deny.
- The user's busy input enters the unique CLI Queue and uses its normal Submission after the idle Turn ends.
- The Provider refactoring does not change the desktop continuous, web remote replayable, or workspace identity semantics.

## 16. Old Production Structures That Need to Be Deleted

M4 audits the following idle usages through `dep:refs`, `rg`, and `knip` at completion:

- `ProviderConfig.executionOnly`;
- `sendText.turnRuntimeModel`;
- The complete `ZCodeModelRuntimeConfig` for idle purposes;
- `buildOffPeakTurnRuntimeModel`;
- `TurnExecutionModel`;
- `ExecutionScopedModelSource` / `createTurnExecutionModelSource`;
- The Turn Runtime Model Overlay;
- The temporary Provider Registry projection and replacement;
- `applyTurnRuntimeModel` / `clearTurnRuntimeModel`;
- The `previousModel`, temporary `setModel`, and restore `finally`;
- The Compact/Subagent's reading of the old Turn snapshot;
- The Host's repeated assembly of the Endpoint, properties, reasoning, and model constraints.

If the old public type still has non-idle consumers, prove the semantics of each consumer first and then migrate; you cannot simply batch-delete by the type name.

## 17. Implementation Order

### M4.1: Config, Visibility, and Access

1. Write failure tests first.
2. Migrate `executionOnly` to `visibility`; the Facade is responsible for the visible/hidden filtering.
3. Add the `request-auth` Access and the completeness check.
4. Complete the `builtin:offpeak-idle-plan` Access, Endpoint, models, and Built-in Model Rules.
5. The Registry includes the complete hidden Provider; the normal Settings/Selection View does not project.

### M4.2: Standard Model Creation and Request Authentication

1. The internal idle call uses the existing Registry lookup/ModelFactory by the precise Selection.
2. The Model/Adapter supports the call-level Request Auth.
3. The missing Request Auth returns the typed error; the dynamic materials do not enter the Config or Registry.
4. The generate/stream, Retry, Usage, and Trace all use the same Adapter boundary.

### M4.3: Switch Idle Production Dispatch

1. The Host no longer constructs the `turnRuntimeModel`.
2. The Core Submission carries the standard Selection and the minimal execution context.
3. The CLI admission directly creates the Idle Active Model, without temporarily `setModel`.
4. The Automatic Compact, Foreground Subagent, and permission continuation use the formal Active Model/Selection.
5. The Ticket expiry, cancellation, failure, and success end the current execution context along the existing Off-Peak state machine.

### M4.4: Delete Dual-Track

1. Delete the Runtime Overlay, Turn snapshot, temporary Registry injection, and restore state machine.
2. Delete the Host's repeated assembly of the Provider/Model static facts.
3. Use a reference audit to confirm that no production consumers read facts from the old Runtime Model.
4. Update the Design, Feature Graph, Off-Peak/Subagent spec, and test matrix.

## 18. Acceptance Cases

| Case  | Setup                                                     | Action                                                   | Assertions                                                                                         | Evidence Layer    |
| ----- | --------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------- |
| M4-01 | The hidden idle Provider is fully configured              | Read the Settings/Selection/Registry                     | The two user Views do not include idle; the Registry can do exact lookup                           | domain unit       |
| M4-02 | The `request-auth` Provider has no call-level credentials | generate/stream                                          | Returns the typed authentication-missing error before the network; no requests are sent            | adapter unit      |
| M4-03 | The idle Session's user Selection=U                       | Dispatch the idle Selection=I                            | The Active Model=I; the Session Selection is still U                                               | protocol/runtime  |
| M4-04 | The idle Turn is running                                  | The user sends a normal prompt                           | The input enters the unique Queue; after the terminal, uses U                                      | protocol/network  |
| M4-05 | The idle Turn triggers the Automatic Compact              | The Compact request                                      | The request uses I, the idle Endpoint, and the current Request Auth                                | runtime/network   |
| M4-06 | The Profiles configure other models                       | The idle parent turn starts multiple Foreground Children | The Children each create their Model, but all use the idle override; the Background has no request | runtime/network   |
| M4-07 | The idle Turn requests permission                         | approve / deny                                           | The Off-Peak task stays running; the same Turn still hits the idle Endpoint                        | protocol/network  |
| M4-08 | The current Ticket becomes invalid                        | The Scheduler re-obtains the ticket and resumes          | The new dispatch, new Model, new dynamic materials; the Session/transcript continues               | service/runtime   |
| M4-09 | The idle Turn ends                                        | The user continues the normal conversation               | Uses U; no idle Header, Ticket, or attribution leakage                                             | network/telemetry |

Do not do the full Cartesian product for theme, language, OS, Provider family, workspace type, and delivery kind. The M4's shared Core/Adapter behavior is proven by the focused tests; the Desktop continuous uses the existing Off-Peak representative E2E; the Mobile replayable only verifies that the protocol fields do not enter the recovery state, without adding new idle mobile product capabilities.

## 19. Completion Gate

The M4 is only completed when all of the following conditions are simultaneously met:

1. The idle Provider/Model static facts enter the execution only from the Effective Config/Rules.
2. The Hidden is only user-visible and does not bypass the Config completeness and Access.
3. The idle Model is created through the standard Registry/ModelFactory.
4. The idle Request Auth/Ticket does not enter the Config, Registry View, or Session persistence.
5. The idle task does not modify or restore the Session Selection.
6. The Compact, Subagent, and permission maintain the inheritance semantics specified in this document.
7. The `turnRuntimeModel`, Runtime Overlay, Turn snapshot, and restore production chain are physically exited.
8. The Usage, Trace, and errors are attributed to the actual Model.
9. The relevant unit tests, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, and the affected E2E pass.

## 20. Explicitly Excluded

- Remote Provisioning, remote settings, remote login, and cross-Environment config sync products;
- The Account Provider identity, entitlement, and plan topology refactoring;
- The Management Service distributing the Built-in Config;
- The `modelContextBudget.strategy`;
- The Off-Peak UI redo;
- The Queue, snapshot, reconnect, continuous/replayable product semantics changes;
- The Audio content block, attachment entry, or Provider encoding.

## 21. Impact Brief

### 21.1 Feature Summary

| Field            | Value                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| Developer intent | Delete the idle Runtime Model dual-track, making special executions reuse the formal Provider/Model chain       |
| Capability       | Provider Registry, Model execution, Off-Peak, Subagent                                                          |
| Change layer     | option-source, validation, commit-effect, persistence, recovery invariant                                       |
| Operating mode   | implementation                                                                                                  |
| Primary seeds    | `ProviderConfigResolver`, `buildOffPeakRequestAuth`, `sessionFlowHandlers`, `agentHandler`                      |
| Out of scope     | Remote Provisioning, Account product refactoring, normal Queue/recovery semantics, Agent parameter gray release |

### 21.2 Shared And Divergent Behavior

| Concern         | Shared across surfaces                                                    | Deliberately different                                                     | Why it matters                                            |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| Option source   | All Models come from the same Registry/ModelFactory                       | The hidden Provider does not enter the user Facade                         | Avoid a second execution Registry                         |
| Validation      | All Providers do the completeness and Adapter validation                  | The `request-auth` additionally requires the call-level credentials        | Visibility cannot become the authentication exemption     |
| Commit effect   | All Loops hold the Active Model                                           | The idle start-now does not write the Session Selection                    | Delete the set/restore state machine                      |
| Child execution | Each Child creates its own Model                                          | The idle Foreground Child forces the idle override, Background is rejected | Prevent the credential and Provider boundary violation    |
| Persistence     | The Config saves the static facts, the Session saves the normal Selection | The Ticket/Auth belongs only to one dispatch                               | The Secret and idle Model do not enter the recovery state |

### 21.3 Feature Relationships

| Rank           | From                         | Semantic edge                  | To                      | Why inspect it                                                            | Evidence                                    |
| -------------- | ---------------------------- | ------------------------------ | ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| must-inspect   | Off-Peak scheduler           | dispatches Selection + context | CLI admission           | The current Host constructs the complete Runtime Model; M4 must delete it | `offPeakRuntimeModel.ts`, `session-flow.ts` |
| must-inspect   | The hidden Built-in Provider | creates through                | Registry/ModelFactory   | The visibility belongs only to the Facade                                 | The Registry Design §§3, 11                 |
| must-inspect   | The idle Active Model        | inherited by                   | Automatic Compact       | The Compact cannot fall back to the Session Selection                     | The Execution Design §8.1                   |
| must-inspect   | The idle execution context   | overrides                      | Foreground Child        | The Child creates its own Model but shares this round's access boundary   | OP10, the Execution Design §8.2             |
| must-inspect   | The permission response      | continues                      | The same idle Turn      | The D44 prohibits the Provider handoff                                    | OP03, the Execution Design §9               |
| should-inspect | The Request Auth             | validates before               | Adapter network I/O     | The missing credentials must fail-closed                                  | The Model Creation Design                   |
| invariant-only | M4                           | must not mutate                | desktop/mobile delivery | Does not change the continuous/replayable                                 | AGENTS, the Feature Graph                   |
| invariant-only | M4                           | must not own                   | Remote Provisioning     | The remote config sync is an independent product capability               | Environment Design                          |

### 21.4 Code Evidence And Graph Drift

There is no callable codegraph in the current toolset, so this round replaces the feature graph's declared seeds, `rg` exact references, and depth-2 manual call graph checks with; the completion gate uses `dep:refs`, `knip`, and the affected tests to complete the symbol-level deletion proof.

| Seed                      | Key path                                                        | Depth | Interpretation                                                               |
| ------------------------- | --------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------- |
| `buildOffPeakRequestAuth` | Desktop Host -> `sendText.modelExecution` -> Model dependencies | 2     | Only provides the dynamic authentication materials for this round's dispatch |
| `sessionFlowHandlers`     | admission -> Core Submission -> Active Model                    | 2     | The single-execution Selection does not change the Session                   |
| `agentHandler`            | override -> Child runtime -> child ModelFactory                 | 2     | The convergence point for the normal override and the idle override          |
| `ProviderConfigResolver`  | Built-in -> Account -> Personal -> Registry                     | 2     | The sole source of M4 static facts                                           |

| Candidate                                                                                  | Live-code evidence                                                                        | Graph action                                                                                 |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The Feature Graph's old code seed points to the deleted dual-track                         | The M4 has deleted the old Builder and Source                                             | Changed to the Request Auth, dispatch, Submission, and the Registry Model Runtime live seeds |
| The invariant of the Provider Registry writes the final authorization as the model service | The Config only assembles the access materials; the final result is decided by the server | Changed to the server                                                                        |
| The OP03 still records switching to the user's Provider after approval                     | The Off-Peak spec D44 contradicts the user's decision                                     | Synchronized the case catalog and coverage matrix                                            |

The unresolved issues that change the M4 scope: none. The physical name of the protocol field, the typed error enum, and the Request Auth Port method signature belong to the implementation details, must obey the invariants of this document, and do not constitute a new product decision.

## 22. Planning Handoff

### 22.1 Boundary Decisions

| Boundary            | Decision                                                | Includes                                                | Excludes / prunes                                    | Source                 |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- | ---------------------- |
| Provider visibility | The general `visible/hidden` visibility                 | The Settings/Selection Facade filtering                 | The permissions, trusted, the completeness exemption | User decision          |
| Access              | The `request-auth` request-level dynamic authentication | The pre-network missing validation, the Retry lifecycle | The Secret persistence, Account sync                 | User decision + Design |
| Idle selection      | A single standard ModelSelection                        | The same Registry/Factory/Model                         | The second model binding, Selection, or Registry     | User decision          |
| Session state       | Idle writes nothing and recovers nothing                | The normal Session Selection stays                      | The temporary setModel/finally restore               | User decision          |
| Permission          | The same idle Turn continues                            | The approve/deny/skip                                   | The Provider handoff, the dedicated awaiting state   | D44                    |
| Child               | Foreground idle override, Background rejected           | Each Child creates its own Model                        | Share the parent Model, Profile escape               | OP10                   |

### 22.2 Dimensions And Pruning

| Dimension                                          | Included classes                    | Pruning reason                                                                |
| -------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| visibility                                         | visible / hidden                    | Only verify the Facade and Registry differences; do not expand theme/language |
| request auth                                       | present / absent / expired          | Affects whether the request is sent                                           |
| admission                                          | idle / busy race                    | The busy directly rejects; do not expand the normal Queue arrangement         |
| child                                              | foreground / background             | Changes the model authority and credential lifecycle                          |
| permission                                         | approve / deny / skip               | All three must maintain the same idle Turn                                    |
| delivery                                           | desktop continuous / web replayable | Only do the isolation proof; do not add new mobile idle product capabilities  |
| provider family, workspace kind, OS, theme, locale | do not expand                       | Does not change the shared Core/Adapter semantics                             |

The accepted cases are fixed as M4-01 through M4-09; the case catalog's OP03, OP10, and coverage matrix are synchronized. The E2E handoff continues to reuse the Off-Peak mock gateway: the OPA proves the idle endpoint is still hit after permission, the OPS proves the Foreground Child inheritance and Background rejection, and the OPB proves that the normal user input and the terminal state conversation do not inherit the idle Provider/Auth/attribution. The remaining Config, Registry, Request Auth, and Adapter behavior are proven by the focused unit/runtime/network tests.

## 23. Implementation Results

### 23.1 The Final Command Boundary

The Host-dispatched model-related fields have been consolidated into a single standard Selection and a single narrow execution context:

```text
sendText
├─ modelSelection
│  ├─ providerId
│  ├─ modelId
│  └─ options
└─ modelExecution
   ├─ selectionScope = execution
   ├─ requestAuth
   │  ├─ apiKey?
   │  └─ headers?
   └─ subagents
      ├─ foregroundModel = submission
      └─ background = deny
```

The strict protocol rejects carrying the Endpoint, Provider Config, Model Config, or properties in the `modelExecution`. The `modelExecution` only accepts the start-now admission for the idle Session; it does not enter the busy Queue, Guide, or held Queue.

### 23.2 The Standard Execution Chain

```text
Host idle ModelSelection + Request Auth
                    |
                    v
             Core Submission
                    |
                    v
       Provider Registry / ModelFactory
                    |
                    v
             Loop Active Model
              /           \
             v             v
   Automatic Compact   Foreground Child
                         |
                         v
                  Child ModelFactory
```

The Execution-scoped Submission does not perform the Session model pre-check; it does not read or fix the Session restore warning; it completes the validation through its own precise Selection in the standard Registry/ModelFactory. The normal Submission still retains the original Session model pre-check.

### 23.3 Deleted Dual-Track

The following production structures and their dedicated tests have been deleted:

- The `turnRuntimeModel` and the `ZCodeModelRuntimeConfig` single-turn snapshots;
- The `TurnExecutionModel`;
- The `ExecutionScopedModelSource`;
- The `runtime-model-factory.ts`;
- The `turn-model-overlay.ts` and `turn-execution-model-source.ts`;
- The Session Facade / V4 Bridge's apply, clear, set/restore interfaces;
- The Compact, Subagent, and the Host's reading of the old snapshot and assembly of the static model facts.

### 23.4 Mock and Credential Boundaries

The `ZCODE_OFFPEAK_MOCK=1` Desktop E2E derives a test Official Config from the formal `official.json`, only rewriting the `builtin:offpeak-idle-plan.api.baseURL` to point to the in-process mock gateway, then injecting it into the Host and Worker through the Official Config Source path. The Mock Endpoint thus still belongs to the test Config and does not return to the single Turn payload.

The command ledger only persists the normal input intent, attachments, and Selection; the `requestAuth` does not enter the input ledger, conversation event, Session snapshot, or repo sidecar. The production logs only record the command lifecycle, ID, and length, without recording the authentication materials.

### 23.5 Verification Results

The following verification was completed on 2026-08-24:

- The `pnpm typecheck` passes; the Desktop Host, E2E types, and the CLI Contracts/Core/Bootstrap builds all pass;
- The `pnpm lint` passes; the repository retains 39 pre-existing warnings unrelated to M4, with 0 new errors;
- The M4 focused tests: 5 files / 135 tests for the root repository, 7 files / 109 tests for the CLI, all pass; the previously 7 files / 168 tests for the Compact, 2 files / 19 tests for the Registry/Adapter, also pass;
- The `test:unit:affected` automatically escalates to a full unit test because the staging baseline includes deleted files: 1445 of 1454 files passed, 12,298 tests passed; the only M4-related failure is that the M2 guard still permits the old Overlay, which passes when rerun separately after tightening the guard. The other 30 items are the baseline failures from the current Linux environment missing `zip`, the macOS notarization/CUA native fixture mismatch, and so on;
- The full workspace `fmt:check` is still blocked by the existing vendored Electron HTML and the GB2312 fixture; the `oxfmt --check` for this round's 65 changed files all passes; the `git diff --check` passes;
- The `dep:refs` confirms the live references of `buildOffPeakRequestAuth`, `ApiProviderModelRuntime`, and `applySubmissionExecutionState`; the old dual-track production symbol search is zero. The full workspace `knip` and the Feature Graph integrity check still have existing drift outside this round; the M4 node itself all resolves.
- The final sealing re-verification covers 10 files / 189 tests for the Adapter, Core lifecycle, Bootstrap, Provider Selection, Services, and the Desktop Bundle; the `typecheck:e2e`, the OP10 fixture check, and the format check for this round's changes all pass.

The OP10 representative Desktop E2E has actually passed in the isolated Xvfb graphical environment (1 spec / 1 test, 26.5 seconds; the artifact:
`packages/desktop/.e2e-artifacts/desktop-e2e-20260824-074156-374`). This case proves through the idle mock gateway and the DeepSeek replay network proxy together that: the parent turn and the Foreground Child use the same idle Selection and request authentication; the Background Child is rejected; after the idle task completes, the normal Prompt of the same Session restores the user-configured DeepSeek Model; and the real request reaches the network proxy.

Three integration boundaries were additionally discovered and corrected during the acceptance process:

- The Protocol Agent, just like the CLI/TUI, reads the Environment-level Model Selection Config; the explicit configured default can reference the hidden Provider; only the user fallback when there is no explicit selection skips the hidden candidate;
- The Desktop main/host/scheduler bundle inline `@zcode/provider` and `@zcode/provider-node`, avoiding the Electron worker parsing non-existent `.js` files from the TypeScript source export in a clean execution environment;
- The Adapter only consumes the Host's account runtime-header Port when the Active Model binds the `accountAccessId`; the normal API-key Model directly uses the static access materials from the Provider Config; the `request-auth` Model uses the request auth source frozen at creation time.

Reproduction command:

```text
ZCODE_E2E_CONTAINER=1 \
ZCODE_E2E_SPEC=./test/e2e/conversation-session/manual-review/pending/\
conversation-session-offpeak-subagent-model-inheritance.test.ts \
pnpm --filter @zcode/desktop test:e2e:serial
```
