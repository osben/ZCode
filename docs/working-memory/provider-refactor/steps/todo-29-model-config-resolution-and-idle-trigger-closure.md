# Todo 29: Model Config Resolution and Settings Page Idle Trigger Consolidation

> Status: Completed
>
> Date: 2026-08-27
>
> Source: Provider settings page real experience feedback
>
> Related tasks: [`Todo 23`](./todo-23-provider-refactor-decision-gap-closure.md),
> [`Todo 27`](./todo-27-provider-settings-dogfood-closeout.md),
> [`Todo 28`](./todo-28-model-rule-precedence-and-order-canonicalization.md)

## 1. Problem Positioning

New model popup already resolves Model Config Rules through Host based on `providerId/modelId/api.type/baseURL`,
but Renderer uses three inconsistent projections for the same resolution result:

```text
Model Config Rules Resolution
├─ context/max output ──> inherited placeholder
├─ boolean properties ──> copied into local Draft
└─ reasoning JSON ──────> not connected, wrongly displayed as "—"
```

Therefore `GLM-5.3-Flash` actually hits 1M context, 128K max output, Image/Video, and reasoning
rules, but popup only partially displays default facts. Meanwhile, new model parsing uses 300ms debounce, editing model ID
parsing uses 180ms debounce, Provider text save uses 800ms idle save; brief pauses frequently trigger requests, field jumps,
config writes, and Registry refreshes.

This Todo consolidates default config parsing, sparse Draft, success feedback, and text idle-trigger. It does not change Model Config Rule
precedence, Provider/Model Overlay order, Registry integrity, or Active Model freeze semantics.

## 2. Unified Domain Naming

Settings page no longer uses `previewModelConfig`, `previewPersonalModelDraft`, `resolvedDefaults` and other synonymous concepts.
Sole operation named `resolveModelConfig`:

```ts
const resolution = await providerSettingsService.resolveModelConfig(input);
setResolution(resolution);
```

- Method: `resolveModelConfig`;
- Return structure: `ModelConfigResolution`;
- Renderer local state: `resolution`;
- Returned content continues as `inheritedConfig/effectiveConfig/issues`;
- New model only parses current candidate ID; editing model can carry unsaved Personal Exact Draft and original Model ID,
  but does not write Personal Config, does not change Registry revision.

`resolve` expresses obtaining config result by current Rules; whether persisted decided by independent save command, `preview` no longer used as domain name.

## 3. Draft and Inheritance Facts

New and editing models both follow same Overlay display chain:

```text
ZCode Built-in + Personal Match Rules
                 |
                 v
        inheritedConfig
                 +
     sparse Personal Draft
                 |
                 v
        effectiveConfig display
```

- Renderer can cache Resolution boolean values in form display state, but that cache is not Personal Config;
- Fields explicitly touched by user recorded separately, late Resolution must not override those fields;
- Numbers, booleans, and JSON all derive display values from same Resolution;
- context/max output and reasoning JSON use inherited/effective placeholder;
- Boolean controls display `Personal Draft ?? inheritedConfig`, only displaying Personal Override style when user explicitly modifies;
- `false` in general Rules is complete default fact, not "default value not obtained";
- On save, only new Provider's Personal model members and truly existing sparse Exact Rules created, no reverse-materialization of Effective Config.

## 4. Unified Idle Trigger

Provider text save, new model config parsing, and editing model config parsing share one idle-trigger dispatch semantics:

```text
onChange
├─ Immediately update local Draft
├─ Cancel previous timer
└─ 1200ms no new input
       |
       v
  Execute current action
  ├─ Provider: save Personal Provider Draft
  └─ Model: parse Model Config

onBlur / Enter / explicit save
└─ Cancel timer and immediately flush current action
```

- Unified idle time 1200ms;
- Continuous input executes only last;
- IME composition period does not trigger;
- Resolution requests use monotonically increasing sequence or equivalent identity validation, expired responses must not update current Model ID;
- When clicking model save while parsing still scheduled/in-flight, must immediately flush and wait completion, then save in same click,
  no requiring user double-click;
