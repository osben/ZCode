# New Task Draft Page Suggested Prompts

## Background

The new New task home adds a "suggested prompts" entry directly below the Chat composer. The original horizontal button group is delivered by the `draft-suggestion` scene of `clientScenesService`; the proactive task suggestion list uses a local pool maintained per feature.

## Proactive task suggestions

- This phase shows proactive task suggestions only in office mode. Office mode offers a default-checked option in the third onboarding step; coding mode shows neither that option nor the proactive list, and keeps the original small Client Scenes entry. The settings page keeps the "主动任务推荐" (proactive task suggestions) switch with the note "仅在办公模式下支持" (only supported in office mode), not operable in coding mode. Even if the old setting has proactive suggestions on, coding mode must not show the proactive list.
- The office-mode draft input keeps a plugin entry above it: collapsed it shows the first three plugin icons of the current list, expanded it still lists those three and the other plugins; clicking an item navigates to the existing plugin marketplace, and the suggestion feature injects no fake marketplace data.
- Display text is short and contains no `[placeholder]`; the body filled on click is complete and executable, and may use placeholders such as `[目标对象]` for non-required information. A suggested task must not use "if the current repo is a certain kind of project" as a start condition.
- Each visible panel shows three items. Drawing first avoids repeated icons and plugins on the same screen and tries to avoid icons already shown in other split panes; when candidates are insufficient it still shows three. "换一批" (shuffle) reassigns only the current panel, and batches shown in other panels and the plugin confirmation anchor stay unchanged. Rotation must make every pool item reachable within finite rounds. Turning suggestions off reuses the existing setting and onboarding record write-back.
- Suggestion icons use a 24px borderless plate with padding; the GitHub white-background asset is additionally scaled to 18px so the white square does not touch the plate edge.
- `[@插件](plugin://stable-id)` in the filled body forms a structured mention in the Composer at its original position; several plugins may appear at once. A click only replaces the draft and does not send automatically.

## Product semantics

- Clicking a suggestion that references no Plugin immediately **prefills** the fixed prompt into the Composer, without sending.
- Clicking a suggestion that references a Plugin waits for the target Host's first trusted resolution. When the first local check still allows a direct reference, no extra feedback is shown and on `ready` the structured Plugin mention and prompt are written once; if the body already references that plugin its position is kept and it is not prepended again, and a body with several plugins resolves them one by one into mention nodes. When the first check finds it cannot be referenced directly, the current suggestion's single Plugin action Popover enters loading at once. For other results or resolution failure the plain prompt is written once, avoiding a two-stage update where the body appears first and a chip jumps in later.
- Prefill **replaces** the existing draft (no append or merge); the user can keep editing and send manually.
- The prompt item's `on_finish` is split by English comma, trimmed and de-duplicated, then mapped to behavior by an explicit `switch` allowlist. The following navigation behaviors are currently supported, and on a hit all end this Composer prefill:
  - `NAVIGATE:AUTOMATIONS`: reuses the workspace main navigation to open Automations.
  - `NAVIGATE:AUTOMATIONS:OFFPEAK`: opens Automations; once scheduled/off-peak task data is ready, selects the `Idle-time` tab only if that tab actually exists, otherwise keeps Automations' default tab. If one item declares both Automations actions, the more specific `NAVIGATE:AUTOMATIONS:OFFPEAK` wins and navigates only once. An unknown or empty action does not change the ordinary prompt prefill semantics.
