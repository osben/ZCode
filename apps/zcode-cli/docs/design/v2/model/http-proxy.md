# Model HTTP Proxy

## Goals

HTTP(S) requests of model providers must support explicit ZCode proxy configuration, so the desktop app,
the debug app or the user can observe request URL, host, status and streamed responses through a
controlled entry.

The same proxy resolution rules are reused by `HttpClientPort`, so non-provider HTTP I/O such as
`WebFetch` does not drift into "one goes through the proxy, the other connects directly". The internal
provider-native `web_search` side request issued by the `WebSearch` handler still uses the provider
transport and therefore follows the model request proxy policy.

The same egress policy applies at the child-process and extension boundary. For subprocesses ZCode
starts itself (`Bash`, background terminals, stdio MCP servers) that may issue network requests, the
app/provider runtime is isolated first, and the user shell's `HTTP_PROXY` / `http_proxy` /
`NODE_EXTRA_CA_CERTS` and similar network variables are restored at the tool boundary. This keeps them
from polluting model requests while preserving the network environment of user commands.

Desktop renderer `fetch`, XHR, page resources and the embedded-browser WebView are also ZCode egress.
They read the explicit HTTP proxy from the settings page and apply it through Electron
`session.setProxy` separately to `defaultSession` and `persist:zcode-embedded-browser`. They must not
depend on user shell environment variables (no inheriting `HTTP_PROXY` / `HTTPS_PROXY` /
`NODE_EXTRA_CA_CERTS`). When the settings page is empty the two sessions fall back differently:
`defaultSession` connects directly, which keeps ZCode backend and model traffic on the explicit
configuration; `persist:zcode-embedded-browser` follows the OS system proxy, because it carries the
user's own browsing and must reach the same sites as the user's local browser. The system proxy comes
from OS network settings, not shell environment variables, so it does not conflict with "no inheriting
shell variables".

Remote resource manifest, component archive and progress `HEAD` requests that the Desktop Window Host
issues during SSH/WSL/Docker deployment are app-managed egress too. They must use the request-scoped
transport frozen for the Host lifetime, consuming the same settings-page proxy, No Proxy and custom CA;
bare `globalThis.fetch` and process-global dispatchers are forbidden. `remote-download` component
archives are still downloaded by remote `curl`/`wget` and do not inherit the desktop proxy.

## Sources and precedence

1. Desktop `AppSettings.httpProxy`, filled in on the settings page and injected when the agent starts.
2. `network.httpProxy` config, for an explicitly configured unified model proxy.
3. `ZCODE_HTTP_PROXY` environment variable, injected explicitly by the app/debug server/CLI runtime.

The provider/app/general `HttpClientPort` use only these explicit sources. The `WebFetch`-specific
`HttpClientPort`, when no explicit proxy matches, may also read the user's standard proxy variables that
the runtime sealed into `ZCODE_TOOL_ENV_PASSTHROUGH_JSON` as a fallback. The fallback reads only the
sealed copy, never bare standard variables of the current process, in the order `https_proxy`,
`HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`, `all_proxy`, `ALL_PROXY` (lowercase first, matching undici).

No Proxy sources:

1. Desktop `AppSettings.httpProxyNoProxy`, filled in on the settings page and injected when the agent
   starts.
2. `network.noProxy` config, bypass rules for the explicit unified model proxy.
3. `ZCODE_NO_PROXY` environment variable, injected explicitly by the app/debug server/CLI runtime.

No Proxy applies to all proxy sources above and supports `*`, exact host, host:port, `.example.com` and
`*.example.com`. The provider/app/general `HttpClientPort` does not read the user shell `NO_PROXY` /
`no_proxy`, so the explicit proxy policy cannot be bypassed. The `WebFetch`-specific `HttpClientPort`
reads the sealed runtime copy only when no explicit proxy matches, lowercase `no_proxy` before
`NO_PROXY`. Tool subprocesses restore the user's own no-proxy environment at the passthrough boundary,
and the explicit No Proxy config overrides same-named variables.

