# Model Input Output Format

## Status

- This document is the target fact specification for Model input/output format in the Provider Refactor.
- Change level: `option-source + validation + persistence + commit-effect`.
- This document covers the `modalities` array, flat `supportsImages` / `supportsPdf` /
  `supportsVideo`, and independent media capability projections from earlier designs.

## Single Source Structure

Config, Registry, Model, Runtime, and cross-process protocols share the same field names and nested structure:

```ts
interface ModelInputFormat {
  support_text: boolean;
  support_image: boolean;
  support_video: boolean;
  support_audio: boolean;
  support_pdf: boolean;
}

interface ModelOutputFormat {
  support_text: boolean;
}

interface ModelProperties {
  input_format: ModelInputFormat;
  output_format: ModelOutputFormat;
  // Other existing Model Properties retain their original responsibilities.
}
```

These snake_case names are the real Schema names; they are not converted to camelCase in Runtime, nor projected into another set
of `supports*` fields.

## Config Rules and Overlay

ZCode Built-in Model Config Rules and Personal Model Config Rules use the same structure. Rules can declare only the leaf fields that need to be covered; nested fields overlay per leaf, with Personal rules concatenated after Built-in rules:

```text
ZCode Built-in Model Config Rules ─┐
                                    ├─ resolve against Effective Provider Config
Personal Model Config Rules ────────┘
                                              |
                                              v
                                  Effective Model Config
```

The three-state semantics of leaf fields in Rules:

```text
undefined -> no opinion at this layer
false     -> this layer explicitly disables
true      -> this layer explicitly enables
null      -> explicit clear; if still missing at the end, completeness validation fails
```

Built-in general rules are responsible for providing complete default facts; specific model rules only save differences. Effective Model Config must form
complete `input_format` and `output_format`; Registry does not accept Models with missing leaf fields.

### Sparse Rules and Complete Execution Facts Boundary

Rule `undefined/null` only expresses Overlay instructions; it does not constitute a third value for Model Properties:

```text
Sparse Built-in / Personal Rule
          |
          | resolve + validateComplete
          v
Effective Model Config
          |
          v
Registry / Protocol / Active Model / Runtime / Adapter
└─ support_* can only be true or false
```

After completeness validation succeeds, `properties?`, `input_format?`, optional `support_*`, or "capability unknown" no longer propagate downstream. Missing fields are Config errors; they must not be patched by Registry, Protocol Mapper, Settings Draft, Runtime, or Adapter through `?? true` / `?? false`. The Registry-published Model type must statically express this completeness, so downstream consumers do not need to repeat `requireCompleteProperties()` or "send Properties only when fields are complete" compatibility branches.

This does not affect Account availability `unknown`, TypeScript `unknown` used for open JSON values, nor does it cancel Personal Rule sparse overlays. One-time legacy importers can only convert format facts explicitly expressed in old files into Personal Rules; fields not declared in old files do not write Overrides and continue to inherit Built-in general rules. Importers cannot migrate special defaults, nor guess capabilities by Catalog, modelId, Provider type, or Endpoint; if incomplete after Overlay, migration fails.

`validateComplete()` is responsible for producing completeness diagnostics for Settings Preview; Registry must still pass the type-tightened
`requireComplete` boundary before publishing. The successful result statically has complete Properties in its type; failed candidates remain only in Settings/diagnostics and cannot enter Registry. The function name can be determined by implementation, but the same sparse `ModelConfig` type must not continue to express the validated result.

No `modalitiesConfigured` is added. Old published config's `modalities.input/output` can only be converted by a one-time legacy importer; flat `supportsImages` / `supportsPdf` / `supportsVideo` intermediate formats are not used as compatibility input for new Provider Config.

## Model and Runtime

```text
Effective Model Config
        |
        v
ModelFactory
        |
        v
Active Model.properties
        |
        +--> Core input check / media projection
        +--> Compact / Memory / Child Agent
        +--> Adapter request check and protocol encoding
```

ModelFactory fixes the complete Properties of Effective Model Config into immutable Active Models. Normal requests,
Compact, Memory, child Agents, and idle turns all read `properties.input_format` from this round's Active Model; they do not re-infer from Session default configs, Catalogs, or modelId.

When async links need to freeze this round's facts, prefer holding the Active Model; when the execution object cannot be held, save an immutable `properties` snapshot of the same structure. Snapshots only freeze the lifecycle; they do not produce new domain fields.

The following migration-period concepts do not belong to the target architecture:

- `ModelInputMediaCapabilities`;
- Runtime Config's `modelInputMediaCapabilities`;
- Turn's flat media capability fields;
- AI SDK Registry's `inputMediaCapabilities` map saved by `providerId/modelId`;
- Runtime helpers that fill input formats from Catalog, Provider type, URL, or specific modelId.