- Mobile `/remote` does not host Automations; when the page has no Automations navigation capability, suggestions declaring any Automations navigation action must be filtered out, and an invalid entry must not be shown nor the existing client-side boundary bypassed.
- A suggestion may declare one fixed Plugin stable ID. Only when the Plugin is enabled and has no same-name conflict does the first write prepend the canonical `[@Plugin](plugin://stable-id)` reference to the prompt and create a structured Plugin chip.
- During the first trusted resolution of a Plugin the renderer-local Composer revision at click time is recorded; if user input, an external insertion or a draft restore changes the revision, the operation silently abandons the deferred write and the later Popover, and a late suggestion result must not overwrite the current draft.
- `missing` must first refresh only `zcode-plugins-official` and re-resolve after the refresh succeeds; refresh failure, candidate disappearance, untrusted source or conflict are `unavailable`/`conflict`, one-click install from an old snapshot is forbidden, and the plain prompt is kept.
- The `zcode-plugins-official` refresh waits at most 10000 ms; on timeout the refresh is aborted and fails closed as `marketplace_refresh_failed`, old-snapshot candidates must not be read further, and only the plain prompt is kept.
- One-click install is allowed only from `zcode-plugins-official`, always with `scope: "user"`, installing for the current user of the current authoritative Agent Host; a remote workspace writes to the remote Host.
- When the first local check finds the target Plugin missing and is about to refresh the official Marketplace, the Agent must first emit `refreshing` progress by `operationId`; on receipt the UI puts the current suggestion's Plugin action Popover into loading at once. When the first trusted resolution returns `disabled` directly, the UI puts the same Popover into loading before writing the plain prompt. `ready`, `conflict`, `unavailable` and resolution failure must not create a second Popover merely because of the first check.
- Each suggestion operation has at most one Plugin action Popover at any time. Loading, install/enable confirmation, install/enable progress and success/failure only update the phase/message/action of the same `PopoverContent`; switching suggestions first cleans the same instance of the old operation and then the new operation reuses this single mount point, and mounting in parallel, nesting or stacking a second Popover is forbidden.
- A `missing` / `disabled` trusted result keeps handing the plain prompt to the Composer; only after the Composer has consumed the matching insert request and the input area and suggestion finished this round of layout does the same loading Popover switch in place to the confirmation state. The Popover anchors on the current suggestion button and opens `9px` directly below it, does not steal Composer focus or block other page interaction, and on desktop and mobile Web must be limited within the current viewport. The confirmation state is `240px` wide with height naturally set by localized content; it has no auto-close time limit. When the user clicks outside the Popover with the primary pointer, the Popover closes, the operation is cancelled and only the plain prompt is kept; focus moving out, clicks inside the Popover, the leading loading, install/enable progress and result states must not trigger this confirmation-state close behavior.
- When the first trusted resolution has already returned `ready`, it replaces with chip + prompt once; there is currently no workspace-level Plugin, so `plugins/referenceCatalog` must not be called again, nor the draft Runtime invalidated, nor trusted resolution called again. Only after a successful install or enable is the deferred draft Runtime invalidated and the state re-resolved trustedly by the target Host.
- A trusted resolution result may carry the official Marketplace listing's display-only `icon`; this field takes no part in identity, install decisions or permissions and returns with the same resolution. The UI writes it into the Plugin mention; when missing or invalid the existing default Plugin icon is used, and the catalog RPC is not restored just for an icon.
- After the user confirms install or enable, the same PopoverContent converges from the confirmation state to persistent progress; the success state shows only after the target Host re-resolves trustedly to `ready` and the Composer has consumed and cleaned the matching leading chip requestId. The switch from progress to success content reuses the vertical scroll structure of the model-switch label: `AnimatePresence initial={false} mode="popLayout"` keeps the mount point, the old progress content fades out from `y: 0` to `-0.75em`, and the 16px Check with success text enters from `y: 0.75em + opacity: 0` to `y: 0 + opacity: 1`, duration `200ms`, easing `[0.4, 0, 0.2, 1]`; under reduced motion it is replaced statically. Confirmation, failure and retry phases do not trigger this scroll. Install/enable failure converges by Popover failure semantics and the plain prompt is still kept.
- The remote install operation waits at most 10000 ms; on timeout the install is judged failed, the old operation is cancelled, late results are blocked, only the plain prompt is kept, the same Popover returns to the install confirmation state for retry, and the failure is recorded with UI logger `warn` and a warning toast. This timeout applies only to the install phase and does not limit the Composer's later wrap-up.
- Each trusted resolution request must carry a unique `operationId` and the target attachment's `clientMode` and `deliveryKind`: `desktop-continuous` on desktop and `web-remote-replayable` for mobile remote control; these only declare the existing chain boundary and create no new stream or recovery state.
- Clicking another suggestion while an install or enable is in progress interrupts the old operation; late results of the old operation must not write into the draft, Popover or chip, and other suggestions are temporarily disabled until the cancel completes.
- When the Plugin does not exist or is not enabled, the current locale's Plugin label shows a recoverable state and the plain prompt is kept; on conflict, workspace RPC not ready or resolution failure it degrades to the plain prompt and shows no fake Plugin chip. The first click does not install or enable automatically; it executes only when the user explicitly clicks the install/enable action in the flow.
- The Plugin reference is only a capability hint: it does not send automatically and does not change tool permission or approval; API Key, OAuth and user plugin configuration are not handled here.
- The draft is still held by the renderer-local Composer draft; sending still goes through the existing desktop `desktop-continuous` or mobile `web-remote-replayable` chain, and no relay/main/Host business state is added.

