# Model Provider Catalog And Metadata Design

Two layers of truth already exist: the Host `modelProviderService` owns app-side provider config, API keys, endpoints, catalog import, and persistence; the ZCode Agent server receives the Host-generated provider registry snapshot and owns the runtime model catalog, current model, and reasoning/thought level. The settings page imports providers from `models.dev`, supports custom providers, model id lists, and basic provider fields; the chat box prefers agent-returned `settings.model.available/current`, with the Host registry hot-synced via `workspace/updateProviderRegistry`. This design formalizes the development-stage China LLM catalog, provider drag ordering, and per-model runtime metadata — contracts and boundaries between app/host/agent registry only, with remote-control ownership rules unchanged.

Goals:

- `models_catalog_china_llm_zcode_2026-06-03.json` as a development-stage temporary catalog source, with a clean CDN migration point.
- The catalog data model follows the `zcode.model-providers.v1` JSON schema — `kind`, `endpoints.baseURL + paths`, `model.kinds`, `modalities`, reasoning patch — and is not disguised as `models.dev`.
- Provider ordering supports drag, persists, and applies to both the settings navigation and the chat provider group order.
- Per-model fields converge from `string[] + metadata map` to a model object array — no long-term dual writes.
- Imported model capabilities flow into `ModelProviderConfig`, then project through `convertModelProviderConfigToZCodeProviderInput` into `ZCodeModelProviderInput.models[*]`.
- Desktop, local remote workspaces, and mobile `/remote` shared-host attachment keep their registry sync semantics.

