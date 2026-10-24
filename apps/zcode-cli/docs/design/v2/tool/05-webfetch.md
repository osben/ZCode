# WebFetch Tool

## Purpose

`WebFetch` fetches URL content, converts it to markdown and extracts the result with a small model according to a prompt.

The ZCode v2 first version follows the L2 runtime contract in this document: the tool itself only expresses the intent "fetch and extract web content"; actual HTTP I/O, permission decisions, caching, artifact writes and the secondary model call must all go through explicit ports or services.

Implementation status (2026-05-08): the L2a mainline has landed. `packages/contracts/src/tools/webfetch.ts` defines the runtime and provider JSON schema; `packages/core/src/tool/handlers/webfetch*.ts` implement URL normalization, host shape validation, `HttpClientPort` GET, manual safe redirect, HTML/text extraction, in-memory fetch cache, lite model prompt processing, result budget and network status events. The permission layer matches WebFetch project rules by `domain:<hostname>` first through `packages/core/src/permission/service.ts`. Still not landed: cross-session persistent cache, robots/meta policy and real binary artifact saving; non-text-like content currently returns a structured failure.

Implementation status (2026-06-28 provider-visible convention): `WebFetch` normalizes a user-provided `http:` URL to `https:` before fetching; `https:` URLs keep their protocol. The `url` in the tool result keeps the user's original input and `finalUrl` is the URL actually requested. Security constraints stay with host shape validation, permission rules, manual redirect validation and the proxy/audit chain.

Implementation status (2026-07-07 correction): the `WebFetch` main path removes the external `domain_info` / WebFetchPreflight pre-check. Calling a third-party domain safety service made otherwise reachable target URLs fail before the real fetch when enterprise networks, proxies or security policies blocked that service. The current contract: boundaries are carried by the URL runtime schema, user/project `domain:<hostname>` permission rules, the unified `HttpClientPort` network entry, manual safe redirect, egress proxy responses and network event audit; the handler no longer depends on an external domain-classification service before the target request.

Implementation status (2026-07-08 security boundary adjustment): ZCode `WebFetch` requests are sent from the machine the agent runtime runs on, not forced through a remote WebFetch proxy. With the external `domain_info` removed, only local/private target blocking at the URL literal level is kept: ordinary domains get no local DNS lookup preflight, so public targets do not fail before the real fetch due to slow local DNS or enterprise resolution policy; literal IPs, `.localhost` and similar local targets are still blocked before entering `HttpClientPort`. IP parsing and basic range checks reuse `ipaddr.js`; ZCode keeps only the WebFetch-specific public policy and URL-literal safety coverage for IPv4-mapped IPv6, DNS64 `64:ff9b::/96` unwrapping, `198.18.0.0/15`, `64:ff9b:1::/48`, `100::/64`, `2001:2::/48`, `2001:10::/28`, `2001:20::/28` and similar. This guard cannot be bypassed by `network.noProxy` / `NO_PROXY`.

## Input contract

`WebFetch` input is a strict object:

| Field    | Type     | Required | Description                                          |
| -------- | -------- | -------- | ---------------------------------------------------- |
| `url`    | `string` | yes      | Complete valid URL                                   |
| `prompt` | `string` | yes      | Extraction or analysis instruction for the fetched content |

Design requirements:

- The URL must be parseable by the standard `URL`.
- Only `http:` and `https:` are supported; `http:` is normalized to `https:` before permission and network request, `https:` keeps its protocol.
- URL length is at most 2000 characters.
- The URL must not carry username/password, so credentials do not enter logs, permission rules or model context.
- The host must first satisfy the public domain shape: hostname has at least two `.`-separated segments. This rejects single-label hosts such as `localhost`.
- Before every real GET a URL-literal egress guard must run: reject `.localhost` and non-public literal IPs (loopback, link-local, private, carrier-grade NAT, multicast, unspecified, broadcast, reserved, etc.). Ordinary domains no longer get a local DNS resolve preflight; IP parsing/range checks use `ipaddr.js`, and IPv4-mapped IPv6 and DNS64 `64:ff9b::/96` are unwrapped and reuse the IPv4 public policy; special ranges that the library marks as unicast but WebFetch must not access (`198.18.0.0/15`, `64:ff9b:1::/48`, `100::/64`, `2001:2::/48`, `2001:10::/28`, `2001:20::/28`, etc.) stay blocked by ZCode policy.
- `prompt` must not be empty, at most 8000 characters.
- `prompt` describes the information to extract and cannot replace permission.
- If an MCP-provided authenticated web fetch exists, prefer the MCP tool.
- For GitHub URLs prefer the `gh` CLI, since authentication and a structured API may be needed.