```text
click a suggestion
  -> clientScenesService.list()
  -> find options.prompts.items of the scene == "draft-suggestion"
  -> resolve item.labels / item.contents to label / prompt by current locale
  -> item.on_finish split by ",", trim, de-dup
     -> hit NAVIGATE:AUTOMATIONS
        -> invalidate earlier async Plugin queries
        -> reuse onOpenAutomationsMain
        -> write workspace navigation history and open Automations
        -> end, Composer not rewritten
     -> hit NAVIGATE:AUTOMATIONS:OFFPEAK
        -> invalidate earlier async Plugin queries
        -> write automationTab=idle into the renderer-local workspace navigation history
        -> open Automations, wait for scheduled / idle tab data to be ready
        -> visibleTabs contains idle ------> switch to Idle-time and consume the intent
        -> visibleTabs lacks idle ---------> keep the default tab and consume the intent
        -> end, Composer not rewritten
     -> no supported action
        -> continue the prompt prefill chain
  -> look up the optional Plugin from item.defaults option key + item id
  -> read prompt / optional pluginStableId
  -> no Plugin -------------------------------> write the plain prompt at once, in one step
  -> has Plugin -> record Composer revision -> subscribe operationId progress -> Agent trusted resolution
                  -> revision changes during resolution ---> silently abandon, do not overwrite the current draft
                  -> enabled and no conflict --------> write Plugin chip (with optional display-only icon)
                                                 + canonical text + prompt in one step
                                                 -> do not read workspace catalog
                                                 -> do not invalidate Runtime, no second resolution
                  -> disabled ----------------> the single Popover enters loading -> write plain prompt once
                                                 + after Composer consumes, the same Popover switches in place to "开启 {Plugin label} 插件" + "确认"
                  -> missing locally -> emit refreshing(operationId) -> the single Popover enters loading
                  -> missing -> refresh zcode-plugins-official (10000ms timeout)
                               -> timeout --------> marketplace_refresh_failed; abort refresh and reject the old snapshot
                               -> failure --------> unavailable, no old-snapshot install; write plain prompt once
                               -> success and trusted candidate -> write plain prompt once
                                                    + after Composer consumes, the same Popover switches in place to "安装 {Plugin label} 插件" + "确认"
                                                    -> click outside the Popover: silent cancel, keep only the plain prompt
                                                    -> click: User-scope install
                                                       -> reaches 10000ms -> cancel and judge failure, keep only the plain prompt
                  -> conflict/unavailable ----> write plain prompt once
  -> install/enable Popover stays at the original anchor
  -> after install/enable completes invalidate the deferred draft Runtime and re-resolve trustedly by the target Host
  -> then prepend the Plugin chip to the latest current draft
  -> after the Composer updates, the same Popover converges to the success state
  -> install failure returns to the confirmation state and allows retry; enable failure shows the failure result
  -> replace Composer + persist draft + focus
  -> the user sends manually
```

```text
operation A active
        |
click suggestion B
        v
close A's existing Plugin action Popover (if any) -> abort A -> plugins/cancelOperation(A) -> clean A's result
        -> B becomes active at once; all late results of A are discarded
        -> no cancel or interrupt feedback is shown
```

## Component

`packages/ui/src/v4/ConversationDraftSuggestedPrompts.tsx`

```tsx
<ConversationDraftSuggestedPrompts className="mt-6" onSelect={(item) => …} />
```

| Prop                  | Description                                                                       |
| --------------------- | --------------------------------------------------------------------------------- |
| `className`           | Extra class name for the outer container                                          |
| `items`               | Suggestion list mapped from `clientScenesService`; default empty array            |
| `onSelect`            | Click callback, argument is the full suggestion config                            |
| `disabled`            | Disables suggestions while the old operation's cancel converges                   |
| `pluginActionPopover` | Anchor, phase, text and confirmation action of the current install/enable Popover |

