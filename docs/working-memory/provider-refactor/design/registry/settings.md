# Provider Settings Page

> Current effective design. Last updated: 2026-09-08.

The Provider settings page edits Personal Config through the Host's Provider Settings Service, with auto-save: editing keeps local drafts; when an edit action completes, the edited Personal Provider Draft is submitted; the Host persists it and refreshes Registry; only then does the page confirm save success.

```text
Renderer Draft
  | Edit action completes
  v
Provider Settings Service -- atomic update --> Provider Config Service
  | invalidation + refresh
  v
Provider Registry -- latest Settings View --> Renderer displays save success
```

The page never reads physical config files, nor runs Overlay, completeness validation, or Registry member judgment in the Renderer. Remote settings pages call the same Service on the target Environment; Desktop never treats local machine Provider configs as remote facts.

## Auto-Save

### Connection Switching After Account Plan Expiration (Todo93)

2026-09-08 decision: when the same account's same complete connection changes from available/pending to explicitly unavailable, prompt once with a "switch to specific plan" button; the connection changes only after the user clicks, re-validates, and the conditional write succeeds. Persistent unavailability does not re-prompt; `unknown` is not treated as failure; new events may occur after recovery. First startup / identity switching only establishes baselines; no state comparisons between different plans; manually selecting an unsubscribed personal plan does not auto-pop back. Retain the first initialization without selection and old-connection migration protection.

Observation records live only in memory at the root layer; no persisted fields or migrations. `AccountProviderState.connectionKey` summarizes the current round's account and complete connection identity, is used only for observation isolation, and never enters Config Overlays. Manual selection still uses the original save entry; Start connection entry filtering, Provider visibility, and model execution gates are unchanged. Detailed states, old-advice expiration, and test boundaries are in [Todo93](../../steps/todo-93-account-plan-loss-manual-switch.md). This replaces Todo88 R06's auto-switching decision; the implementation only conditionally writes after click and re-verification.

### Model Popup Final Decision (Todo90 / Todo92)

Implemented 2026-09-08 and passed Pro joint acceptance; evidence in Todo90/92 takes precedence over the historical "restore default" and focus-border descriptions below on conflict.

- Keep the toggle on the save/cancel row, renamed "Smart Config" — "Match recommended configurations automatically based on model ID, with individual overrides allowed."
- Enabled: match and inherit recommended configurations by model ID with personal overrides allowed. Disabled: fill the complete effective draft, all config fields required, no ID matching or recommendation borrowing, no personal-override styles shown.
- Re-enabling clears model config overrides and restores recommendations by current ID; later new edits are retained. Switches only modify drafts; saves take effect, cancels are abandoned; IDs, enabling, and membership ownership are unchanged. Existing mode fields retained; no new migrations.
- Borders express only no-override/has-override with neutral light-emphasis thin borders; saving and re-opening preserves source markers. Numerical, modal, capability, and MFJS items are independent; when levels are renamed, numbered, or reordered, all level boxes highlight together; Mapping highlights separately. Outer containers do not highlight.
- Hover and focus share slight background changes; borders are not modified and no extra focus outlines added; disabled-option backgrounds and keyboard focus must stay recognizable. Only the model editor is adjusted — do not globally modify shared base components.
- MFJS uses the same button styles as capability options, no icons or pre-checkboxes; the "render checkbox without icons" visual branch is fully deleted; accessibility semantics preserved.
- Keep the reasoning outer container and level/Mapping editing areas; remove the duplicate "Reasoning Settings" title; advanced settings keep titles and containers. No "Custom" text, no group-level or global restore-default buttons.

Implementation and acceptance: [Todo90](../../steps/todo-90-model-add-edit-shared-recommended-draft.md), [Todo92](../../steps/todo-92-model-smart-config-and-override-feedback.md).

