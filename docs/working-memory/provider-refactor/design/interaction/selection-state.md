# Model Selection State

ModelSelection is a persistent and transmissible model intent:

```ts
interface ModelSelection {
  providerId: ProviderId;
  modelId: ModelId;
  options?: {
    reasoningLevel?: string;
  };
}
```

It saves the model identity and the already-selected reasoning level. A Selection used for execution must carry a valid `reasoningLevel`; a persisted intent can temporarily be incomplete; it must not prevent opening a session due to incompleteness.
`maxOutputTokens` is a single-request execution parameter and does not enter Selection. Endpoint, credentials, Properties, Option Specs, and Adapter are provided by the Registry and ModelFactory at execution time.

```text
Product Draft / Config / Record
        |
        | modelSelection?: whether a model is specified
        v
ModelSelection
|- providerId + modelId: explicit identity
`- options: explicitly selected concrete values
        |
        | + current Registry validation and request binding values
        v
ModelFactory
        |
        v
Active Model.options: complete execution facts for this lifecycle
```

Official persistence does not save `options: {}` or leaf `null` for option leaves. The update API can temporarily use `null` to express "clear explicit override," but the repository must normalize it to deleting the corresponding leaf; after the last leaf is deleted, the empty `options` is omitted together.

## Composer and Draft

Composer Selection expresses the next submission the user is editing. Draft saves the content not yet submitted by the Composer:

```text
Draft
├─ prompt
├─ attachments
├─ mode
└─ ModelSelection
```

The Composer's memory state prevails during its lifetime. After text, attachments, mode, or model selection changes, the persisted Draft is updated in sync; attachments are still held in memory and are not serialized across restarts in this round. Only the submitted content is cleared after the Submission is accepted; the current mode and ModelSelection are retained. When the App restarts or the Session is restored, the Draft reinitializes the Composer.

When Registry updates invalidate the Selection of an unsubmitted draft, the **temporary valid result** is handled by invalidation level, without clearing the persisted original intent; leaving it empty does not pop an error prompt:

- Normal Provider or Model invalidation: keep the model control empty, wait for user re-selection; do not automatically replace with another Provider or default model; ordinary account plans uniformly correspond to the current connection per the next section;
- Provider/Model still valid but Reasoning is missing or invalid: keep the Provider/Model, clear only `reasoningLevel`, requiring the user to re-select the level; do not automatically replace with the highest, lowest, or default value.

A brand new draft that has never had a historical Selection initializes normally, without showing invalidation notifications. The invalidation reason is an instantaneous state calculated based on the current Ready
`ModelSelectionView`; it is not separately persisted as another set of model facts.

## Current Valid Selection (Todo 87, implemented)

```text
Original persisted intent / user's latest edit
        +  Target Host's currently applied Registry and Account State
        -> getView({ selection })
        -> candidate View + this input's effectiveSelection / selectionIssue
             | display/edit text             | authoritative acceptance / explicit save
             v                            v
          Original selection unchanged  Adopt valid value per existing domain boundaries