- Provider blur/Enter/pre-save and unload protection unchanged; only replacing timed dispatch, no creating second save queue.

## 5. Resolution Success Banner

Model popup displays green success banner when new Resolution genuinely changes inherited config:

> Model default config loaded

```text
Resolution complete
├─ inheritedConfig same as currently applied result
│  └─ Silent: do not update fields, do not display banner
└─ inheritedConfig genuinely changed
   ├─ Atomic update all inherited display
   └─ Display one success banner
```

- Displayed on first successful config load;
- Not displayed on repeated blur, repeated parse, same-case-only changes with same config, and different IDs getting identical inherited config;
- Failure, expired, or incomplete Resolution does not display success banner;
- Banner located at fixed feedback position of model popup content area, using existing semantic success color, checkmark, and internationalization, not scrolling out of view;
- Same stable key in-situ replacement, no stacking multiple same feedback.

"Loaded" only indicates a rule parse baseline obtained; general `modelMatch: ".*"` can also provide default config, text does not claim
server has recognized or authorized that model.

## 6. Impact Boundaries

| Layer         | This Round Handling                                      | Unchanged                                           |
| ------------- | -------------------------------------------------------- | --------------------------------------------------- |
| draft-default | Unified Resolution projection and sparse Draft           | Rule content and override precedence                |
| presentation  | New success banner, eliminate JSON default wrong display | Model field order and editable scope                |
| commit-effect | Unified 1200ms idle/blur flush                           | Host save, Registry refresh, and revision authority |
| validation    | Wait for current Resolution before save                  | Integrity rules and Adapter compatibility           |
| persistence   | Provider text still auto-saves                           | Personal Config Schema and physical location        |

Does not modify model selection, connection testing, account plan, Remote Provisioning, Desktop continuous, Mobile replayable, queue, or recovery chain.

## 7. Test Plan

1. `GLM-5.3-Flash + anthropic-messages` displays 1M, 128K, Image/Video, reasoning spec, and mapping;
2. Built-in `false` capabilities displayed as inheritance values, but not written to Personal Rule;
3. reasoning JSON uses Resolution placeholder, no longer displays wrong "--";
4. 1200ms continuous input does not call Resolution/Provider save, calls only once after stabilization;
5. blur/Enter immediately flushes, clicking save waits for Resolution and completes in one operation;
6. Late Resolution discarded; same inheritedConfig does not redundantly update fields or display banner;
7. Banner displayed once when config changes, failure and incomplete results do not display;
8. Provider name/baseURL/API Key idle save changed to 1200ms, blur and pre-save does not regress;
9. New model untouched fields only save members and necessary sparse Personal Rule;
10. Chinese/English, light/dark themes, keyboard, and narrow window banner usable.

## 8. Completion Criteria

- Settings has only one domain naming `resolveModelConfig` and one Resolution state;
- All inherited fields in new/edit popups from same Resolution;
- Renderer does not materialize inherited booleans as persistent Personal Config;
- Text idle-trigger unified to 1200ms, proactively ending editing immediately flushes;
- Success banner only appears when inherited config changes;
- Related Design, Feature Graph, unit tests, typecheck, lint, and format checks pass;
- Submit Conventional Commit upon completion.

## 9. Implementation Results

- Settings Facade and Service deleted two `preview*` interfaces, unified to `resolveModelConfig()`,
  `ModelConfigResolution`, and Renderer `resolution` state;
- New and rename popups share 1200ms idle-trigger, blur, Enter, and save immediately flush; save no longer requires double-click due to parsing in-flight;
- Numbers, booleans, Reasoning Option Spec, and Reasoning Mapping all displayed by same Resolution;
- New model form separately records touched fields, late Resolution does not override user input, final Personal Config remains sparse;
- "Model default config loaded" displayed only when complete `inheritedConfig` genuinely changes; repeated parsing does not renew, does not stack;
- Provider name, Base URL, and API Key idle-stop-save uniformly extended to 1200ms, blur/Enter/pre-save unchanged;
- Real Built-in Config, Facade, Provider auto-save, model popup, late response, and sparse submission all have directed regression evidence.
