# Chat timeline labels: reasoning duration and compaction markers

Scope: the copy rendered by the reasoning disclosure trigger (`packages/ui/src/components/ai-elements/reasoning.tsx`) and the context compaction marker (`packages/ui/src/v4/ConversationRowView.tsx`). QA references: ISSUE-059, CH-01, CH-26.

## Reasoning duration label

- While reasoning streams collapsed, the trigger reads "Thinking" with the streaming summary.
- With a known duration of N whole seconds, it reads "Thought · N second(s)". The count is pluralized through `intl.formatPlural` on the `chat.reasoning.durationSeconds` family. Catalogs:
  - en-US: `.one`/`.other`.
  - zh-CN: `.other` only. The en `.one` key is in the parity allowlist.
  - uk-UA: `.one/.few/.many/.other`, each with `{count}`.
- N is whole seconds rounded up with a floor of 1 everywhere: the component's own timer, its value at stream end, and `ReasoningRowView` (`Math.max(1, Math.ceil(ms / 1000))`). A sub-second block never reads "0 seconds".
- With no known duration, it reads "Thought · a few seconds" (`chat.reasoning.durationFewSeconds`).

### Known gap (deferred, needs a product decision)

The settled timeline does not keep the live duration:

```text
CLI ProductProjection ── reasoning row (durationMs never set) ──► UI ReasoningRowView
                                                                   │ duration prop: undefined
Reasoning (local timer state) ── lost when the history Collapsible unmounts its content
                                                                   ▼
                                                   "Thought · a few seconds"
```

- The projection's `closeReasoningRow` never sets `ReasoningRow.durationMs`.
- The persisted `ReasoningPart.time` spans the whole model call, not the reasoning span. So cold hydration cannot rebuild an accurate value.
- Making live, settled and reloaded turns agree needs these together:
  - the runtime persists the real reasoning span;
  - hydration replays it;
  - the projection sets `durationMs`.

Until then, a remounted reasoning block falls back to "a few seconds".

## Context compaction marker

- The `compact` marker label key is `<scope>.<status>`:
  - `<scope>` is `chat.contextOptimization` for an auto run in office mode, and `chat.contextCompaction` otherwise.
  - `<status>` is one of `started`, `skipped`, `interrupted`, `failed`, `completed`.
  - A successful auto run outside office mode uses `completedAuto` instead.
- Every key this produces exists in en-US, zh-CN and uk-UA. A raw key must never render. These ids are built dynamically, so unused-key pruning must keep them. `i18nCatalogParity.test.ts` enumerates the set.
