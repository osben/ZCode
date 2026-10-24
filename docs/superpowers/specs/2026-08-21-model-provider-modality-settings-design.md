# 3.9.0 Model Input/Output Type Settings Design

> Provider Refactor consolidated the formal model facts into `properties.input_format` /
> `properties.output_format`. This document keeps the staging UI decisions; the current data contract is
> [`../../working-memory/provider-refactor/design/model/input-output-format.md`](../../working-memory/provider-refactor/design/model/input-output-format.md).

## Status

- Target version: 3.9.0
- Current stage: implemented, unit/integration verified.
- Related current facts: `ModelProviderModelConfig.modalities` supports `input` / `output`, with public enum
  `text`, `image`, `video`, `audio`, `pdf`; the model edit dialog offers Text/Image/Video input types and a
  fixed Text output type.
- Related docs:
  - `docs/superpowers/specs/2026-06-04-model-provider-model-editor-design.md`
  - `docs/model-provider-client-config-remote-model-facts.md`
  - `docs/superpowers/plans/2026-06-24-model-media-capability-projection.md`
  - `docs/ssh-remote-app-global-state-authority.md`

## Goal

Add a type-selection interaction to the model provider settings "Add model" and "Edit model configuration"
dialogs so users can declare the input and output types a model supports. The underlying `modalities` field of
the provider schema stays; the saved type facts must enter the existing provider registry and take effect
within the capability boundary the current runtime supports.

This is not just a displayed field. When a user explicitly unchecks image or PDF input, the configuration must
be distinguishable from the legacy "capability not declared" state, so the UI never shows text-only while the
runtime still passes media through as unknown capability. PDF uses the existing low-level capability fact and
gets its own toggle in the settings page.

## Non-goals

- No Audio attachment sending, encoding or provider request conversion in this settings feature; Video
  attachment capability comes from the separate video input feature.
- No rendering chain for image, audio or video output.
- No change to model candidate grouping, current model selection, task recovery and mobile replayable
  semantics.
- The remote workspace's `~/.zcode/v2` does not become the authority for model settings.
- Provider registry or capability state is not pushed down to the relay, desktop main or renderer queues.

## Current facts and the design gap

`ModelProviderModelConfig.modalities` is always normalized to an array; when unconfigured it defaults to:

```json
{
  "input": ["text"],
  "output": ["text"]
}
```

But for legacy/custom providers this text-only default does not mean "image explicitly unsupported".
`convertModelProviderConfigToZCodeProviderInput` keeps the media capability unknown state, so a third-party
vision model is not misjudged as text-only by the historical default.

The following two states are therefore indistinguishable in the in-memory config:

```text
old config without modalities ──normalize──> input=[text] ──> capability unknown, media passes through
user explicitly selects only text ─normalize─> input=[text] ──> expected: image/pdf explicitly unsupported
```

Adding only UI and array saving would produce a wrong interaction: after unchecking image the runtime might
still send images. 3.9.0 must also keep the provenance fact of "whether the modality was explicitly configured
by the user".

## Confirmed product semantics

### Grouping interaction

- The model dialog shows, in order: Model ID, Enabled, Context window, Max output tokens, Input types, Output
  types, Model capabilities, then Reasoning, Mapping and MFJS Tool Schema, all in untitled group cards with no
  collapse. Label-to-options spacing for Input types, Output types and Model capabilities is uniformly `mb-1`.
- Model ID and "Enabled" share one row: the ID input fills the remaining width and "Enabled" uses a stable
  `w-24` column with label and Switch centered; on narrow screens the row stays one line and the ID column may
  shrink so the Switch is never pushed out. Model list items use `px-3 py-2`; a lifted dragged item shows no
  bottom divider and uses a transparent bottom border to avoid vertical jitter.
- Footer actions reuse the `SettingsFormActions` hierarchy of editing a Subagent: restore default on the left;
  on the right "Save" first (`default + lg`), "Cancel" after (`ghost + lg`); narrow screens may stack but keep
  the primary/secondary relation. Provider and model save success feedback uses the full-row width,
  `rounded-xl` corners and a neutral floating layer like the Loading state (no green background, border or
  body text; only the success icon keeps `text-success`); failure keeps the destructive style.