Custom TLS CA sources:

1. `network.caCertFile` config.
2. Desktop `AppSettings.httpProxyCaCertPath`, filled in on the settings page.
3. `ZCODE_AGENT_CA_CERT` environment variable, injected explicitly by the app/debug server/CLI runtime.

The inherited runtime environment filters `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`,
`NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE` / `GIT_SSL_CAINFO` and
package-manager proxy/CA variables. Before filtering, these user shell network variables are sealed into
the internal `ZCODE_TOOL_ENV_PASSTHROUGH_JSON`. That variable plays no role in proxy resolution for the
app/provider/general `HttpClientPort`; it serves only as the `WebFetch`-specific fallback or is restored
when a tool subprocess environment is built.

Subprocess proxy and certificate environments first restore the user shell network variables, then the
explicit network policy overrides the same targets:

- If `network.httpProxy`, `AppSettings.httpProxy` or `ZCODE_HTTP_PROXY` matches, the adapter fills
  `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and the lowercase forms.
- If `network.noProxy`, `AppSettings.httpProxyNoProxy` or `ZCODE_NO_PROXY` matches, it fills `NO_PROXY`
  and `no_proxy`.
- If `network.caCertFile`, `AppSettings.httpProxyCaCertPath` or `ZCODE_AGENT_CA_CERT` matches, it fills
  `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` and `GIT_SSL_CAINFO`,
  for consistency across Node, OpenSSL/curl, Python requests and git.

A command with `env.base: "empty"` does not restore the user shell passthrough; it keeps only the
explicit network configuration and the command-level overlay.

## Behavior

- Proxy resolution is implemented once in the adapter and serves both model requests and
  `HttpClientPort`.
- Only model HTTP(S) requests issued by the AI SDK provider are proxied; the provider `baseURL` is not
  rewritten.
- Dynamic provider endpoint routing first resolves the final URL per
  [`provider-endpoint-routing.md`](./provider-endpoint-routing.md), and only then Proxy/No Proxy matching
  runs. The routing config interface uses its own `HttpClientPort` and must not enter routing, to avoid
  recursion.
- Without proxy config, or when explicit No Proxy matches, native `fetch` is used.
- With a proxy, the adapter layer forwards through one fetch, keeping the response stream so streaming
  is not broken.
- When a custom CA is configured, the adapter must make direct HTTPS, HTTPS proxy and HTTP CONNECT paths
  all use the same extra trust chain.
- The explicit CA is additive trust: the CLI network adapter merges Node `tls.rootCertificates` with the
  user PEM bundle and passes the result as `ca`; it must not pass only the user CA and replace the
  standard public roots. Model/provider/MCP fetch and `HttpClientPort` share this loader. Global TLS
  defaults are not changed and certificate or hostname verification is never disabled. Without a
  configured CA the native default behavior is kept.
- The CA file is loaded with async IO when the client first needs it. Each client holds a single loading
  Promise that concurrent requests reuse. A read failure fails the request and clears the failed
  Promise, so later requests can retry; it must not degrade to default trust or ignore certificate
  errors. The timeout/abort of one request covers its wait for the CA: it cancels only that request's
  wait, not the file read shared with other requests. Successful results stay cached; a config change
  still requires rebuilding the client. Order:

  ```text
  request → client-owned CA Promise → async PEM read → Node public roots + PEM
                ↑ concurrent requests reuse it             ↓
  caller timeout/abort → stop own wait         direct / CONNECT / HTTPS proxy
  ```

- Desktop main must apply the Electron network policy to `defaultSession` and
  `persist:zcode-embedded-browser` independently before creating the first window. With `httpProxy` set,
  both sessions use `session.setProxy({ mode: "fixed_servers", proxyRules, proxyBypassRules })`, where
  `proxyBypassRules` comes from `httpProxyNoProxy`. When empty, `defaultSession` uses `mode: "direct"`
  and `persist:zcode-embedded-browser` uses `mode: "system"`, and old connection pools are closed after
  the policy update. When empty, `proxyBypassRules` is not sent: bypass rules only make sense for
  `fixed_servers`, and the exception list in `system` mode is maintained by the OS. A failure applying
  one session must not block configuring the other. Changes take effect on the next app start only, and
  the settings page must prompt the user to restart.
- The Desktop Window Host must inject its managed proxy-aware transport as `RemoteAssetNetworkPort` into
  desktop-attached remote deployment. Manifest, component archive and progress `HEAD` must not fall back
  to bare `fetch` when the transport is missing or fails; when a standalone server does not inject the
  port, the original direct-connection contract holds.
- A Chromium session's custom CA does not read `NODE_EXTRA_CA_CERTS`. Only when the settings page has
  `httpProxyCaCertPath` does main read the PEM bundle and allow, through each session's
  `setCertificateVerifyProc`, certificates whose chain contains that CA; when empty, Chromium default
  verification is restored.
- Other dedicated WebView sessions such as `persist:zcode-coding-plan` do not inherit the embedded
  browser network policy. This boundary only fixes the explicit egress of the renderer and the embedded
  Browser / Browser Use; it adds no global certificate-ignore switch and does not allow unconfigured
  self-signed certificates.
- When the adapter issues requests itself (proxy, custom CA, `WebFetch` public-DNS validation), upstream
  status codes are handled like native `fetch`, and **one response can never kill the agent process**:
  `HttpClientPort` returns any status code unchanged, including non-standard codes outside 200–599
  (LinkedIn answers crawlers with `999`), and callers treat it as an ordinary non-2xx; bodyless statuses
  such as 204 / 205 / 304 yield an empty body. The proxy-aware fetch must return a WHATWG `Response`,
  which cannot represent statuses outside 200–599, so that one request fails with a `TypeError`
  carrying `code: "ZCODE_UNSUPPORTED_HTTP_STATUS"` and `status`, on the same path as network errors.
  Code that converts a Node response into an upper-layer object always wraps the `http.request` callback
  in try/catch; on failure it destroys the response and rejects that one request.
- `HttpClientPort` responses carry a redacted `egress` summary with at least: whether a proxy was used,
  the proxy source, the proxy host, whether `NO_PROXY` matched and whether a custom CA was used.
- Before spawning a subprocess, `ExecutionPort` must build the environment from the infrastructure
  layer: choose inherited or empty environment and filter the generic runtime/proxy/certificate
  variables, then restore the sealed user tool network environment, then inject the explicit egress
  policy, and finally apply the per-execution `env.set` / `env.unset` overlay. Normal commands thus get
  the user shell network configuration by default while the explicit app/provider network boundary and
  command-level exceptions are preserved.
- When `network.httpProxy` or `ZCODE_HTTP_PROXY` exists, the subprocess environment must fill
  `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and the lowercase forms. User standard proxy variables are
  not inherited input for the provider/app/general `HttpClientPort`; they enter a controlled boundary
  only through the `WebFetch`-specific fallback or tool passthrough.
