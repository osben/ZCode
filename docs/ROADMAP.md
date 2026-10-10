# ZCode Roadmap

Ideas and planned work that are not yet implemented. Each entry records the motivation, what is
already known (with sources), open questions, and a phased plan. Before implementing an entry,
write or update its spec as required by `AGENTS.md`.

Status legend: `idea` → `research` → `planned` → `in progress` → `done`.

---

## Prompt-cache TTL indicator (Z.ai)

**Status:** `research`

### Motivation

Z.ai caches repeated prompt context, and cache hits cost about 50% of normal input tokens and
respond faster. The cache expires after an idle period. If the user leaves a long session alone
past that point, the next turn re-processes the whole context at full price. A subtle indicator
showing when the cache is likely to expire would let the user decide whether to continue now or
accept a cold start.

### What the API provides (confirmed)

- The Z.ai Context Caching docs (<https://docs.z.ai/guides/capabilities/cache>) describe the cache
  as **implicit and automatic**. The only statement about lifetime is "Cache has reasonable time
  limits, will recalculate after expiration". **No TTL value is documented.**
- Responses contain **token counts only**. They include no TTL, no expiry timestamp, and no
  cache-related headers:
  - OpenAI-compatible `/api/paas/v4`: `usage.prompt_tokens_details.cached_tokens`.
  - Anthropic-compatible `/api/anthropic` (used by the ZCode Coding Plan):
    `usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens`. On Z.ai these values
    arrive in the final `message_delta` event, not in `message_start`.
- Billing: cache-hit tokens are billed at a discount (the docs say "usually 50% of standard price").

### What ZCode already has

- Requests mark cache breakpoints with `cache_control: { type: "ephemeral" }` and **no `ttl`**:
  - `apps/zcode-cli/packages/core/src/context/builder.ts`
  - `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts`
- The model contract already accepts `ttl?: "5m" | "1h"`
  (`apps/zcode-cli/packages/contracts/src/model/index.ts`, `ModelCacheControl`).
- Every model request emits a `usage.delta` telemetry fact with `cacheReadTokens` and
  `cacheWriteTokens` (`packages/shared/src/zcode-protocol-v4/telemetry.ts`).
- The composer's context-usage popover is a natural UI home
  (`packages/ui/src/chat-input-toolbar/contextUsage.tsx`).

### Open questions (unverified)

- What the real TTL is on Z.ai. Under Anthropic semantics the default is 5 minutes and every hit
  refreshes it. Some third-party summaries claim the same for Z.ai, but no primary source confirms
  it.
- Whether Z.ai honors `cache_control.ttl: "1h"`, and at what write price.
- Whether a cache hit refreshes the TTL (a sliding window) or the TTL is fixed from creation.
- The cache key scope (API key, account, or region), and which changes invalidate it: model
  switch, system-prompt or tool-list change, or compaction.

### Conclusion

The server gives no countdown data, so any indicator must be **client-derived**:

```
expiresAt ≈ lastCacheActivityAt + ttl(provider)
```

The UI must present this as an **estimate** (`≈`), never as server truth.

### Plan

**Phase 0: TTL probe (spike)**

- Write a script that sends an identical long prefix (≥ several thousand tokens) to the Coding
  Plan Anthropic endpoint at increasing idle gaps (1, 3, 5, 6, 10, 30, 60 min) and records
  `cache_read_input_tokens` / `cache_creation_input_tokens`.
- Repeat with `cache_control.ttl: "1h"`.
- Test sliding refresh: hit the cache at t=4 min, then probe at t=8 min.
- Record the results in the spec. They decide the per-provider TTL constants.

**Phase 1: Client-side estimate and indicator**

- State owner: the session telemetry projection, not local component state. On each `usage.delta`
  where `cacheReadTokens + cacheWriteTokens > 0`, record `lastCacheActivityAt` for the session.
  Track it per provider and model, because switching models changes the cache.
- TTL source: a per-provider constant in provider config, with a default for unknown providers.
  Hide the indicator when the TTL is unknown.
- UI: a quiet state chip or countdown in the context-usage popover, with an optional dot on the
  trigger:
  - `warm`: more than about 60 s left
  - `expiring soon`: 60 s or less left, shown with emphasis
  - `cold`: expired; the next turn rebuilds the cache
- Show the last turn's cache hit rate (`cacheRead / input`) next to the indicator as evidence.
- Follow `DESIGN.md` and reuse existing popover and progress components. Support desktop and
  mobile Web, both themes, and i18n.

**Phase 2: Optional improvements**

- If Phase 0 confirms support and pricing makes sense, send `ttl: "1h"` for Z.ai on long agentic
  sessions, and make it configurable.
- Possibly add a "keep warm" hint. Do not ping automatically in the background, because that
  spends quota without user intent.

### Acceptance criteria

- The indicator appears only for providers with a known TTL and after at least one cache activity
  in the session.
- The countdown resets on every turn that reads or writes the cache, and shows `cold` after expiry.
- Resuming or reconnecting a session (desktop-continuous and web-remote-replayable) restores the
  estimate from telemetry and never shows a stale `warm` state.
- The copy states that the value is an estimate.

### Risks

- The TTL is not documented and Z.ai may change it silently. Keep it configurable and re-run the
  probe periodically.
- Cache hits depend on prefix similarity. A warm timer does not guarantee a hit if the context
  changed, for example after compaction or tool-list changes.
