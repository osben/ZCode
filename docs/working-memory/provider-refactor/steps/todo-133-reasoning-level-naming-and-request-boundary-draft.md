# Todo133: Naming reasoning levels and request-construction boundaries

> Status: draft only (2026-09-12). Discussion is recorded; the naming decision has not been made and
> implementation is not authorized. Do not change configuration, migrations or the SDK on this basis.
>
> Related: [Todo95, normalization of disabled levels](./todo-95-builtin-reasoning-map-simplification-and-fallback.md),
> [Todo113, second-round catalog and configuration](./todo-113-round2-research.md).

## Background and verified facts

- The concern is whether old and new models share one naming standard for the "reasoning disabled" level.
- Todo95 (`2c1addd3d8`) changed `off` on 24 rules and `nothink` on one rule to `disabled`; existing GPT-5.6 `none` values were kept. The old-value conversion entry handles only source-scoped `off/nothink`.
- Todo113 (`262c42e592`) added dedicated value ranges containing `none` for GPT-5.4 / Mini / Nano and Qwen3.8 Omni (previously without dedicated config, possibly on a general fallback with only `disabled`).
- Result: older models use normalized `disabled`, newer ones native `none`. This matched the then-allowed native-`none` exception; whether to keep the exception needs a separate discussion.
- The primary request path validates the reasoning level first; after the SDK builds the request body, `model-option-map-fetch.ts` applies the Reasoning Map to the final JSON. The inspected first-party execution path has no branch that packages messages based on `reasoningLevel === "none"`. This does not prove no SDK-internal branch exists, and it is not a confirmed SDK bug.

```text
Selection level -> domain validation -> retained as Map input
SDK builds messages/request body -> apply Reasoning Map -> send request
If the SDK needs reasoning state before packaging, a final JSON patch may not override behavior at that stage.
```

The user is open to following vendor naming for a disabled state, but a vendor may have no string-valued
level (disabling may be `thinking.type`, a boolean, an omitted field or a request-construction branch), so
standardizing names alone does not replace checking execution semantics.

## Candidate directions (none decided)

1. Standardize the internal disabled identifier as `disabled` in all built-in configuration and express native request parameters through the Map; remove the native-`none` exception. Assess impact on existing selections and personal Maps.
2. Prefer vendor naming: keep native levels where provided and choose a stable name when only a boolean switch exists. Requires accepting cross-model selection-value differences and defining the rule for new models.
3. Request-stage boundary: first verify whether a specific SDK/API consumes reasoning state before packaging; if so, define the correct adaptation point. Do not fix it by renaming strings and do not add global state or a conversion layer without evidence.

## Open follow-ups

- [ ] Compare current model/API/site rules: list disabled values, actual request fields, and differences among default, disabled and low-strength reasoning; pay attention to models without an official disabled enum.
- [ ] Trace the real SDK request-construction path with discriminating captured requests to check whether the Map is applied too late (checking only that the field appears in final JSON is insufficient).
- [ ] Decide separately what rules naming, UI copy and request parameters follow before changing config or adapter code.
- [ ] If names change, assess saved `none` and fallback `disabled` selections, personal value ranges and Maps; define a bounded conversion scope, no global replacement of historical data.
- [ ] After a decision, update the spec and add a failing test before implementation; scope verification to actual impact.

## Boundaries

- `minimal/low` does not automatically mean disabled; an omitted parameter does not automatically mean disabled; no disabled capability is invented for unsupporting models.
- The shared Runtime does not do vendor-level string guessing. The Map handles only request-body changes it can express; it is not claimed to cover all pre-packaging differences.
- Do not silently change user-defined value ranges/Maps, historical execution records or running Models; old/new selection handling is decided only after a formal decision.
- This document records the issue and candidates only; it claims no new request bug and does not implement Kimi Code plan support or other deferred features.
