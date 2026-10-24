# OpenAI Responses Non-stream JSON Compatibility

> Implemented (2026-07-11). The "compact is fixed non-stream" statements in this history were
> the 2026-07-11 baseline and are no longer the transport contract; the JSON normalizer and
> its provider boundary remain valid and now serve the HTTP fallback leg of
> [Compact Stream-first → Non-stream Fallback](../specs/2026-07-15-compact-stream-first-nonstream-fallback-design.md).
> Full contract: [design doc](../specs/2026-07-11-openai-responses-nonstream-json-compat-design.md).

Kept facts:

- `createOpenAIResponsesJsonCompatFetch()` normalizes only two confirmed missing fields —
  `output[].id` (filled as `msg_<UUIDv4>` via `node:crypto.randomUUID()`) and
  `output_text.annotations` (filled as `[]`) — for 2xx non-SSE JSON Responses bodies.
- It is composed only into the `providerKind === "openai"` factory branch
  (`apps/zcode-cli/packages/adapters/src/model/model-execution.ts`) that returns
  `provider.responses`; no URL/method/model-name protocol guessing, and it never enters the
  shared `createProviderBusinessErrorFetch()` or other factory branches.
- E2E evidence: `openai-responses-compact` fake case in
  `apps/zcode-cli/e2e/compact-microcompact/` is the provider-input variant recorded under
  F08 in `docs/conversation-session-case-catalog.md`; it proves main SSE plus non-stream
  compact through one real registry. The scripted provider supports raw SSE
  (`bodyText`/`headers`) and case-local provider `kind`/`model` overrides; single-case runs
  may override the suite's top-level `model`.
