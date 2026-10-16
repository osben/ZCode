# Provider Settings Page

> Status: Current effective design
>
> Last updated: 2026-09-08

The Provider settings page edits Personal Config and interacts with the target Environment's Config and Registry through the Provider Settings Service in the Host. The page uses auto-save: the editing process retains local drafts; after one edit action completes, the edited Personal Provider Draft is submitted; the Host completes persistence and refreshes Registry; only then does the page confirm save success.

```text
Renderer Draft
      |
      | Edit action completes
      v
Provider Settings Service
      |
      | Atomic update Personal Config
      v
Provider Config Service
      |
      | invalidation + refresh
      v
Provider Registry
      |
      | Return latest Settings View
      v
Renderer displays save success
```

The settings page does not read physical config files, nor does it execute Overlay, completeness validation, or Registry member judgment in the Renderer. Remote settings pages call the same Service on the target Environment; Desktop does not treat local machine Provider configs as remote facts.

## Auto-Save

### Connection Switching After Account Plan Expiration (Todo93)

2026-09-08 decision: When the same account, same complete connection changes from available/pending to explicitly unavailable, prompt once and provide a "switch to specific plan" button; only when the user clicks, re-validates, and conditionally writes successfully does the actual connection change. Persistent unavailability does not re-prompt; unknown should not be treated as failure; new events occur after recovery. First startup/identity switching only establishes baselines; no state comparisons between different plans are made; manually selecting unsubscribed personal plans does not automatically pop back. Retain the first initialization without selection and old connection migration protection.

Observation records are maintained only at the root layer in memory; no additional persisted fields/migrations are added. AccountProviderState.connectionKey is a summary of the current round's account and complete connection identities, used only for observation isolation; it does not enter Config Overlays. Settings page manual selection still uses the original save entry; Start connection entry filtering and Provider visibility remain unchanged; model execution gates are not bypassed. Detailed states, old advice expiration, and test boundaries are documented in [Todo93](../../steps/todo-93-account-plan-loss-manual-switch.md). It replaces Todo88 R06's auto-switching decision; current implementation only conditionally writes after clicking and re-verifying.

### Model Popup Final Decision (Todo90 / Todo92)

2026-09-08 implemented according to this section and passed Pro joint acceptance; evidence is recorded by Todo90/92 and takes precedence over the historical "restore default" and focus border descriptions below when in conflict.

- Retain the toggle on the same row as save/cancel; display name changed to "Smart Config." Explanation: "Match recommended configurations automatically based on model ID, with individual overrides allowed."
- Enabled: Match and inherit recommended configurations by model ID, with personal overrides allowed; Disabled: Fill the current effective draft completely, all config fields required, no longer matching by ID or borrowing recommendations, no personal override styles shown.
- Re-enabling clears model config overrides and restores recommendations by current ID; subsequent new edits are still retained. All switches only modify drafts; saves take effect, cancels are abandoned; IDs/enabling/membership ownership are not changed. Existing mode fields are retained; no new migrations are added.
- Borders only express no-override/has-override, using neutral/light-emphasis thin borders; saving and re-opening preserves source markers. Numerical, modal, capability, and MFJS items are independent; when levels are renamed, numbered, or reordered, all level boxes highlight together; Mapping is highlighted separately. Outer containers do not highlight.
- Hover and focus share slight background changes; borders are not modified; no additional focus outlines are added; option enabled/disabled backgrounds and keyboard focus must still be recognizable. Only adjust the model editor; do not globally modify shared base components.
- MFJS uses the same button styles as capability options, without icons or pre-checkboxes; completely delete the "render checkbox without icons" visual branch; preserve accessibility semantics.
- Retain the reasoning outer container and level/Mapping internal editing areas; remove the duplicate "Reasoning Settings" title; advanced settings retain titles and containers. No "Custom" text, no group-level or global restore default buttons.

