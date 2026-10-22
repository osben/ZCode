# UI test translation ledger

Upstream (3.16.1, `0a1fc56d`) UI tests that still assert zh-CN behavior were translated to English (`en-US`) against the current fork sources. Files whose translated version passes are committed. Files that fail only because the fork source has not been ported yet are listed here as awaiting source and are not committed in failing form.

## Awaiting source

None.

## Resolved

- `packages/ui/test/agentToolCallBlock.test.ts`: the planned assertion `not.toContain(expectedCopy("chat.toolCall.agent.fallback"))` was dropped. It was not part of upstream `0a1fc56d`: upstream's "never falls back" test asserts only `not.toContain("在右侧打开")`, which the fork already checks through `expectedCopy("chat.toolCall.agent.openInSidePane")`. The assertion could not hold in either tree because upstream `agent.tsx` also sets `kindLabel={fallbackLabel}` (the outer kind is always "SubAgent"), and seven tests require that label. The fork therefore keeps upstream test content and `agent.tsx` unchanged. A separate case, "shows the fallback copy as summary text only when no subagent name is available", covers the fallback path through the summary trigger's `title`.