Non-goals: no CDN service, signature verification, incremental updates, or offline caching this stage; drag ordering changes display order only — never `source`, preset identity, or official OAuth identity; no full price/rate-limit/region/billing/multi-endpoint-fallback management; no provider/model metadata in `session/send` (runtime uses only the agent server's applied workspace model catalog); v1 has no arbitrary reasoning patch JSON editor (patches come from catalog or migration, so the UI cannot save well-formed but runtime-unusable parameters).

Current constraints:

- The China catalog follows `zcode.model-providers.v1`; its `endpoints.paths` keys are runtime kinds `anthropic`, `openai`, `openai-compatible` — the AI SDK-internal name `openaiCompatible` must not appear in public JSON.
- `endpoints.baseURL + endpoints.paths[kind]` gives the request address per kind. The app/agent protocol carries a single effective kind/baseURL, so import/projection must choose an effective kind explicitly without dropping other kinds from the unified catalog model.
- `model.kinds` lists the model's supported formats and must exist in the provider's `endpoints.paths`. `modalities` is the input/output capability source; UI booleans like `supportsImages` derive from it.
- `reasoning.levels[level][kind]` is a request-parameter patch — not final providerOptions, with no UI label/rank/enabled. The conversion layer maps the public `openai-compatible` namespace to the AI SDK's `openaiCompatible`.
- Switching `ModelProviderConfig.models` to a model object array requires a one-time automatic migration of old `model-providers.json`, or upgrading users lose providers to schema mismatch.
- `sortModelProvidersForDisplay` reorders by built-in provider buckets, so raw array order is not a user ordering.
- ZCode Protocol already has `ZCodeModelReasoningState` (`enabled`, `levels: { value, label, description? }[]`, `defaultLevel?`, `providerOptionsByLevel?`).

## Catalog source

App-side source abstraction; the China LLM catalog is not disguised as `models.dev` schema:

```ts
type ModelProviderCatalogSourceId = "models-dev" | "china-llm-zcode-dev";

interface ModelProviderCatalogSource {
  id: ModelProviderCatalogSourceId;
  label: string;
  load(): Promise<ModelProviderCatalogFile>;
}
```

`models-dev` still fetches `https://models.dev/api.json` but converts into the unified catalog file; `china-llm-zcode-dev` reads the repo-root `models_catalog_china_llm_zcode_2026-06-03.json` during development. `catalogSourceId` means only "which catalog this import came from" — it is not a product source grouping. Provider `source` stays `builtin`, `models-dev`, `custom`, `workspace`; new product sources require formally extending the shared schema, protocol source schema, and UI grouping.

Unified catalog model, directly matching the public JSON schema so the source adapter drops nothing:

```ts
type ModelProviderKind = "anthropic" | "openai" | "openai-compatible";
type Modality = "text" | "image" | "video" | "audio" | "pdf";

interface ModelProviderCatalogFile {
  schemaVersion: "zcode.model-providers.v1";
  providers: ModelProviderCatalogProvider[];
}

interface ModelProviderCatalogProvider {
  id: string;
  name: string;
  endpoints: {
    baseURL: string;
    paths: Partial<Record<ModelProviderKind, string>>;
  };
  defaultKind?: ModelProviderKind;
  models: ModelProviderCatalogModel[];
}

interface ModelProviderCatalogModel {
  id: string;
  name?: string;
  kinds: ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  modelIdByKind?: Partial<Record<ModelProviderKind, string>>;
  modalities: {
    input: Modality[];
    output: Modality[];
  };
  contextWindow: number;
  maxOutputTokens?: number;
  reasoning?: ModelProviderReasoningSpec;
}

interface ModelProviderReasoningSpec {
  defaultLevel?: string;
  levels: Record<string, Partial<Record<ModelProviderKind, ProviderOptionsPatch>>>;
}

interface ProviderOptionsPatch {
  set?: Array<{ path: string[]; value: unknown }>;
  unset?: Array<{ path: string[] }>;
}
```

`models.dev` adapter conversion: provider `api` becomes one effective-kind endpoint; `attachment` / `modalities.input` become `modalities` (no persisted `supportsImages`); `models.dev`-specific booleans like `tool_call`/`structured_output` are import-time optional runtime metadata only — never stuffed into unrelated fields when the unified schema has no carrier; `supportsReasoning: true` without level/patch detail generates no fake levels (UI shows "may support reasoning" only, no selectable thought levels declared to the agent).

Local file and CDN migration point: the `china-llm-zcode-dev` loader centralizes the future CDN URL switch — development reads the local file; the CDN stage downloads JSON via `ApiClient` with a local dev fallback; the switch changes neither the unified model, the persisted provider schema, nor the agent registry projection.

## Provider config

No `modelMetadata` map and no long-term `modelDisplayNames` / `modelSupportedFormats` dual writes — model id and metadata live in one object:

```ts
interface ModelProviderStoreFile {
  schemaVersion: "zcode.model-providers.v2";
  providers: ModelProviderConfig[];
}

interface ModelProviderConfig {
  id: string;
  name: string;
  enabled?: boolean;
  systemDisabledReason?: ModelProviderSystemDisabledReason;
  source?: ModelProviderSource;
  catalogSourceId?: ModelProviderCatalogSourceId;
  catalogProviderId?: string;
  apiKey: string;
  apiKeyRequired?: boolean;
  apiKeyUrl?: string;
  headers?: Record<string, string>;
  logoUrl?: string;
  endpoints: {
    baseURL: string;
    paths: Partial<Record<ModelProviderKind, string>>;
  };
  defaultKind?: ModelProviderKind;
  models: ModelProviderModelConfig[];
  providerMappings?: ProviderModelMappings;
  createdAt: number;
  updatedAt: number;
}

interface ModelProviderModelConfig extends ModelProviderCatalogModel {
  disabledReason?: string;
}
```

Rationale: catalog facts are model objects; keeping `models: string[]` plus metadata maps would force rename/delete/reorder/import/projection to maintain several indexes, breeding orphan metadata.

Migration (one-time conversion, not long-term compat): read v2 directly when `schemaVersion` matches; a legacy bare array parses via the old `modelProviderListSchema` then converts to v2; parse failure never overwrites the original file (warn + safe fallback to an empty list); write-back is atomic with a backup like `model-providers.v1.backup.json` (backup failure warns but never blocks reads). Conversion rules:

- `models: string[]` → `ModelProviderModelConfig[]` with at least `id`, `name`, `kinds`, `modalities`, and a conservative `contextWindow`.
- `modelDisplayNames[modelId]` → model `name`.
- `modelSupportedFormats[modelId]` → `kinds`: `anthropic` → `anthropic`; `openai` → `openai-compatible`; `responses` → `openai`; `gemini` has no `ModelProviderKind` — a model left with only `gemini` keeps the provider but is disabled or marked `disabledReason`, never silently generating unusable runtime config.
- Legacy `apiFormat` → provider `defaultKind`: `anthropic-messages` → `anthropic`; `openai-chat-completions` → `openai-compatible`; `openai-responses` → `openai`.
- Legacy `endpoints.anthropic` / `endpoints.openai` URLs cannot be reliably split into `baseURL + path`: the chosen legacy endpoint goes verbatim into `endpoints.baseURL` with `paths[kind]` set to empty string — empty path means the baseURL already contains the adapter-ready path (pinned by comment/test).
- `providerMappings`, `enabled`, `systemDisabledReason`, `apiKey`, `headers`, `createdAt`, `updatedAt` pass through unchanged.

## Provider ordering

Ownership: display order is a UI/settings preference that does not affect agent requests — it never enters `ZCodeModelProviderInput` and never bumps the provider registry revision. Persistence is separate from runtime config:

```ts
interface ModelProviderDisplayOrderState {
  providerIds: string[];
  updatedAt: number;
}
```

`modelProviderService` exposes separate read/save methods with an independent on-disk location, so drag ordering cannot fire `onDidChangeProviderRegistry` or make remote agents rebuild catalogs.

Sort rules: providers listed in `providerIds` keep that order; unlisted new providers fall back to their bucket at the group tail; ids of deleted providers are cleaned on the next save; grouping still follows existing source rules — drag never changes group identity.

Two application points: settings navigation applies display order within each draggable group; the chat model selector builds provider groups from agent `settings.model.available`, then reorders groups by local display order (in-group model order stays agent/catalog order) — display order influences chat display without entering the registry. `buildProviderRegistrySnapshot` may keep a stable sort for reproducible revisions; editing only display order never calls `convertModelProviderConfigToZCodeProviderInput` or changes the revision.

Drag interaction uses the existing `@dnd-kit`: `GripVertical` handles on navigation items; only real provider nodes drag (not "add provider", loading nodes, or group headers); preset/custom/official group boundaries hold — cross-group drag does not change provider `source` and is unsupported in v1; drop applies optimistic order then saves, restoring the previous order with a UI-logger warn on failure; keyboard accessibility comes from `@dnd-kit` sortable defaults with localized aria-labels and tooltips on the handle.

## Reasoning

Persisted reasoning keeps only runtime facts: `defaultLevel`, `levels[level][kind].set`, `levels[level][kind].unset` — no UI label, description, rank, or `enabled` on disk. UI labels derive from i18n by level id (`off`, `enabled`, `high`, `max`); unknown levels display the raw value.

Projection (`convertModelProviderConfigToZCodeProviderInput`, per `models[*]`):

1. Effective kind = `model.defaultKind ?? provider.defaultKind`.
2. Validate it exists in `model.kinds` and `provider.endpoints.paths`; otherwise disable/skip the model with a warn.
3. Runtime model name = `model.modelIdByKind?.[effectiveKind] ?? model.id`.
4. Derive `supportsImages` from `modalities.input`; `supportsTools` / `supportsJsonSchemaOutput` need dedicated schema fields if ever supported — never guessed from unrelated fields.
5. Pass through `contextWindow` and `maxOutputTokens`.
6. With `reasoning.levels`, take each level's effective-kind patch into `providerOptionsByLevel[level]`: `set` writes nested objects by path; `unset` deletes the path at generation or via a sentinel before final runtime application; namespaces map `anthropic -> anthropic`, `openai -> openai`, `openai-compatible -> openaiCompatible`.
7. `ZCodeModelReasoningState.levels` entries get only `{ value, label }`, label from i18n/local mapping.
8. `defaultLevel` passes through only when present in levels; otherwise the first level.

Models without a reasoning patch get no label-only levels and no declared thought levels.

Settings editing in v1 (low-risk only): provider name, API key, baseURL, kind paths, default kind; model id, display name, kinds, default kind, modalities, context window, max output tokens; reasoning levels viewable with enable/disable of existing levels, and deleting the default level re-defaults to the first remaining level by normalization. No "add arbitrary level" or "advanced JSON editing" in v1: a reasoning patch is a runtime request parameter, and without provider docs and tests the UI can persist levels the agent can select but the request cannot use. Custom patches, if ever, become a separate advanced feature reusing the catalog patch editor plus connectivity tests.

## Agent registry projection

- Provider `kind` is the effective kind; `baseURL` is resolved per effective kind (the legacy empty path means the baseURL is already adapter-ready).
- `models[*].modelId` is the kind-aware name; `label` is the model `name`; `contextWindow`, `maxOutputTokens`, `supportsImages` pass through/derive; `reasoning` is the converted `ZCodeModelReasoningState`.
- `models[*].providerOptions.supportedFormats` is no longer a primary fact source; if the agent still filters on it, project it temporarily from `model.kinds` and converge on kind semantics later.

Changing provider/model runtime metadata bumps the registry snapshot revision and affects the next turn; display-order edits do not.

## Remote and multi-client boundaries

Mobile `/remote` attaches to the desktop window's existing host via shared-host attachment — never a separate provider runtime. Provider metadata reaches remote workspace agent servers via the local host's registry snapshot. `workspaceIdentity` stays the identity isolation for remote registry sync; display order, as an app-global preference, is not sharded by workspace identity. Desktop continuous and mobile web-remote replayable session event semantics are unchanged — registry updates keep going through workspace state updates without leaking replayable snapshot semantics into the desktop continuous path.

Logging: interaction logs (drag save failure, level normalization failure) use `packages/ui/src/logger.ts`; service logs (catalog load/parse failures, CDN download failures, migration outcomes) use `createServiceLogger("ModelProviderService")` or equivalent, no info on hot paths; registry revision logs fire only on metadata/behavior changes, never for display order saves.

Tests and acceptance:

- Shared schema: v1 catalog parse; v2 store parse; legacy bare-array auto-migration; patch `set`/`unset` validation and namespace mapping; `convertModelProviderConfigToZCodeProviderInput` passthrough/derivation.
- Service: `models.dev` adapter still works and outputs the unified model; `china-llm-zcode-dev` parses the local catalog; migration preserves API keys, enabled flags, providerMappings, display names, and model formats; display-order saves fire no registry-changed event.
- UI: navigation drag persists order; catalog imports land model objects in the draft; reasoning levels enable/disable with normalized default on deletion; display-order-only edits change both surfaces' ordering without a registry snapshot revision.
- Manual: desktop local workspace import + API key + visible model metadata; remote workspace sees the same capabilities after snapshot sync; mobile `/remote` reconnect reads the attached host's agent state with no separate runtime.

Implementation order: (1) shared types/schemas + catalog schema + v2 store schema + migration; (2) catalog source abstraction converting both sources to the unified model; (3) provider import writing v2 model object arrays; (4) registry projection with effective kind, modality derivation, patch conversion; (5) display order service + UI hook; (6) navigation sorting and drag; (7) chat provider group ordering via display order; (8) per-model edit UI (model object fields + level enable/disable); (9) tests + `pnpm typecheck` + `pnpm lint`.

Follow-up: the China LLM catalog moves to CDN once review and publishing stabilize — switch the `china-llm-zcode-dev` loader to CDN download with a local dev fallback, changing neither the persisted schema nor the protocol projection.
