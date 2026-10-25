# WebSearch Client Tool Implementation Plan

> **Status 2026-06-08:** Implemented. Final focused tests, CLI typecheck, explicit build and prompt-trajectory e2e passed. Final trajectory evidence is two local (not checked in) records under `tools/prompt-trajectory/out/`: the P-12 outer request `test20260608-213225` and the internal request `final3`. Full CLI lint/test still have unrelated pre-existing failures documented in the final implementation report.

**Goal:** Switch ZCode WebSearch from a direct provider-native `web_search` in the main request to a client tool + internal side request. The outer request exposes an ordinary `WebSearch` client tool; the handler issues an internal model request containing only the provider-native `web_search`, and feeds the result back to the main model as an ordinary tool result.

**Architecture:** The main model request sees only the `WebSearch` function tool; `web_search` appears only in the internal side request of the `WebSearch` handler. Runtime registry, permission, scheduler, hooks, tool parts, history and nested usage treat WebSearch as an ordinary client-side tool. The adapter's provider-native helper mapping stays but serves only the internal request.

**Tech stack:** TypeScript, Zod, Vercel AI SDK tool helpers, Vitest, prompt-trajectory, ZCode core runtime/tool registry/adapter contracts.

## Commit policy

The user asked not to auto-commit unless they ask. Each phase may suggest a commit message; run no `git commit` unless the user explicitly asks in that turn, and ask before `git add`.

## Source references

- Spec rewritten by this plan: `apps/zcode-cli/docs/design/v2/tool/13-websearch.md`; tool change chain `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md`.
- Handler `packages/core/src/tool/handlers/websearch.ts`; result formatter `websearch-results.ts`; provider support helper `websearch-support.ts`; runtime direct append (removed) `packages/core/src/runtime/methods/config.ts`; public/native schema `packages/contracts/src/tools/websearch.ts`; adapter mapping `packages/adapters/src/model/tool-transform.ts`.

## Frozen decisions

| ID | Decision |
| --- | --- |
| WS-D1 | The outer provider-visible tool name is `WebSearch`, not `web_search`. |
| WS-D2 | The outer `WebSearch` is a client-side tool and must go through ToolExecutor, permission, scheduler, hooks, tool part persistence and tool result history. |
| WS-D3 | The only tool of the internal side request is provider-native `web_search`, mapped by the adapter to the Anthropic provider's native web search helper. |
| WS-D4 | The outer public schema uses snake_case domain fields: `query`, `allowed_domains`, `blocked_domains`. |
| WS-D5 | Keep only the optional public tuning field `maxUses` that the Anthropic provider-native `web_search` actually consumes, passed through to the internal provider-native args. `searchContextSize` is no longer exposed (it would be a no-op contract). |
| WS-D6 | `web_search` may map to `WebSearch` as a legacy allowlist alias but must never appear in the outer provider-visible `tools[].name`. |
| WS-D7 | The provider capability gate runs first in runtime tool projection; the handler assertion stays as a second fail-closed defense. |
| WS-D8 | The runtime exposes `WebSearch` only when it can resolve a model connection with `providerKind === "anthropic"` and a baseURL host of `bigmodel.cn` / `z.ai` / `deepseek.com` or a subdomain; if resolution fails, fail closed. |
| WS-D9 | No streaming progress for the internal request yet: it stays `generateText`; only request shape and tool result format are guaranteed. |
| WS-D10 | Do not restore the BigModel Web Search REST API, the DuckDuckGo HTML fallback, `numResults` or `safeSearch`. |

## File map

