# Todo 54: Model Option Map and Raw Request Body Closeout

> Status: Completed
>
> Date: 2026-08-31
>
> Prerequisite: Todo 42 fixed the Reasoning level order and the lowest-level semantics for auxiliary calls; this Todo
> does not change that decision and only closes how an Option maps to the raw API Schema.

## 1. Background

Model Config expresses two public call parameters as unified Options:

```ts
interface ModelOptions {
  reasoningLevel?: string;
  maxOutputTokens?: number;
}
```

Their projection into the real Provider request was split: `reasoningLevel` had `optionSpecs.reasoningLevel`
(domain and default), a separate `reasoningMapping` (per-level Provider parameters) and an Adapter wrapping them into
the AI SDK `providerOptions` namespace; `maxOutputTokens` had `optionSpecs.maxOutputTokens` (max/default), the AI SDK
standard `maxOutputTokens` and an Anthropic fixed-thinking "subtract first, AI SDK adds back" compat computation.
That scattered one Option's definition and effect across Config, ModelFactory, the AI SDK namespace and Adapter
helpers, and forced advanced config authors to understand `providerOptions.anthropic`, `providerOptions.openai`,
`extra_body` etc. instead of the target Anthropic Messages, OpenAI Chat Completions or OpenAI Responses Schema.

This Todo moves the mapping into each Option Spec: each Option knows only its own final `value` and uses one
restricted CEL `map` to produce a JSON Merge Patch (RFC 7396) for the raw API Schema Request Body. It must not grow
into an aggregate Option Mapping, general Request Adapter or arbitrary request rewrite language. Before migrating
Option Config, the single restricted CEL compile/execute module must be implemented and verified independently;
Config integrity checks and Adapter request execution reuse that module and never parse or interpret expressions
separately.

## 2. First principles

| ZCode Option      | Anthropic Messages                               | OpenAI Chat Completions                                          | OpenAI Responses    |
| ----------------- | ------------------------------------------------ | ---------------------------------------------------------------- | ------------------- |
| `reasoningLevel`  | `thinking.type`, `thinking.budget_tokens` if needed | `reasoning_effort` or the target compatible Schema's equivalent | `reasoning.effort`  |
| `maxOutputTokens` | `max_tokens`                                     | `max_completion_tokens`; some compatible protocols use `max_tokens` | `max_output_tokens` |

ZCode keeps the unified semantics of the public Options; the concrete field names, object nesting and switch
expression are declared by the Model Config Rule hitting the current `providerId/modelId/api.type`. Runtime and
Adapter no longer hardcode the same mapping by model ID, Provider ID or API type.

Users face the raw API Schema, not the AI SDK protocol: they should not need to understand the AI SDK
`providerOptions` namespace, `extra_body` passthrough, ZCode's internal `ReasoningParameters`, or the Adapter's
budget-adjust and field-cleaning helpers. The Map result in Config is the final raw Request Body field authority;
how the AI SDK or Adapter builds the base request is internal and must not become a second configurable semantics.

## 3. Target structure

### 3.1 Each Option carries one `map`

```ts
interface EnumOptionSpecConfigInput {
  type?: "enum" | null;
  values?: readonly string[] | null;
  default?: string | null;
  map?: string | null;
}

interface EnumOptionSpec {
  type: "enum";
  /** Ordered by semantic strength from low to high; values[0] is the lowest public level. */
  values: readonly string[];
  default: string;
  /** CEL: reads the current Option's value, returns a JSON Merge Patch Object. */
  map: string;
}

interface LimitOptionSpecConfigInput {
  type?: "limit" | null;
  max?: number | null;
  default?: number | null;
  map?: string | null;
}

interface LimitOptionSpec {
  type: "limit";
  max: number;
  default: number;
  /** CEL: reads the current Option's value, returns a JSON Merge Patch Object. */
  map: string;
}

interface ModelOptionSpecs {
  reasoningLevel?: EnumOptionSpec;
  maxOutputTokens: LimitOptionSpec;
}
```