- When `network.noProxy` or `ZCODE_NO_PROXY` exists, the subprocess environment must fill both cases.
  Standard `NO_PROXY` / `no_proxy` is not inherited input for the provider/app/general
  `HttpClientPort`, but may serve as the `WebFetch`-specific fallback or be restored as user tool
  passthrough.
- The startup environment of stdio MCP servers goes through the same subprocess network environment
  builder; HTTP/SSE MCP transports must receive a proxy-aware fetch and must not rely on Node global
  fetch reading proxy environment variables.
- core, bootstrap, CLI, TUI and ordinary business adapters must not call `fetch`, `http.request` or
  `https.request` directly. Exceptions are allowed only at explicit network adapter/provider transport
  boundaries, guarded by an architecture test.

## Boundary

This stage converges the default network egress; it is not an unbypassable system firewall. A subprocess
can still delete proxy variables inside the command, use its own network stack, or leave through a
non-HTTP protocol. Forcing all traffic through one egress needs an OS sandbox, container network policy
or a host-firewall-level capability later.

## Test coverage

- `ZCODE_HTTP_PROXY` routes model requests through a local HTTP proxy.
- A match of `network.noProxy` or `ZCODE_NO_PROXY` makes model requests bypass the proxy and connect
  upstream directly.
- `ZCODE_HTTP_PROXY` also routes `WebFetch` through the same proxy; the internal model request of the
  `WebSearch` handler reuses the provider transport proxy.
