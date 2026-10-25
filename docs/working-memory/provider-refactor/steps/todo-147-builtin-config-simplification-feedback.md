# Todo147: Simplify Built-in Config and adjust default baselines

> Status (2026-09-15): collecting feedback. The directions below are confirmed but not implemented. The
> user asked to create the Todo first and append further feedback here; this round records notes only
> and does not modify runtime config or publish a revision.

## Goal

Keep the Provider/Model hierarchy and ordered overlay while making Built-in Config easier to maintain, on
the user-approved assumption of a closed model set and a mainstream default baseline; remove special
rules that are no longer needed.

Related: [current design](../design-v2/design.md),
[Todo76: layering and matching](./todo-76-builtin-provider-config-layering-and-site-rules.md),
[Todo138: general reasoning fallback](./todo-138-reasoning-level-ui-and-api-defaults.md).

## Confirmed feedback

### F01: Simple prefix/suffix wildcards for model matching

- Model and Model + API rules are considered against a finite, closed, maintained model set; no complex boundary regexes for infinitely many unknown names.
- Rules for one kind of model may be simplified to `.*deepseek-flash.*`; no extra suffix-delimiter groups.
- Generic model rules go first, more specific rules (longer suffixes) later; existing per-field overlays apply the differences.
- Maintainers write the order explicitly and the parser keeps processing array order; no sort by length or "most similar model" algorithm.
- Regex metacharacters in literals (for example decimal points in versions) are still escaped correctly.
- Applies only to Model / Model + API matching: Site URL matching is not loosened and exact identity matching for Template / Provider + Model is unchanged.

```text
generic model rule -> more specific model rule -> more specific variant rule
later rules override only explicitly declared fields
```

### F02: Delete two model rules

In `config/provider/zcode-builtin.json`, `config.modelConfigRules.modelRules`, delete exactly these two complete rules:

1. the rule matching `.*\\[1m\\]` that only sets `properties.contextWindow = 1000000`;
2. the rule matching `.*(?:ox-alpha|glm-x-preview-f|x-preview-f-free).*` that only sets `optionSpecs.maxOutputTokens.max = 128000`.

Aliases with the same names also have reasoning levels and request mappings at the Model + API level; those
rules, template membership and user-saved model IDs are not removed.

### F03: Raise the generic default context/output baseline

Change the first generic Model rule (`modelMatch: ".*"`):

| Config field                      | Current value | Approved target |
| --------------------------------- | ------------- | --------------- |
| `properties.contextWindow`        | `200000`      | `1000000`       |
| `optionSpecs.maxOutputTokens.max` | `32000`       | `128000`        |

"Output" is the maximum-output limit in Model Config; no policy defaulting each request to 128000 output
tokens and no extra request-default layer. Later specific model, protocol, site and personal rules keep
overriding in their existing order; explicitly declared model limits are not forced to one value. Generic
reasoning levels, media capabilities and other fields are unchanged.

## Open implementation checklist

- [ ] Keep appending user feedback and clarify the actual scope; unapproved review suggestions do not become requirements.
- [ ] Update the matching principles and default-baseline description in the current design before implementing.
- [ ] Regression coverage first: generic baseline is 1000000 / 128000, the two rules are absent, specific model rules still override the baseline.
- [ ] Verify order and per-field inheritance with different base models and variants (not just shorter regex strings).
- [ ] Change the config and review rule ordering, effective capabilities and option mappings; keep Personal overlays and exact model identity.
- [ ] Update tests that depend on the old 200000 / 32000 baseline (distinguish unknown-model fallback from explicit values for specific models).
- [ ] Run config parsing and request-mapping tests and required repository checks; add interaction verification if the UI is actually affected.
- [ ] At release, increment the built-in revision from the then-current version via the existing release path; no revision change while only collecting feedback.

Boundary: not every earlier review suggestion is included. Completing the maintained model list, naming
for disabled reasoning, highest-level selection policy and similar topics need separate user feedback.

Record: 2026-09-15 created; F01-F03 recorded; documentation only, configuration remains at its original values.
