# Security audit report (2026-06-09)

Full history: `git show b8876e8b:docs/security/security-audit-2026-06-09.md`

This is a point-in-time audit ledger. Findings, versions and file:line evidence are as of 2026-06-09; their
current status was not re-verified during documentation compaction.

## Scope

- Repository: `/Users/dev/workspace/z-code`
- Scanned: source, config, scripts, documentation examples, currently tracked Git files, part of Git history, the production dependency tree.
- Focus: AK/SK leakage, credential storage, Electron/IPC exposure, Web/remote-control interfaces, command execution, log redaction, dependency vulnerabilities.
- Not done: real penetration testing, runtime CDP/packet-capture verification, code audit of the third-party relay server.

## Commands run

- `rg` rule scans: AK/SK, OpenAI/GitHub/Google/AWS/Slack tokens, private key blocks, dangerous APIs, IPC, CORS, command execution.
- `git grep` sensitive-pattern scan of currently tracked files.
- `git log -G` sensitive-pattern scan of Git history.
- `pnpm audit --prod --json` production dependency audit (run online).
- `pnpm lint`
- `pnpm typecheck`

## Overall conclusion

No high-confidence real AK/SK, private key or long-term cloud credential in plaintext was found in currently
tracked files. The key-shaped hits are mainly documentation placeholders, test fake values and redaction test
samples.

Four kinds of real risk need priority handling:

1. Production dependencies have 19 high, 42 moderate and 4 low vulnerabilities, concentrated in `axios`, `protobufjs`, `basic-ftp`, `fast-uri`, `mermaid`, `dompurify`, `hono`.
2. A release script still embeds a default Docker registry username and the default password `123456`, a weak-credential path open to misuse.
3. The Web HTTP server's `/ws` and `/api/connect-remote` have no authentication; if bound to a non-local address or exposed through a reverse proxy, they directly expose local/remote workspace service capability.
4. The credential-encryption fallback secret is derived from `platform + homedir + username` and cannot resist offline decryption by the same local user or anyone who obtains the config files.

## Findings

### P0: production dependencies have high-severity vulnerabilities

Evidence: `pnpm audit --prod --json` returned `critical=0`, `high=19`, `moderate=42`, `low=4`; 1246 production dependencies in total.

| Module       | Version  | Path                                                                         | Risk summary                                                                           | Suggested version              |
| ------------ | -------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------ |
| `axios`      | `1.13.6` | `packages__desktop>@larksuiteoapi/node-sdk>axios`                            | Several prototype pollutions, proxy credential leak, request hijacking, ReDoS/DoS      | `>=1.16.0` or upstream upgrade |
| `protobufjs` | `7.5.5`  | `packages__desktop>@larksuiteoapi/node-sdk>protobufjs`                       | Code-generation gadget after prototype pollution, recursive DoS, unsafe option path    | `>=7.5.8`                      |
| `basic-ftp`  | `5.2.2`  | `apps__zcode-cli>proxy-agent>pac-proxy-agent>get-uri>basic-ftp`              | A malicious FTP server can trigger client memory/response-buffer DoS                   | `>=5.3.1`                      |
| `fast-uri`   | `3.1.0`  | `apps__zcode-cli__packages__adapters>@modelcontextprotocol/sdk>ajv>fast-uri` | percent-encoded authority/path confusion that may affect SSRF/path traversal decisions | `>=3.1.2`                      |

Other moderate/low highlights:

- `mermaid@11.14.0`: CSS/HTML injection, Gantt DoS; path `packages__ui>@streamdown/mermaid>mermaid`; suggested `>=11.15.0`.
- `dompurify@3.3.3`: several sanitizer bypasses; path `packages__ui>@streamdown/mermaid>mermaid>dompurify`; suggested `>=3.4.0`.
- `hono@4.12.12`: JWT scheme, cookie/header, bodyLimit, JSX injection and other moderate/low issues; path `apps__zcode-cli__packages__debug>hono`; suggested `>=4.12.21`.
- `electron@41.0.3`: low/moderate Electron advisories; path `packages__desktop>@arms/rum-electron>electron`; suggested `>=41.1.0`.

Recommendations:

- First assess feasibility of one `pnpm update axios protobufjs basic-ftp fast-uri mermaid dompurify hono electron --latest -r`.
- For transitive dependencies such as `@larksuiteoapi/node-sdk`, `@modelcontextprotocol/sdk`, `@streamdown/mermaid`, upgrade the direct dependency first; if not possible short-term, pin patched versions with pnpm `overrides` and run regression.
- Until the Mermaid/DOMPurify fix, keep Mermaid rendering strictly sandboxed or disable untrusted diagram rendering.

### P1: Docker release script embeds default weak credentials

Evidence: the old single-version remote-control release script (since deleted; the historical conclusion is kept), `scripts/docker-build-and-push-web-remote-control-test.sh:6-8`.

Status at audit: the default username was a personal email; the default password was `123456`; the script only printed a warning and still ran `docker login`.

Risk: if the registry still accepts that password anyone with the script can push images; even if invalid, it encourages CI/local misuse of weak credentials and sets the wrong expectation that the default password works.

Recommendation: remove the default username and password and require `DOCKER_REGISTRY_USERNAME` and `DOCKER_REGISTRY_PASSWORD`; the default-password path should fail directly instead of continuing to login; rotate the registry account password and check recent push records.

### P1: Web HTTP server exposes unauthenticated RPC/remote-connection capability

Evidence:

- `packages/server/src/http.ts:80-92`: `/ws` creates the local-service ChannelServer without authentication.
- `packages/server/src/http.ts:95-114`: `/api/connect-remote` accepts remote connection parameters without authentication.
- `packages/server/src/http.ts:159-188`: `/ws/remote/:id` fetches a connection by random id with no extra identity check.
- `packages/server/src/entry-http.ts:6-7`: default port 3030, hostname not explicitly restricted.

Risk: if the server is bound to a non-loopback address, exposed by container port mapping, an intranet reverse proxy or a debug environment, an attacker can connect to the RPC service and further reach file/system/terminal/git capability; `/api/connect-remote` can be abused to launch SSH/WSL/Docker connection attempts, forming a lateral-probing or credential-exposure surface.

Recommendation: `createHttpServer` should explicitly bind `127.0.0.1` by default; introduce a local random bearer token or origin-bound session token that `/ws`, `/api/connect-remote` and `/ws/remote/:id` must all validate; if Web mode is only for local development, state "must not be exposed to the public internet" in startup logs and docs and disable the unauthenticated entries in production builds.

### P1: the credential-encryption fallback secret is derivable

Evidence: `packages/services/src/credential/providers/credentialCipherProvider.ts:23-37`; `apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts:87-100`.

Status at audit: AES-256-GCM with a random IV (a reasonable algorithm choice); without `ZCODE_CREDENTIAL_SECRET` the key is derived from `platform + homedir + username`.

Risk: the same local user, a local malicious process that obtains the config directory, or an environment that leaks the home path/username can derive the key offline; this is not the protection level of the OS keychain / Electron `safeStorage`.

Recommendation: Desktop should migrate to Electron `safeStorage` or system-keychain-managed keys first; the CLI/host fallback should at least generate a one-time random master key protected by OS permissions instead of deriving from a predictable string; migrate old `enc:v1` credentials to the new format on read.

### P2: Electron `openExternal` has an unvalidated IPC entry

Evidence: `packages/desktop/src/preload/index.ts:309`; `packages/desktop/src/main/desktopMainIpcRemote.ts:90-92`.

Status at audit: the Renderer can send an arbitrary string to main through `window.zcode.openExternal(url)`; main calls `shell.openExternal(url)` directly with no protocol allowlist; another webview popup path already validates with `isAllowedEmbeddedBrowserNewWindowUrl`, showing an adjacent protection pattern exists.

Risk: if renderer XSS, malicious markdown/link handling or a supply-chain script can call the bridge, an unexpected protocol handler may be triggered; the impact is limited by Electron/OS protocol policy but main should hold a last allowlist.

Recommendation: implement a unified `openExternalSafe(url)` in main that allows only `http:`/`https:` (and project-required custom deep links if needed); log rejections at warn without the full sensitive URL query.

### P2: the Web remote-control QR URL carries `passHash`

Evidence: `packages/shared/src/web-remote-control.ts:254-283`; `packages/desktop/src/main/webRemoteControlRelayAuthProvider.ts:17-22`.