## Prompt constraints

ZCode gives `WebFetch` full tool prompt semantics, not just a one-line "Fetch a URL". The provider-visible tool description is a short `description` plus `modelInstructions`, which after projection must express at least:

- An explicit warning: `WebFetch WILL FAIL` for authenticated or private URLs; before use, judge whether the URL points to an authenticated service such as Google Docs, Confluence, Jira or GitHub, and prefer a dedicated MCP tool with authenticated access.
- `WebFetch` fetches the given URL, converts HTML to markdown, then processes the page with a small fast model according to `prompt` and returns the model's answer about the page content.
- Use it when retrieving and analyzing web content; input is a URL plus a prompt, and `prompt` should describe what to extract or analyze from the page.
- If MCP provides a web fetch tool, prefer the MCP version because it may have fewer restrictions or authentication capability.
- The URL must be complete and valid; `http:` is normalized to `https:` before fetching per the provider-visible convention, `https:` keeps its protocol.
- The tool is read-only and modifies no file, but performs a network GET and may write session artifact/cache.
- Large content may be summarized; results for the same URL enter a self-cleaning 15-minute, 50 MB in-memory cache, making repeat visits faster.
- ZCode follows only safe redirects at the same host / `www.` level automatically; a cross-host redirect does not auto-fetch the new host, the error message must carry the redirect URL, and the model may re-issue the request with the new URL only when user intent and permission allow.
- For GitHub URLs consider the `gh` CLI / GitHub API first, for example `gh pr view`, `gh issue view`, `gh api`, because they generally suit authentication, PR, issue and structured data reading better.

## Output contract

Reference output:

| Field        | Type     | Description                        |
| ------------ | -------- | ---------------------------------- |
| `bytes`      | `number` | Fetched content size               |
| `code`       | `number` | HTTP status code                   |
| `codeText`   | `string` | HTTP status text                   |
| `result`     | `string` | Result after prompt processing     |
| `durationMs` | `number` | Fetch and processing time          |
| `url`        | `string` | Original request URL               |

ZCode output structure:

| Field          | Type      | Description                                                                                         |
| -------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `url`          | `string`  | Original request URL                                                                                |
| `finalUrl`     | `string`  | URL actually fetched, including the location after safe redirects                                   |
| `status`       | `number`  | HTTP status code                                                                                    |
| `statusText`   | `string`  | HTTP status text                                                                                    |
| `contentType`  | `string`  | Response content type                                                                               |
| `bytes`        | `number`  | Raw response bytes                                                                                  |
| `durationMs`   | `number`  | Total time                                                                                          |
| `result`       | `string`  | Result after prompt processing                                                                      |
| `cacheHit`     | `boolean` | Whether the fetch cache was hit                                                                     |
| `redirects`    | `array`   | Chain of accepted safe redirects                                                                    |
| `artifactUri`  | `string?` | Artifact reference when the raw markdown/text content was persisted                                 |
| `artifactPath` | `string?` | Local artifact path returned by the adapter, for internal/UI tracing only, not required to be model-visible |
| `truncated`    | `boolean` | Whether the input to the secondary model or the model-visible result was truncated by budget        |

The model-visible result returns only `result`; the full structure goes to the tool result event and internal output.

## Behavior semantics

Target core flow; items marked "later" are not part of the current L2a implementation:

1. Validate the URL.
2. Keep the URL's explicit protocol and port; HTTP must not be rewritten to HTTPS automatically before the request.
3. Check the 15-minute URL content cache.
4. Issue a GET request with a user agent, a content-length limit and a 3-minute timeout.
5. Convert HTML to markdown; non-HTML is handled as raw text.
6. Later: binary content is additionally persisted and the save path is hinted at the end of the result; currently non-text-like content fails directly.
7. For non-preapproved or large content, call the small model to process the prompt.
8. Later: preapproved markdown of small length may be returned directly; currently the lite model is always called to execute the prompt.
9. Cache the fetch result.