Implementation and acceptance are documented in [Todo90](../../steps/todo-90-model-add-edit-shared-recommended-draft.md) and [Todo92](../../steps/todo-92-model-smart-config-and-override-feedback.md).

Implementation ownership: Add/edit share editing draft hooks; source marking of personal fields belongs to editing intent; it is not inferred from the entire form validation results. The Host returns recommended baselines; UI only projects un-overridden controls to baselines; no self-rule matching is done. Fixed modes stop recommendation requests; Host writes check completeness; runtime parsing only uses its complete personal config (enabled still processed by independent enable/disable rules); Built-in cannot fill gaps.

### Write and Edit Transaction Supplement (Todo 89)

Built-in/account Providers may have no Personal Provider records yet. When modifying members or ordering, the Config Service creates sparse overlays as needed; editing model configs does not require or additionally create Provider records. Member sources uniformly come from Facade snapshots and cannot be replaced with executable Registries or static lists. New models retain existing member relative ordering and append new members.
Deleted Personal-only Providers must not be recreated by late saves.

Model enable/disable uses independent leaf updates, reading the latest personal config in atomic transactions; only changing `enabled` while preserving config modes and other fields. Provider forms only submit edited config items; untouched fields like headers are preserved; no edits do not trigger saves.

Model popups fix the original model, draft, and revision for this edit upon opening. External View updates do not overwrite this draft; saves still check versions; conflicts or failures retain inputs; cancel and re-open only loads the latest values. Config-incomplete models still provide editing fixes and enable/disable entries;
personal members can be deleted; inherited members cannot be deleted or renamed. Editable does not mean executable; Registry completeness validation remains unchanged.

Model members and configs directly display Host-returned Views; no separate rollback-on-add/delete-failure table is maintained;
only drag-and-drop preserves existing optimistic ordering. Add popups wait for actual saves to complete before closing; failures are retried in the original draft;
explicit popups do not offer out-of-draft notification retry operations. Account and ordinary vendor details share the same model write callbacks.
When Start Plan has been confirmed available by Account snapshots, quota/plan cards re-querying temporary empty states cannot uninstall model editing areas;
this does not therefore allow unclaimed Start Plan models to display, nor modify entitlement query caches, switch plans, or execution gates.

Text inputs only modify component-internal Drafts during editing. When there is no new input for 1200ms, auto-save triggers; when input boxes lose focus,
users press Enter, or when switching to other Providers, a single Personal Provider Draft update is submitted immediately. Selection boxes, switches, and drags submit immediately after operations complete.

```text
Input characters
├─ Update local Draft
└─ 1200ms without new input -> auto-save

Lose focus / Enter / Switch Provider
├─ Provider fields: save Personal Provider Draft
└─ Model fields: save that model's Personal Exact Draft

Select API Format / Toggle Enabled / Drag end
└─ Immediately save Personal Draft after operation
```

Text idle-triggers only schedule a single save for the current Provider Draft; each new input cancels the previous timer; consecutive inputs only save the final value.
Losing focus, Enter, and switching Providers cancel the timer and immediately flush. Auto-save must not establish a second accepted queue;
expired responses are still isolated by Provider Draft revisions.

New and edited model IDs use the same 1200ms idle-trigger to schedule `resolveModelConfig()`. This method only parses `inheritedConfig/effectiveConfig/issues` based on the current
Provider and unsubmitted sparse Model Draft; it does not persist or change Registry revisions. Losing focus, Enter, or explicit saves immediately flush; save buttons wait for current Resolution to complete before continuing to submit in the same operation.

The recommended config match prompt uses "Recommended settings matched for this model" (in English: "Recommended settings matched for this model"),
no longer called "Loaded model default config." This only adjusts prompt text; it does not change parsing, prompt timing, or save behavior.

