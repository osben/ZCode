# WebSearch Client Wrapper Tool

## Conclusion

`WebSearch` is an ordinary client-side tool visible to the main model. After the model calls `WebSearch`, ZCode issues, inside the tool handler, a model request that contains only the provider-native `web_search`. After the internal request returns, ZCode formats the links/sources into an ordinary tool result and feeds it back to the main model to continue generating the final answer.

The main model request must not expose the provider-native `web_search` directly.

## Design goals

1. The provider-visible tool name in the main loop is `WebSearch`, execution mode `client`.
2. `WebSearch` must enter the `ToolExecutor`, permission, scheduler, hooks, events, resultBudget, tool result history and replay lifecycle.
3. The provider-native `web_search` may appear only in the internal side request issued by the `WebSearch` handler, projected by the adapter into the provider SDK helper.
4. The public input schema keeps the core fields: `query`, `allowed_domains`, `blocked_domains`; it also keeps the optional tuning field `maxUses` that the current Anthropic provider-native `web_search` actually consumes. `searchContextSize`, `numResults` and `safeSearch` are not visible to the main model.
5. A provider/model that does not support native web search does not expose `WebSearch` to the main model by default; if the runtime cannot resolve the provider capability, `WebSearch` is not exposed either.
6. The handler output must extract the sources/results/usage returned by the provider and remind the main model, in an ordinary tool result, to cite sources with markdown links in the final answer.

## Public Tool Contract

The contract the main model sees:

| Field             | Value        |
| ----------------- | ------------ |
| `name`            | `WebSearch`  |
| `capability`      | `web_search` |
| `executionMode`   | `client`     |
| `providerNative`  | absent       |
| `readOnly`        | `true`       |
| `concurrentSafe`  | `true`       |
| `sideEffectScope` | `network`    |
| `needsApproval`   | `false`      |

public input:

| Field             | Description                                                                         |
| ----------------- | ----------------------------------------------------------------------------------- |
| `query`           | Natural-language query to search                                                    |
| `allowed_domains` | Optional, allow only results from these domains                                     |
| `blocked_domains` | Optional, exclude results from these domains                                        |
| `maxUses`         | Optional, upper limit of internal provider-native searches, default `8`             |

`allowed_domains` and `blocked_domains` cannot be passed together. A domain accepts only a hostname, not a protocol, path or wildcard.

模型可见描述是固定文本。月份一行写作
`The current month is (provided in the conversation below)`，不写入真实月份：模型从会话中的
当前日期得知月份。描述里写真实月份会让 tools 段每个月变化一次，整个请求的缓存前缀随之失效。

## Internal Provider-Native Request

The `WebSearch` handler converts the public input into internal provider-native args:

| public field      | internal provider-native args       |
| ----------------- | ----------------------------------- |
| `allowed_domains` | `allowedDomains`                    |
| `blocked_domains` | `blockedDomains`                    |
| `maxUses`         | `maxUses`, default `8` when omitted |

The internal request is fixed:

- system message: `You are an assistant for performing a web search tool use.`
- user message: `Perform a web search for the query: <query>`
- tools: only `web_search`
- toolChoice: not set. BigModel's Anthropic-compatible endpoint rejects a named forced `web_search` tool choice (1210); provider-native search is currently triggered by the single-tool request and the prompt.
- metadata.querySource: `web_search_tool`

## Provider mapping

Core does not import `@ai-sdk/anthropic` or `@ai-sdk/openai`. The adapter is the only place that converts the provider-native contract into an SDK provider tool.

### Anthropic-compatible

The internal `web_search` uses `anthropic.tools.webSearch_20260209()`, and the AI SDK generates in the internal request:

```json
{
  "type": "web_search_20260209",
  "name": "web_search"
}
```

Support conditions:

- The provider kind is `anthropic`.
- The resolved baseURL host is `bigmodel.cn`, `z.ai`, `deepseek.com` or a subdomain.
- An Anthropic-compatible provider outside the allowlist does not project provider-native search.

### OpenAI