Ownership: add/edit share editing draft hooks; personal-field source marking belongs to editing intent, not inferred from form validation results. The Host returns recommended baselines; the UI only projects un-overridden controls to baselines and does no rule matching itself. Fixed modes stop recommendation requests; Host writes check completeness; runtime parsing uses only the complete personal config (enabled still follows independent enable/disable rules); Built-in never fills gaps.

### Write and Edit Transaction Supplement (Todo 89)

Built-in/account Providers may have no Personal record yet; when modifying members or ordering, the Config Service creates sparse overlays as needed, and editing model configs does not require or create Provider records. Member sources come uniformly from Facade snapshots — never executable Registries or static lists. New models retain existing member relative ordering and append new members. Deleted Personal-only Providers must not be recreated by late saves.

Model enable/disable uses independent leaf updates, reading the latest personal config in an atomic transaction and changing only `enabled` while preserving config modes and other fields. Provider forms submit only edited config items; untouched fields like headers are preserved; no edits means no save.

Model popups fix the model, draft, and revision for this edit on open. External View updates do not overwrite the draft; saves still check versions; conflicts or failures retain inputs; cancel and re-open load the latest values. Config-incomplete models still offer edit-fix and enable/disable entries; personal members can be deleted; inherited members cannot be deleted or renamed. Editable does not mean executable; Registry completeness validation is unchanged.

Model members and configs display Host-returned Views directly; no separate rollback-on-add/delete-failure table; only drag-and-drop preserves optimistic ordering. Add popups wait for the actual save to complete before closing; failures retry in the original draft; explicit popups offer no out-of-draft notification retry. Account and ordinary vendor details share the same model write callbacks. When Account snapshots confirm a Start Plan, quota/plan cards re-querying temporary empty states must not unmount model editing areas; nor may this reveal unclaimed Start Plan models, modify entitlement caches, switch plans, or bypass execution gates.

Text inputs only modify component-internal drafts. Auto-save triggers after 1200ms without new input; blur, Enter, or switching Providers submits the single Personal Provider Draft immediately. Select boxes, switches, and drags submit immediately after the operation.

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

Text idle-triggers schedule a single save for the current Provider Draft; each new input cancels the previous timer, so consecutive inputs save only the final value. Blur, Enter, and Provider switching cancel the timer and flush immediately. Auto-save never creates a second accepted queue; late responses are isolated by Provider Draft revisions.

New and edited model IDs schedule `resolveModelConfig()` with the same 1200ms idle-trigger. It resolves only `inheritedConfig/effectiveConfig/issues` from the current Provider and the unsubmitted sparse Model Draft; it never persists or changes Registry revisions. Blur, Enter, or explicit saves flush it immediately; save buttons wait for the current Resolution before submitting in the same operation.

The recommended-config match prompt reads "Recommended settings matched for this model", no longer "Loaded model default config." This changes copy only — not parsing, prompt timing, or save behavior.

A single save submits only the Personal Draft belonging to that operation, never the page's current collection as a Repository snapshot: Provider fields write only Provider Config; Model fields write only that model's `type="provider-model"` specific Rule. New Personal Models atomically write `modelIds` membership, complete `modelOrder`, and an initial `enabled=true` specific Rule; deletes, renames, and reordering each use their own domain atomic operation. No ordinary save traverses or replaces other Model Rules on the same Provider, nor copies Effective Config back into Personal. A modified config item submits the complete replacement value; unmodified inherited values are never materialized by form loading or unrelated field saves.

Provider Settings Facade generates Settings Views from Effective Built-in and Personal at the same revision; Personal Repository atomically updates config. Save methods wait for the corresponding Registry refresh, so a successful response means simultaneously: (1) Personal Config is persisted; (2) this process's Registry has observed the version; (3) the returned Settings View matches the facts after this submission.