A single save only submits the Personal Draft belonging to this operation, not the current collection on the page as a Repository snapshot: Provider fields only
write Provider Config; Model fields only write that model's `type="provider-model"` specific Rule. New Personal Models atomically write
`modelIds` members, complete `modelOrder`, and initial `enabled=true` specific Rules; deletes, renames, and reordering also use their respective domain atomic operations.
No ordinary save traverses or replaces other
Model Rules on the same Provider, nor copies Effective Config back into Personal.
A single config item, once modified by the user, submits the complete replacement value; unmodified inherited values are not materialized due to form loading or unrelated field saves.
Provider Settings Facade generates Settings Views from Effective Built-in and Personal at the same revision as inputs, and config is atomically updated by
Personal Repository. Save methods wait for corresponding Registry refreshes to return; therefore, successful responses simultaneously mean:

1. Personal Config has been persisted;
2. The current process Registry has observed this version;
3. The returned Settings View corresponds to the facts after this submission.

Whether the settings page displays, locks, or hides a field is merely a UI product decision; it is not a Config Schema permission boundary. Formal UI may
not expose Account Access, Built-in Model IDs, PDF/Audio, and other fields, but Schema does not therefore increase "users must not write"
source validation. Users editing Personal Config manually still use the same Overlay, structure, and completeness rules; business-invalid but structurally complete
account connections are handled by Request Auth or server request failures.

Model format Drafts directly maintain `properties.input_format` / `properties.output_format`. The input page only displays locked
Text and editable Image, Video, PDF; Audio is hidden but must be preserved as-is. The output page only displays locked Text.
Facades do not reverse-generate Personal Rules from Built-in baselines. They compute the authoritative Effective Config by taking Effective Built-in and existing Personal Overlays; Renderers only submit user-modified materialized leaves; untouched hidden fields do not produce new overlays. See
[`../model/input-output-format.md`](../model/input-output-format.md).

Normal editing Views provide read-only `templateConfig?`, `effectiveBuiltinConfig?`, sparse `personalConfig`, and authoritative
`effectiveConfig` from sources; Personal Providers created from Templates do not fabricate `effectiveBuiltinConfig`. Renderers only copy
`personalConfig` as Personal Drafts. Inherited values can be displayed as control values, but only when users
actually touch a config item is that item materialized into Drafts. Ordinary fields can delete the corresponding Personal field by restoring defaults; the `enabled` toggle in the model list does not offer a "restore default" operation; every user toggle saves explicit Personal boolean values. Renderers do not call Effective → Personal diffs, nor combine members or calculate conflicts themselves.

The page maintains incrementing revisions for each Provider Draft. Only when the response revision matches the current Draft revision can the current input be displayed as saved; late responses from earlier requests cannot overwrite new inputs, nor incorrectly display success. Provider/Model/member writes to the same Provider are executed in order; rename waits for old ID operations and switches subsequent identities; delete is a terminal operation; connection tests wait for related saves. External View updates only refresh unedited fields; dirty fields retain local inputs; save failures retain inputs and retry entries.

## Save Feedback

The Renderer internally continues to use Draft revisions to distinguish local edits, in-progress saves, and expired responses, but does not show `dirty` copy to users, nor saves another save state in the Provider content area. A single save operation projects as a notification at the bottom of the window, replacing in-place by the same stable key:

```text
saving (does not auto-dismiss)
  |
  +-- success -> replace by same key, stay briefly then fade
  |
  `-- failure -> replace by same key, stay longer with retry/close