```

`getView()` without arguments still returns shared candidates and preferredSelection; reading with arguments only calculates results for that single input, without putting the consumer's choice into shared events or the Host global cache. Passing null means explicitly no selection, and does not adopt preferredSelection.

Unified pure parsing first identifies whether the original selection is a formal ordinary account Provider: if so, find the unique `current=true` ordinary account Provider in the same snapshot; otherwise keep the original Provider (including Off-Peak). Identity classification is injected by the service assembly layer reusing existing formal ID definitions; the Provider pure module does not copy a separate ID table, does not import the entire shared barrel, and does not guess identity by string. When the target is missing/multiple current, return incomplete; do not arbitrarily select the first item. Then precisely match modelId and the original reasoningLevel:
missing model results in an empty result; missing level clears only the level of the valid result, without filling the highest value. Ordinary selectable menus still filter hidden; Off-Peak's original identity validity check uses the same Registry internals, not hiding models into the ordinary menu.

Todo95C closing level rename is a limited exception for invalidated levels: when the original value is still valid, keep it; otherwise, only when explicitly matching the renamed Built-in source and the target supports `disabled`, map the old `off/nothink` to the past in the temporary valid result. Node Host/Worker reuse the same source judgment; API native `none` and custom values are not globally replaced. Personal reasoning domain/Map or fixed config do not apply built-in old name inference. The final Registry/ModelFactory still performs precise validation; no migration at the execution layer.

Read/config refresh does not write files. Text and attachment auto-save still saves the original selection; explicit user clearing is a new empty intent. When the submission is accepted, adopt the current valid value; you must check whether the original intent and scope have been replaced by subsequent edits. Fixed Submissions, runs, Active Models, and history do not re-map accounts. Long-term scheduling config only changes during edit saves; this run is fixed before the first dispatch on the target Host; Off-Peak does not cross-account switch Providers or Tickets; only protect reads without breaking the original intent.

Interface read failures are separated from normal incomplete results: public hooks continue subscribing; the first temporary read failure allows a limited, cancelable retry; incomplete selections or dispatches are not retried; after exhaustion, explicitly reload. Without a target, remote disconnection does not fall back to local. No config sync barrier before sending.

## App Recent

App Recent saves the ModelSelection of the last successful submission by the App in a given Workspace:

```text
App Recent
├─ scope = App x workspaceKey
├─ Loaded into memory from persistent carrier at App startup
├─ Used to initialize new Sessions during App runtime
└─ Memory and persistent values updated simultaneously after Submission is received by App
```

Where `workspaceKey = workspaceIdentity?.trim() || workspacePath`. This round does not add `environmentId`. Remote Workspaces must provide `workspaceIdentity`; `workspacePath` is only used as a local compatibility fallback and for file/command execution paths.

Menu switching that has not yet produced a Submission does not update Recent. Goal auto-continuation, Background wake, idle tasks, and Subagents also do not update Recent. Prompt CLI and TUI do not read/write App Recent.

## Session Selection

Creating or opening a Session does not require the model to already be bound. V4 creates the record and handles explicit Selection through native commands; it does not generate a legacy protocol snapshot that is subsequently discarded. The model field contract of the old snapshot is not relaxed by V4; requests truly starting still validate Selection and cannot automatically select other models or levels for creation success.

Session Selection saves the ModelSelection that the Session continues to use for subsequent execution. Written when normal Submissions truly start the Agent Loop; written when the Guide is received by the current Loop. A normal user message updates it when the CLI accepts the message through serial admission. A queued message executes with its own Submission snapshot and does not overwrite a continuation selection determined by newer input. Idle tasks temporarily maintain a continuation selection within their own lifecycle; after user input takes over, the user-submitted selection is adopted.

Provider Config updates do not rewrite Session Selection. The next execution queries the latest Registry based on this Selection and creates a new Model. Only Selection is saved in the Session, so API Key, Endpoint, or model config updates take effect when new Models are created.

Old Sessions that have not saved Selection are recovered by one-way migration; the running Reader does not read old fields, nor does it extend normal initialization priorities.

## Offline Migration (Todo 96)

Migration only decodes published old formats and static Provider identities; it does not read current login, connection, entitlement, Registry, or model lists. The old `builtin:bigmodel-coding-plan` / `builtin:zai-coding-plan` is deterministically migrated to the same-domain Individual ID; it is the deterministic intent landing point, not explaining historical plans, and does not switch the current connection.

```text
Old field -> pure format/static identity migration -> Formal original intent
                                  |
                     getView({ selection })
                                  |
                         Temporary effectiveSelection
                                  |
                     Original acceptance/dispatch boundary -> Final Model validation