- Mount point: in `conversationBottomDock` of `packages/ui/src/v4/SessionPane.tsx`, after `{composerNode}`, rendered only in draft state (`isDraft`). The draft page is organized as `welcome -> composer -> suggested slot`; the container uses a fixed `h-8` slot in normal document flow, with no absolute positioning. The slot stays empty while the list loads asynchronously, and buttons fill the same slot when data returns, so the height does not change before and after loading.
- Layout: the button group keeps a `24px` gap from the Composer's lower edge, uses a hug-content single-row horizontal arrangement internally, with `gap-4` between buttons. On desktop it is centered under the Composer; on narrow screens it stays single-row and may scroll horizontally, does not fold into a vertical list and does not squeeze the Composer. The button group adds no extra card background; the Composer and the empty slot take part in the same centered layout as a whole.
- Each item reuses the shared `Button` `outline` interaction state, with row height `h-8`, an 8px `rounded-lg` and `px-3`; a `size-4` icon slot on the left (a `size-4` lucide icon inside) and on the right preferring the prompt item's `label` in the current locale (from Client Scenes `labels`). A click still prefills the Composer with `prompt` (from `contents`).
- On the first render of the Client Scenes list a waterfall entrance is used: buttons follow in DOM order from left to right at `65ms` intervals, each button clipped from the top and expanding while dropping `12px` from above into place. The animation does not change the button group's layout height. It is turned off completely when the system has `prefers-reduced-motion: reduce`.
- Button visible text and icons uniformly use `text-foreground`; default content opacity is `opacity-70`, transitioning to `opacity-100` on hover through `transition-opacity`. Visible text keeps `text-ui-base` and always stays single-line with ellipsis. Narrow screens do not wrap; overflow beyond the group width is carried by horizontal scroll inside the group, and the page itself does not overflow horizontally.
- The `plugin` config participates only in the capability resolution after a click; the Plugin label and canonical reference are not shown in the suggestion list.
- The icon uses the prompt item's `img` directly as a Lucide canonical name (kebab-case, for example `file-text`) and loads the matching SVG dynamically by name. The icon sets no color of its own and uses `currentColor` to inherit the icon slot's `text-foreground`; when `img` is empty, the name is not in the current Lucide version, or module loading fails, it falls back to the neutral `SquareCode`. The locale-dependent `imgs.cn` / `imgs.en` must not be read.
- Server i18n fields use `cn` / `en`; `zh-CN` reads `cn`, `en-US` reads `en`, and an empty field falls back to the other language.

## Client Scenes mapping

Only `options.prompts.items` of `ClientSceneConfig.scene === "draft-suggestion"` is consumed; the old `ai-writing` is no longer a fallback, and other scenes and options take no part in the suggestion list:

| `DraftSuggestedPromptItem` | Source                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                       | the prompt item's `id`                                                                                                                                       |
| `label`                    | the prompt item's `labels` (`cn` / `en`)                                                                                                                     |
| `prompt`                   | the prompt item's `contents` (`cn` / `en`)                                                                                                                   |
| `iconName`                 | the prompt item's `img` Lucide canonical name; explicitly does not read `imgs`                                                                               |
| `actions`                  | the prompt item's `on_finish`; after splitting by English comma only the actions the UI explicitly supports are kept                                         |
| `plugin.stableId`          | iterate the prompt item's `defaults`; the key locates `scene.options[key]`, the id in the value locates the item of that option, read that item's `contents` |
| `plugin.label`             | `labels` (`cn` / `en`) of the same matching item                                                                                                             |

When `defaults` is missing, the option key does not exist, the item id does not exist or the Plugin stable ID is empty, the suggestion is treated as having no Plugin. `DraftSuggestedPromptItem` currently supports only one Plugin, so with several valid defaults references the first in server declaration order is taken.