The Adapter's protocol implementation capability remains an independent constraint. For example, `support_video` indicates the model accepts Video; it does not mean any arbitrary
Adapter has already been able to encode Video; real requests must simultaneously satisfy Model Properties and target Adapter implementation boundaries.

## Format Boundary

| Format      | Config / Model / Runtime | Settings page                  | This round's execution behavior                                                    |
| ----------- | ------------------------ | ------------------------------ | ---------------------------------------------------------------------------------- |
| Text input  | Supported                | Fixed display, cannot turn off | Participate in request check                                                       |
| Image input | Supported                | Toggleable                     | Participate in existing media check and encoding                                   |
| Video input | Supported                | Toggleable                     | Participate in existing media check; still subject to Adapter encoding constraint  |
| Audio input | Supported                | Not displayed                  | No new content block projection, attachment entry, or Provider encoding this round |
| PDF input   | Supported                | Toggleable                     | Participate in existing media check and encoding                                   |
| Text output | Supported                | Fixed display, cannot turn off | Current only output format                                                         |

This round does not add Image, Video, Audio, or PDF output fields.

## Settings Page and Protocol

The settings page draft directly maintains `input_format` / `output_format`. Visible controls only modify Text, Image, Video, and PDF; when saving any other field or toggling visible formats, the hidden Audio must be preserved as-is. The save result forms a sparse Personal
Model Config Rule; untouched hidden fields should not be written as override values.

Drafts are initialized from the complete Effective Properties returned by the Service. The settings page cannot self-fill
Text=`true` or other formats=`false` due to missing fields; incomplete Config should be presented as an authoritative validation issue.

Cross-process model information transmission uses the same nested Properties; flat `supportsImages` / `supportsPdf` /
`supportsVideo` are no longer transmitted. Ordinary selectable Models must carry complete Properties; unselectable diagnostics for conflicts use explicit state
branches; `properties = undefined` must not imply unknown capabilities. Serialization is a transmission behavior; it does not constitute a second set of capability facts.

The existing Vision identifier is merely a presentation projection of Model Properties; it does not participate in Registry admission, Runtime judgment, model selection, or persistence authority. Provider Settings is the only format editing entry point; conversation toolbars, automation, Subagents, and Repo Wiki continue to only read model facts.

## Client and State Boundary

- Desktop, Web, and phone settings pages use the same Service contract.
- This round does not change the Provider Config authority relationship of local / remote Environments.
- This round does not change desktop continuous, mobile replayable, task queue, owner / lease, or recovery semantics.
- Config updates only affect later-created Models; already-created Active Models remain immutable.

## Impact Summary Table

| Level          | Relationship                              | Reason                                                           |
| -------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| must-inspect   | Provider Config / Model Rules -> Registry | New Schema and completeness validation authority entry           |
| must-inspect   | Registry -> ModelFactory -> Active Model  | Properties must be fixed as-is and cannot be re-inferred         |
| must-inspect   | Active Model -> Core / Adapter            | Execution consumers after removing Runtime capability copies     |
| must-inspect   | Provider Settings -> Personal Model Rules | Visible field modifications and hidden field preservation        |
| should-inspect | Model option protocol / remote runtime    | Cross-process use the same nested structure                      |
| invariant-only | Queue / replay / workspace identity       | This round must not change existing state and recovery semantics |

## Acceptance Cases

1. Built-in complete rules and Personal sparse rules merge per-leaf; Personal only overrides explicitly declared formats.
2. Registry completeness validation fails when Effective Models lack any required format leaf.
3. Models created by Registry hold Effective Properties as-is; config updates do not modify already-created Models.
4. Normal requests, Compact, Memory, child Agents, and idle models all read this round's Model Properties, not inheriting another model's media facts.
5. Image, PDF, Video allowance and rejection are consistent in the generate/stream links; Video cannot bypass Adapter encoding constraints.
6. Audio fields can overlay, save, transmit, and read, but do not produce unimplemented Audio requests.
7. Settings page displays Text/Image/Video/PDF input and Text output; hidden Audio remains unchanged after editing.
8. Legacy `modalities` are only converted by the importer when old files explicitly provide them; the formal Config Schema rejects old flat fields; the importer does not guess defaults for missing facts.
9. Local and remote protocols carry the same Properties; desktop continuous and mobile replayable behavior remains unchanged.
10. All `support_*` in Effective Config are required booleans going forward; UI, Protocol, Runtime, and Adapter have no optional capability or `?? true/false` fallback.