Whether the page displays, locks, or hides a field is a UI product decision, not a Config Schema permission boundary. The formal UI may not expose Account Access, Built-in Model IDs, PDF/Audio, and similar fields, but Schema adds no "users must not write" source validation for them; manual Personal Config edits use the same Overlay, structure, and completeness rules, and business-invalid but structurally complete account connections fail in Request Auth or at the server.

Model format Drafts maintain `properties.input_format` / `properties.output_format` directly. The input page shows locked Text and editable Image, Video, PDF; Audio is hidden but preserved as-is. The output page shows locked Text only. Facades never reverse-generate Personal Rules from Built-in baselines: they compute the authoritative Effective Config from Effective Built-in plus existing Personal Overlays; Renderers submit only user-modified materialized leaves; untouched hidden fields create no new overlays. See [`../model/input-output-format.md`](../model/input-output-format.md).

Normal editing Views return read-only `templateConfig?`, `effectiveBuiltinConfig?`, sparse `personalConfig`, and authoritative `effectiveConfig`; Personal Providers created from Templates fabricate no `effectiveBuiltinConfig`. Renderers copy only `personalConfig` as Personal Drafts. Inherited values may display as control values, but only a user touch materializes that item into a Draft. Ordinary fields can restore defaults (deleting the Personal field); the `enabled` toggle in the model list offers no "restore default" and every toggle saves an explicit Personal boolean. Renderers do no Effective → Personal diffs, membership combination, or conflict calculation.

The page keeps incrementing revisions per Provider Draft. Only a matching response revision may display the current input as saved; late responses from earlier requests can neither overwrite new inputs nor show false success. Provider/Model/member writes to one Provider execute in order; rename waits for old-ID operations and switches subsequent identities; delete is terminal; connection tests wait for related saves. External View updates refresh only unedited fields; dirty fields keep local input; save failures retain inputs and retry entries.

## Save Feedback

The Renderer keeps using Draft revisions internally to distinguish local edits, in-flight saves, and late responses, but shows no `dirty` copy and keeps no second save state in the Provider content area. A save operation projects as one window-bottom notification, replaced in place by a stable key:

```text
saving (does not auto-dismiss)
  +-- success -> replace by same key, stay briefly then fade
  `-- failure -> replace by same key, stay longer with retry/close
```

The model popup's save button shows a Spinner during requests and blocks duplicate submissions — an operation control state, not second save feedback. Only a Host-confirmed revision replaces "saving" with success. Late responses never overwrite current operations; failure information is never conveyed by color alone.

## Provider Identity and Names

`providerId` is an execution identity, immutable after creation; `label` is an editable display name; the two are never converted by rename. Personal-only Providers are created with unoccupied default IDs (`new-provider`, `new-provider-2`, `new-provider-3`, …).

Name changes write Personal `label` Overlays. Empty label means restore inheritance; all Effective labels must be unique case-insensitively, so settings and selector entries stay distinguishable. `providerId` stays non-empty, trimmed, globally unique. Internal states and cross-process protocols use structured `ModelSelection`; Prompt CLI's `provider/model` is only a human-readable shorthand at the Entry boundary.

ZCode Built-in and Account Built-in Provider IDs are managed by Built-in Config and cannot be renamed from the settings page; they still expose read-only `label` and brand info, and `providerId` is always the execution identity and display fallback when no label exists.

`visibility` is a Provider Config fact, not a page control. Provider Settings Facade returns only `visibility = "visible"` Providers; hidden Providers never appear and the page offers no toggle. Hiding affects product entries only — not Registry members, completeness validation, or internal execution.

Model Config has no independent `visibility`: model appearance in normal selectors is decided jointly by Provider visibility, Model enabled, and completeness; Settings still shows disabled models for editing or re-enabling.

## Provider Grouping, Adding, and Deleting

The page shows only real Providers; Templates appear only on the right-side Template selection page:

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

Providers save no extra `builtin` flags or top-level `enabled`, and groupings are never inferred from Provider ID whitelists. Templates are not Providers: no runtime `providerId`, executable state, or Settings detail page.

Top actions reuse the Subagents settings page header action hierarchy: refresh first (`outline + icon-md`), then "Add Vendor" (`default + default` primary with Plus icon), both right-aligned with `gap-2`. Clicking add keeps the left Provider navigation and switches the right details to `ProviderTemplatePicker`. The selection page consumes the target Host's `ProviderSettingsView.providerTemplates` directly: fixed-height cards, names truncated to at most two lines, publication order; no separate Catalogs, searches, ID sort tables, or Renderer brand lists. A back button returns; after successful creation the new Provider detail opens. Names longer than two lines truncate with a Tooltip showing the full name.

"Add Model" in Provider details is a secondary creation action of the current Provider (`secondary + default` with Plus icon), staying right of the "Model List" title row; the title row's parent uses `mb-1` with a `4px` gap to the list body and never floats over or covers list borders.

Two immediately-effective creation entries:

```text
Add Vendor
└─ Select Provider Template
   └─ Each creation creates a new Personal Provider instance
      ├─ Record templateId
      ├─ UI parses label seed from Template nameMap by current Locale
      ├─ Host generates unique providerId / label inside the creation atomic update
      └─ Atomic write Personal Config and providerOrder

