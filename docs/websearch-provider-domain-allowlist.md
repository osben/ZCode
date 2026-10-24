# WebSearch Provider Domain Allowlist

## Background

WebSearch issues internal model requests through the provider-native `web_search`. Not every
Anthropic-compatible endpoint supports this server-side tool, so the runtime exposes `WebSearch` only under
confirmed provider domains.

## Rules

- Enable WebSearch only for connections with `providerKind === "anthropic"`.
- Domain matching uses the hostname of `baseURL`, not the provider id or model name.
- The root domain and all subdomains of `bigmodel.cn`, `z.ai`, `deepseek.com` and `z.ai` are allowed.
- For example, `bigmodel.cn` subdomains are covered by the `bigmodel.cn` rule, and `zcode.z.ai` is covered by the `z.ai` subdomain rule.

## Impact

This only affects agent-side tool exposure and the provider-native WebSearch projection. It does not change the
desktop continuous chain, the mobile replayable recovery semantics, or the endpoint resolution of ordinary model requests.
