# UI test translation ledger

Upstream (3.16.1, `0a1fc56d`) UI tests that still assert zh-CN behavior were translated to English (`en-US`) against the current fork sources. Files whose translated version passes are committed. Files that fail only because the fork source has not been ported yet are listed here as awaiting source and are not committed in failing form.

## Awaiting source

- `packages/ui/test/agentToolCallBlock.test.ts`: test "never falls back to inline prompt or child output" asserts `not.toContain(expectedCopy("chat.toolCall.agent.fallback"))` on rendered HTML. The fork's `agent.tsx` always renders the catalog-localized kind label ("SubAgent" in en-US, around `agent.tsx:355`), so the upstream expectation that the generic label never appears cannot hold until the source is ported. The other 16 tests in the file pass against the translated version.
