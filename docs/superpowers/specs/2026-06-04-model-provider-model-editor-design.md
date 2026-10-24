# Model Provider Model Editor Design

The provider settings page's "add model" and "edit model" share one dialog editor. Fields are grouped in task order — identity, token limits, input/output, capabilities, options — with hierarchy from spacing and borders, no extra section titles or cards. Adding no longer inserts a blank row first: the model joins the list only after the user confirms and validation passes. Modality source and runtime projection boundaries: `docs/superpowers/specs/2026-08-21-model-provider-modality-settings-design.md`.

Current state:

- `ProviderModelsSection` opens `ProviderModelMetadataDialog` on add and calls `onAddModel` after validation; `ModelRowInput` holds row drafts and edits model ID, context window, and max output tokens through the same dialog.
- `ProviderModelDraftValues.maxOutputTokensValue`, positive-integer validation, and persistence to `ModelProviderModelConfig.maxOutputTokens` already exist; the modality input entry is the addition here.
- Supported API formats live in `ModelProviderModelConfig.kinds`; `mapModelProviderApiFormatToKind` maps `ModelProviderApiFormat` → `ModelProviderKind`. The dialog shows no API format multi-select: add mode derives formats from the settings page's current API format; edit mode uses the model's existing `kinds`.

UX:

- "Add model" opens the dialog titled "添加模型" ("add model"); a row's edit button opens the same dialog titled "编辑模型配置" ("edit model config"). Add mode focuses the model ID; edit mode focuses and selects the context window for quick replacement.
- Groups, in order: (1) Basics — model ID (required, trimmed; the only empty field on add) then enable-model toggle, as separate vertical fields; (2) Token limits — context window and max output tokens, numeric text inputs without steppers, positive integers, add defaults `1000000` and `128000`; (3) Input & output — input types flat with wrapping, Text checked and non-deselectable, other visible types optional; output shows fixed Text only; (4) Capabilities — Tool Call, Structured Output, Native Web Search, Mid-conversation System; (5) Options — Reasoning Levels, Reasoning Mapping, MFJS Tool Schema, shown directly.
- Audio/PDF stay hidden in settings; legacy configs and remote authoritative facts remain compatible, and editing visible types never silently drops hidden values.
- All groups always render, no collapse. Compact desktop density; narrow screens wrap naturally without semantic change.
- Footer is Cancel/Save for both modes: cancel discards the dialog draft; save validates, commits the model draft, and closes — provider persistence stays with the existing outer save chain. Validation failure keeps the dialog open with errors.
- Add mode: max output starts editable at `128000`. After the model ID settles for 300ms, the existing model provider catalog service is queried by the full trimmed, case-insensitive ID; while pending, defaults/draft are kept, Save is disabled, and a compact loading state shows. Backfill happens only when the catalog explicitly declares `maxOutputTokens` and the user has not edited the field; no match, undeclared, failure, or late results keep the current value (never clearing the `128000` default). The runtime 32K fallback must never be shown or written into the form.
- Catalog backfill is add-mode only. Edit mode shows saved values, allows manual edits, and issues no catalog query.
- If the ID changes while the max-output value came from a previous auto-backfill and is unedited, reset to `128000` before re-querying; user-typed values are never cleared. Late results from an old query (further typing or dialog closed) never overwrite the draft.
- Catalog queries never modify the context window: add drafts default to 1M, `[1m]` models keep the forced-1M rule, and there is no context-window backfill or post-save re-read.

```text
open add dialog ──> empty ID + Context=1M + Max output=128K + Input/Output=Text
model ID changes ──> pending ── 300ms stable ──> query catalog
                                               ├─ explicit value & unedited ──> backfill
                                               └─ miss/failure/edited ──> keep current value
input changes again or dialog closes ─────────────────────> discard old query result

click Save ──> validation fails ──> keep dialog open
          └─> validation passes ──> commit model draft + close
                                └─> existing outer provider save chain
```

Data rules:

- API formats save as `ModelProviderModelConfig.kinds` in fixed order: `anthropic`, `openai-compatible`, `openai`.
- `defaultKind` prefers the kind matching the settings page's current API format; otherwise the first selected kind.
- At least one API format is required, else `invalid` with field `kinds`.
- `resolveProviderModelDraftCommit` does not parse dialog reasoning JSON and preserves existing `reasoning` via `...currentModel`; it validates max output as a positive integer and saves `maxOutputTokens` (missing values on legacy models draft as `128000` and persist on save).
- Editable local models persist output modalities as fixed `["text"]`; read-only authoritative models bypass this commit path.
- Validated adds call the parent `saveModels` with the full model (no intermediate empty row); validated edits reuse `onModelCommit`.

Components:

- `ProviderModelDraftValues` keeps `kindsValue` for commit rules and gains input-modality and touched draft state; no `reasoningJsonValue`.
- `resolveProviderModelDraftCommit` validates/commits `kinds`, `defaultKind`, input modalities, fixed Text output, and explicit provenance.
- `ProviderModelMetadataDialog` keeps both titles and organizes existing fields per the groups above.
- `ProviderModelsSection` owns the add dialog's open state, new draft, and catalog query timing; `ModelRowInput` owns row edit dialogs and passes the current API format kind for `defaultKind`.

Validation errors: empty model ID (add shows the error; edit no longer deletes via empty ID — deletion stays with the trash button), empty API formats, invalid context window (existing error), non-positive-integer max output, and missing Text input modality (defensive check; the UI makes Text non-deselectable). No dialog-side reasoning-strength JSON validation.

Testing: unit tests cover all flat fields and the 1M/128K/Text defaults; interaction tests cover empty ID, 300ms debounce, catalog hit/miss/undeclared/failure, late-result isolation, pending state, user override of backfill, value retention on ID change and on miss/failure, edit mode without catalog queries, no advanced collapse, non-deselectable Text input, fixed Text output, current-API-format default selection, commit contents (ID, `kinds`, `defaultKind`, context, max output, input modalities, Text output, preserved `reasoning`), and empty-kinds rejection. Desktop E2E reuses the I08 real-settings add-provider flow covering flat fields, defaults, pending/loading, real backfill, user override, modality selection, edit-mode echo and change, persistence, and the final provider request's `max_tokens`. Miss/undeclared/failure/late isolation stay in service-mocked unit tests; E2E gains no catalog injection, caching, or retry.
