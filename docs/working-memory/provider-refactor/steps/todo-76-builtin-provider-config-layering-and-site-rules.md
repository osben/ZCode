# Todo 76: Builtin Provider Config Layering and Provider Site Rules

> Status: done
>
> Date: 2026-09-04

## Goal

Reorganize the rule semantics of `zcode-builtin.json` without changing the existing sequential overlay mechanism, clearly separating model baseline, API Schema, Provider Site (a concrete Base URL), Provider Template and Provider instance, so site config is not written as a generic model rule.

## Fixed overlay order

```text
Model ID
 -> Model ID + API Schema
 -> Provider Site / Base URL
 -> templateId + modelId
 -> Built-in Provider Instance Model overlay
 -> Personal Provider Instance Model overlay
```

The order is unchanged. A later layer overrides only the fields it declares; being later does not give it every field. "Personal Provider Instance" is a product concept (a concrete user-created Provider instance); its model edits still use the same `ModelConfigOverlay`, with no second Personal Rule structure.

## Layer responsibilities

- **Model ID**: the model's own base facts: context window, maximum output limit, base input modalities and base reasoning values. `maxOutputTokens.max` is a capability limit, not a request default.
- **Model ID + API Schema**: protocol-level baseline: reasoning map, output-length field mapping, JSON Schema encoding, tool-call format and media serialization. These are defaults and do not assume every site is identical.
- **Provider Site / Base URL**: matches real service behavior by concrete site URL and may override the protocol baseline (a URL's reasoning map, search capability, PDF, JSON Schema, tool calling or extra request fields). It is not model membership or template enable config. The rules currently written as `modelMatch: ".*"` + `apiMatch` + `baseURLMatch` for Z.ai/BigModel Anthropic capability are reclassified under Provider Site semantics.
- **templateId + modelId**: built-in template model membership and default enablement (`enabled`). A Template is not an executable Provider and must not accidentally override protocol behavior a Site confirmed. Within the maintained scope, Template Model Rules use only `enabled`; other `ModelConfigOverlay` fields are not forbidden at the low level but runtime-capability overrides are not added to Templates without clear need.
- **Built-in Provider Instance Model overlay**: ZCode Builtin Config's exact model override for a definite `providerId + modelId`.
- **Personal Provider Instance Model overlay**: the user's exact override saved in Personal Config for a definite `providerId + modelId`. Both reuse the same `provider-model` Rule type and `ModelConfigOverlay`; the difference is only the Builtin/Personal source. Personal Config allows only exact `providerId + modelId` overrides: no Personal global `match` rules are supported, read or written. Users may edit any Model Config leaf but cannot create a global-rule layer through Personal Config.

## API Schema choice for official templates

A vendor may support several API Schemas. Official templates prefer Anthropic Messages; only when the vendor or a specific model/Endpoint does not support it is another Schema chosen, based on the entry's actually supported and best-verified Schema (evidence from real template requests, not "OpenAI-compatible" marketing labels). If different models on one site must use different Schemas, split the template identity or first propose an explicit per-model API config design; never put different-protocol models under one fixed `api.type`.

## Maintenance scope and completeness boundary

The maintained scope is one short Builtin Provider entry inventory, not a duplicate of the full Provider Config; see [`Builtin Provider maintenance list`](../design-v2/builtin-provider-inventory.md). Format: `vendor | type | templateId / providerId | Base URL | product-maintained models`.

- Ordinary API entries give `templateId`; Account entries give the concrete `providerId`.
- The models in the table are the product-maintained models; a Template's `builtinModelIds` is the corresponding config fact and no duplicate "which Templates a model belongs to" column is kept.
- No model display names, Provider Site Catalog or Legacy/Compatibility model list.
- Historical models in a vendor catalog but not in the table do not enter Builtin Templates and get no compatibility migration.
- Small relays and self-hosted inference services still use the generic Model/API baselines, but users configure unmaintained models themselves.

The table's model set is the completeness-check input: every listed model needs a Model baseline, three API Schema baselines and an explicit `enabled` in the corresponding Template/Account Provider. No full vendor catalog and no full Model × URL × Schema matrix. The table is maintained in the design doc and not inferred from Rules that happen to exist in code. Provider URL special rules form no separate "Site list": `providerSiteRules` are written only where an actual difference exists, otherwise the earlier baseline applies. Research docs record evidence only.

## Per-field discussion list

| Field                           | Baseline           | Site may override | When unconfirmed                             |
| ------------------------------- | ------------------ | ----------------- | -------------------------------------------- |
| `contextWindow`                 | Model              | yes               | use the known Model value                    |
| `maxOutputTokens.max`           | Model              | yes               | use the known limit                          |
| `reasoningLevel.values`         | Model              | yes               | conservative, add no levels                  |
| `reasoningLevel.map`            | Model + API Schema | yes               | no reliable mapping means unavailable        |
| `maxOutputTokens.map`           | API Schema         | yes               | no reliable mapping means unavailable        |
| `support_pdf`                   | Model              | yes               | do not declare support                       |
| `supportsToolCall`              | Model/API          | yes               | must not disable a ZCode-required capability |
| `supportsJsonSchemaOutput`      | Model/API          | yes               | do not declare support when unconfirmed      |
| search / system-message ability | API baseline       | yes               | do not declare support when unconfirmed      |

"May override" is a configuration capability; a site need not write an override, and without one the earlier baseline applies.

## Match rule principles

`match` expresses "several equivalent spellings of the same object"; it does not infer vendors, capabilities or product semantics through complex regex. Prefix/suffix matching is allowed only in Model Rules (`modelRules`) and Model+API Rules (`modelApiRules`); Template Model and Provider Model use exact `templateId/providerId + modelId`; Provider Site uses URL rules and does not reuse the model wildcard logic.

Model IDs are a slowly changing closed maintained set, so Model Rules may use prefix/suffix matching by default (for example `.*GLM-5\\.3.*`) to cover vendor namespaces and confirmed version suffixes. Model rules may overlap and are processed in written order: generic model-family rules first, specific model/variant rules later (`.*GLM-5.*`, then `.*GLM-5\\.3.*`, then `.*GLM-5\\.3-Flash.*`), so `GLM-5.3-Flash` inherits generic config and then specific overrides. No runtime "most similar" ranking and no unboundedly wide rules for unknown Providers. Suffixes with different product semantics (such as `-flash`, `-turbo`, `-thinking`, `:free`) get explicit specific rules and are not swallowed as aliases. Case or truly equivalent separator spellings can be handled by normalization or narrow matching; a URL that looks like a service never auto-infers its model, search or JSON Schema capability.

## Base URL matching

Base URLs are parsed with the standard WHATWG URL before rule matching: protocol and Host follow URL semantics; default port and trailing slash cause no difference; Path, Query and Fragment get no business guessing. Whether Query/Fragment participate is decided by explicit rules; no proxy-URL auto-inheritance or URL rewriting. Provider Site rules stay simple, specific and readable; a proxy address does not inherit official Site config just because it looks official, unless it matches the same explicit rule or is explicitly configured.

## Builtin Config organization

1. Keep the sequential overlay, no dynamic priority algorithm.
2. `baseURLMatch` rules are gathered by Provider Site semantics and formally split out of `matchRules` into an independent `providerSiteRules`.
3. `templateModelRules` keep carrying template model membership and `enabled`, not a second fact source for all capabilities.
4. The generic API Schema map is only a baseline; site differences are overridden by Site rules.
5. `providerModelRules` stay exact Provider-instance overrides; the Personal Overlay applies last.
6. Runtime, Adapter and UI never guess capability from model name, URL or API Schema.

## Not in scope

- Option `default` retirement, Reasoning completion and explicit request budgets are not revisited.
- PDF, tool calling and JSON Schema values are decided by Todo 74, which must obey this Todo's layering and completeness constraints.
- The "Provider Template is not an executable Provider" abstraction is unchanged.
- The config is not yet released: Personal generic match rules are deleted from the new Schema directly with no migration or tolerant read; unmaintained Provider historical models get no migration.

## Acceptance criteria

- Every maintained mainstream Model has a Model baseline and API baselines for the three API Schemas (an inapplicable combination is not forced to a fake config).
- A Provider Site override is added only for an explicit difference; small or unknown sites use the generic baseline.
- Every Template model member has an explicit `enabled`.
- Every Builtin Rule can state whether it belongs to Model, API Schema, Provider Site, Template or Provider Instance; URL rules express concrete site behavior, not generic capability for all Providers.
- The same Effective Model Config is used by Settings, Model Selection, Runtime and Adapter.
- The existing sequential overlay stays predictable and has unit tests for rule conflicts; Providers outside the maintained list need no Site Rule and use the Model/API baseline.

## Outcome (2026-09-04)

- The Built-in Model Config serialized output and the actual `config/provider/zcode-builtin.json` are split into `modelRules`, `modelApiRules`, `providerSiteRules`, `templateModelRules` and `providerModelRules`; the Resolver still appends groups in the agreed order with no dynamic priority.
- The three kinds of Builtin match rules still reuse the same `match` Rule and `ModelConfigOverlay` internally; Personal no longer enters this generic match pipeline.
- `parseZCodeBuiltinModelConfigRules` reads the new groups and merges them in fixed order; the old `matchRules` read branch remains only for not-yet-synced development-period test fixtures, encoding never produces the old field, and the formal built-in file no longer uses it.
- `toZCodeBuiltinJSON` puts rules with no API/URL condition into `modelRules`, those with `apiMatch` into `modelApiRules`, and those with `baseURLMatch` into `providerSiteRules`.
- Cross-layer order tests and an actual-file grouping-integrity test were added; Provider/Provider Node/Runtime tests pass (54 earlier, 30 migration regressions); `pnpm typecheck` and `pnpm lint` pass (0 error).
- Runtime, Adapter and Model Selection consumption paths are unchanged (they consume the same `ModelConfigRules.resolve` result). The 134 existing Builtin rules were mechanically classified by field semantics with content and in-group order unchanged. Personal config was separately narrowed to exact `provider-model` only; the 74/79 capability-rule adjustments close out with their own Todos.