- The dialog body scrolls independently with Header and Footer fixed; the scroll container extends to the
  dialog's inner padding and keeps a separate gutter so the scrollbar never touches the card border.
- A new model opens with only the model ID empty: context window `1000000`, max output tokens `128000`, input
  Text, output Text.
- Input types are shown in the fixed order Text, Image, Video, PDF. Text is selected and cannot be deselected;
  Image/Video/PDF toggle independently; Audio is not shown. Output types show only a fixed, non-interactive
  Text. No generic attachment capability hint is shown under input types: whether Image/Video can be
  attachments is decided by the model's explicit capability and the provider adapter's real encoding ability.
- Input options are directly visible icon capsules that may wrap (no dropdown/Popover), reusing the shared
  Button `outline + lg` shell, fixed `h-8`, `rounded-lg`, `px-3`, `size-4` icon + text, no checkbox. Selected:
  `bg-selected border-primary/20` with `background-clip: border-box` so the semi-transparent border overlays
  the selected background; Hover only strengthens to `border-border-hover` (a selected item keeps
  `bg-selected`); unselected: `bg-transparent border-border`. The Personal Overlay does not override these
  borders. Text stays selected via native disabled with a muted lock icon at the end; the others toggle by
  click or Space. Output types use the same "icon + text + lock icon" structure.
- Model capabilities use the same icon + text capsules (Wrench tool calling, Layers structured output, Search
  native web search, MessageSquareText mid-conversation system message) with the same state colors, keeping
  `role="checkbox"` and `aria-checked`. Reasoning level static text and edit input use `text-ui-sm` (not
  monospace); the input stretches by content, keeps the `h-7` shell without jumps, and the add entry is a
  `size-7` Outline icon button.
- The low-level schema, old config reads and remote authoritative facts keep supporting Audio/PDF. Editing an
  old model must not delete untouched hidden values, and toggling visible types keeps an existing Audio value.
- Editing echoes the saved context window, max output tokens and input modalities; an old model without max
  output tokens shows `128000`. Output is fixed to Text; after a successful save of an editable local model
  output is uniformly `["text"]`, while read-only catalog/remote authoritative models keep the server's output
  facts.
- A catalog hit with an explicit `maxOutputTokens` may override `128000` only if the user has not edited the
  field; a miss, undeclared value, failed lookup or late result keeps the current value.
- Image/Video input selection affects the runtime media capability projection; PDF in old config or
  authoritative facts keeps taking part. Video is saved as a provider model fact and joins attachment
  validation through `supportsVideo`; a provider adapter without Video encoding still rejects or degrades at
  runtime. Read-only builtin package/authoritative remote models keep showing server facts with no local edit.

### Explicit provenance

An optional provenance field is added to `ModelProviderModelConfig`, for example:

```ts
modalitiesConfigured?: boolean;
```

Semantics:

- `true`: the user or an authoritative catalog explicitly supplied the modality fact; a missing image/pdf in
  input may be projected as an explicit `false`.
- `undefined`: a historical custom/legacy config without a reliable modality fact; even if the normalized
  array is text-only, the media capability stays unknown.
- catalog-backed/remote authoritative models do not depend on the user flag and still project by the existing
  authoritative-source rules.

The field must be saved via the `zcode` extension to avoid polluting OpenCode public fields; the top-level
`modalities` keeps the real input/output arrays. The name can be adjusted before implementation but must keep
an equivalent provenance distinction and must not reuse a coarse `modified`: a user changing only the context
window must not be misjudged as explicit text-only.

The draft tracks separately whether the user touched the modalities. After opening an old model and changing
only the context window, `modalitiesConfigured=true` must not be written automatically; it is written only when
the user changes modalities, or when a new model's modality selection is actively confirmed.

### Vision capability badge

- When a model's configured `modalities.input` contains any non-`text` type, the UI marks it as a vision
  model. The decision consumes only the declared input types and does not depend on `modalitiesConfigured`,
  output types, the provider adapter or attachment encoding ability.