Create Custom Vendor
└─ Immediately create Personal Providers not referencing Templates
   ├─ Write group=standard-personal, access.type=api-key
   │  └─ API Keys may temporarily be missing; Access discriminator fields must not
   ├─ Do not infer API type, Endpoint, or models
   └─ Enter complete custom details
```

`standard-personal` currently supports only `api-key` Access. Renderers pick settings forms by Effective `access.type` only — never by Provider group UI inferences. Template and blank creation both call `createPersonalProvider({ templateId?, label?, initialConfig? })`; `initialConfig` must not carry `label`, to bypass no deduplication. Template names are creation seeds only; created Personal `labels` are stable and editable and never follow interface language or Template updates. The Welcome's API Key entry calls the same atomic creation and maintains no fixed `zai-api` / `bigmodel-api` runtime Providers or dedicated save interfaces.

Incomplete new Providers may appear in Settings Views and show completeness issues but do not enter Registries. Personal-only structured drafts may save: empty Base URLs, API Keys, or model members never block persistence; null stays absent rather than being written as an illegal pseudo-URL. Hosts still mark such Providers non-executable by formal completeness rules. Non-empty but malformed URLs are rejected as field errors, so input mistakes are not mistaken for "not yet configured."

The page offers no general Provider enable/disable. Account plan eligibility reads `access.entitled`; ordinary Personal Providers exist by their Personal root declaration; neither is inferred from Provider top-level `enabled`.

Template publishing order fixes the "Add Vendor" menu order: Zhipu, Moonshot, MiniMax, DeepSeek, Alibaba Model Studio, Xiaomi, and other domestic services precede OpenAI, Anthropic, xAI, and other overseas services; Renderers keep no separate menu sort table.

Navigation, detail titles, Template selection pages, and Account details read Provider Config's structured `logo` references; UI resource parsers map `logo.key + current actual theme` to packaged materials. Missing keys, unknown keys, or load failures fall back to generic package icons; Renderers never infer brands from Provider IDs. Fully custom Providers do not support Logo upload yet.

Deleting an ordinary Provider deletes its Personal root declaration and Personal `provider-model` Rules; Templates are unaffected and can instantiate again. Account Family Providers offer no delete; account states update through Account Overlays. Generic Personal `match` Rules survive Provider deletions.

## Model List and Editing

The model list handles browsing, enable/disable, testing, editing, Personal model deletion, and full-member ordering. It displays `enabled` states and action buttons directly; Model IDs, Properties, and Option Specs are edited in independent model editing pages; list rows offer no inline name editing.

```text
Model list row
├─ Model ID
├─ Context window summary (left-aligned right after Model ID)
├─ Status: Normal / Disabled / Incomplete config
├─ Properties summary
├─ Test
├─ Delete (Personal only)
├─ Edit icon -> Model edit popup
├─ Enabled toggle (fixed far right, no "restore default")
└─ Model ID and non-interactive blanks start whole-row dragging (Built-in and Personal)
```

Model IDs are part of the `providerId/modelId` identity. Built-in Model IDs are read-only; editing a Personal Model ID performs a single explicit atomic rename, not ordinary display-text editing.

The `enabled` toggle displays Effective Model Config and writes Personal `type="provider-model"` specific Rules with explicit booleans; the list offers no "restore default" for this leaf. Disabled models stay visible on Provider pages but hidden in the normal selector. Enabled ≠ selectable: incomplete Provider config, unentitled Account, or hidden Provider can still make an enabled model unselectable.

Normal Personal Provider navigation rows show no separate drag handles; Provider names, icons, and non-interactive blanks are whole-row drag areas. Clicks still select Providers; ordering starts only after dragging passes the activation distance. Real buttons in rows stay excluded from drag activation; draggable text suppresses browser text selection — no "selected text but no sorting" fake drag states.

`executable` and `selectable` are Host-derived results, not saved fields: executable needs Account entitlement (account types), Provider completeness, Model enabled, and member identity; selectable additionally needs Provider visibility visible. Hidden ≠ disabled.

When `builtinModelIds` and `modelIds` share an ID, Built-in-wins: exactly one normally running Built-in model. Normal UI prohibits duplicate members; handwritten duplicates normalize on the next related save. The system creates no conflict DTOs, suspended identities, or same-named second models. Hosts still return `builtin` explicitly — used only for Model ID read-only and delete permissions; Renderers never guess sources from IDs or catalogs.

Model editing uses local Drafts and manual saves. The popup edits product-open Model Config: enabled, context, input/output formats, capability booleans, MFJS, Reasoning levels, Reasoning Mapping, and maximum output Tokens. Reasoning Mapping uses fixed-height technical text boxes: Personal Maps as values, Inherited Maps as placeholders; clearing restores inheritance. Maximum output Tokens use independent numeric inputs shown directly, not inside an "advanced" collapse; Max Output Maps have no second editing entry yet and must be preserved by other saves. The enable toggle and Model ID share the first row, not a separate status card. Field order is fixed: `Model ID/Enabled -> context -> max output Tokens -> input types -> output types -> model capabilities`, with complex JSON and MFJS after these. Context, maximum output Tokens, and the two complex JSON slots take only Personal overrides as input; inherited/effective values show as the same input's placeholder — no separate read-only previews, no pre-filled inherited values. Null means inheritance; an explicitly filled Map is a Personal leaf override. JSON/Map areas keep only their own borders, fixed heights, and internal scrolling — no second-layer bordered containers; MFJS switches use "Other Settings" group titles before them so complex JSON and boolean settings do not visually adhere. Maximum output number `N` directly expresses `optionSpecs.maxOutputTokens.max=N`; no Option Defaults saved. The popup bottom always provides "restore all defaults", disabled when no Personal Overlays exist; one click clears all Personal Model Config overrides for that model except identity/membership; saves write only sparse Personal Rules actually changed versus Effective Built-in. Cancel, X, and Esc produce no Mutations. PDF/Audio fields are not displayed but must be preserved by all other edits. While the popup is open, popup content and overlays are excluded from whole-row drag activation; Portal React event bubbling must not reach background model sorting. Desktop popups keep centered moderate maximum heights; long forms scroll only in the content area — no near-full-screen layouts glued to window edges; narrow screens shrink safely by available viewport height.

Input/output formats, capability booleans, and MFJS share the same Boolean Model Option: checked expresses only the Effective value; a sparse Personal leaf is expressed by higher-saturation outer frames and Checkbox borders; no "default/modified" text, no source inference by comparing values to Built-in. Locked Text just means non-editable.

When adding Personal Models, the Host's Model Config Resolution is the inherited baseline for that `providerId/modelId/api.type`. Renderers show numbers and JSON as placeholders and cache format/capability booleans as form display state; display caches are not Personal Config, and late Resolutions never overwrite user-touched fields. Saves still generate sparse Personal Overlays against inherited baselines — never reverse-materializing Built-in Rule defaults.

Provider/Model saves and model connection feedback use the app's window-level Toasts, fixed to the viewport bottom; different objects stack upward; the same object's saving/success/failure replaces by key. Failures stay longer than success and provide retry or close. Model-level messages include Model IDs, plus Provider identity when needed. Toast position comes only from `top`/`bottom` insets; Y transforms are entry animations only; bottom containers must not pan out of viewports.

Complete UI, state ownership, and acceptance cases: [`model-membership-and-enablement.md`](./model-membership-and-enablement.md).

The left-right split containers use stable heights, not stretched by Provider, Model, or form lengths. Outer cards clip overflow; navigation and details scroll independently — scrolling a long model list never drags Provider navigation or vice versa. Both scroll areas need `min-height: 0` so Grid/Flex children truly shrink into internal scrolling instead of stretching the page. Model settings pages use wider content columns than ordinary Settings forms, keeping room for fixed navigation and complete forms; neither side may produce horizontal scrollbars. Narrow screens collapse navigation text and wrap/truncate detail fields; horizontal dragging is never required to reach fields.

Template-created and fully custom Personal Providers share the same detail hierarchy. Inherited Base URLs and API Schemas stay visible through read-only or equivalent frozen controls; API Keys, model configs, and other allowed Personal fields stay editable. Provider IDs and Built-in Model IDs stay read-only. The connection fact area is never hidden because endpoints are read-only, and no Template-specific detail DTO is built.

Personal Model Config Rules never decide field editability; they are only the sparse persisted result of explicit user modifications. Editability is decided by field ownership and product interaction; once editable, Built-in and Personal Models both save overrides through the same Personal Rules. Rename/delete rights follow member ownership; Built-in Model IDs are read-only and undeletable.

Account Individual / Team Coding Plans are a product exception: the settings page fully hides Endpoints and API Schemas, showing only plan status and effective model configs. Hiding does not remove Config fields — Endpoints/API Schemas remain in Effective Provider Config and are consumed normally by Registries, ModelFactory, and Runtime. Renderers neither trim nor rebuild Account Provider Config for this; plans, quotas, credentials, or request errors never decide whether model config areas exist.

## Provider and Model Reordering

Providers and Models use explicit Personal order fields, never Map insertion order. Family Providers are fixed at the front and outside normal ordering; the two fixed creation entries follow Families; all `standard-personal` Providers come after the entries and drag freely. Provider order is valid `providerOrder` members plus an unsorted Personal tail.

```text
Personal:       [A, B, C, X, Y]
providerOrder:  [C, X, A, Y, B]