Config Rules use a nestable, sparse-Overlay Input; Effective Model Config and Active Model use the complete Option
Spec. `map` sits inside the Option (`optionSpecs.reasoningLevel.map`, `optionSpecs.maxOutputTokens.map`). These
parallel concepts are not added or kept: `reasoningMapping`, an aggregate `optionMapping`,
`requestPatch`/`requestBodyPatch`, `requestAdapter`/`requestAdapterRule`, `requestBodyTransform`,
`reasoningLevelPolicy`, any Runtime capability/option DTO.

### 3.2 CEL input and output

Current Option Effective value -> `Option.map` -> JSON Merge Patch Object -> target API Schema Request Body. First
version boundary:

- The only CEL input variable is the current Option's `value` (Enum: current final string level; Limit: current
  final number).
- CEL conditionals and necessary arithmetic are allowed; besides `value`, values in the expression must be literals.
- The result is a JSON Object applied with RFC 7396 semantics: `null` deletes the field; arrays, strings, numbers
  and booleans replace the whole value at that path.
- Map acts only on the JSON Request Body; it does not touch Header, Query, Path, Endpoint, auth or request security
  validation.

Explicitly not exposed to CEL: other Options, context, messages/tools, Provider/Model objects, apiKey / JWT / Request
Auth, Environment / Runtime state, AI SDK instances or providerOptions. If a formal Provider appears that independent
Option Maps truly cannot express, it is re-decided with a real API Schema and request evidence; no cross-Option
context, aggregate Adapter or expression dependency graph is built in advance.

### 3.3 Restricted CEL subset

No Beta JavaScript CEL Runtime and no full CEL implementation. The repo adds an independent side-effect-free
restricted CEL module in three layers (tokenizer, parser, AST evaluator); `eval`, `Function` and any dynamic code
execution are forbidden. Supported syntax is strictly: `value`; string / number / boolean / null literals; object /
array literals; `==` `!=` `<` `<=` `>` `>=`; `+` `-` `*` `/` `%`; `&&` `||` `!`; `condition ? trueValue :
falseValue`; parentheses. Not supported: function or method calls, macros, comprehensions; member reflection, dynamic
variables, other Options, Context; time, random, IO, Provider/Model/credential objects; the full CEL standard
library or user extension functions.

Externally it is called a "restricted CEL expression": syntax and control flow use the declared CEL subset, but all
numbers are JavaScript `number` with JavaScript arithmetic/comparison/division/modulo semantics (no CEL `int` /
`double` distinction or integer division). The parser must reject unimplemented syntax, never approximate. Numbers
must be finite values safely projectable to JSON; NaN, Infinity, integers outside the JavaScript safe range and
BigInt results must fail.

The module is a pure TypeScript standalone package that both Provider Config and the CLI Adapter may depend on (not
in UI, Services or a concrete Adapter, to avoid reverse cross-domain dependency). Lifecycle:

```text
CEL source (persisted) -> validated by the shared compiler at Config read
 -> Registry/protocol keep passing the immutable CEL source
 -> CLI ModelFactory compiles and binds the Program when creating the Active Model
 -> each request binds only value and executes
```

The same compiler/evaluator serves Config compile checks and Adapter execution; Config and Runtime must never each
implement a subset.

### 3.4 Config Overlay

`reasoningLevel` and `maxOutputTokens` stay two independent nested config items, overlaid per leaf. A model Rule may
declare only the domain/default and an API Schema Rule only the matching `map`; they merge into the complete
Effective Option Spec (type / values / default / map). Each leaf in a Config Rule may be omitted, overridden or
cleared with `null`; Personal Rules keep only user-modified leaves and come after Built-in. The Effective Option Spec
must have complete type, domain, default and map, otherwise integrity check fails. Showing inherited values in
Settings creates no Personal Rule; "restore all defaults" deletes the corresponding Personal leaf overrides. `map` is
never split into another Overlay Source or separate persisted field.

## 4. Reasoning semantics

`reasoningLevel.values[0]` is the lowest public level and later items increase in strength; the lowest level does not
guarantee "off" (e.g. `["off","low","high"]` or `["low","high","max"]`). Ordinary requests use the explicit selection
or `default`; Title, Goal Title, Git Commit Message and Memory Recall keep selecting `values[0]`. Runtime never scans
`off`/`none`/`nothink` strings to infer a switch.

