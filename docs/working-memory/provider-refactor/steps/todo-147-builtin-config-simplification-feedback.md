# Todo147: Simplify Built-in Config and Adjust Default Baselines

> Status: Collecting feedback. The directions below are confirmed but not yet implemented.
> Date: 2026-09-15.
> The user asked to create a Todo first and append further feedback here. This round records notes only; do not modify runtime config or publish a revision.

## Goal

Keep the existing Provider/Model hierarchy and ordered overlay while making Built-in Config easier to maintain. Adopt the user-approved assumption of a closed model set and mainstream default baseline; remove special rules that are no longer needed.

Related: [current design](../design-v2/design.md), [Todo76: layering and matching](./todo-76-builtin-provider-config-layering-and-site-rules.md), [Todo138: general reasoning fallback](./todo-138-reasoning-level-ui-and-api-defaults.md).

## Confirmed Feedback

### F01: Use Simple Prefix/Suffix Wildcards for Model Matching

- Consider Model and Model + API rules against a finite, closed set of maintained models; do not add complex boundary regexes for infinitely many unknown model names.
- Rules for the same type of model may be simplified to `.*deepseek-flash.*`; extra suffix-delimiter groups are not required.
- Put generic model rules first and more specific rules, with longer suffixes, later; existing per-field overlays apply differences.
- Config maintainers explicitly write the order and the parser continues to process array order. Do not add sorting by length or a “most similar model” algorithm.
- Continue escaping regex metacharacters in literals correctly, such as decimal points in model versions; simplification does not mean removing all escaping.
- This principle applies only to Model / Model + API matching. Do not loosen Site URL matching or change exact identity matching for Template / Provider + Model.

```text
Generic model rule → more specific model rule → more specific variant rule
                       Later rules override only explicitly declared fields.
```

### F02: Delete the Two Model Rules Identified by the User

Location: `config/provider/zcode-builtin.json`, `config.modelConfigRules.modelRules`.

1. Delete the rule matching `.*\\[1m\\]` that only sets `properties.contextWindow = 1000000`.
2. Delete the rule matching `.*(?:ox-alpha|glm-x-preview-f|x-preview-f-free).*` that only sets `optionSpecs.maxOutputTokens.max = 128000`.

Delete exactly these two complete Model rules. Aliases with the same names also have reasoning levels and request mappings at the Model + API level; this feedback does not ask to remove those rules, template membership, or user-saved model IDs.

### F03: Raise the Generic Default Context/Output Baseline

Change the first generic Model rule, `modelMatch: ".*"`:

| Config field                      | Current value | Approved target |
| --------------------------------- | ------------- | --------------- |
| `properties.contextWindow`        | `200000`      | `1000000`       |
| `optionSpecs.maxOutputTokens.max` | `32000`       | `128000`        |

- Use these values as the mainstream default baseline per the user's decision.
- Here, output means the maximum-output limit in Model Config. Do not add a policy that defaults each request to 128000 output Tokens; do not add another request-default layer.
- Later specific model, protocol, site, and personal rules continue to override in their existing order. Do not force every explicitly declared model limit to the same value.
- Keep existing semantics for generic reasoning levels, media capabilities, and fields not mentioned here.

## Implementation Checklist (Pending)

- [ ] Continue appending user feedback and clarify the actual implementation scope. Review suggestions that have not been approved do not automatically become implementation requirements.
- [ ] Before implementation, update the matching principles and default-baseline description in the current design.
- [ ] Add regression coverage first: generic baseline is 1000000 / 128000, the two rules above are absent, and specific model rules can still override the generic baseline.
- [ ] Use differing base models and variants to verify order and per-field inheritance; do not merely assert that regex strings got shorter.
- [ ] Change the config and review all affected rule ordering, effective capabilities, and option mappings; preserve existing Personal overlays and exact model identity.
- [ ] Update tests that depend on the old generic 200000 / 32000 baseline, distinguishing unknown-model fallback from explicit values for specific models.
- [ ] Run relevant config parsing and request-mapping tests and required repository checks; add interaction verification if there is actual UI impact.
- [ ] At release time, increment the built-in revision from the then-current version and use the existing release path. Do not change the revision while only collecting feedback.

## Feedback Boundaries

This Todo does not automatically include every suggestion from prior reviews. Completing the maintained model list, naming for disabled reasoning, highest-level selection policy, and other topics must be recorded separately based on later user feedback; do not treat discussion points as implementation decisions.

## Record

- 2026-09-15: Created the feedback Todo; recorded F01 simpler matching, F02 removal of two special Model rules, and F03 generic baseline adjustment. Documentation only; configuration remains at its original values.
