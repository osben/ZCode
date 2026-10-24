# Compact Thinking Control

The compact summary is a short auxiliary request. The runtime flag `ENABLE_COMPACT_SUMMARY_THINKING` decides whether the main conversation's reasoning/thinking providerOptions are passed through to compact. It only controls whether the summary uses thinking; Anthropic fixed thinking and visible output still share the compact request's total budget, which the adapter enforces per request without touching main-conversation config.

Behavior:

- `ENABLE_COMPACT_SUMMARY_THINKING` = `false`: the compact summary request disables inherited thinking/reasoning providerOptions.
- `ENABLE_COMPACT_SUMMARY_THINKING` = `true` (current default): compact passes through the current `modelProviderOptions`; Anthropic fixed thinking stays within the request's total budget.
- Regular conversation, subagent, and title-generation requests are unaffected by the flag.

Scope: only compact summary inheritance of reasoning/thinking providerOptions. Not owned here: total-budget enforcement, compact prompt, history selection, UI compact divider, or reasoning config of normal model requests.