Client Scenes are obtained through the shared `useClientScenesResource()`: when mounted concurrently with the scheduled / off-peak templates under the same Service authority only one request is issued. While a cold cache loads, an empty list is shown; with an existing cache the old catalog is mapped and shown at once, and background revalidation must not clear the list. On the first interface failure, a response `code !== 0`, a missing `draft-suggestion` scene or missing `options.prompts`, an empty list is shown with no fallback to local static suggestions; a revalidation failure with an existing cache keeps the last-known-good suggestions. Interface failure uses UI logger `warn` and does not affect the Composer. A locale switch only re-maps the i18n fields in the cache and triggers no request. The cache de-dup window is 10 minutes; after the page actually goes hidden and then visible again, a revalidation must be forced once bypassing the de-dup window, and several suggestion or template consumers under the same Service/cache authority must not request repeatedly.

## State pruning and coverage

| Case  | State                                                                 | Expected                                                                                                                                                                                                                                                                                                                                                                                          | Coverage     |
| ----- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| DSP01 | `draft-suggestion` prompt item, no defaults                           | Map server i18n, replace with the plain prompt, no auto-send                                                                                                                                                                                                                                                                                                                                      | focused unit |
| DSP02 | defaults resolve to a Plugin, first resolution is ready               | No write before resolution; after the result returns replace with chip + prompt once, no Runtime invalidation, no second resolution, no workspace catalog read; the optional icon is written with the structured chip                                                                                                                                                                             | focused unit |
| DSP03 | Plugin missing                                                        | After the first local check finds it missing, emit `refreshing` first and the single Popover enters loading; refresh only the official market, a 10000ms timeout aborts and fails closed; after completion write the plain prompt once; after the Composer consumes it the same Popover switches in place to a no-time-limit confirmation state, and a click outside the Popover cancels silently | focused unit |
| DSP04 | Plugin disabled / conflicted / catalog request failed                 | disabled first puts the single Popover into loading, then writes the plain prompt once, switching in place to confirmation after the Composer consumes; conflict/failure adds no second Popover; the request carries clientMode/deliveryKind                                                                                                                                                      | unit         |
| DSP05 | Click another suggestion during install or enable                     | Silently close the old Plugin action Popover and cancel the old operation; other suggestions are disabled until the cancel converges; late results do not overwrite the new selection                                                                                                                                                                                                             | focused unit |
| DSP06 | Install completed and the user has edited the draft                   | The Popover progress stays; keep the body and prepend the single Plugin chip; after the Composer updates show success in the same Popover with the model-label-style vertical scroll, no auto-send                                                                                                                                                                                                | focused unit |
| DSP07 | Install or enable failed or install reaches 10000ms                   | Install failure restores the confirmation Popover and allows retry; enable failure shows the failure result; install timeout cancels the operation and keeps the plain prompt                                                                                                                                                                                                                     | focused unit |
| DSP08 | scenes load failed / non-success code / target config missing         | Empty list, Composer stays usable                                                                                                                                                                                                                                                                                                                                                                 | unit         |
| DSP09 | locale is `zh-CN` / `en-US`                                           | Use `cn` / `en` respectively, cross-language fallback when missing                                                                                                                                                                                                                                                                                                                                | unit         |
| DSP10 | `img` valid / missing / load failed, with any `imgs`                  | Valid icon; otherwise fall back to the placeholder and ignore `imgs`                                                                                                                                                                                                                                                                                                                              | focused unit |
| DSP11 | User modifies the Composer during the first trusted Plugin resolution | After the revision changes silently abandon the deferred write and Popover, the current draft is not overwritten                                                                                                                                                                                                                                                                                  | focused unit |
| DSP12 | `on_finish` has commas, whitespace, duplicates or unknown actions     | Keep only the de-duplicated supported actions                                                                                                                                                                                                                                                                                                                                                     | focused unit |
| DSP13 | Click a `NAVIGATE:AUTOMATIONS` suggestion                             | Open Automations, no prefill, no auto-send                                                                                                                                                                                                                                                                                                                                                        | focused unit |
| DSP14 | Click a `NAVIGATE:AUTOMATIONS:OFFPEAK` suggestion                     | Open Automations; select the Idle tab automatically when it exists                                                                                                                                                                                                                                                                                                                                | focused unit |
| DSP15 | No Idle tab after OFFPEAK intent data is ready                        | Keep the default tab and consume the one-shot intent                                                                                                                                                                                                                                                                                                                                              | focused unit |
| DSP16 | Mobile `/remote` without Automations navigation capability            | Filter both navigation-type suggestions, ordinary prompts stay usable                                                                                                                                                                                                                                                                                                                             | focused unit |

