# Option Map Writing Style

> Status: Decided; 2026-09-09. Applies to the writing and review of Built-in specific and fallback Option Maps.
> This document only stipulates the writing and display layout of expressions; it does not stipulate migration, historical compatibility, or feature transformation strategies.

## 1. General Principles

Simplify expression logic, but do not compress structure. Readability in the settings page text box is the standard; physical line count of JSON config files is not.

- Nested objects are expanded by level with uniform two-space indentation; sibling fields are on separate lines.
- Simple, non-nested ternary expressions are kept on one line, not mechanically split into three lines.
- Complex or nested conditions are line-broken by branch; indentation shows ownership; split by semantics when too long, do not rely on text box soft line-breaks to show structure.
- Simple single-layer objects can be on one line; not all Maps need to be expanded.

```js
{
  "thinking": {
    "type": reasoningLevel == "enabled" ? "enabled" : "disabled"
  }
}
```

Simple single-layer objects:

```js
{"max_tokens": maxOutputTokens}
```

## 2. Conditions Where They Differ

- When only field values differ, share the object structure and sink conditions to the corresponding field.
- When branches change whether a field exists or the object structure, keep object-level branches; do not cram unrelated fields in to write fewer branches.
- Do not redundantly expand nearly identical complete objects.

When object branches are needed, for example:

```js
reasoningLevel == "disabled"
  ? {
      thinking: {
        type: "disabled",
      },
    }
  : {
      thinking: {
        type: "adaptive",
      },
      output_config: {
        effort: reasoningLevel,
      },
    };
```

Examples only illustrate structure writing; they do not require all models to use these fields or levels.

## 3. Pass Through When Possible

When the values accepted by the target field are the same as the value of the owning Option, directly use the variable; do not enumerate `low → low / high → high / max → max` synonymous condition chains. Only perform necessary transformations for closing states or different interface values.

Variable names use the formal name of the owning Option, such as `reasoningLevel`, `maxOutputTokens`; do not introduce ambiguous generic `value`.

## 4. Layout Ownership

- Line breaks and indentation are preserved in the Built-in Map source string; JSON files may appear as `\n` escapes.
- The GUI displays the source string as-is; no second display format, Formatter Service, or runtime rearrangement is added.
- Do not auto-format users' Personal Maps; opening, viewing, or canceling edits must not generate personal overrides or write to disk due to layout.
- This standard applies uniformly to both specific Maps and fallback Maps, regardless of vendor, theme, language, or window width.

## 5. Separate from Transformation Principles

"Modifying existing rules must maintain request behavior equivalence," "whether to migrate old levels," and "whether to be compatible with old configs" belong to the boundaries of their corresponding transformation Todos; they are not writing style rules. Do not mix these into this document's style requirements.

Related: the original layout convention is documented in [Todo66](../../steps/todo-66-option-map-variable-naming-and-display-formatting.md); this regression fix is documented in [Todo98](../../steps/todo-98-builtin-option-map-formatting-regression.md).
