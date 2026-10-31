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

It saves the model identity and the already-selected reasoning level. A Selection used for execution must
carry a valid `reasoningLevel`; a persisted intent may temporarily be incomplete and must not block opening a
session. `maxOutputTokens` is a single-request execution parameter and does not enter Selection. Endpoint,
credentials, Properties, Option Specs, and Adapter are provided by the Registry and ModelFactory at execution
time.

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

Official persistence does not save `options: {}` or leaf `null`. The update API may temporarily use `null` to
express "clear explicit override," but the repository must normalize it to deleting the corresponding leaf;
after the last leaf is deleted, the empty `options` is omitted together.

## Composer and Draft

Composer Selection expresses the next submission being edited. Draft saves the Composer's unsubmitted
content: `prompt`, `attachments`, `mode`, `ModelSelection`.

The Composer's memory state prevails during its lifetime. Text, attachment, mode, or model selection changes
update the persisted Draft in sync; attachments stay in memory and are not serialized across restarts in
this round. Only submitted content is cleared after the Submission is accepted; the current mode and
ModelSelection are retained. On App restart or Session restore, the Draft reinitializes the Composer.

When Registry updates invalidate an unsubmitted draft's Selection, the **temporary valid result** is handled
by invalidation level, without clearing the persisted original intent; leaving it empty raises no error
prompt:

- Normal Provider or Model invalidation: keep the model control empty, wait for user re-selection; do not
  automatically substitute another Provider or default model; ordinary account plans uniformly map to the
  current connection per the next section;
- Provider/Model still valid but Reasoning missing or invalid: keep the Provider/Model, clear only
  `reasoningLevel`, requiring the user to re-select the level; do not substitute the highest, lowest, or
  default value.

A brand-new draft that never had a historical Selection initializes normally without invalidation
notifications. The invalidation reason is an instantaneous state computed from the current Ready
`ModelSelectionView`; it is not separately persisted as a second set of model facts.

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

`getView()` without arguments still returns shared candidates and preferredSelection; reading with arguments
computes results for that single input only, without putting the consumer's choice into shared events or the
Host global cache. Passing null means explicitly no selection and does not adopt preferredSelection.

Unified pure parsing first checks whether the original selection is a formal ordinary account Provider; if
so, it finds the unique `current=true` ordinary account Provider in the same snapshot; otherwise it keeps
the original Provider (including Off-Peak). Identity classification is injected by the service assembly
layer reusing existing formal ID definitions; the Provider pure module copies no separate ID table, imports
no entire shared barrel, and guesses no identity by string. When the target is missing/multiple current, it
returns incomplete; it never arbitrarily selects the first item. It then matches modelId and the original
reasoningLevel precisely: a missing model yields an empty result; a missing level clears only the level of
the valid result, without filling the highest value. Ordinary selectable menus still filter hidden;
Off-Peak's original identity validity check uses the same Registry internals, not hiding models into the
ordinary menu.

Todo95C closing level rename is a limited exception for invalidated levels: when the original value is still
valid, keep it; otherwise, only when explicitly matching the renamed Built-in source and the target supports
`disabled`, map old `off/nothink` to it in the temporary valid result. Node Host/Worker reuse the same
source judgment; API-native `none` and custom values are not globally replaced. Personal reasoning
domain/Map or fixed config does not apply built-in old-name inference. The final Registry/ModelFactory still
performs precise validation; there is no migration at the execution layer.

Read/config refresh does not write files. Text and attachment auto-save still saves the original selection;
explicit user clearing is a new empty intent. On submission acceptance, adopt the current valid value after
checking whether the original intent and scope were replaced by subsequent edits. Fixed Submissions, runs,
Active Models, and history do not re-map accounts. Long-term scheduling config changes only during edit
saves; a run is fixed before the first dispatch on the target Host; Off-Peak does not cross-account switch
Providers or Tickets; only protect reads without breaking the original intent.

Interface read failures are separated from normal incomplete results: public hooks keep subscribing; the
first temporary read failure allows a limited, cancelable retry; incomplete selections or dispatches are
not retried; after exhaustion, explicitly reload. Without a target, remote disconnection does not fall back
to local. No config sync barrier exists before sending.

## 手动压缩的模型选择（2026-10-20）

手动 `/compact` 与上下文面板的压缩动作使用提交时 Composer 的 ModelSelection。
命令携带 provider/model 及稀疏 options；不携带 mode、Plan 或执行凭据。
CLI 接收时固定为 canonical intent，立即执行、FIFO 排队、恢复及提升均沿用该快照。
旧客户端缺少选择时，CLI 在接收边界固定当前 Session Selection。
已开始的请求不受后续菜单编辑影响；Session 续跑选择沿用现有 admissionSeq 防倒写规则。
摘要请求的 reasoning/output 策略继续由 compact 实现决定；自动 compact 使用触发轮的 Active Model。
验收与实施边界见 [compact 裁决](../../../../testing/conversation-session-compact-decision-worksheet.md)。