| File | Responsibility |
| --- | --- |
| `docs/design/v2/tool/13-websearch.md` | Formal spec: public wrapper + internal native side request (replaces direct provider-native). |
| `docs/design/v2/tool/00-tool-change-chain.md` | Provider-native/server-side checklist: WebSearch uses the side-request form. |
| `docs/design/v2/tool/README.md` | Tool matrix: `WebSearch` client-side wrapper. |
| `docs/design/v2/model/http-proxy.md` | The WebSearch internal model request follows provider transport/proxy. |
| `docs/design/v2/compact/plan.md` | WebSearch has a local tool result budget. |
| `docs/design/v2/loop/system-prompt-contract.md` | WebSearch is no longer a main-request provider-native tool. |
| `docs/design/v2/loop/architecture.md` | Read-only/concurrent tool scheduling includes WebSearch. |
| `docs/design/v2/tui-network-status-panel.md` | Network status of the WebSearch handler's internal model request. |
| `packages/contracts/src/tools/websearch.ts` | Splits public schema, internal provider-native args and client contract. |
| `packages/core/src/tool/handlers/websearch.ts` | Normalizes public snake_case input; issues the internal provider-native `web_search` request. |
| `packages/core/src/tool/handlers/websearch-results.ts` | Tool result text, sources reminder, typed result extraction. |
| `packages/core/src/tool/handlers/websearch-support.ts` | Exports the provider support predicate shared by runtime projection and handler. |
| `packages/core/src/tool/handlers/index.ts` | Registers `webSearchToolEntry`. |
| `packages/core/src/runtime/agent-runtime.ts` | Keeps `modelConnectionPort`; normalizes the allowlist alias; registers/filters WebSearch. |
| `packages/core/src/runtime/internal.ts` | `AgentRuntimeInternal` gains `modelConnectionPort?: ModelConnectionPort`. |
| `packages/core/src/runtime/methods/config.ts` | Removes the direct `web_search` append; `getTools()` returns filtered registry contracts. |
| `packages/core/src/tool/scheduler.ts` | `READ_ONLY_TOOLS` includes `WebSearch` again. |
| `packages/core/src/permission/service.ts` | `isReadOnlyTool()` includes `WebSearch` again. |
| `packages/adapters/src/model/tool-transform.ts` | Keeps provider-native helper mapping; public `WebSearch` never enters the provider-native branch. |
| Tests | `core/tests/{websearch,main-tool-pool,subagent-explore,scheduler}.test.ts`, `adapters/tests/{websearch,runner}.test.ts`, `tools/prompt-trajectory/testcases/*`. |

## Phase gate

After each phase, stop for user review with: the phase diff summary; focused test commands and results; affected surface (provider-visible request, runtime lifecycle, UI/remote, docs); residual risk; no automatic commit.

## Phases (all complete)

### Phase 0: Spec and red tests

- Rewrite `13-websearch.md`. Its top-level conclusion: `WebSearch` is an ordinary client-side tool visible to the main model; on a call, ZCode issues inside the tool handler a model request containing only provider-native `web_search`; when it returns, ZCode formats links/sources as an ordinary tool result and feeds it back to the main model for the final answer. The main model request must not expose provider-native `web_search` directly.
- `00-tool-change-chain.md`: replace the WebSearch direct-exposure paragraph with the side-request form; the outer `WebSearch` fully goes through ToolExecutor, permission, hook, scheduler, events, resultBudget and tool result history.
- Red tests (all fail against the old direct provider-native behavior):
  - Public schema: `query`, `allowed_domains`, `blocked_domains`, `maxUses` defined; `allowedDomains`, `blockedDomains`, `searchContextSize`, `numResults`, `safeSearch` undefined.
  - Registry: `WebSearch` registered as `executionMode: "client"` without `providerNative`; `web_search` not registered.
  - Runtime `getTools()` contains the client `WebSearch` and no `web_search`.
  - Handler side request: the internal request has `metadata.querySource === "web_search_tool"`, messages exactly `[{ role: "system", content: "You are an assistant for performing a web search tool use." }, { role: "user", content: "Perform a web search for the query: <query>" }]`, `tools` containing only `web_search` with `executionMode: "providerNative"`, `providerNative.logicalName: "WebSearch"`, `providerToolName: "web_search"`, `args` with `allowedDomains` and `maxUses: 8`, no `searchContextSize`, and `toolChoice` undefined.

```bash
pnpm --filter @zcode/core exec vitest run tests/websearch.test.ts tests/main-tool-pool.test.ts tests/subagent-explore.test.ts
pnpm --filter @zcode/adapters exec vitest run tests/websearch.test.ts
```

### Phase 1: Contract split