```

The model popup's save button still shows a Spinner during requests and prohibits duplicate submissions; this is an operation control state, not a second save feedback. Only the Host confirms the corresponding revision can replace saving with success. Late responses from earlier requests must not overwrite current operations; failure information cannot be expressed solely by colors.

## Provider Identity and Names

`providerId` is an execution identity that cannot be modified after creation; `label` is an editable display name. The two are no longer converted through rename. Personal-only Providers are created with currently unoccupied default IDs:

```text
new-provider
new-provider-2
new-provider-3
```

The settings page modifies names by writing Personal `label` Overlays. Empty labels mean restore inheritance; all Effective Provider labels must be unique after case-insensitive comparison, avoiding indistinguishable same-name entries in the settings page and model selector. `providerId` continues to be non-empty, trimmed, and globally unique. Internal states and cross-process protocols use structured `ModelSelection`; Prompt CLI's
`provider/model` is merely a human-readable shorthand at the Entry boundary.

ZCode Built-in and Account Built-in Provider IDs are managed by ZCode Built-in Provider Config; the settings page cannot rename them.
They can still provide read-only `label` and brand information from Built-in Config; `providerId` is always the execution identity and display fallback when no label is present.

`visibility` is the product visibility fact of Provider Config, not a settings page control. Provider Settings Facade only returns
`visibility = "visible"` Providers; hidden Providers do not appear in the settings page; the page also does not offer operations to toggle this field.
Hiding only affects product entries; it does not affect Registry members, completeness validation, or internal execution.

Model Config no longer has independent `visibility`. Whether models appear in normal selectors is jointly determined by Provider visibility, Model enabled, and completeness;
Settings still displays disabled models, allowing users to edit or re-enable them.

## Provider Grouping, Adding, and Deleting

The settings page only displays real Providers; Templates only appear in the right-side Template selection page:

```text
zai-family / bigmodel-family
└─ Fixed Account Family areas
   ├─ Start Plan
   ├─ Individual Coding Plan
   └─ Team Coding Plan

Provider Templates
└─ Creation baselines opened by top "Add Vendor"
   ├─ Z.AI API / BigModel API
   ├─ DeepSeek / Moonshot / MiniMax
   └─ Other official templates

standard-personal
└─ Created normal Personal Providers
```

Providers do not save extra `builtin` flags or top-level `enabled`, nor infer groupings by Provider ID whitelists. Templates are not
Providers, with no runtime `providerId`, executable state, or Settings detail pages.

Top operations reuse Subagents settings page header action hierarchy: refresh first, using `outline + icon-md`; "Add Vendor" follows, using `default + default` primary action buttons with Plus icons; both are right-aligned with `gap-2`. Clicking add keeps the left Provider navigation unchanged, switching the right details to
`ProviderTemplatePicker`. The selection page directly consumes the target Host's `ProviderSettingsView.providerTemplates`, displaying
fixed-height cards with names truncated to at most two lines by publication order; no separate Catalogs, searches, ID sort tables, or Renderer brand lists are created. The page provides a back button; entering the new Provider detail after creation succeeds. Long names beyond two lines are truncated and the full name is shown via Tooltip.

"Add Model" in Provider details is a secondary creation action subordinate to the current Provider, using `secondary + default` buttons with Plus icons; buttons
remain to the right of the "Model List" title row; the title row's parent container uses `mb-1` and maintains a `4px` gap with the list body; they cannot float over or cover list borders.

The selection page has two immediately-effective creation entries:

```text
Add Vendor
└─ Select Provider Template
   └─ Each creation creates a new Personal Provider instance
      ├─ Record templateId
      ├─ UI parses label seed from Template nameMap by current Locale
      ├─ Host generates unique providerId / label within creation atomic update
      └─ Atomic write Personal Config and providerOrder

Create Custom Vendor
└─ Immediately create Personal Providers not referencing Templates
   ├─ Write group=standard-personal, access.type=api-key
   │  └─ API Keys may temporarily be missing; Access discriminator fields must not be missing
   ├─ Do not infer API type, Endpoint, or models
   └─ Enter complete custom details
