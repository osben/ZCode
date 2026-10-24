# Agent Model Runtime Platform Headers

Agent model requests carry source/attribution headers (`User-Agent`, `X-ZCode-App-Version`, `X-Title`, `x-request-id`, `x-session-id`). They also carry the OS, CPU architecture, and system version of the machine whose agent runtime issues the request, to distinguish macOS, Windows, Linux, and remote workspace environments.

Rules:

- All zcode-cli agent model requests carry by default:
  - `X-Platform`: `${process.platform}-${arch()}`
  - `X-Os-Category`: `macos` / `windows` / `linux`
  - `X-Os-Version`: `release()`
- The headers describe the machine actually issuing the request. Remote SSH/WSL/Docker workspaces get headers from the remote zcode-cli runtime, never from the local desktop or the mobile `/remote` client.
- Header names reuse the app-side ones; no `X-ZCode-OS` / `X-ZCode-Arch` / `X-ZCode-OS-Version`.
- Values are printable ASCII only; if a safe value cannot be produced, omit that optional header rather than fail the HTTP fetch on an illegal header value.
- Explicitly configured same-name headers in provider config override the defaults.

Design: the headers are built during default provider header generation in `apps/zcode-cli/packages/bootstrap/src/model-config.ts`, at the same layer as `User-Agent`, `X-ZCode-App-Version`, `X-Title`, `X-ZCode-Agent`. Merge order is unchanged: (1) bootstrap default headers; (2) `target.headers` from provider config; (3) adapter merges per-request attribution headers at `generateText` / `streamText` time. Platform headers thus neither pollute session/request attribution nor bypass explicit user provider headers.

Non-goals: no `@zcode/protocol` change (the app does not need to send this to the agent); `x-request-id` / `x-zcode-trace-id` / `x-session-id` / `x-query-id` semantics unchanged; no mobile `/remote` device info; no new env vars or user-visible settings.

Coverage matrix:

| Case ID | Setup | Action | Assertions | Evidence |
| --- | --- | --- | --- | --- |
| AMRPH-001 | Default provider config, no custom headers | Create AI SDK provider registry config | Provider headers include `X-Platform`, `X-Os-Category`, `X-Os-Version` | bootstrap unit test |
| AMRPH-002 | Explicit same-name header in provider config | Create AI SDK provider registry config | User config overrides default platform header | bootstrap unit test |
| AMRPH-003 | Provider headers already include platform headers | Create `generateText` request options | Platform headers coexist with `x-request-id`, `x-session-id` | adapter options unit test |