- The badge text follows the system language: Chinese "视觉", English "Vision"; the accessible name and hover
  title reuse the same i18n copy.
- The badge appears in two shared entries:
  1. In the model selection menu, right after the full model name, in the left content area; the selected
     check stays fixed at the row end.
  2. In the compact model row of model settings, side by side with the context window capacity badge; from
     left to right fixed as "视觉 / Vision", then the context window capacity, with the capacity badge kept at
     the far right.
- Both use the same `rounded-md`, semantic border/surface colors and compact font size; the context window
  keeps a monospace font, the vision text an ordinary UI font.
- Both badges must reuse the same i18n key; in English both show exactly `Vision`, and neither entry may fall
  back to Chinese or use a different English name.
- A model ID is an opaque string. IDs containing one or more `/` such as `openrouter/ox-alpha` and
  `openrouter/nvidia/model` must be displayed, encoded and selected verbatim, never split by `/` or reverse
  matched for the badge projection.
- The badge describes only the input type fact in the model configuration; it adds no attachment entry, does
  not bypass the runtime capability guard, and does not change the model selection value, provider registry,
  request parameters or persistence format.

## State and sync chain

```text
model settings dialog
  local draft
  ├─ inputModalities
  ├─ outputModalities=[text]
  └─ modalitiesTouched
          |
          | save + validate
          v
local modelProviderService (the only authority)
  ~/.zcode/v2/config.json
  ├─ model.modalities.input/output
  └─ model.zcode.modalitiesConfigured
          |
          | provider registry revision
          +-------------------------------+
          |                               |
          v                               v
desktop local runtime               desktop-attached remote runtime
workspace/updateProviderRegistry    local snapshot sent explicitly, remote config not written
          |                               |
          +---------------+---------------+
                          v
protocol model capability projection
  catalog-backed or modalitiesConfigured=true
    ├─ input has image -> supportsImages=true
    ├─ input lacks image -> supportsImages=false
    ├─ input has pdf   -> supportsPdf=true
    ├─ input lacks pdf -> supportsPdf=false
    ├─ input has video -> supportsVideo=true
    └─ input lacks video -> supportsVideo=false

  legacy custom and not explicitly configured
    └─ supportsImages/supportsPdf/supportsVideo not sent, stays unknown
                          |
                          v
hot update modelInputMediaCapabilities of the current session
                          |
                          v
provider-visible request keeps or textualizes media
```

### Client boundary

- Desktop local and desktop-attached remote use the same provider registry revision semantics.
- A remote workspace must keep isolating sync state with `workspaceIdentity?.trim() || workspacePath` and carry
  `remoteSessionId`; `workspacePath` is only for execution and display.
- Mobile `/remote` still attaches to the existing desktop host; no independent runtime is added and the
  modality settings are not written into the replayable snapshot.
- The feature does not modify `clientMode` / `deliveryKind`; regression cases must prove that desktop
  continuous and web remote replayable are unchanged.

## UI Surface Matrix

| Scenario                  | UI entry                                                 | Draft owner                 | Default/echo                                  | Validation                             | commit sink         | Authority            | Boundary                                    |
| ------------------------- | -------------------------------------------------------- | --------------------------- | --------------------------------------------- | -------------------------------------- | ------------------- | -------------------- | ------------------------------------------- |
| Add custom model          | `ProviderModelsSection` -> `ProviderModelMetadataDialog` | add draft state             | context=1M, maxOutput=128K, input/output=Text | ID required, numbers positive integers, Text input locked | `onAddModel` | local provider config | new model saves types explicitly       |
| Edit custom model         | `ModelRowInput` -> `ProviderModelMetadataDialog`         | row draft state             | saved input + fixed Text output               | Text input cannot be deselected        | `onModelCommit`     | local provider config | untouched input modalities must not change unknown semantics |
| Builtin/package model     | provider settings read-only row                          | no editable draft           | catalog/remote facts                          | server schema                          | no commit           | local authoritative sync cache | no local override of authoritative facts |
| Conversation model runtime | no new UI                                               | current session runtime config | provider registry projection               | existing capability guard              | registry hot update | Agent runtime memory | consumes image/pdf/video input              |