```

`standard-personal` currently only supports `api-key` Access. Renderers select corresponding settings forms only based on Effective `access.type`;
they must not build separate UI inferences by Provider groups. Template creation and blank creation uniformly call
`createPersonalProvider({ templateId?, label?, initialConfig? })`; `initialConfig` does not allow carrying `label`, avoiding bypassing deduplication.
Template names are only creation seeds; created Personal `labels` are stable and editable, not automatically changing with interface language or Template updates. The Welcome's API Key entry also calls the same atomic creation operation and must not maintain
fixed `zai-api` / `bigmodel-api` runtime Providers or dedicated save interfaces.

Incomplete new Providers can appear in Settings Views and display completeness issues, but do not enter Registries.
Personal-only Providers' structured drafts allow saving: empty Base URLs, empty API Keys, or empty model members should not block persistence; null values are not written as illegal pseudo-URLs, but keep corresponding fields absent. Hosts still mark such Providers as non-executable by formal completeness rules. Non-empty but malformed
URLs continue to be rejected as field errors, avoiding mistaking input errors as "not yet configured."

The Provider settings page does not offer general enable/disable controls. Account plan eligibility reads `access.entitled`; ordinary Personal Providers' existence is expressed by their Personal root declarations. Neither can be inferred from Provider top-level `enabled` anymore.

Provider Template publishing order determines the default order of the "Add Vendor" menu. Zhipu, Moonshot, MiniMax, DeepSeek,
Alibaba Model Studio, Xiaomi, and other domestic model services are placed before OpenAI, Anthropic, xAI, and other overseas services; Renderers no longer separately save a menu-specific sort table.

Provider navigation, detail titles, Template selection pages, and Account details uniformly read Provider Config's structured `logo` references, mapped by UI resource parsers to `logo.key + current actual theme` into packaged materials. Missing, unknown keys, or resource loading failures all fall back to generic Package
icons; Renderers do not infer brands by Provider IDs. Pure custom Providers do not currently support uploading Logos.

When deleting ordinary Providers, delete that Personal Provider root definition and its Personal `provider-model` Rules; Templates are unaffected and can be created as new instances again. Account Family Providers do not offer delete entries; account states are updated by Account Overlays. Generic Personal `match` Rules are not affected by Provider deletions.

## Model List and Editing

The model list handles browsing, enable/disable, testing, editing, Personal model deletion, and full-member ordering. The list must directly
display `enabled` states and operation buttons; model IDs, Properties, and Option Specs content are modified in independent
model editing pages; list rows do not provide inline name editing.

```text
Model list row
├─ Model ID
├─ Context window summary (left-aligned immediately after Model ID)
├─ Status: Normal / Disabled / Incomplete config
├─ Properties summary
├─ Test
├─ Delete (Personal only)
├─ Edit icon -> Model edit popup
├─ Enabled toggle (fixed to the far right, no "restore default" offered)
└─ Model ID and non-interactive blanks can all start whole-row dragging (Built-in and Personal)
```

Model IDs are part of the `providerId/modelId` identity. Built-in Model IDs are read-only; when editing pages modify Personal Model IDs, they execute a single explicit atomic rename operation, rather than treating them as ordinary display text.

The `enabled` toggle displays Effective Model Config; after toggling, it writes Personal `type="provider-model"` specific Rules and maintains explicit
boolean values; the model list does not offer a "restore default" entry to delete this leaf. Disabled models continue to display on Provider pages but are hidden from the normal model selector. The toggle does not equal
`selectable`: Provider config incomplete, Account not entitled, or Provider hidden may still make an enabled model unselectable.

Normal Personal Provider navigation rows do not display independent drag handles; Provider names, icons, or non-interactive blanks are all the same whole-row drag areas. Clicks still select Providers; only after dragging exceeds the activation distance does ordering enter, avoiding mistaking ordinary clicks as drags. Real buttons within rows continue to be excluded from drag
activation areas; draggable text prohibits browser text selection; no "selected text but no sorting" fake drag states can appear.

`executable` and `selectable` are Host-derived results, not saved fields: the former is determined by Account entitlement (account types), Provider
completeness, Model enabled, and member identity; the latter additionally requires Provider visibility to be visible. Hidden does not equal disabled.

When `builtinModelIds` and `modelIds` share IDs, Built-in-wins is adopted: only one normal-running Built-in model is produced. Normal UI
prohibits creating duplicate members; duplicates in handwritten configs are normalized on the next related save. The system does not create conflict DTOs, suspended identities, or second models with the same name. Hosts still explicitly return `builtin`, used only for Model ID read-only and deletion permissions; Renderers do not guess sources by IDs or catalogs.

Model editing uses local Drafts and manual saves. Popups allow editing product-open Model Config fields: enabled, context, input/output formats,
capability booleans, MFJS, Reasoning levels, Reasoning Mapping, and maximum output Tokens. Reasoning Mapping uses fixed-height
technical text boxes: Personal Maps are values, Inherited Maps are placeholders; clearing means restoring inheritance. Maximum output Tokens use
independent numeric inputs, displayed directly and not placed inside "advanced" collapse; Max Output Maps are not yet open for second editing entries; saving other fields must preserve them as-is.
Enable toggles and Model IDs share the first row; they do not independently occupy a status card. The main field order is fixed as
`Model ID/Enabled -> context -> max output Tokens -> input types -> output types -> model capabilities`; complex JSON and MFJS
are placed after these common fields.
Context, maximum output Tokens, and two complex JSON slots only take Personal overrides as input values; the current inherited/effective values are displayed as the same input box's
placeholder, with no separate read-only previews, and inherited values cannot be pre-filled into user inputs. Null means inheritance; explicitly filled Map expressions represent
Personal leaf overrides. JSON/Map editing areas only retain the text box's own borders, fixed heights, and internal scrolling; no second-layer bordered containers are wrapped around them; MFJS switches use
"Other Settings" group titles before them, avoiding visual adhesion between complex JSON and subsequent boolean settings. Maximum output number `N` directly expresses
`optionSpecs.maxOutputTokens.max=N`, with no Option Defaults saved. The popup bottom always provides "restore all defaults"; disabled when no Personal Overlays exist; a single clear of all
Personal Model Config overrides for that model except identity/members; saves only
write sparse Personal Rules truly changed relative to Effective Built-in. Cancel, X, and Esc produce no Mutations. PDF/Audio fields are not displayed in the UI, but all other edits must preserve existing values. During popup open time, popup content and overlays must be excluded from the model whole-row drag activation area;
Portal's React event bubbling cannot penetrate the popup-start background model sorting.
Desktop popups maintain centered moderate maximum heights; long forms only scroll in the content area; they do not form near-full-screen "top-to-bottom" layouts sticking to window top and bottom edges;
narrow screens still safely shrink according to available viewport heights.

Input/output formats, capability booleans, and MFJS use the same Boolean Model Option. Checked only expresses Effective values; sparse
Personal leaf existence is expressed by higher-saturation outer frames and Checkbox borders; no "default/modified" text is displayed, nor sources inferred by whether values equal
Built-in. Locked Text only expresses non-editable.

When adding Personal Models, the Host's Model Config Resolution is the inherited baseline for that `providerId/modelId/api.type`. Renderers
display numbers and JSON as placeholders; format and capability booleans are cached as form display states; display caches do not belong to Personal Config;
late Resolutions cannot overwrite user-touched fields. Saves still generate sparse Personal Overlays based on inherited baselines; prohibiting the
reverse-materialization of ZCode Built-in Model Config Rules' default facts.

Provider/Model saves and model connection feedback use the application's existing window-level Toasts, fixed to the viewport bottom; different objects stack upward; the same object's saving, success, and failure replace by key. Save or connection failures stay longer than success, providing necessary retry or close entries. Model-level messages must include Model IDs; Provider identities are simultaneously included when necessary. The static position of Toasts can only be determined by `top`/`bottom` insets; Y-axis
transforms are only used for message entry animations; bottom containers must not be panned out of viewports.

Complete UI, state ownership, and acceptance cases are documented in
[`model-membership-and-enablement.md`](./model-membership-and-enablement.md).

Provider settings' left-right split containers use stable heights, not stretched by Provider counts, Model counts, or right-form lengths. Outer cards clip overflows; left Provider navigation and right Provider details each have independent vertical scroll areas; scrolling long model lists cannot drag Provider navigation, and vice versa. Both scroll areas must have `min-height: 0`, ensuring Grid/Flex sub-items truly shrink and produce internal scrolling, rather than continuing to stretch the page. Model settings pages use wider content columns than ordinary Settings forms, retaining enough horizontal space for fixed Provider navigation and complete detail forms; both left and right scroll areas must not produce horizontal scrollbars. Narrow screens can still collapse navigation text and wrap or truncate detail fields; they must not rely on horizontal dragging to access fields.

Personal Providers created from Templates and fully custom Personal Providers use the same detail information hierarchy. Inherited Base URLs and API Schemas from Templates must be visible but use read-only controls or equivalent frozen displays; users can still edit API Keys, model configs, and allowed Personal fields. Provider IDs and Built-in Model IDs remain read-only. The entire connection fact area cannot be hidden because endpoints are read-only; nor can a separate Template-specific detail DTO be built.

Personal Model Config Rules do not determine whether fields are editable; they are merely sparse persisted results formed after users explicitly modify. Whether fields are editable is determined by field ownership and product interactions; once editing is allowed, Built-in/Personal Models both save overrides through the same Personal Rules. Whether model members can be renamed or deleted is independently determined by member ownership; Builtin Model IDs are read-only and cannot be deleted.

Account Individual / Team Coding Plans are product exceptions to the above universal display rules: the settings page completely hides Endpoints and API Schemas, only displaying plan status and effective model configs. Hiding does not mean Config lacks fields; Endpoints/API Schemas are still retained in Effective Provider Config and are normally consumed by Registries, ModelFactory, and Runtime. Renderers do not trim or rebuild Account Provider Config for this; they cannot let plans, quotas, credentials, or request errors determine whether model config areas exist.

## Provider and Model Reordering

Both Providers and Models use explicit Personal order fields; they do not rely on Map insertion order. Family Providers are fixed at the front and do not participate in
normal ordering; two fixed creation operations immediately follow Families; all `standard-personal` Providers are located after operations and can be uniformly dragged. Provider
order is determined by valid members of `providerOrder` plus unsorted Personal tail segments.

```text
Personal:       [A, B, C, X, Y]
providerOrder:  [C, X, A, Y, B]