User drags X in front of Y
-> Save complete providerOrder: deduplicate, drop stale, fill gaps
```

All Effective Built-in/Personal Model members are draggable; Built-in members are simply undeletable. Dragging saves the complete `modelOrder` without touching `builtinModelIds` / `modelIds` ownership or ModelConfigRules priority. Model whole-rows are drag activation areas; inline switches, tests, edits, and deletes are excluded; draggable text suppresses text selection. Pointers use movement thresholds; touch screens keep vertical scrolling; keyboards get equivalent ordering.

Dragging displays optimistically: saves run immediately after the drop; failure restores the original order with errors in the corresponding lists.

## Connectivity Testing

Connectivity testing is a Host-provided capability. Auto-save means no "temporary Registry" or un-publishable execution snapshot:

```text
Click model "Test"
  -> Submit uncommitted Provider and target Model Drafts
  -> Wait for Personal Config writes and Registry refresh
  -> Registry creates the formal Model by providerId/modelId
  -> Model.streamText() sends a minimal real request
  -> Formal Adapter / Request Auth / Provider API
```

The test button may use the item's `executable` for normal UI states, but Hosts copy no Registry admission algorithm. Disabled, config-incomplete, or single-collection duplicate models cannot be tested; cross-collection name conflicts test the normally executable Built-in X.

Renderers prepare no security-verification Headers and assemble no Endpoints, Reasoning parameters, or protocol bodies. Registries create Models from saved formal ProviderConfig, ModelConfig, and Model Options; request attempts obtain dynamic auth materials (API Keys, JWTs, Runtime Keys, one-time security verification Headers) through formal Request Auth Services.

Account Provider settings, entitlements, and Usage entries likewise read only the static `access: { type: "zhipu-account", family, mode }` from Settings Views. Renderers do not parse this with dynamic Account Access Schemas and never disguise current plans or Team scopes as Effective Provider Config:

```text
Provider Settings View.access { family, mode }
  v