```

When the current field exists (even if cleared or corrupted), do not repair using the old field. Ordinary unknown models/Providers keep explicit identity; temporary unavailability does not prevent migration. Session restoration returns the original selection, without first discarding by Registry; true Runtime binding still only allows valid complete selections. Composer re-selection/clearing only changes drafts; formal Selection/Recent is updated by the send acceptance boundary; failures and refresh do not write empty. Idle task identity/Ticket migration is still excluded. In-place migration of user directory Subagent Markdown is defined by Todo97; other sources do not write automatically.

## Configured Default

Configured Default is the new Session initial preference provided by the Host belonging to the target Workspace. It saves ModelSelection, not Provider, Endpoint, credentials, or model capabilities, and therefore uses an independent versioned document from Provider Config:

```json
{
  "schemaVersion": 1,
  "configuredDefault": {
    "providerId": "deepseek",
    "modelId": "deepseek-v4-pro",
    "options": {
      "reasoningLevel": "high"
    }
  }
}
```

The default physical location for local Node Workspaces is `.zcode/v2/model-selection.json`. Host, Prompt CLI, and TUI can share this Workspace preference; App Recent is still App-exclusive state and is not written here.

The `model` field in old CLI user files is migrated one-way into `configuredDefault` only when the new document does not exist. Provider definitions in old files are handled by Personal Provider Config migration; the two will not re-synthesize an old Runtime Model Config.

The target Host resolves Configured Default and Fallback when generating the same `ModelSelectionView`, and returns `preferredSelection`. The still-selectable Configured Default takes priority; when the Provider or model has disappeared, the Fallback Policy is entered. The current Fallback Policy takes the first user-visible model from the ordered Model Selection Facade View; this can be replaced by ZCode Built-in recommendation policy later. Hidden Providers do not participate in Fallback. Fallback only initializes this Composer/Session; it does not automatically overwrite the persisted Configured Default.

Entries no longer call a second `resolveInitialSelection()` RPC. They read candidates, Option Specs, and Host `preferredSelection` from the same View, then decide the final Composer initial value based on local state:

```text
Target Host ModelSelectionView
|- providers / models / optionSpecs
`- preferredSelection = Configured Default or Fallback
                 |
                 v
Entry initializes Composer
Existing Composer / Draft
  > Currently selectable workspace App Recent in current View
  > Host preferredSelection
```

Persistent Entries re-read Configured Default when creating each new Session. Updates to files or other persistent carriers only affect Sessions created thereafter; already-started Sessions continue to be decided by Session Selection.

When restoring an existing Session, Configured Default is not read. Persisted Session Selection keeps the original intent even if temporarily unavailable, reported through UI prompts or execution errors; the system does not silently switch to the current first model.

## Active Model

Active Model is a runtime object and does not enter Session persistence. It is created by Registry based on Selection at Loop startup; ModelFactory only validates and freezes the already-selected reasoning, and no longer derives request execution values from Option Specs. Agents/callers must explicitly decide `maxOutputTokens` for each request; the model's `spec.max` itself is also a valid explicit decision. Ordinary config changes do not modify already-created Models. A Guide can create and switch a new Active Model at an explicit Step boundary within the current Loop.

Usage, Trace, Token, and errors for model calls come from the Active Model. The model name returned by the Provider can serve as routing diagnostic information, but does not replace local Model identity.

If execution history needs to prove the actual option used at that time, it should record the Active Model or execution facts, not re-infer from the current Option Spec in the future.

## Selection in Product Config

Products such as Automation, Repo Wiki, Bot, Off-Peak, and Subagent retain their own Draft, Config, Record, save events, and execution timing; they only uniformly the value type of the models they reference:

```text
Each product's own Draft / Config / Record
                 |
                 | Optionally contains modelSelection
                 v
          Target Worker ModelFactory
```

An outer `modelSelection` being missing means this product has no fixed model; the specific inheritance source and parsing timing are determined by the product contract; once a product writes Selection, it writes the specifically selected model and reasoning level at that time. The two cannot be merged, nor can pseudo-model IDs such as `model: "inherit"` be used to express inheritance.

When Subagents have no explicit override, they inherit the Parent's Active Model; saved Off-Peak execution selections use their own identity at dispatch time. Automation resolves the current Host preferred or user's explicit selection into a concrete Selection when created and saves it, without retaining the virtual "inherit/default model" form state.

