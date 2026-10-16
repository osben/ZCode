# Model Option Map and Raw Request Body

> Status: Current effective design
>
> Last updated: 2026-09-02

## Goal

`reasoningLevel` and `maxOutputTokens` are ZCode's public Model Options. Each Option Spec simultaneously declares the value domain and its mapping to the target API's raw JSON Request Body:

```ts
interface EnumOptionSpec {
  type: "enum";
  /** Ordered from lowest to highest by semantic intensity; values[0] is the lowest public level. */
  values: readonly string[];
  map: string;
}

interface LimitOptionSpec {
  type: "limit";
  max: number;
  map: string;
}
```

`map` is a constrained CEL expression. Its only readable variable is the Option it belongs to by name: `reasoningLevel.map` reads
`reasoningLevel`, `maxOutputTokens.map` reads `maxOutputTokens`. The expression returns an RFC 7396
JSON Merge Patch Object. Config, Registry, Active Model, and Runtime share the same field names and facts; no separate
`reasoningMapping`, AI SDK `providerOptions` mapping, or output budget compatibility DTO is established.

## Single Execution Chain

```text
Effective Model Config
        |
        | complete optionSpecs
        v
ModelFactory creates Active Model
        |
        | Compile each map once
        v
Model.bind / ModelRequest options
        |
        | bound < request; must be complete before entering Executor
        v
Effective Request Option values
        |
        | reasoningLevel, then maxOutputTokens
        v
Ordered JSON Merge Patches
        |
        v
AI SDK has already completed protocol serialization and schema-compatible raw JSON Body
        |
        | Apply Patch, and record Model IO
        v
Business Header / dynamic auth / request security check / network send
```

Map must be applied after AI SDK and protocol compatibility layers have formed the final JSON Body, but before dynamic request security checks. `generateText()` and
`streamText()` share the same executor; Model IO captures the request body truly sent after the Patch. Runtime does not simultaneously pass
AI SDK standard `maxOutputTokens` or reasoning namespace; otherwise a second set of request field authorities is formed.

## Constrained CEL

The sole implementation is in the pure TypeScript package `@zcode/model-option-map`, jointly used by Provider Config validation and CLI Adapter. The implementation is fixed as tokenizer, parser, AST evaluator; `eval`, `Function`, or dynamic code execution is prohibited.

Supported:

```text
The same-name variable belonging to the Option (`reasoningLevel` or `maxOutputTokens`)
string / number / boolean / null
object / array literal
== != < <= > >=
+ - * / %
&& || !
condition ? whenTrue : whenFalse
parentheses
```

Each Map only exposes its own same-name variable; the old generic variable `value` is not supported. Functions, methods, member access, macros,
comprehension, other Options, Provider/Model/credential objects, time, random numbers,
and any IO are not supported. Numbers uniformly use JavaScript `number`; arithmetic, comparison, division, and modulo all follow JavaScript numeric semantics; this constrained expression does not implement CEL's `int` / `double` type distinction or integer division. Numeric input and calculation results must be safely representable as finite JSON numbers; Maps must ultimately return JSON Objects.

## Overlay and Completeness

`optionSpecs.reasoningLevel` and `optionSpecs.maxOutputTokens` in Rule Input are both nestable sparse Overlays;
`type`, value domain, max, and map can be independently inherited, overridden, or cleared with `null`. Effective Model Config must obtain
complete Option Specs:

- `maxOutputTokens` must have a valid `type/max/map`;
- `reasoningLevel` must have valid `type/values/map`;
- `reasoningLevel.values` is non-empty, has no blank items, no duplicates, and is ordered from low to high by semantic intensity; clients do not guess semantics by name;
- All maps must be compilable by the same constrained CEL compiler, and return Object Patches;
- No incompatible reading of unpublished `reasoningMapping`, nor dual-read or importer establishment.

The settings page edits Reasoning Maps in a fixed-height technical text box. Personal Maps are input values, Inherited Maps are placeholders;
clearing input means deleting the Personal `map` leaf and restoring inheritance. The Renderer still only maintains sparse Personal Model Rules and cannot reverse-expand Inherited values into Personal overrides. Max Output Maps are not yet open for editing; other fields must be preserved as-is when saving.

## Patch Order and Conflicts

The same request executes in a fixed order:

```text
reasoningLevel.map
        |
        v
maxOutputTokens.map
```

Both Maps can write to different leaves under the same object, such as `reasoning.effort` and `reasoning.max_tokens`. If they write to the same
path, or one writes to a parent path while the other writes to its child path, the request fails explicitly before the network; do not rely on overlay order to silently determine results. In RFC 7396, `null` means field deletion; arrays and other non-Object values are replaced wholesale at the corresponding path.

## Typical Schemas

```text
Anthropic Messages
├─ reasoningLevel -> thinking.type or output_config.effort
└─ maxOutputTokens -> max_tokens

OpenAI Chat Completions
├─ reasoningLevel -> reasoning_effort (or compatible fields confirmed by evidence)
└─ maxOutputTokens -> max_completion_tokens / max_tokens

OpenAI Responses
├─ reasoningLevel -> reasoning.effort
└─ maxOutputTokens -> max_output_tokens
```

Specific expressions only belong to the Model Config Rule that hits `providerId/modelId/api.type/baseURL`. Runtime and Adapters are prohibited from re-inferencing these fields based on specific model IDs, Provider IDs, or API types.

## Built-in Fallback and Specific Rules (Todo 95)

Expression writing and layout uniformly follow the [Option Map Writing Style](option-map-map-writing-style.md): object expansion, two-space indentation, simple ternary on one line. The writing style is maintained separately from the following transformation/compatibility constraints.

- Specific Map organization only allows request equivalence for valid inputs: same-name effort is directly passed through, conditions sink to changed fields; whether a field exists is the only reason to keep object branches. Do not use `null` instead of omission, nor change modes, budgets, and value domains.
- API Schema fallback enhancement: Chat Completions simultaneously outputs `thinking.type`, `enable_thinking`, `reasoning_effort`, `reasoning.effort`; closing `disabled/none` uniformly converts to a closing switch and effort `none`; Responses only use `reasoning.effort`; Messages are `disabled` or Adaptive + original effort, without adding manual budget mode.
- Mixed Chat fallback depends on user-accepted assumptions: unknown fields are ignored, consistent duplicate controls can coexist, extra effort can be ignored or allowed `none` in closing mode. Not all sites have verified guarantees; incompatible normal errors, do not delete fields and retry.
- Generic values still only include `disabled`; additional valid levels can only be used when those levels are added; specific rules and Personal Maps still override fallback by existing Overlay order. Reasoning Maps do not write output limits.
- Non-native closing level renames as a separate compatibility change; without Personal Map-only override and execution entry security validation, do not change `off/nothink` to `disabled`. Limited-source old selection compatibility cannot replace user Map semantics protection.