- Explicit CA loading result contains all Node standard public roots and the full user PEM bundle; a
  missing file fails explicitly; without config the default policy is returned. With a delayed CA read,
  requests still cancel/time out in time, uncancelled concurrent requests complete and reuse the same
  read, and a failed first read is retried by the next request. Test TLS key/cert are generated at run
  time with the certificate start time set back one day; the HTTPS proxy and upstream use separate
  certificates, covering rejection on each side. Both CLI HTTP clients trust the configured test CA over
  direct, HTTP CONNECT and HTTPS proxy, and still reject untrusted self-signed certificates.
- `ZCODE_AGENT_CA_CERT` lets `WebFetch` trust the custom CA; the internal model request of the
  `WebSearch` handler reuses the provider certificate policy.
- `network.httpProxy` or `ZCODE_HTTP_PROXY` is injected into the `ExecutionPort` subprocess environment
  with both cases of the proxy variables filled.
- `network.caCertFile`, `AppSettings.httpProxyCaCertPath` or `ZCODE_AGENT_CA_CERT` is filled into the
  common Node, curl, git and Python requests variables.
- Desktop settings `httpProxy` applies after restart to both Electron `defaultSession` and
  `persist:zcode-embedded-browser`, so renderer and embedded Browser / Browser Use traffic uses the
  explicit proxy; when empty, `defaultSession` connects directly and `persist:zcode-embedded-browser`
  follows the system proxy so the embedded browser reaches the same sites as the user's local browser.
- Desktop settings `httpProxyNoProxy` applies after restart to the `proxyBypassRules` of both target
  sessions and is injected into the agent as `ZCODE_NO_PROXY` / `NO_PROXY` / `no_proxy`.
- Desktop settings `httpProxyCaCertPath` is injected after restart into the agent `NODE_EXTRA_CA_CERTS`
  and makes both target sessions trust TLS certificates issued by that CA; other dedicated WebView
  sessions are unaffected.
- Desktop settings `httpProxy`, `httpProxyNoProxy` and `httpProxyCaCertPath` control the Window Host
  remote resource manifest, component archive and progress `HEAD` requests; no direct request happens
  when the explicit proxy fails.
- When applying the `defaultSession` network policy fails, `persist:zcode-embedded-browser` is still
  configured, and vice versa; diagnosable logs are recorded by session name.
- User shell standard proxy/certificate variables do not enter model requests, the app runtime or
  `WebFetch` directly; `WebFetch` reads only the sealed standard proxy/no-proxy fallback in
  `ZCODE_TOOL_ENV_PASSTHROUGH_JSON`. They are also restored through that sealed variable into inherited
  tool/MCP/Bash subprocesses. Command-level env overlays can still override or delete them.
- stdio MCP servers inherit the unified network environment and HTTP/SSE MCP transports get a
  proxy-aware fetch.
- Upstream `999` / `204` / `304` through a proxy: `HttpClientPort` returns the original status (empty
  body for 204 / 304); the proxy-aware fetch returns a `Response` with empty body for 204 / 304 and
  fails `999` with `ZCODE_UNSUPPORTED_HTTP_STATUS`; neither produces an uncaughtException
  (`packages/adapters/tests/http-response-status.test.ts`).
- An architecture test scans in-process sources to prevent new direct HTTP egress from bypassing the
  unified network boundary.
