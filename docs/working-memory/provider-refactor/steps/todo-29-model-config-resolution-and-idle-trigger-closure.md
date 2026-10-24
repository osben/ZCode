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

## 1. Problem

The new-model popup already resolved Model Config Rules through Host by `providerId/modelId/api.type/baseURL`, but
Renderer projected the same resolution three inconsistent ways: context/max output as inherited placeholder, boolean
properties copied into the local Draft, reasoning JSON not connected (wrongly shown as "—"). So `GLM-5.3-Flash`
actually hit 1M context, 128K max output, Image/Video and reasoning rules while the popup showed only some defaults.
Debounces were also inconsistent (new model parsing 300ms, model ID edit parsing 180ms, Provider text save 800ms),
so brief pauses triggered requests, field jumps, config writes and Registry refreshes.

This Todo consolidates default config resolution, sparse Draft, success feedback and text idle trigger. It does not
change Model Config Rule precedence, Provider/Model Overlay order, Registry integrity or Active Model freeze.

## 2. Unified domain naming

`previewModelConfig`, `previewPersonalModelDraft`, `resolvedDefaults` and similar are retired. The sole operation:

```ts
const resolution = await providerSettingsService.resolveModelConfig(input);
setResolution(resolution);
```

Method `resolveModelConfig`; return structure `ModelConfigResolution` (`inheritedConfig/effectiveConfig/issues`);
Renderer local state `resolution`. A new model resolves only the current candidate ID; an editing model may carry the
unsaved Personal Exact Draft and original Model ID. Resolving never writes Personal Config or changes Registry
revision; whether to persist is decided by a separate save command (`preview` is no longer a domain name).

## 3. Draft and inheritance facts

```text
ZCode Built-in + Personal Match Rules -> inheritedConfig + sparse Personal Draft -> effectiveConfig display
```

- Renderer may cache Resolution boolean values in form display state; that cache is not Personal Config.
- Fields explicitly touched by the user are recorded separately; a late Resolution must not override them.
- Numbers, booleans and JSON all derive display values from the same Resolution; context/max output and reasoning
  JSON use inherited/effective placeholder.
- Boolean controls display `Personal Draft ?? inheritedConfig` and show the Personal Override style only when the
  user explicitly modifies them.
- `false` in general Rules is a complete default fact, not "default not obtained".
- On save, only the new Provider's Personal model members and truly existing sparse Exact Rules are created;
  Effective Config is never reverse-materialized.

## 4. Unified idle trigger

Provider text save, new-model config resolution and editing-model config resolution share one idle-trigger semantics:

```text
onChange: update local Draft immediately; cancel previous timer; after 1200ms of no new input execute the action
  Provider: save Personal Provider Draft
  Model: resolve Model Config
onBlur / Enter / explicit save: cancel timer and flush the action immediately
```

- Idle time is 1200ms; continuous input executes only the last; IME composition does not trigger.
- Resolution requests use a monotonically increasing sequence (or equivalent identity check); expired responses must
  not update the current Model ID.
- Clicking model save while resolution is scheduled/in flight immediately flushes and waits, then saves in the same
  click (no double-click).
- Provider blur/Enter/pre-save and unload protection are unchanged; only timed dispatch is replaced, no second save
  queue.

## 5. Resolution success banner

A green banner "Model default config loaded" appears when a new Resolution genuinely changes inherited config:

```text
Resolution complete
├─ inheritedConfig same as currently applied result -> silent: no field update, no banner
└─ inheritedConfig genuinely changed -> update all inherited display atomically + show one success banner
```

- Shown on the first successful config load.
- Not shown on repeated blur, repeated resolution, case-only changes with the same config, or different IDs getting
  identical inherited config.
- Failure, expired or incomplete Resolution shows no success banner.
- The banner sits at the model popup content area's fixed feedback position, uses the existing semantic success
  color, checkmark and i18n, never scrolls out of view, and replaces in place by a stable key (no stacking).

"Loaded" only means a rule-resolution baseline was obtained; a general `modelMatch: ".*"` can also provide default
config, and the text does not claim the server recognizes or authorizes the model.

## 6. Impact boundaries

| Layer         | This round                                               | Unchanged                                           |
| ------------- | -------------------------------------------------------- | --------------------------------------------------- |
| draft-default | Unified Resolution projection and sparse Draft           | Rule content and override precedence                |
| presentation  | New success banner, fix JSON default wrong display       | Model field order and editable scope                |
| commit-effect | Unified 1200ms idle/blur flush                           | Host save, Registry refresh, revision authority     |
| validation    | Wait for current Resolution before save                  | Integrity rules and Adapter compatibility           |
| persistence   | Provider text still auto-saves                           | Personal Config Schema and physical location        |

Model selection, connection testing, account plan, Remote Provisioning, Desktop continuous, Mobile replayable, queue
and recovery are untouched.

## 7. Acceptance scenarios

1. `GLM-5.3-Flash + anthropic-messages` displays 1M, 128K, Image/Video, reasoning spec and mapping.
2. Built-in `false` capabilities display as inheritance values but are not written to a Personal Rule.
3. Reasoning JSON uses the Resolution placeholder, no wrong "--".
4. 1200ms continuous input does not call Resolution/Provider save; one call after stabilization.
5. blur/Enter flushes immediately; clicking save waits for Resolution and completes in one operation.
6. A late Resolution is discarded; the same inheritedConfig neither updates fields nor shows the banner.
7. The banner shows once when config changes; failure and incomplete results show none.
8. Provider name/baseURL/API key idle save is 1200ms; blur and pre-save do not regress.
9. New model untouched fields save only members and necessary sparse Personal Rules.
10. Chinese/English, light/dark, keyboard and narrow window keep the banner usable.

## 8. Completion and Outcome

- Settings has one domain name `resolveModelConfig` and one Resolution state; all inherited fields in new/edit popups
  come from the same Resolution; Renderer does not materialize inherited booleans as persistent Personal Config.
- Settings Facade and Service deleted the two `preview*` interfaces; new and rename popups share the 1200ms
  idle-trigger with blur, Enter and save immediate flush.
- New model form records touched fields separately; the final Personal Config stays sparse.
- "Model default config loaded" appears only when the complete `inheritedConfig` genuinely changes.
- Provider name, Base URL and API key idle save extended to 1200ms; blur/Enter/pre-save unchanged.
- Real Built-in Config, Facade, Provider auto-save, model popup, late response and sparse submission have directed
  regression evidence; Design, Feature Graph, unit tests, typecheck, lint and format checks pass.