Host Account Request Auth Service
  v
Current connection { planKind, productId?, organizationId?, projectId? }
  v
Entitlement / Usage / Reset / Model Request
```

Dynamic account facts resolve in the target Environment's account services at call time. Team usage lists may combine subscribed-product responses with static `team-coding-plan` modes into query scopes but must never write scopes back to Personal Config, Account Overlays, or Registries.

Tests use the same streaming Adapter paths as Agents, sending exactly two messages — system `You are ZCode connectivity probe.`, user `hi` — and consume the complete stream. Text, roles, and order are whitelist-related contracts: no history, tools, extra system messages, or internationalization (Todo 91); no effect on other auxiliary requests. Tests use an independent 1-Token output budget; Reasoning explicitly uses the first item of the ordered levels; the 5,000-Token auxiliary-content budget (Todo144) is not reused. A normal finish (including length) means success — no body content required; stream anomalies or missing finishes fail. The path depends on no retired Option Defaults and assumes no implicit default Options. Timeouts, auth errors, budget rejections, unknown models, rate limiting, server errors, and parse errors normalize through formal Model/Adapter error boundaries, then project as settings-page results; no automatic budget increases or model switches. Success means the saved formal Model completed one real request, not merely that an HTTP probe returned success. Start Plans, Coding Plans, and ordinary API Providers share one entry; differences end inside Providers, Request Auth, and Adapters.

A test returns one combined success/failure result; no single-element `results[]`, Endpoint aggregation, or Host-side API type inference. Final admission is done by the target Environment's current Registry ModelFactory; tests modify no model selections or Active Models.

## Implementation Boundaries

Renderers, Hosts, and local and remote Environments use the same Settings Service contracts. The settings page builds no temporary Registries, Connectivity Probe Adapters, or second Overlay/completeness algorithms.

## Provider Form Saves and Feedback

Provider detail main forms use the auto-save semantics above: text changes submit the latest complete Provider Draft after a short idle; blur, Enter, Provider switching, or unload flushes immediately. Consecutive inputs to one Provider share one debounce — no per-field saves. Selectors, switches, and other discrete operations save instantly.

Model Metadata Dialogs stay explicit transactions: only "save" submits, "cancel" abandons the whole draft; they never join the main form's idle auto-save.

After add/edit submissions, duplicate submissions, Escape, and overlay closures are rejected until saves return, so an old request cannot close a newly opened draft. Success closes popups; failures retain inputs, restore editing/cancel capabilities, and retry in the original draft; external notifications trigger no separate saves.

Saves and model connectivity feedback belong to the current Provider detail bar, not global viewport Toasts. Feedback containers stay fixed at the right detail bar bottom, not scrolling with Provider or Model lists; different objects stack upward; the same object's saving/success/failure replaces in place. Success uses a success-color banner with a checkmark; failures stay longer with retry and close.