Examples (`map`):

- Anthropic Messages: values `["off","low","high"]`, default `low`, map `value == 'off' ? {'thinking': {'type':
  'disabled'}} : {'thinking': {'type': 'enabled', 'budget_tokens': value == 'low' ? 1024 : 8192}}`.
- OpenAI Chat Completions: values `["low","medium","high"]`, default `medium`, map `{'reasoning_effort': value}`.
- OpenAI Responses: same values, map `{'reasoning': {'effort': value}}`.

`budgetTokens` boundary: the unified ZCode/AI SDK middle-layer `budgetTokens` parameter and its compat arithmetic are
deleted (not in public Options, Request or Mapping parameter structure); Anthropic's raw `thinking.budget_tokens` is
allowed as a literal field generated by `reasoningLevel.map`.

## 5. Max Output Tokens semantics

`maxOutputTokens` keeps the unified total generation budget meaning: the total token cap of one generation,
including reasoning/thinking tokens and user-visible output tokens. `LimitOptionSpec.max` is the model's domain cap
and `default` the default Option Value when the caller does not override; both belong to the unified Option
abstraction and are not removed just because an SDK may omit sending them. Provider must not reinterpret it as
"visible output only"; field-name differences are solved by Map. Maps: Anthropic Messages `{'max_tokens': value}`;
OpenAI Chat Completions `{'max_completion_tokens': value}` (legacy/third-party compatible Schemas may use
`{'max_tokens': value}` per their Rule); OpenAI Responses `{'max_output_tokens': value}`.

## 6. AI SDK and wire boundary

```text
Model Effective Options -- each Option runs only its own map(value) --> Option JSON Merge Patches
 -> expanded in fixed Option order, write-path conflicts checked -> conflict-free ordered Patches
 -> AI SDK serializes the base JSON Request Body -> apply Option Patches
 -> inject Access material / request security validation -> send HTTP request
```

For fields already managed by an Option Map: the final raw Body is governed by the Map; the same value is not also
written into AI SDK `providerOptions`; `createRequestProviderOptions(api.type, reasoningMapping[level])` is not kept;
no Runtime branch by Provider Kind that changes the same Option's meaning; no Anthropic fixed-thinking
subtract-then-add conversion; no field cleaning of raw `max_tokens`, `max_output_tokens`, `max_completion_tokens`
competing with the canonical Option.

Generate and Stream use the same Patch executor and application order. Patch completes before any Body-dependent
request security validation; Request Auth, Attribution Headers, retry and response parsing are outside this config
language. The fixed order is `reasoningLevel` then `maxOutputTokens`; a future public Option must add an explicit
order (never rely on JavaScript object property enumeration). Before applying, the runtime expands the RFC 7396 paths
each Patch actually writes and compares them: a duplicate write to the same path, a parent replaced by
`null`/array/scalar and a child then written, or any other ancestor-replacement conflict immediately fails this
request's assembly; different leaf paths under an object may merge. No priority, auto-override or complex static
conflict analysis.

Model IO, Debug and network capture must record the final Request Body after Patch and before security validation,
no longer the AI SDK's pre-Patch `result.request.body`; existing redaction rules still apply. If an AI SDK Provider
forces a synonym parameter before the final Body Patch stage, pin the failure with a real request test first and
treat it as a concrete Schema Adapter compatibility problem; never expose the AI SDK namespace back into Config or
restore a second mapping authority.

## 7. Validation boundary

No complex preview or runtime validation system. Config/Schema require: provided leaves of sparse Config Input have
legal types; the Effective Enum/Limit Option Spec has all required leaves; `map` is a non-empty string that
restricted CEL can compile. Explicitly not done: executing every `reasoningLevel.values`; traversing the
`LimitOptionSpec` domain or trial-running default/max; Cartesian products of Options; static JSON path conflict
analysis or preview; a second Anthropic/OpenAI Request Schema validator; automatically rewriting or fixing user CEL;
`language`/`engine`/`version`/Policy discriminators on Map.

