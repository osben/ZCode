# Todo 66: Option Map Variable Naming and Display Formatting

> Status: done
>
> 2026-09-09 note: Todo95 later introduced a partial single-line formatting regression, fixed by [Todo98](todo-98-builtin-option-map-formatting-regression.md). The current writing guideline is [Option Map writing style](../design/model/option-map-writing-style.md); simple ternaries stay on one line. The examples below are historical and do not require restoring duplicated branches that were later simplified.
>
> Date: 2026-09-02
>
> Prerequisites: Todo 54 moved request Option mapping into Option Spec `map`; Todo 60 fixed Reasoning Option integrity and the GUI editing boundary. This Todo only improves naming and readability of Map expressions and changes no responsibility of Option, Model Config, Adapter or request parameters.

## 1. Goal

1. Option Map stops using the vague generic variable `value`; it uses the formal name of its owning Option.
2. Built-in Option Map line breaks and indentation follow the reading experience in the settings GUI, not single-line file content.

```text
optionSpecs.<optionName>.map
   -> expression variable = <optionName>
   -> compiled to this request's JSON Merge Patch
```

## 2. Variable naming

```ts
reasoningLevel == "high"
  ? { "reasoning_effort": "high" }
  : { "reasoning_effort": "max" }
```

```text
optionSpecs.reasoningLevel.map  -> variable: reasoningLevel
optionSpecs.maxOutputTokens.map -> variable: maxOutputTokens
```

- The variable is the owning Option's formal field name, same case.
- A Map consumes only its own Option value; it does not expose other Options.
- `value` is deleted with no alias, tolerant read or dual syntax; no migrator (unreleased config).
- Map output stays the JSON Merge Patch used by the current request.

## 3. Built-in Map formatting

Built-in Map strings favor readability in the settings text box. Complex conditions and nested objects use line breaks and two-space indentation:

```ts
reasoningLevel == "low"
  ? {
      "thinking": {
        "type": "adaptive"
      },
      "output_config": {
        "effort": "low"
      }
    }
  : {
      "thinking": {
        "type": "adaptive"
      },
      "output_config": {
        "effort": "max"
      }
    }
```

Simple expressions may stay on one line: `{ "max_tokens": maxOutputTokens }`.

- Complex branches span lines; multi-level objects are expanded; simple Maps are not mechanically expanded.
- `zcode-builtin.json` may contain escaped newlines; physical file compactness is not a goal.
- The GUI shows string newlines and indentation as-is, with no second formatter.
- Personal Map is not auto-reformatted, so saving never rewrites user input.

## 4. Scope

Variable name comes from the owning Option name in the Option Map compile environment; Schema, types and current Design drop `value`; all Built-in Config `value` references switch to Option names; long Reasoning Maps are reformatted; the simple Max Output Map stays one line; GUI placeholder/value tests prove formatting is preserved; constants, fixtures and error text serving only the old `value` are deleted.

## 5. Test boundary

No exhaustive before/after equivalence test for every Built-in Map (variable replacement and formatting are deterministic). Kept evidence: the compiler accepts the owning Option name and rejects old `value`; representative `reasoningLevel` and `maxOutputTokens` Map compile and request-Patch tests; Built-in Config passes the formal Schema and Map compile checks; the settings page preserves Built-in Map newlines and indentation; Personal Map raw formatting is not rewritten on read or save; typecheck, lint, related unit tests and `git diff --check`.

## 6. Non-goals

No change to Option Spec structure, Reasoning level order or `maxOutputTokens.max` capability-limit semantics; no new Map DSL, Formatter Service or versioned expression protocol; one Option Map may not read other Options; no Model settings dialog redesign; no compatibility layer for the unreleased `value` syntax.

## 7. Outcome

- The compiler injects the unique variable name per owning Option and includes it in the compile cache key, so one expression cannot bypass another Option's variable boundary through the cache.
- Schema, integrity validation, Built-in Config, CLI/Service/UI fixtures and current Design use `reasoningLevel` / `maxOutputTokens`; old `value` survives only in rejection tests and history.
- Complex Built-in Reasoning Maps are two-space multi-line; the simple Max Output Map is single-line; Personal Map got no formatting step.
- Provider Node assertions that pinned single-line whitespace now verify variable and mapping content, so display layout is not mistaken for a runtime contract.

Verification: `@zcode/model-option-map` 26 tests, `@zcode/provider` 167, `@zcode/provider-node` 47, CLI Adapter 54, CLI Bootstrap Registry/Model 83, UI/Services/Server 144 (plus 11 UI default-config display tests), typecheck and `git diff --check` all passed.
