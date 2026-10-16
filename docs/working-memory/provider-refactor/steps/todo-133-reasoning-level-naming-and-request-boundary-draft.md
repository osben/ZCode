# Todo133: Naming Reasoning Levels and Request-construction Boundaries

> Status: **Draft only, recording discussion; implementation is not authorized and the naming decision has not been made.**
>
> On 2026-09-12 the user asked to record a draft and move on to another issue. This item is not part of the previously delivered 19 items. Do not automatically resume that Goal or change configuration, migrations, or the SDK.
>
> Related: [Todo95, normalization of disabled levels](./todo-95-builtin-reasoning-map-simplification-and-fallback.md), and [Todo113, second-round catalog and configuration](./todo-113-round2-research.md).

## Background and Verified Facts

- The user is concerned with whether old and new models use the same naming standard, not just whether one model's name was changed back and forth.
- Todo95 commit `2c1addd3d8` changed `off` on 24 rules and `nothink` on one rule to `disabled`; the existing GPT-5.6 `none` values were retained. The current old-value conversion entry point handles only source-scoped `off/nothink`.
- Todo113 commit `262c42e592` added dedicated value ranges containing `none` for GPT-5.4 / Mini / Nano and Qwen3.8 Omni. These models previously lacked dedicated configuration and may have used a general fallback with only `disabled`.
- As a result, a mixture exists: older models use normalized `disabled`, while newer models use native `none`. This was consistent with the then-allowed native-`none` exception, but whether to retain the exception needs another discussion.
- The current primary request path validates the reasoning level first; after the SDK constructs the request body, `model-option-map-fetch.ts` applies the Reasoning Map to the final JSON. The inspected first-party execution path did not show a branch that packages messages based on `reasoningLevel === "none"`. This does not prove that no such branch exists in any SDK internals, and it is not a confirmed SDK bug.

```text
Selection level → domain validation → retained as Map input
                                        |
SDK constructs messages/request body     |
          |                              |
          +----→ apply Reasoning Map → send request

If the SDK needs reasoning state before packaging: a final JSON Patch may not override behavior at that stage.
```

## User Concern

The user does not insist on our own name for a disabled state and is open to following the vendor. However, a vendor may not have a string-valued reasoning level that can be copied directly; disabling may instead be expressed through `thinking.type`, a boolean switch, an omitted field, or a request-construction branch. Standardizing names or copying vendor terminology alone does not replace checking execution semantics.

## Directions for Discussion (None Is an Implementation Decision)

1. **Standardize the internal disabled identifier:** use `disabled` in all built-in configuration and express native request parameters through the Map; remove the native-`none` exception. Assess impacts on existing selections and personal Maps.
2. **Prefer vendor naming:** retain native levels where provided and choose a stable name when there is only a boolean switch and no native disabled name. This requires accepting or resolving cross-model selection-value differences and defining the rule for new models, rather than making an ad hoc decision each time.
3. **Request-stage boundary:** first verify whether a specific SDK/API consumes reasoning state before packaging. If it does, define the correct adaptation point. Do not try to fix it by changing the string name, and do not create global state or a conversion layer without evidence.

## Follow-up Investigation and Acceptance Scope

- [ ] Compare current model/API/site rules and list disabled values, actual request fields, and differences among default, disabled, and low-strength reasoning; pay special attention to models without an official disabled enum.
- [ ] Trace the real request-construction path in the SDK. Use discriminating captured requests to verify whether the Map is applied too late; checking only whether the target field appears in final JSON is insufficient.
- [ ] Decide separately what rules naming, UI copy, and request parameters follow before changing configuration or adapter code.
- [ ] If names change, assess saved `none` selections and fallback `disabled` selections, personal value ranges, and Maps. Define a bounded conversion scope; do not globally replace historical data.
- [ ] After a decision, update the spec and add a failing test before implementation. Organize verification according to actual impact; do not use this draft to start a broad regression.

## Boundaries

- `minimal/low` does not automatically mean disabled; omitting a parameter does not automatically mean disabled; do not invent a disabled capability for models that do not support it.
- Do not make the shared Runtime distribute vendor-level string guessing. The current Map handles only request-body changes it can express; do not claim that it covers all pre-packaging differences.
- Do not silently change user-defined value ranges/Maps, historical execution records, or currently running Models. Decide how old/new selections are handled only after a formal decision on this item.
- This document only records the issue and candidate approaches. It does not claim a new request bug was found and does not implement Kimi Code plan support or other deferred features.
