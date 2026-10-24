# Compact media capability projection

## Problem

Normal model requests project history messages against the executing model's input capabilities before the provider call: when `properties.input_format.support_image === false` or `support_pdf === false`, the matching media blocks are replaced with an explicit text placeholder. Compact summary requests reuse the MCS / system-reminder provider-message projection, but previously skipped media capability projection, so a text-only model failed with `invalid_model_request` upon receiving historical media blocks.

## Semantics

```text
RuntimeMessageEntry history
        |
        v
buildCompactSummaryRequestMessages
  - attachment / reminder ordering
  - MCS or <system-reminder> projection
  - compact prompt and cache control
        |
        v
project media capabilities for the compact executing model
  - support_image === false -> image replaced with the standard omitted text
  - support_pdf === false   -> PDF replaced with the standard omitted text
  - true                    -> media kept on the first request
        |
        v
existing media_too_large fallback (retry only after failure)
        |
        v
Compact ModelRequest event and provider request
```

- Manual, automatic, and Reactive Compact must all pass through this one projection boundary.
- Capabilities come from this run's `compactModel.properties`; never fall back to the session default model or a stale snapshot from the parent turn.
- The `ModelRequest` event must record the projected provider-visible messages.
- Capability projection happens before the first request; it must not rely on retrying after an `invalid_model_request` failure.
- The existing `media_too_large` retry semantics are unchanged: with capability `true`, media stays in the first request, and the compact-specific short placeholder is used only after the provider explicitly reports oversized media.
- Compact keeps its own stream/non-stream fallback, summary output cap, tool surface, cache-control, and prompt-too-long re-selection logic; it does not switch wholesale to the normal turn's model-request function.

## Acceptance

- With a text-only model and an automatic Compact over history containing images, the request contains no `image` block, includes the standard `Media omitted from provider request` text, and Compact completes normally.
- With `input_format.support_image: true`, the first Compact request still keeps the images. Active Model Properties are the complete truth; there is no "capability unknown" runtime state.
- Image and PDF capability projection share one generic helper; the existing `media_too_large` two-phase request tests keep passing.