At request time, running restricted CEL, checking the current Patch write-path conflicts and applying RFC 7396 is
normal request assembly, not value-domain enumeration. If expression execution, JSON-compatible conversion, path
conflict or Merge Patch application fails, this request's assembly fails with a clear error; Map is never silently
ignored, the old `reasoningMapping` is not fallen back to, and the AI SDK does not guess fields. Independent Option
Maps are expected to write non-conflicting raw fields; the Built-in publisher is responsible for avoiding multiple
Maps competing for one path (a real unavoidable same-path need would be decided separately).

## 8. UI and protocol projection

The Settings page no longer shows an independent "reasoning parameter Mapping JSON" and offers no UI to edit
Reasoning or `maxOutputTokens.map`. Maps come from Built-in general/specific Model Config Rules by `api.type`; when
Settings edits visible Option domain, default or max, it must not copy the inherited Map into a Personal Rule nor
clear the Map with `null`. The advanced config file still uses the same Option Spec structure; no UI-only Mapping
type. Cross-process Config, Settings draft, Personal JSON round-trip, Registry Model Config and Active Model Option
Specs use the same structure; no flat `reasoningMap`, Runtime capability DTO or UI-only Mapping type. Vision flag,
input/output format, model selection, Session Selection, Automation, Subagent, Repo Wiki, Compact and Off-Peak keep
consuming only the Effective Model/Options; their model identity, queue, recovery and persistence ownership are
unchanged.

## 9. Implementation scope

- **Config and Resolver:** `map` on `EnumOptionSpec`/`LimitOptionSpec`; Enum/Limit Option Config as leaf-level nested
  Overlay with updated strict Schema, freezing, `null`, JSON round-trip and integrity checks; delete
  `ReasoningParameters`, `ReasoningMappingConfig`, `ModelConfig.reasoningMapping` and its integrity loop; migrate
  Built-in and Personal projections to per-Option `map` (model Rule and API Schema Rule may provide different
  leaves); update Resolver, Registry Model Config, Active Model and cross-process projection. The new Schema does not
  read the unreleased old `reasoningMapping`, no dual-read or one-time importer.
- **Adapter:** reuse the single verified restricted CEL module with RFC 7396 Merge Patch and runtime path conflict
  check; Generate/Stream share the executor; delete the reasoning-level to AI SDK providerOptions mapping, the
  Anthropic fixed-thinking output budget add/subtract, mapped max-output's parallel AI SDK field authority, old
  cleaning helpers, `visibleMaxOutputTokens` fixed-thinking conversion and vague intermediate states. Message, tool,
  media, structured output, streaming parse, Access and Attribution duties are unchanged. Only the AI SDK namespaces
  and duplicate budget fields generated by reasoning/max-output mapping are deleted; `apiFormat`, Anthropic reasoning
  history block `signature`/`redactedData`, request metadata, and internal provider metadata/options needed for tool
  and message encoding are out of scope.
- **Built-in Config:** by `api.type`, move every `reasoningMapping` into `optionSpecs.reasoningLevel.map`; add the
  correct raw API field Map for every `maxOutputTokens` Spec; Anthropic, OpenAI Chat, OpenAI Responses and
  third-party compatible Rules each write Maps per their real Schema; no production branching by model ID (model
  differences exist only in Rule content); `reasoningLevel.values` stays ordered low to high with existing `default`
  unchanged unless model-fact evidence says otherwise.
- **Docs and Settings:** update Model Contract, Configuration, Runtime/Execution, Settings, Built-in Config and
  Access/Adapter boundary docs; delete every current-design statement that "Reasoning Mapping is an independent Model
  Config field"; Settings removes the independent Reasoning Mapping editing state, protocol field and save helper and
  adds no max-output Map editor; Built-in Maps write raw API Schema fields directly, with no AI SDK namespace.

## 10. Impact brief

Capability: Model Option Config, Provider Adapter request assembly. Change layer: option-source, validation,
commit-effect, persistence. Out of scope: Access, Header, Endpoint, model selection, queue, recovery, cross-Option
Context, general Request Adapter.