Status at audit: `passHash = sha256(password)`, the QR parameter is named `hash`; later authentication proof uses `HMAC-SHA256(passHash, nonce|role|deviceSid)`.

Risk: `passHash` is effectively a bearer-equivalent secret, not an unusable ordinary hash; QR screenshots, browser history, proxy logs and Referer leaks can give an attacker a reusable pairing credential. The existing `resetPairing`/`leaked-qr` semantics show leakage was considered, but the URL query still widens the leak surface.

Recommendation: replace the long-term `passHash` in the QR with a short-lived one-time pairing token, with the relay/device negotiating or issuing a persistent credential after successful pairing; give the QR an expiry, with the relay enforcing `t` and single consumption; the mobile side clears the `hash` parameter from the address bar right after entering.

### P2: debug Hono server enables global CORS

Evidence: `apps/zcode-cli/packages/debug/server/index.ts:29-31`, `:107-119`.

Status at audit: default host is `127.0.0.1` (a good risk-reducing design); `app.use("*", cors())` opens cross-origin access for all debug APIs.

Risk: if the user exposes the debug server via `host=0.0.0.0` or a reverse proxy, any web page can read traces/network capture; the debug API contains sensitive debug assets such as trace, network requests and CA certificates.

Recommendation: CORS should allow only the local UI origin by default and require an explicit token when exposed beyond loopback; add a local token or a startup-time random secret to sensitive endpoints such as `/api/network/ca.pem`.

### P3: the local `.env` contains a real OpenAI API Key but is not tracked by Git

Evidence: `.gitignore` ignores `.env`; `git ls-files` does not contain `.env`; the local `.env` has an `OPENAI_API_KEY` of length 56 (the raw value is not recorded).

Risk: not committed, but a real key exists in the working directory; later copying, packaging, log output or a manual commit can still leak it.

Recommendation: confirm whether the key is still needed, delete it or move it to system credential storage if not; rotate it if it was used in tests or may have been exposed to terminals/logs; keep `.env` ignored; a new `.env.example` must contain only placeholders.

### P3: Git history once committed `.env.production` with placeholder OSS fields

Evidence: `.env.production` now contains only production link constants and the public OAuth client id and no longer stores the current product environment selection; `git log -- .env .env.production .env.local .env.e2e.local` shows 5 related history entries; historical commit `60345957e`'s `.env.production` once contained `OSS_ACCESS_KEY_ID` and `OSS_ACCESS_KEY_SECRET`, both of length 7 with masked forms `yo***ak` / `yo***sk`, judged to be placeholders rather than real AK/SK.

Risk: no real OSS AK/SK found, but env files once entered version history, showing the process once allowed sensitive config into Git.

Recommendation: if it cannot be confirmed that these values are absolutely placeholders, treat them as leaked and rotate the OSS credentials; add secret scanning to pre-commit/CI, such as gitleaks or trufflehog.

## Confirmed positive controls

- `.gitignore` ignores `.env`, `.env.local`, `.env.*.local`.
- Log export has sensitive-field redaction covering token, authorization, password, api key, URL query and more, with UTF-16-related bugfix comments and tests.
- The Electron main window enables `contextIsolation: true`, `nodeIntegration: false`.
- The webview popup path already has a URL allowlist and window-open deny policy.
- Remote SSH passwords/private-key passphrases are stored through the credential service and not written directly into workspace history.

## Verification results at audit

- `pnpm lint`: passed, 0 errors, 74 warnings (all pre-existing unused variable/import warnings).
- `pnpm typecheck`: passed.
- `pnpm audit --prod --json`: failed with exit code 1 because vulnerabilities exist; the online audit returned the vulnerability list.
- `git status --short`: clean before the audit; this report file was the only addition.

## Suggested fix priority (open items)

1. Dependency vulnerabilities: handle `axios`, `protobufjs`, `basic-ftp`, `fast-uri`, `mermaid`/`dompurify` first.
2. Remove the default weak credentials of the Docker release script and rotate the registry account.
3. Add local binding and authentication to the `packages/server` HTTP/WS entries.
4. Rework the credential master key: migrate from the derivable fallback to the system keychain or a random master key.
5. Have main uniformly validate the `openExternal` URL protocol.
6. Change the Web remote-control QR to a short-lived one-time token and clear the URL query.
7. Add secret scanning to CI to stop `.env*` and high-confidence keys from entering the repository.