## App Recent

App Recent saves the ModelSelection of the last successful submission by the App in a given Workspace:

```text
App Recent
├─ scope = App x workspaceKey
├─ Loaded into memory from persistent carrier at App startup
├─ Used to initialize new Sessions during App runtime
└─ Memory and persistent values updated simultaneously after Submission is received by App
```

`workspaceKey = workspaceIdentity?.trim() || workspacePath`. This round adds no `environmentId`. Remote
Workspaces must provide `workspaceIdentity`; `workspacePath` is only a local compatibility fallback and for
file/command execution paths.

Menu switching that has not yet produced a Submission does not update Recent. Goal auto-continuation,
Background wake, idle tasks, and Subagents do not update Recent. Prompt CLI and TUI do not read/write App
Recent.

## Session Selection

Creating or opening a Session does not require a bound model. V4 creates the record and handles explicit
Selection through native commands; it does not generate a legacy protocol snapshot that is subsequently
discarded. The old snapshot's model field contract is not relaxed by V4; truly starting requests still
validate Selection and cannot automatically select other models or levels for creation success.

Session Selection saves the ModelSelection the Session continues to use. Written when normal Submissions
truly start the Agent Loop; written when the Guide is received by the current Loop. A normal user message
updates it when the CLI accepts the message through serial admission. A queued message executes with its own
Submission snapshot and does not overwrite a continuation selection determined by newer input. Idle tasks
temporarily maintain a continuation selection within their own lifecycle; after user input takes over, the
user-submitted selection is adopted.

Provider Config updates do not rewrite Session Selection. The next execution queries the latest Registry
from this Selection and creates a new Model. Only Selection is saved in the Session, so API Key, Endpoint, or
model config updates take effect when new Models are created.

Old Sessions that saved no Selection are recovered by one-way migration; the running Reader reads no old
fields and extends no normal initialization priorities.

## Offline Migration (Todo 96)

Migration only decodes published old formats and static Provider identities; it reads no current login,
connection, entitlement, Registry, or model lists. Old `builtin:bigmodel-coding-plan` /
`builtin:zai-coding-plan` migrates deterministically to the same-domain Individual ID; that is the
deterministic intent landing point, not a historical plan interpretation, and does not switch the current
connection.

```text
Old field -> pure format/static identity migration -> Formal original intent
                                  |
                     getView({ selection })
                                  |
                         Temporary effectiveSelection
                                  |
                     Original acceptance/dispatch boundary -> Final Model validation
```

When the current field exists (even if cleared or corrupted), do not repair from the old field. Ordinary
unknown models/Providers keep explicit identity; temporary unavailability does not block migration. Session
restoration returns the original selection without first discarding it by Registry; true Runtime binding
still allows only valid complete selections. Composer re-selection/clearing changes only drafts; formal
Selection/Recent is updated by the send acceptance boundary; failures and refresh write nothing empty. Idle
task identity/Ticket migration stays excluded. In-place migration of user-directory Subagent Markdown is
defined by Todo97; other sources do not write automatically.

## Configured Default

Configured Default is the new-Session initial preference provided by the Host of the target Workspace. It
saves ModelSelection — not Provider, Endpoint, credentials, or model capabilities — and therefore uses an
independent versioned document separate from Provider Config:

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

Default physical location for local Node Workspaces: `.zcode/v2/model-selection.json`. Host, Prompt CLI, and
TUI can share this Workspace preference; App Recent remains App-exclusive and is not written here.

The old CLI user file's `model` field migrates one-way into `configuredDefault` only when the new document
does not exist. Provider definitions in old files are handled by Personal Provider Config migration; the two
never re-synthesize an old Runtime Model Config.

The target Host resolves Configured Default and Fallback when generating the same `ModelSelectionView` and
returns `preferredSelection`. The still-selectable Configured Default takes priority; when the Provider or
model has disappeared, the Fallback Policy applies. The current Fallback Policy takes the first
user-visible model from the ordered Model Selection Facade View; ZCode Built-in recommendation policy may
replace it later. Hidden Providers do not participate in Fallback. Fallback only initializes this
Composer/Session; it does not automatically overwrite the persisted Configured Default.

Entries no longer call a second `resolveInitialSelection()` RPC. They read candidates, Option Specs, and
Host `preferredSelection` from the same View, then decide the Composer initial value from local state:

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

Persistent Entries re-read Configured Default when creating each new Session. Updates to files or other
persistent carriers affect only Sessions created thereafter; already-started Sessions continue to be decided
by Session Selection.

When restoring an existing Session, Configured Default is not read. The persisted Session Selection keeps
the original intent even if temporarily unavailable, reported through UI prompts or execution errors; the
system never silently switches to the current first model.

## Active Model