Resource limits:

- URL max length 2000.
- HTTP response max 10 MB.
- Main fetch timeout 3 minutes.
- Same-host redirects at most 10.
- Markdown fed to the secondary model at most 100000 characters.
- URL cache TTL 15 minutes, total size 50 MB.

The ZCode first version lands progressively. Current code covers the L2a mainline, while L2b is future work:

- L2a implemented: URL length and prompt length schema, URL parsing, HTTP->HTTPS normalization, host shape validation, WebFetch URL-literal egress guard, domain permission rule, `HttpClientPort` GET, manual redirect safety, HTML/text extraction, 10 MB response limit, 15-minute/50 MB in-memory cache, lite model prompt, result budget, artifact write interface, large-content truncation, trace propagation and `network_request_status` events.
- L2b pending: binary artifact, cross-session persistent cache, robots/meta policy, more complete HTML cleaning, and finer-grained path-level network permission rules.

## Redirect policy

WebFetch does not follow cross-host redirects unconditionally:

- The protocol must be the same.
- The port must be the same.
- The redirect URL must not carry username/password.
- The host may only add or remove `www.`, or stay the same host.
- Any other redirect returns a special result asking the model to call `WebFetch` again with the new URL.

This prevents an open redirect on a trusted domain from being used to bypass user authorization.

## Permission model

`WebFetch` is read-only and concurrency-safe but has network side effects.

The permission rule content is `domain:<hostname>`, where hostname is normalized to lowercase with the trailing dot removed:

- A preapproved host/path may be allowed directly.
- Explicit deny denies directly.
- Explicit ask goes to ask.
- Explicit allow allows directly.
- No rule defaults to ask, suggesting an allow rule in local settings.

Preapproved domains apply only to WebFetch GET requests and must not be shared with sandbox network permission. ZCode writes this into `NetworkPermissionPolicy` so a GET preapproval does not grow into arbitrary network access.

`PermissionService` uses `domain:<hostname>` as the rule subject for `WebFetch`, not the full URL. When the user clicks "always allow", `domain:<hostname>` is suggested for saving, not a URL with path/query, unless path-level rules are introduced later.

## Safety and copyright constraints

The secondary model prompt carries extra constraints for non-preapproved domains:

- Answer only from the page content.
- Exact quotes have a length limit.
- Do not reproduce lyrics.
- Do not output legal self-assessment.

If ZCode supports WebFetch summarization, copyright and quote limits should live in a `WebFetchProcessingPolicy`, not be scattered in prompt strings.

## Validation and errors

Key failure paths:

- Invalid URL.
- URL too long.
- URL carries username/password.
- Host is not a publicly resolvable shape.
- Egress blocked.
- Redirect missing Location.
- Too many redirects.
- Content length over limit.
- Fetch timeout.
- Secondary model cancelled or failed.

Errors keep structured fields such as domain, URL, HTTP code and whether egress was blocked.

## ZCode design conclusions

`WebFetch` is split into:

- `WebFetchTool`: schema, permission entry, result serialization.
- `HttpClientPort`: unified network entry with timeout, proxy, certificates, retry and audit.
- `NetworkPermissionPolicy`: domain rules, preapproved list, redirect safety and public egress safety; it does not depend on an external domain safety service pre-check.
- `ContentExtractionService`: HTML to markdown, binary persistence, content budget.
- `ModelSummarizationPort`: secondary model call, subject to cancellation and token/cost observation.
- `FetchCache`: cache with TTL and size budget.

### `HttpClientPort`

`HttpClientPort` is the base contract for all non-provider HTTP I/O. WebFetch v1 needs only GET, but the port design must support later convergence of remote config, telemetry and MCP HTTP transport.

Network environment requirements of the WebFetch-specific `HttpClientPort`:

- An explicit `network.httpProxy` configuration takes priority.
- When not explicitly configured, read `ZCODE_HTTP_PROXY` first; then the user's standard proxy variables that the runtime has sealed into `ZCODE_TOOL_ENV_PASSTHROUGH_JSON`. Bare `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` in the current process must not be inherited directly, because runtime initialization clears these variables first and restores them only at explicit tool/network boundaries. Runtime-sealed proxy variables are read lowercase-first (the same order as undici): `https_proxy`, `HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`, `all_proxy`, `ALL_PROXY`.
- `network.noProxy` must also apply to WebFetch; `ZCODE_NO_PROXY` and the runtime-sealed `no_proxy` / `NO_PROXY` may serve as fallback, lowercase-first. The runtime-sealed `no_proxy` participates only in the WebFetch fallback and does not bypass an explicit `network.httpProxy` / `ZCODE_HTTP_PROXY`. Bare standard environment variables are not inherited input.
- Custom CA supports at least `network.caCertFile` and `ZCODE_AGENT_CA_CERT`; standard CA variables are derived by the runtime only for controlled child processes.
- WebFetch itself must not re-parse these environment variables; it must fully reuse the unified parsing logic of `HttpClientPort`.
- WebFetch uses the ordinary HTTP total-request timeout through `HttpClientPort`, default 60000 ms; this timeout does not apply to long streaming requests such as provider SSE.
- The WebFetch request must run the URL-literal egress policy at the tool handler layer before entering `HttpClientPort`. Reason: ZCode WebFetch is not forced through a remote WebFetch proxy; with the external `domain_info` removed, relying only on the ordinary HTTP proxy / noProxy would let a model-driven GET reach local services, cloud metadata endpoints or intranet addresses on the machine of the agent runtime. The current policy does no local DNS lookup for ordinary domains and blocks only local/private targets appearing directly in the URL.
- The URL-literal egress guard must take effect before proxy/noProxy resolution and cannot be bypassed by configuration such as `NO_PROXY=127.0.0.1`.

Request fields:

- `url`: complete URL.
- `method`: fixed `GET` in WebFetch v1.
- `headers`: passed by the tool/service; the adapter appends the trace header.
- `timeoutMs`: outer timeout, clipped jointly by the tool contract and input.
- `maxResponseBytes`: hard response body limit.
- `redirect`: `manual` or `follow`; WebFetch uses `manual` and the tool service judges same-host safe redirects.
- `trace`: must carry the same `traceId`.

Response fields:

- `url`, `status`, `statusText`, `headers`, `body`, `bytes`, `durationMs`.
- `bodyTruncated` may appear only in an explicit preview request; a formal WebFetch fetch over the limit throws a structured error and does not silently truncate.

Covered tests:

- `packages/core/tests/webfetch-tool.test.ts` covers explicit HTTP URL normalization to HTTPS, HTML to markdown handed to the lite model, model-visible result returning only `result`, in-memory cache hit still processed with the new prompt, literal local/private IP rejection, `.localhost` rejection, ordinary domains not triggering DNS preflight, DNS64 private-network literal mapping rejection, public IP literal allowed, rejection of the special ranges `198.18.0.0/15` / `64:ff9b:1::/48` / `100::/64` / `2001:2::/48` / `2001:10::/28` / `2001:20::/28`, cross-host redirect rejection, single-label host rejection, network pending/complete/error status events.
- `packages/core/tests/permission-service.test.ts` covers WebFetch project rules matched by normalized `domain:<hostname>` and a domain deny overriding a full-URL allow.
- `packages/core/tests/tool-contracts.test.ts` covers the WebFetch tool contract declaring `sideEffectScope: network` and requiring approval.
- `packages/adapters/tests/http.test.ts` covers `HttpClientPort` trace header, `ZCODE_HTTP_PROXY`, runtime-sealed proxy, `network.noProxy`, `ZCODE_AGENT_CA_CERT`, standard proxy/certificate variable filtering, response size limit and unsupported protocol; `packages/adapters/tests/http-response-status.test.ts` covers upstream `999` / `204` / `304` via proxy returned as is without crashing the process.
- `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-webfetch.test.ts` keeps the desktop session `WebFetch` success-loop case, but it currently sits in `manual-review/pending` and cannot count as formal automated coverage. The fixture is still at `packages/desktop/test/e2e/fixtures/cases/conversation-session/conversation-session-webfetch.json`.

Remaining test focus:

- domain rule allow/deny/ask.
- Binary content persistence.
- Large content truncation.
- Abort signal.
- Preapproved domains not spreading to sandbox network permission.
- Structured error fields for egress blocked.