## Renderer Async Read State

The target Host's `ModelSelectionView` is the complete candidate fact, but the Renderer reads it asynchronously. The interaction entry must first handle the read lifecycle; it cannot use `null` to simultaneously express loading, remote waiting, target missing, and errors:

```ts
type ModelSelectionState =
  | { status: "loading" }
  | { status: "ready"; view: ModelSelectionView }
  | { status: "unavailable"; reason: "remote-waiting" | "missing-target" }
  | { status: "error"; error: Error };
```

```text
Explicit Workspace Target
        |
        +-- Missing ----------------> unavailable/missing-target
        +-- Remote not yet connected -> unavailable/remote-waiting
        `-- Target Host Service
                 |
                 +-- First read ----> loading
                 +-- First failure ---> error + reload
                 `-- Success --------> ready(ModelSelectionView)
```

- Candidate projection helpers only accept Ready Views; they do not convert non-Ready states into empty candidates.
- Service/Target switching during the same render immediately shows loading based on the new owner; the old Host's late Promise or events cannot override the new owner.
- The revision of the same owner is monotonically increasing; a newly arrived event cannot be overwritten by a subsequently returning old `getView()`.
- Backend read failures after obtaining a Ready View preserve Last Known Good; the first failure enters error and provides explicit reload.
- Remote waiting does not fall back to Base/Local Host. Desktop continuous and mobile replayable only share the target Host's selection facts; this section does not change task message recovery semantics.
- Composer, Automation, Subagent, Repo Wiki, and Root startup gate retain their own Draft and submission semantics; only the candidate read lifecycle is unified.

## Initialization Rules

App new Session:

```text
Draft
  >
Currently selectable workspace App Recent in current View
  >
Host preferredSelection
```

TUI new Session:

```text
TUI Draft
  >
Host/domain preferredSelection
```

App and TUI restore existing Session:

```text
Draft
  >
Session Selection
```

Prompt CLI new Session:

```text
Explicit --model provider/model + --reasoning
  >
domain preferredSelection
```

Prompt CLI restore existing Session:

```text
Explicit --model / --reasoning
  >
cliDefaultSelection（从持久普通用户选择初始化）
```

Configured Default belongs to the target Workspace's Host/domain config. Host `preferredSelection` already atomically includes the resolution result of Configured Default and Fallback Policy; the Renderer does not repeat this algorithm.

When creating the default selection in real terms, the selection boundary can use the last item of the ordered `reasoningLevel.values` according to the default completion rules.
Users actively selecting a new model in the menu only determine the model identity; Reasoning is left empty for explicit selection; this is not a default completion entry.
Models missing or invalid in existing Sessions/Composers are left empty; when the model is valid but Reasoning is missing/invalid, only the level is cleared;
no highest/lowest is filled, no preferred is switched, no empty prompt is popped; submission is not allowed before completion.
Old structures are only converted at the migration boundary by explicit facts, not repaired from old fields. Auxiliary low-cost calls explicitly select `values[0]` at the call site; ModelFactory only validates and freezes, without filling default values.

## Write Events

| State             | Write Event                                                                                 | Persistence Scope                         |
| ----------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Draft Selection   | Composer editing                                                                            | Entry Draft                               |
| App Recent        | App accepts user Submission                                                                 | App x workspaceKey                        |
| Session Selection | Normal Submission admitted by CLI, Guide received, or idle execution sets a temporary value | Session (only normal selection persisted) |
| Active Model      | Loop starts, or Guide switches at Step boundary                                             | Current Agent Loop, not persisted         |

These states share ModelSelection semantics, but do not share write timing. After one state changes, another state can be updated by an explicit event; no state guesses what it should save by observing the current value of other states.

Idle tasks temporarily update the in-memory Session Selection so that their owning background recovery/wake-up can read it. They do not write App Recent, Configured Default, or the persisted user selection. After the whole item completes without user takeover, the original normal selection is restored. Once user input is admitted, the user's selection prevails and the old idle wrap-up no longer overwrites it.