User drags X in front of Y

Save complete providerOrder, deduplicate, delete stale, fill gaps
```

All Effective Built-in/Personal Model members can be dragged; Builtin members are simply not deletable. Dragging saves complete
`modelOrder`, but does not modify `builtinModelIds` / `modelIds` member ownership, nor does it modify ModelConfigRules priorities.
Model whole-rows are drag activation areas; inline Switches, tests, edits, and deletes must be excluded; draggable text prohibits browser text selection. Pointers use movement
thresholds; touch screens retain vertical scrolling; keyboards provide equivalent ordering capabilities.

Dragging uses optimistic display: operations are saved immediately after completing; original ordering is restored on save failure, with errors displayed in the corresponding lists.

## Connectivity Testing

Connectivity testing is a Provider Settings capability provided by the Host to the Renderer. Auto-save means testing does not need to maintain "temporary Registries" or an un-publishable execution snapshot:

```text
Click model "Test"
        |
        v
Submit currently unsubmitted Provider and target Model Drafts
        |
        v
Wait for Personal Config writes and Registry refresh
        |
        v
Registry creates formal Model by providerId/modelId
        |
        v
Model.streamText() sends minimal real requests
        |
        v
Formal Adapter / Request Auth / Provider API
```

The test button can use the model item's `executable` to provide normal UI states, but Hosts do not copy Registry admission algorithms. Disabled, config
incomplete, or single-collection duplicate models cannot be tested; cross-collection name conflicts test normally executable Built-in X.

Renderers do not prepare security verification Headers; they do not assemble Endpoints, Reasoning parameters, or protocol request bodies. Registries create Models using saved formal ProviderConfig, ModelConfig, and Model Options; request attempts obtain dynamic auth materials like API Keys, JWTs, Runtime Keys, one-time security verification Headers, etc., through formal Request Auth Services.

Account Provider settings, entitlements, and Usage entries can also only read Registry's static
`access: { type: "zhipu-account", family, mode }` from Settings Views. Renderers do not parse this field with dynamic Account Access Schemas;
they do not disguise current plans or Team scopes as Effective Provider Config:

```text
Provider Settings View.access { family, mode }
                    |
                    v