State owners: Option value-domain/default/map — Effective Model Config Rule leaf Overlay (Built-in JSON / Personal
Model Rule); this call's Option value — immutable Active Model + ModelRequest (this call only, not written back to
Config); final raw Option fields — the Option Map result (Request Body, this network request only); AI SDK/provider
metadata — Adapter internal compat, never Config or Option Map authority.

Must-preserve invariants (with proof): `reasoningLevel.values[0]` stays the lowest public level for auxiliary calls
(Title/Goal/Git/Recall regression); `maxOutputTokens` always means reasoning + visible output total budget (three
Schema wire and budget tests); an Active Model stays frozen and later Config updates affect only new Models
(ModelFactory/Registry tests); Personal Rule stays sparse and Settings edit/restore never copies or clears Built-in
Maps (Overlay/UI round-trip); Config compilation and request execution use the same restricted CEL (CEL unit and
vertical Adapter tests); Debug/Model IO Body equals the final sent Body (post-Patch capture and redaction tests);
Remote Workspace still syncs the same Provider Registry with no remote Mapping authority (Registry sync regression);
Desktop continuous and Mobile replayable unchanged (no protocol/recovery state change). The Patch precedes any
Body-dependent signing and credential ownership is unchanged. Feature Graph got a stable semantic edge "Model Option
Map to final raw Request Body" (historical `reasoningMapping` is no longer registered as a capability).

UI surface: editing Built-in/Personal models (Provider Model Metadata Dialog, Model Config draft, Effective Model
Config Rules, Personal Model Config Rule, isolated from Provider members, account eligibility and Session
Selection); selecting Reasoning/Max Output (Chat/Automation/Subagent etc. with each entry's own Selection draft and
existing Selection/record); actual request generation (no direct UI, this ModelRequest, no new persistence).

## 11. Acceptance scenarios

Test first.

- **Restricted CEL module:** tokenizer / parser / AST evaluator layered tests; `value`, literals, nested
  objects/arrays, comparison, boolean, arithmetic, ternary and parentheses; operator precedence, short-circuit
  evaluation, string escapes, error positions and stable error messages; unknown identifiers, functions/methods,
  macros, member access, comprehensions and trailing illegal tokens all rejected; no dynamic code execution and the
  execution environment contains only the current `value`; non-finite numbers, unsafe integers, BigInt and
  non-JSON-convertible results fail; compiled Programs are cacheable and repeatable with no cross-request mutable
  state; representative CEL standard semantic samples cross-validate the supported subset (no full CEL conformance
  claim); loading and execution verified in Node dev, unit tests, CLI build and SEA/release bundle.