The shared model selector, automation, Subagent and Repo Wiki only read provider registry candidates and show
the "视觉 / Vision" badge when a candidate model declares any non-Text input type. Their draft, default and
commit sink are not changed; candidate and default isolation regression is required, but no modality edit entry
is added.

## Data and validation rules

- `ProviderModelDraftValues` gains the input modality array and `modalitiesTouched` (or equivalent local
  state); output is fixed to `["text"]` when an editable model is committed.
- Modalities are saved deduplicated in the public enum's fixed order and unknown enums outside the UI are not
  accepted.
- Input must contain Text; the UI offers no deselect path, and the commit resolver still validates
  defensively.
- Context window and max output tokens must both be positive integers; max output tokens may no longer be left
  empty.
- Cancelling the dialog discards the modality draft and does not modify the provider registry.
- A modality change commits atomically together with the existing ID, API format, context window and max output
  tokens.
- When editing other metadata, existing input modalities and the explicit provenance must be preserved; output
  is normalized to fixed Text per the confirmed boundary.
- Video maps only to `supportsVideo`; Audio/output types must not be wrongly mapped to `supportsImages` /
  `supportsPdf` / `supportsVideo`.
- No new ZCode Protocol field; the current protocol already has optional `supportsImages`, `supportsPdf`,
  `supportsVideo`. For Audio to take effect immediately the protocol schema and runtime capability must be
  extended first; that requirement is outside this spec.

## Invariants to preserve

- The unknown media capability of a legacy custom model does not become explicit false because of an upgrade
  or editing other fields.
- After a user explicitly deselects Image, the currently matching session receives the capability refresh
  without restart or re-selecting the model; a hidden PDF fact is not lost by editing other visible types.
- Provider settings is the only edit entry; the conversation toolbar, automation, Subagent and Repo Wiki gain
  no new modality commit permission.
- Local and remote workspaces use the same local app-global provider authority facts.
- Theme, i18n, keyboard operation and mobile Web small-screen layout stay usable; input type options may wrap,
  and the UI uses `text-ui-*` and semantic color tokens.
- The badge must not occupy the model row's selected-check position at the row end; a long model ID (including
  multiple `/` segments) still takes part in selection as a complete value, and only visible text may truncate
  per the existing layout.
- Setting updates do not change task messages, queues, snapshots, owner/lease or delivery semantics.

## Settled boundaries

- All fields are grouped in untitled cards with no extra hierarchy.
- A new model has defaults for everything except the model ID: 1M context, 128K max output, Text input/output.
- Input Text is locked, Image/Video/PDF are independently selectable; Audio is not shown for now but stays
  data-compatible.
- Output supports only a fixed Text and offers no other option.
- Any non-Text input type triggers the "视觉 / Vision" display; text-only and legacy string models lacking
  structured modality facts do not show it.
- Authoritative catalog models keep the existing read-only/authoritative boundary and open no local override.

The feature graph gained the vision badge projection relation from `capability.model-capabilities` to the shared
model candidates and provider settings; the existing `surface.provider-settings -> capability.provider-registry`
explicit modality provenance relation is unchanged.

## Acceptance evidence

- UI unit tests: add/edit, defaults, echo, multi-select, keyboard, cancel, validation, i18n.
- Display unit tests: text-only vs any non-Text input type decision, model menu left badge / row-end check
  layout, settings row capacity badge side by side, zh/en copy, round-trip of model IDs with multiple `/`.
- draft unit tests: sorted dedupe, atomic commit, preserving untouched fields, old model with untouched
  modalities stays unknown.
- shared/services unit tests: schema, OpenCode config read/write, `zcode` provenance flag round-trip, legacy
  migration.
- protocol/bootstrap unit tests: positive/negative image/pdf/video projection, active session hot update,
  unknown state preserved.
- Desktop E2E: real settings page save, config on disk, provider registry revision, the final provider
  request.
- Remote E2E/integration: the local provider snapshot is sent to the remote runtime, and the remote config file
  does not become the authority.
- Regression: model selection, automation, Subagent, Repo Wiki, desktop continuous and mobile replayable have
  no side effects.