Host Account Request Auth Service
                    |
                    v
Current connection { planKind, productId?, organizationId?, projectId? }
                    |
                    v
Entitlement / Usage / Reset / Model Request
```

Dynamic account facts are resolved by target Environment account services at call time. Team usage lists can combine subscribed product responses with static
`team-coding-plan` modes into query scopes, but must not write these scopes back to Personal Config, Account Overlays, or Registries.

Tests use the same streaming Adapter paths as Agents, fixedly sending two messages: system `You are ZCode connectivity probe.`, user `hi`, and consuming the complete stream. Text, roles, and order are whitelist-related contracts; no history, tools, extra system messages, or internationalization (Todo 91) are added; they do not affect other auxiliary requests. Tests independently use 1 Token output budgets; Reasoning explicitly uses the first item of the ordered levels; they do not reuse the 5,000 Token budgets for auxiliary content generation (Todo144). Normal finish (including length) means success; no body content is required; stream anomalies or missing finishes still fail. The test path does not depend on retired Option Defaults, nor assumes Models are implicitly bound with implicit default Options. Timeouts, auth, budget parameter rejections, model non-existence, rate limiting, server errors, and response parsing errors are normalized by formal Model/Adapter error boundaries, then projected as settings page results; no automatic budget increases or model switches are added.

Test success means the saved formal Model can complete a single real request, not merely that some independent HTTP Probe received a success status code. Start Plans, Coding Plans, and ordinary API Providers use the same entry point; their differences end within Providers, Request Auth, and Adapters.

A single test returns only one success/failure combined result; no single-element `results[]`, Endpoint aggregation, or Host-side API type inference is retained.
Final admission is completed by the target Environment's current Registry's ModelFactory; tests do not modify any model selections or Active Models.

## Implementation Boundaries

Renderers, Hosts, local and remote Environments use the same Settings Service contracts. The settings page does not establish temporary Registries,
Connectivity Probe Adapters, or second sets of Overlay/completeness algorithms.

## Provider Form Saves and Feedback

Provider detail main forms use the same auto-save semantics: after text input changes, users stop inputting for a short time before submitting the latest
complete Provider Draft; losing focus, Enter, switching Providers, or unloading immediately flushes. The same Provider's consecutive inputs share one
debounce; no separate saves are manufactured by fields. Selectors, Switches, and other discrete operations continue to save instantly.

```text
Consecutive inputs --reset timer--> pause threshold --save latest complete Draft
     |
     +-- blur / Enter / switch --> cancel timer --> immediate save
```

Model Metadata Dialogs remain explicit transactions: only clicking "save" submits; "cancel" must be able to abandon entire drafts; therefore, they do not participate in
Provider main forms' idle auto-saves.

After add and edit submissions, no duplicate submissions, Escape, or overlay closures are accepted before saves return, avoiding old requests closing newly opened drafts. Saves close popups on success; failures retain inputs, restore editing/cancel capabilities, and retry in the original drafts; no separate saves from external notifications are initiated.

Saves and model connectivity feedback belong to the current Provider detail bars, not global viewport Toasts. Feedback containers are fixed to the right-side detail bar bottom; they do not scroll with Provider or Model long lists; different objects stack upward; the same object's saving / success / failure replaces in-place.
Success uses success-color banners with checkmarks; failures stay longer and can be retried or closed.