- **Config:** Enum/Limit `map` strict Schema, freezing and JSON round-trip; three-state Overlay per Option Spec
  leaf, model Rule and API Schema Rule merging, Personal overriding last; `map` missing, empty string and CEL compile
  failure; `reasoningLevel.values` checked only for non-empty and `default` belonging to the domain (duplicates and
  semantic order are the publisher's duty); after deleting independent `reasoningMapping` the new Schema rejects the
  old field; Effective Config integrity still covers reasoning default/values and max/default; Config validation
  executes no enum value, traverses no limit and previews no conflicts.
- **CEL and Patch:** Enum string and Limit number as the only `value` input; conditionals, arithmetic and nested
  objects; RFC 7396 add, replace, nested merge, whole-array replacement and `null` delete; no other Option, Context,
  Provider, Model or credential variables; fixed Option order; different object leaves merge, same path and
  parent-child replacement conflicts fail; CEL execution failure and non-object results fail the request with no
  fallback to the old mapping.
- **Wire:** Anthropic `thinking` and `max_tokens`; OpenAI Chat `reasoning_effort` and `max_completion_tokens`;
  OpenAI Responses `reasoning.effort` and `max_output_tokens`; third-party compatible custom paths; Generate/Stream
  final Body identical; Patch effective before request security validation; Model IO, Debug and network capture see
  the same post-Patch Body with sensitive fields redacted; final Body does not keep the AI SDK namespace, old fields
  or duplicate canonical fields; Anthropic no longer runs fixed-thinking subtract-then-add.
- **Runtime/UI regression:** ordinary requests use `default` or the explicit Option; Title, Goal, Git, Recall use
  `values[0]` and synthesize nothing without a Reasoning Spec; Compact, Memory, Subagent, Off-Peak, Repo Wiki keep
  reading this turn's Active Model; Settings shows no Map and editing visible Option fields neither copies,
  overwrites nor clears the Built-in Map; cancelling edit commits nothing and hidden fields are not lost; local and
  remote Registry use the same structure with no second Runtime DTO.

Execution plan (stages): stage 0 independent restricted CEL module verified in Node, CLI build and SEA/release
bundle with an independent Review of the security boundary, the declared restricted-expression semantics and the
fail-closed behavior for unsupported syntax (no Config or Adapter migration before it fully passes); stage A updated
current Model/Configuration/Execution/Settings design and failing tests (Config leaf Overlay, Model freeze, three
Wires, pinning no aggregate Mapping, Context input or old `reasoningMapping`); stage B Config and Built-in
migration; stage C Adapter wire closeout (shared CEL Program, RFC 7396 Patch and runtime path conflict check,
Generate/Stream final JSON Body, deletion of old mappings, Model IO/Debug capture moved to post-Patch pre-validation,
three API Schema wire tests); stage D cleanup (zero old symbols, text, JSON and test helpers; Feature Graph and
current fact docs; verification).

## 12. Completion criteria

The independent restricted CEL module is verified first and is the sole implementation of Config compilation and
Runtime execution; every public Option Spec declares its raw API Schema Request Body projection by its own
`map(value)`, merged through leaf Overlay by model/API/Personal Rules; `reasoningMapping`, `ReasoningParameters`, the
AI SDK namespace mapping for reasoning/max-output and the old integrity loop are fully deleted; `maxOutputTokens`
and Reasoning both form the final raw Body through the Option Map with no second Adapter field mapping; the
Anthropic fixed-thinking budget subtract-then-add and the ZCode middle `budgetTokens` are zero (raw
`thinking.budget_tokens` exists only as an Anthropic Map field); Generate/Stream wire tests for three API Schemas
prove field paths, values and total-output-budget semantics; multi-Option Patch uses fixed order and rejects actual
write-path conflicts; Debug/Model IO equal the final wire Body; Settings, Personal Overlay, Registry, Active Model
and remote sync share one Option Spec structure; Settings exposes no Map editing entry and visible-field editing
never overwrites Built-in Maps; no aggregate Option Mapping, Context input, general Request Adapter, cross-Option
dependency or complex validator is added; targeted and full verification pass; Design, Feature Graph, implementation
and tests agree.

## 13. Outcome and verification

- New pure TypeScript `@zcode/model-option-map` provides the single mapping implementation (restricted CEL, RFC 7396
  Merge Patch, fixed Option order, write-path conflict check).
- Config Schema, sparse Overlay, Built-in Rules, Registry, Active Model, CLI Adapter and Settings are all migrated to
  per-Option `map`.
- The Patch applies after the AI SDK builds the base request body and before request security validation;
  Generate/Stream, Debug, Model IO and real network requests observe the same final Body.
- Deleted: `reasoningMapping`, `ReasoningParameters`, old max-output/visible-output budget conversion, Anthropic
  fixed-thinking add/subtract, OpenAI compatible `extra_body` reasoning projection and related helpers.
- Verification: `@zcode/model-option-map` 25/25 + typecheck + build; `@zcode/provider` 152/152 + typecheck;
  `@zcode/provider-node` 48/48 + typecheck; CLI Adapter 190/190, Core 197/197, Bootstrap 52/52 (typecheck each); UI
  90/90; Contracts typecheck; `pnpm --filter @zcode/cli build`, `pnpm lint`, changed-file format check, Feature
  Graph YAML parse and `git diff --check` passed. Repo-wide gates still report three baseline problems outside this
  Todo: two nullable port type errors in a Desktop E2E helper; repo-wide `fmt:check` failure from Electron doc
  samples and a binary file; the Adapter Bash process-group cleanup test failing to kill descendants that ignore TERM
  in this environment. Affected files' format, types and tests were verified individually.