Active Model is a runtime object and does not enter Session persistence. It is created by Registry from
Selection at Loop startup; ModelFactory only validates and freezes the already-selected reasoning and no
longer derives request execution values from Option Specs. Agents/callers must explicitly decide
`maxOutputTokens` per request; the model's `spec.max` itself is also a valid explicit decision. Ordinary
config changes do not modify already-created Models. A Guide can create and switch a new Active Model at an
explicit Step boundary within the current Loop.

Usage, Trace, Token, and errors come from the Active Model. The model name returned by the Provider can
serve as routing diagnostic information but does not replace local Model identity.

If execution history needs to prove the actual option used at the time, it records the Active Model or
execution facts; it does not re-infer from the current Option Spec later.

## Selection in Product Config

Automation, Repo Wiki, Bot, Off-Peak, and Subagent keep their own Draft, Config, Record, save events, and
execution timing; they only unify the value type of referenced models:

```text
Each product's own Draft / Config / Record
                 |
                 | Optionally contains modelSelection
                 v
          Target Worker ModelFactory
```

A missing outer `modelSelection` means the product has no fixed model; the inheritance source and parsing
timing are set by the product contract; once a product writes Selection, it writes the specifically selected
model and reasoning level at that time. The two cannot be merged, and pseudo-model IDs such as
`model: "inherit"` cannot express inheritance.

Subagents without explicit override inherit the Parent's Active Model; saved Off-Peak execution selections
use their own identity at dispatch time. Automation resolves the current Host preferred or the user's
explicit selection into a concrete Selection when created and saves it, without retaining a virtual
"inherit/default model" form state.

## Renderer Async Read State

The target Host's `ModelSelectionView` is the complete candidate fact, but the Renderer reads it
asynchronously. The interaction entry must first handle the read lifecycle; `null` cannot simultaneously
express loading, remote waiting, missing target, and errors:

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

- Candidate projection helpers accept only Ready Views; they do not convert non-Ready states into empty
  candidates.
- Service/Target switching during the same render immediately shows loading for the new owner; the old
  Host's late Promise or events cannot override the new owner.
- The revision of the same owner is monotonically increasing; a newly arrived event cannot be overwritten by
  a subsequently returning old `getView()`.
- Backend read failures after obtaining a Ready View preserve Last Known Good; the first failure enters
  error and provides explicit reload.
- Remote waiting does not fall back to Base/Local Host. Desktop continuous and mobile replayable share only
  the target Host's selection facts; this section does not change task message recovery semantics.
- Composer, Automation, Subagent, Repo Wiki, and the Root startup gate keep their own Draft and submission
  semantics; only the candidate read lifecycle is unified.

## Initialization Rules

App new Session:

```text
Draft
  >
Currently selectable workspace App Recent in current View
  >
Host preferredSelection
```

TUI new Session: `TUI Draft > Host/domain preferredSelection`.

App and TUI restore existing Session: `Draft > Session Selection`.

Prompt CLI new Session: `Explicit --model provider/model + --reasoning > domain preferredSelection`.

Prompt CLI restore existing Session: `Explicit --model / --reasoning > cliDefaultSelection` (initialized
from the persisted normal user selection).

Configured Default belongs to the target Workspace's Host/domain config. Host `preferredSelection` already
atomically includes the Configured Default and Fallback Policy resolution; the Renderer does not repeat that
algorithm.

When creating the default selection in real terms, the selection boundary may use the last item of the
ordered `reasoningLevel.values` per the default completion rules. Users actively selecting a new model in
the menu determine only the model identity; Reasoning is left empty for explicit selection — this is not a
default completion entry. Models missing or invalid in existing Sessions/Composers are left empty; when the
model is valid but Reasoning is missing/invalid, only the level is cleared; no highest/lowest is filled, no
preferred is switched, no empty prompt is popped; submission is not allowed before completion. Old
structures are converted only at the migration boundary by explicit facts, not repaired from old fields.
Auxiliary low-cost calls explicitly select `values[0]` at the call site; ModelFactory only validates and
freezes, without filling defaults.

## Write Events

| State             | Write Event                                                                                 | Persistence Scope                         |
| ----------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Draft Selection   | Composer editing                                                                            | Entry Draft                               |
| App Recent        | App accepts user Submission                                                                 | App x workspaceKey                        |
| Session Selection | Normal Submission admitted by CLI, Guide received, or idle execution sets a temporary value | Session (only normal selection persisted) |
| Active Model      | Loop starts, or Guide switches at Step boundary                                             | Current Agent Loop, not persisted         |

These states share ModelSelection semantics but not write timing. After one state changes, another is
updated only by an explicit event; no state guesses what to save by observing another state's current value.

Idle tasks temporarily update the in-memory Session Selection so their owning background recovery/wake-up
can read it. They do not write App Recent, Configured Default, or the persisted user selection. After the
whole item completes without user takeover, the original normal selection is restored. Once user input is
admitted, the user's selection prevails and the old idle wrap-up no longer overwrites it.