- Public input schema is strict snake_case: `query` (string, min 2), `allowed_domains` (array of domains, max 20, optional), `blocked_domains` (max 20, optional); a refine rejects both domain lists being specified together (message "allowed_domains and blocked_domains cannot both be specified", path `blocked_domains`).
- Internal `WebSearchProviderNativeArgs { allowedDomains?, blockedDomains?, maxUses? }` and `toWebSearchProviderNativeArgs(input, { maxUses })` (maps snake_case to the adapter's camelCase, `maxUses: input.maxUses ?? defaults.maxUses`).
- `WEBSEARCH_TOOL_CONTRACT` is client-side: `capability: "web_search"`, `executionMode: "client"`, permission `websearch` (reason: read-only provider-native web searches through an internal model request; `riskLevel: "low"`, `sideEffectScope: "network"`, `needsApproval: false`, `patternSources: ["toolName", "input", "network"]`, `denyPriority: "beforeAsk"`), `resultBudget` (`maxInlineBytes: 10_000`, `maxModelBytes: 20_000`, strategy `truncate`, preview head 30 lines), timeout (`defaultMs: 60_000`, `maxMs: 120_000`, call override allowed), cancellation supported with best-effort cleanup (message "WebSearch was cancelled"), trace required with full input / summary output. It has no `providerNative`.
- The handler passes provider-native camelCase args via `toWebSearchProviderNativeArgs(...)` with `DEFAULT_MAX_USES`, and reads `input.allowed_domains` / `input.blocked_domains`.

### Phase 2: Registry and runtime projection cutover

- Register `webSearchToolEntry` in `handlers/index.ts` (after `webFetchToolEntry`).
- `resolveBuiltInToolAllowlist(...)` normalizes the legacy alias `web_search` -> `WebSearch`; for the Explore toolset the normalized allowlist is intersected with `EXPLORE_AGENT_ALLOWED_TOOL_SET` (or defaults to `EXPLORE_AGENT_ALLOWED_TOOLS`).
- `AgentRuntime` keeps `modelConnectionPort` (`deps.modelConnectionPort ?? deps.modelAdapter`) and passes it into `createToolExecutor(...)`; `AgentRuntimeInternal` exposes it.
- `websearch-support.ts` exports `supportsProviderNativeWebSearch(connection)` (`providerKind === "anthropic"` and a capable baseURL); `assertProviderSupportsWebSearch(...)` reuses it and throws `CoreErrorType.ConfigurationError` "Current provider/model does not support native WebSearch" (recoverable).
- `config.ts` drops the direct provider-native append (`withRuntimeProviderNativeTools`, `shouldExposeProviderNativeWebSearch`, `createProviderNativeWebSearchContract` and related constants). `getTools()` returns registry contracts filtered by capability: `WebSearch` is shown iff `shouldExposeWebSearch` holds (with a model connection port, `supportsProviderNativeWebSearch(resolveConnection(defaultModelRef))`; without a port it is shown).
- Test expectations: main tool pool contains `WebSearch` and not `web_search`; Explore child tool list uses `WebSearch`.

### Phase 3: Handler result formatting and nested usage

- The internal request keeps the exact side-request shape: model ref with `role ?? ModelRole.Main`, the two messages above, `tools: [createProviderNativeWebSearchContract(input)]`, no `toolChoice` (BigModel's Anthropic-compatible endpoint rejects a named forced `web_search` tool_choice with error 1210, so selection stays automatic and relies on the single-tool request and prompt), `maxOutputTokens: 4096`, `abortSignal`, metadata `{ traceId, sessionId, turnId, toolCallId, toolName: WEBSEARCH_TOOL_NAME, querySource: "web_search_tool" }`, `statusSink: createToolModelStatusSink(context)`, `traceContext: webSearchTraceFromContext(context)`.
- The model-visible result ends with the reminder `REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.`
- `collectResults(...)` also handles typed wrapper objects with `content` arrays (typed `web_search_tool_result` hits) while keeping direct `url` extraction, so Anthropic typed results and OpenAI source-like results both work.
- Formatter test: output contains `Web search results for query: "latest zcode"`, `- [Example](https://example.com)` and "markdown hyperlinks".
- Verified: handler side request, formatter, providerExecuted normalization, nested usage extraction (`serverToolUse.webSearchRequests`).

### Phase 4: Permission, scheduler, hooks, lifecycle

- `WebSearch` is in `READ_ONLY_TOOLS` (`scheduler.ts`) and in `isReadOnlyTool(...)` (`permission/service.ts`); the old temporary-debug comments saying WebSearch does not enter local scheduling are removed.
- Lifecycle assertion: the stored session events contain a `SessionEventType.ToolCallResult` with `payload.toolName === "WebSearch"`.
- Result: `WebSearch` is read-only/concurrent safe and produces ordinary tool lifecycle events.

### Phase 5: Adapter semantics and prompt trajectory

- Adapter tests use an internal native contract named `web_search`: the provider-native mapping yields `tools?.web_search` with `id: "anthropic.web_search_20260209"`, `type: "provider"`; the public client tool `tools?.WebSearch` must not map to the provider-native helper.
- Runner tests keep verifying that provider request bodies can contain the private `web_search` for allowlisted Anthropic-compatible side requests.
- `p12-tool-surface/main-and-explore/expect.json` no longer excludes `WebSearch`: parent contains `Agent`, `WebSearch` and excludes `Glob`, `Grep`, `GoalRead`, `web_search`; Explore child contains `Read`, `Bash`, `Glob`, `Grep`, `WebSearch` and excludes `Agent`, `Skill`, `Write`, `Edit`, `ApplyPatch`, `GoalRead`, `web_search`.
- New testcase `testcases/websearch-client-tool/` (`fixture.json`, `expect.json`): the main turn exposes `WebSearch` and not `web_search`; the internal `web_search_tool` request contains only `web_search`. If prompt-trajectory cannot force a WebSearch tool call without a live provider, it stays a manual inspection fixture and focused handler tests cover the internal request.

```bash
pnpm --filter @zcode/adapters exec vitest run tests/websearch.test.ts tests/runner.test.ts
pnpm --filter @zcode/bootstrap^... build
pnpm --filter @zcode/bootstrap build
pnpm --filter @zcode/prompt-trajectory run:testcases -- --cases testcases/p12-tool-surface --out-root out/websearch-client-tool-p12
```

### Phase 6: Docs sweep and full validation

- Sweep stale wording (`rg -n "direct provider-native|主请求.*provider-native|provider-native `web_search`|不注册本地 handler|不进入本地调度|ToolExecutor 不执行搜索" apps/zcode-cli/docs -g '*.md'`) and for every WebSearch hit use: "WebSearch is a public client-side wrapper tool. Its handler sends an internal model request whose only provider-native tool is `web_search`." Docs describing generic provider-native behavior or adapter internals stay if they do not claim main-turn direct exposure. Docs touched: tool `README.md`, `model/http-proxy.md`, `compact/plan.md`, `loop/system-prompt-contract.md`, `loop/architecture.md`, `tui-network-status-panel.md`.
- Focused suite: core `websearch`, `main-tool-pool`, `subagent-explore`, `scheduler`; adapters `websearch`, `runner`.
- Repo gates: `CI=true pnpm typecheck` and `CI=true pnpm lint`. `pnpm lint` should exit 0 (warnings allowed). `pnpm typecheck` may fail on the baseline `@zcode/shared` export/type errors; capture the first 20 error lines and confirm none reference files touched here.
- Manual runtime check: no live external-provider smoke test was run (no throwaway native-search provider credentials). Runtime-equivalent evidence: `packages/core/tests/websearch.test.ts` covers `ToolCallStarted` / `ToolCallResult`, `querySource: "web_search_tool"`, automatic internal tool choice, provider-native args and nested `serverToolUse.webSearchRequests`; the local P-12 outer record `test20260608-213225` shows outer main/Explore bodies expose `WebSearch` and not `web_search`; the local internal record `final3` shows the internal request exposes only `web_search` and the final outer request receives a formatted `WebSearch` tool result. With a disposable real provider key, rerun a final smoke check and confirm: main `tools[]` has `WebSearch` and no `web_search`; lifecycle shows `WebSearch` pending/running/completed; internal request metadata has `querySource: "web_search_tool"`; internal `tools[]` contains only `web_search`; the final answer cites links from the tool result; nested usage records `serverToolUse.webSearchRequests`.

## Final acceptance

- The public provider-visible main/explore tool name is `WebSearch`; private provider-native `web_search` never appears in outer main/explore `tools[]`.
- The handler's internal request uses only provider-native `web_search` and sets no `toolChoice`.
- Public schema is `query`, `allowed_domains`, `blocked_domains`, `maxUses`; `allowedDomains`, `blockedDomains`, `searchContextSize`, `numResults`, `safeSearch` are not public provider-visible fields.
- Adapter provider-native mapping still works for internal requests.
- `WebSearch` is read-only, concurrent safe, low risk, no approval by default; it triggers the normal ToolExecutor lifecycle and tool result replay.
- Result text includes sources and the markdown hyperlink reminder.
- No code path restores BigModel REST search or HTML fallback.
- Docs no longer describe WebSearch as direct main-turn provider-native exposure.
- No automatic commit was made.