`openai.web_search` is currently not projected; even if the baseURL host hits the WebSearch allowlist, `WebSearch` is not exposed. The WebSearch gate must satisfy both `providerKind === "anthropic"` and the baseURL host allowlist.

### Other providers

`openai-compatible`, `gateway` and `custom` currently do not project the WebSearch provider-native tool. Do not degrade it to an ordinary function tool, and do not restore the old BigModel Web Search REST API or the DuckDuckGo HTML fallback.

## Registration, permission and execution

- `WebSearch` is registered in `builtInTools`; the default main agent and the Explore agent may each expose it according to their own tool pool/allowlist.
- `web_search` is only a legacy allowlist alias mapped to `WebSearch`; it must not appear in the main request `tools[].name`.
- The provider capability gate filters `WebSearch` first in the runtime projection; the handler's `assertProviderSupportsWebSearch` is the second line of defense.
- The capability gate is decided jointly by provider kind and the resolved baseURL; it is exposed only for `anthropic` with a baseURL host of `bigmodel.cn`, `z.ai`, `deepseek.com` or a subdomain.
- `WebSearch` enters the local `ToolExecutor` and triggers the ordinary tool lifecycle: `ToolCallScheduled`, `ToolCallStarted`, `ToolCallResult`, permission, hook, scheduler, resultBudget and session history.
- The network status of the internal provider-native request keeps being forwarded as `ModelNetworkStatus` events through the tool context.

## Deletion and migration

Deleted or not restored:

- Appending the provider-native `web_search` contract directly to the main request.
- The old BigModel Web Search adapter tool.
- The DuckDuckGo HTML fallback.
- The `searchContextSize` / `numResults` / `safeSearch` fields.
- The legacy camelCase domain fields `allowedDomains`, `blockedDomains` in the public schema.

Kept:

- `WEBSEARCH_PROVIDER_NATIVE_SPEC` as the basis of the internal request adapter mapping.
- The provider-native helper mapping in `packages/adapters/src/model/tool-transform.ts`.
- `ModelUsage.serverToolUse.webSearchRequests` aggregates provider usage and counts as nested usage in the main turn.

## Test requirements

Core:

- The public JSON Schema exposes `query`, `allowed_domains`, `blocked_domains`, `maxUses`, but not `allowedDomains`, `blockedDomains`, `searchContextSize`, `numResults` or `safeSearch`.
- `registerBuiltInTools()` registers `WebSearch` and not `web_search`.
- The `tools[]` of the main runtime and the Explore child request contain `WebSearch` and not `web_search`.
- `toolAllowlist: ["web_search"]` can expose `WebSearch` as a compatibility alias.
- The internal request issued by the handler contains only the provider-native `web_search` and does not set `toolChoice`.
- `WebSearch` enters permission, scheduler and lifecycle events as a read-only, concurrency-safe tool.

Adapters:

- Only the internal provider-native `web_search` contract is mapped to `anthropic.web_search_20260209`.
- Projected only when the provider kind is Anthropic and the baseURL host hits the `bigmodel.cn`, `z.ai`, `deepseek.com` allowlist; official OpenAI, MiniMax and any custom/gateway provider do not expose WebSearch.
- The public client-side `WebSearch` stays an ordinary function tool.

Trajectory:

- Only `WebSearch` appears in the main request body.
- The request body with internal `metadata.querySource === "web_search_tool"` contains only `web_search`.
- The current prompt-trajectory mock proxy affects runtime provider capability injection; to restore the WebSearch trajectory testcase later, the harness must explicitly provide an allowlisted Anthropic baseURL.

Regression:

- `CI=true pnpm typecheck`
- `CI=true pnpm lint`
- focused core/adapters vitest
- prompt-trajectory P-12 testcase; the WebSearch testcase needs the harness capability baseURL first

## Remaining risks

- Streaming progress is not implemented for now; the internal request uses `generateText` and only guarantees that the request shape, tool lifecycle and tool result conform to this contract.
- Providers expose citations, sources and providerExecuted tool results inconsistently; the handler must be compatible with provider `sources`, typed tool result output and source-like result payloads at the same time.