- Trusted-resolution loading, remote waiting and RPC error all fall under "currently unverifiable" and are represented by DSP04, without expanding an error-type Cartesian product.
- "Not installed" must go through trusted resolution and the official market refresh; a catalog miss cannot be treated directly as installable, and the old snapshot from a failed refresh cannot be used.
- The Popover and the draft write share a latest-wins boundary; a late old catalog response must not overwrite the draft or show a stale hint; an interruption caused by manually switching suggestions is always silent.
- Neither loading nor confirmation starts an auto-close timer; only confirmation responds to a primary-pointer click outside the Popover and cancels the current operation. At most one Plugin action Popover is mounted globally at any time.
- Desktop, mobile Web, local and remote share the same workspace-scoped prefill and canonical text, without a per-Plugin-state cross product; manual UI acceptance checks both desktop and mobile Web.
- Conversation E2E uses representative chains: desktop local install, desktop remote User-scope Host isolation, mobile remote refresh-failure recovery, plus switching suggestions during install. Theme, language, Popover action/persistence/outside click, keyboard focus, mobile layout and reduced motion are manual acceptance and UI automation coverage is not claimed.

## Impact brief

| Field          | Conclusion                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change layers  | `option-source`, `presentation`, `draft-default`, `validation`, `commit-effect`                                                                                                                                                                                                                                           |
| UI surface     | New Task draft page `ConversationDraftSuggestedPrompts`                                                                                                                                                                                                                                                                   |
| Draft owner    | renderer-local Composer draft / workspace-scoped insert request                                                                                                                                                                                                                                                           |
| Option source  | `clientScenesService.list()` -> `draft-suggestion.options.prompts.items`                                                                                                                                                                                                                                                  |
| Validation     | Client Scenes mapping boundary + target Host `plugins/resolveSuggestedReference` trusted resolution                                                                                                                                                                                                                       |
| Commit sink    | `requestComposerTextInsert`; does not call `onSendText`                                                                                                                                                                                                                                                                   |
| Persistence    | Existing V4 Composer draft persistence                                                                                                                                                                                                                                                                                    |
| Invariants     | An ordinary prompt replaces and does not auto-send; navigation actions do not prefill; OFFPEAK only switches among existing Idle tabs; plain prompt when the Plugin is unavailable; workspaceIdentity isolation; mobile `/remote` adds no Automations entry; operations carry clientMode/deliveryKind and are cancellable |
| Graph evidence | `capability.plugin-reference` + a new suggested-prompts surface; no codegraph in this environment, verified with feature graph seeds and depth-2 exact call sites                                                                                                                                                         |

The component remains a pure display and click entry; the server config only provides candidates and capability hints, the UI consumes only the target Host's trusted resolution result, no longer reads the workspace catalog, and keeps the existing contract of single-line titles, hidden Plugin references, replacing the draft and not auto-sending.

## Prompt template click telemetry

On Desktop every click on a suggested Prompt template (including ordinary Prompt prefill, Automations navigation and Off-Peak navigation) reports one product telemetry event through the existing `reportAppTelemetryEvent()`. Web and mobile remote control keep only the existing UI behavior this round and do not call this telemetry; the real reporting chain of those two is to be added separately. The event is fixed as:

| Field                              | Value / meaning                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `elementName`                      | `prompt_template_ck`                                                                                  |
| `eventRegion`                      | `app.session`                                                                                         |
| `eventType`                        | `ck`                                                                                                  |
| `eventText`                        | The template name the user actually sees in the current UI language                                   |
| `eventExtraDetail.template_id`     | The Client Scenes prompt item's `item.id`, a statistics dimension stable across languages and renames |
| `eventExtraDetail.template_prompt` | The full Prompt resolved in the current UI language; excludes anything the user edits afterwards      |

`eventExtraDetail` strictly contains only `template_id` and `template_prompt`, and does not upload `template_name`, `template_action`, `talkId` or `messageId`. The click telemetry fires at the start of click handling and is decoupled from async Plugin operations, navigation and draft prefill; a telemetry failure must not block the original interaction. Desktop's `userId`, client context and device fields continue to be added by the existing `/event/report` host chain. Web / mobile remote control are not in this round's `/event/report` statistics scope.
