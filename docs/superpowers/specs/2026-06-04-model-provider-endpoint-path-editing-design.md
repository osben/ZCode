# Model Provider Endpoint Path Editing Design

Custom model providers store one shared `endpoints.baseURL` plus per-format `endpoints.paths`. The provider add/edit UI exposes those path values, so users can correct providers whose operation paths differ from the defaults:

- Anthropic Messages: `/anthropic/v1/messages`
- OpenAI Chat Completions: `/v1/chat/completions`
- OpenAI Responses: `/responses`

Scope: provider-level only. The model editor chooses which API formats a model supports; models never own endpoint paths. Catalog provider endpoint editing, per-model path overrides, and runtime protocol changes are out of scope.

Resolution: API format display metadata comes from one small UI helper that resolves (1) the API format and kind, (2) the configured `endpoints.paths[kind]`, or (3) `getDefaultModelProviderEndpointPathForKind(kind)` when no custom path exists — so no component duplicates path strings.

UI (dense form style per `DESIGN.md`):

- Add-provider custom mode: below the API format multi-select, one path input per selected format (`Input`, `font-mono`, compact). Removing a format drops its path from the draft; re-adding restores the default.
- Edit provider detail: path inputs for every format the provider supports; read-only providers show read-only paths. Changing one path updates `endpoints.paths` without deleting sibling paths.
- Long labels (`Chat Completions (...)`), select options, tags, and model-metadata format pickers show the path resolved from current provider config or draft state, never a hardcoded path. Short tags (`Chat`, `Anthropic`, `Responses`) may stay short; their tooltip/title uses the resolved long label.

Data flow:

- `AddProviderDraft` gains `customEndpointPaths`: selected formats initialize with defaults; selection changes keep retained paths, add defaults for new formats, drop unselected ones; `customProviderToConfig` passes optional paths into endpoint construction.
- `ProviderDraftValues` gains `endpointPathsValue`, initialized by `InlineEditableProviderCard` from normalized provider paths; input changes update `draftRef`, blur commits via `resolvePendingProviderDraftSave`; `buildCanonicalEndpointsForDraft` prefers draft paths, then existing provider paths, then defaults.

Normalization:

- Empty paths for selected/supported formats normalize to protocol defaults (never save empty strings — this preserves the fix for invisible empty `endpoints.paths`).
- Paths are trimmed; a missing leading slash is allowed in input but normalized before saving.
- Base URL normalization keeps removing duplicated suffixes when the path starts with `/anthropic/` or `/v1/`; the existing duplicate-prefix protection stays.

Error handling: no blocking validation. Unusual non-empty paths are saved after trim/slash normalization, supporting proxy-specific paths.

Tests: default paths saved for new custom providers; custom paths saved; editing one path preserves siblings; Base URL edits preserve paths; full operation URL uses the edited path; format multi-select/options render path text from supplied paths; the model metadata dialog keeps provider-supported formats with configured paths.
