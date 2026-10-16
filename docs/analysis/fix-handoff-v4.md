# Exa MCP OAuth Repair Implementation Handoff Brief (v4)

> Handoff from staging session (2026-08-14). This worktree has completed the first-phase root cause analysis (see `exa-oauth-reauth-analysis.md` in the same directory). This document is Phase 2: implement PR1-3 per the v4 design specs.
> You are the implementer. The review team has completed three rounds of adversarial reviews.

## 0. Step 1: Absorb the Third-Round Final Review Conclusions

The final review conclusions (v4 convergence review) are delivered separately:

- If the conclusion is "implementable": proceed directly with this brief. Before the final review conclusions arrive, first work on step 2 spec skeletoning that is unrelated to the review.
- If there are still blocking items: absorb the blocking items into the design (revise the corresponding spec chapters). Blocking items only affect the details of the corresponding PR, not overturning the two-phase overall architecture (which has already been confirmed in two rounds of reviews).

## 1. Background and Two Root Causes (Finalized, Do Not Re-Analyze)

The production package is `@modelcontextprotocol/client@2.0.0` (`apps/zcode-cli/packages/adapters/package.json:105`). Note that the repository also has `@modelcontextprotocol/sdk@1.29.0`; do not read the wrong package.

- **Root cause 1 (refresh race)**: Multiple CLI processes share `~/.zcode/v2/credentials.json`; `withFileLock` only covers credential reads/writes, not network token exchanges; when access tokens expire, each process concurrently refreshes using the same refresh token, hitting the server's rotation reuse-detection, the token family is revoked -> SDK invalidates tokens -> requires re-authorization.
- **Root cause 2 (secondary authorization dead loop)**: DCR-registered clients lock `redirect_uris` to the callback port at registration time; callback servers switch ports each time with `listen(0)`; when redirect_uri mismatches, the authorization server (RFC 6749 §4.1.2.1) prohibits returning to render error pages in-place (the Exa "Server Components render error" seen by users) -> callbacks never arrive -> timeouts, and retries never self-heal.
- Key code: `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts` (595-line single-file provider), `src/auth/localhost-callback.ts`, `src/mcp/index.ts` (connection orchestration, oauthSessions survive long after connection success, only closed by closeRecord), `src/auth/shared-credentials.ts`.

## 2. v4 Plan (Two-Phase Connections, Three Rounds of Reviews Completed)

### Design Principles

1. Passive connections: zero listeners/zero discovery/zero DCR.
2. Interactive authorization only builds listeners, cross-process single-flight, DCR client transactions in memory.
3. All refreshes (proactive + reactive) merge into one cross-process file lock.
4. Deterministic OAuth error CAS invalidation, only fail-soft for non-deterministic errors.
5. 15s is the caller's waiting budget; the global transaction lifetime is 300s; the two are separated.

### Phase 1 Runtime: Pure Minimal AuthProvider

client@2.0.0 natively supports (`node_modules/@modelcontextprotocol/client/dist/index.d.mts:186`): when passing pure AuthProvider (only `token()` + `onUnauthorized()`), the transport's `_oauthProvider` is empty (`dist/index.mjs:4978-4980`), 401s only call our `onUnauthorized` and automatically retry once; the SDK's auth()/discovery/DCR do not participate. **Do not** pass OAuthClientProvider to runtime transport (it will be wrapped by adaptOAuthProvider, 401s go through SDK auth() bypassing our locks).

```ts
{
  async token() {
    const pair = await loadCanonical();
    if (!pair?.tokens) return undefined;                  // -> 401 -> onUnauthorized
    if (!isNearExpiry(pair)) return pair.tokens.access_token;
    return refreshUnderLock(pair);
  },
  async onUnauthorized() {                                // automatically retried once by transport
    const pair = await loadCanonical();
    if (!pair?.tokens?.refresh_token) throw interactiveRequired();
    return refreshUnderLock(pair, { reactive: true });
  },
}
```

refreshUnderLock (`refreshAuthorization` imported from `@modelcontextprotocol/client`, verified to exist):

```
withFileLock(<independent refresh lock file, basename only hash/hyphens, no colons — Windows illegal>, async () => {
  cur = loadCanonical()
  cur.generation !== pair.generation → return cur.tokens?.access_token    // Merged, zero second requests
  meta = resolveAsMetadata()
    // discovery_state exists and not expired (self-defined TTL 24h) → use directly
    // Missing/expired → discoverOAuthServerInfo() once (public metadata) → write back → continue
    // Discovery failure → fail-soft return current value, never treat as grant invalid
  next = refreshAuthorization(meta.url, { ...meta, clientInformation: cur.client, refreshToken, resource })
    Success → publishCanonical({ clients unchanged, tokens: next, obtainedAt: now }); return next.access_token
    invalid_grant  → compareInvalidateTokens(cur.generation); throw interactiveRequired
    invalid_client → compareInvalidateBoth(cur.generation);  throw interactiveRequired
    Network/5xx → fail-soft return current value
})
```

- `interactiveRequired()` = stable code + symbol-branded errors (not just instanceof, resistant to bundle repeated loading). SDKs bubble non-OAuthErrors as-is and transports use `Symbol.for("mcp.authSeamEscape")` to preserve identity (`index.mjs:2263,2270-2277`); adapters must identify it before `failConnection()` (near `mcp/index.ts:570`), and create new transports for Phase 2 (transport closed by negotiation cannot be reused, `index.mjs:3283`).
- Canonical credential structure adds `obtained_at`/`expires_at`/`issuer` (issuer is stored only as a field, per-AS keying not done in this pass). **Migration**: Old records without time fields → treated as near-expiry and enter locks to try once refresh (lock-internal re-reads prevent multi-process concurrency triggering); if that single attempt receives invalid_grant (old family was already dead, exactly the exa on-site scenario) → compareInvalidate + enter Phase 2, this path is correct.
- 403 insufficient_scope: Under pure AuthProvider, SDKs ignore default 'reauthorize' and directly throw `InsufficientScopeError{requiredScope,...}` (`index.mjs:5010`) → adapters compute unionScope = token.scope ∪ requiredScope → enter Phase 2 with unionScope (both DCR's clientMetadata.scope and authorize use it), otherwise 403 infinite loops.

### Phase 2 Interactive Authorization: Independent Authorization Lock + baseline generation + real abort

```
G0 = Current canonical generation (baseline)
tryAcquire(authz-lock:<hash>, maxWaitMs≈0)          // Independent lock file, not locking main credentials file
 ├─ Did not win → follower: poll canonical, when generation ≠ G0 return to Phase 1 reconnection
 │            Caller budget (session 15s/settings 300s) reaches → report "authorization in progress elsewhere", continue waiting in background
 └─ Won → leader:
      Re-read inside lock: generation ≠ G0 (others completed during wait) → release lock and finish
      listen(0) random port (completely abandon port reuse — listeners survive long during connection phase, reuse will definitely collide)
      Interactive OAuthClientProvider (new states, scope = unionScope):
        clientInformation(): Static configuration clientId → return; otherwise undefined
                            → SDK must use the currently surviving listener's URL to re-DCR → redirect_uri mismatch eliminated at root
        saveClientInformation(): Only write transaction memory (all production read-sides only oauth.ts, verified;
                                 client@2.0 will supplement issuer for old clients and callback saveClientInformation,
                                 interactive semantics = memory, passive has no such method, will not pollute canonical)
        tokens(): undefined (do not trigger refresh)
        saveTokens(): Lock-internal saveMany atomic publish canonical + legacy (clients from transaction memory, same authorization as tokens)
      Authorization URL + states written to shared pending_authorization keys (with TTL) → session TUI / settings pages can all read to display
      Wait for callbacks until global TTL 300s
      On abandon: AbortController real cancels listener/fetch/finishAuth
        // Existing withTimeout only ignores late results without cancellation (timeout.ts:1); real abort means late
        // token exchange still publishes, fencing (= locks) would miss
      finally: Release lock + delete pending keys + close listeners + destroy transports → **Return to Phase 1 reconnection**
```

- **Phase 2→1 handoff is a hard requirement**: After authorization success, must discard Phase 2 transports and re-connect to Phase 1 using passive providers. Reusing Phase 2 authenticated transports in runtime 401s goes through SDK auth() bypassing refresh locks.
- Using independent authorization locks instead of markers/long-lock concerns has been disproven by code: `withFileLock`'s maxWaitMs only limits acquisition, not holding (`packages/shared/src/node/privateFilePersistence.ts:51`); live PID locks are not recycled by stale (`atomicFileLock.ts:69`); `67666ea256` fixes waiter timeout mis-cleanup. The lock itself is fencing.
- All listen errors like `EACCES/EMFILE/ENFILE/EADDRNOTAVAIL` are handled as leader failures (release locks to retry/report), not special-handled for EADDRINUSE.
- localhost-callback state verification: mismatches → return 400 but **do not reject its own callback promise** (continue waiting for correct callbacks); states matching with `error=access_denied` → immediately settle failures.

### PR Sequence (Order Cannot Be Reversed)

| PR  | Content                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR1 | localhost-callback: state mismatches do not poison promises; states matching error=access_denied settle immediately. oauth.ts: invalidateCredentials branches, authorization/refresh events add warn-level logs (no plaintext tokens)                                                                                                                                                                                        |
| PR2 | Phase 2: Independent authorization locks + fresh DCR transaction memory + lock-internal atomic publishing + pending_authorization shared keys + caller budgets separated from transaction lifetimes + real abort. **Fix root cause 2**. Note: When PR2 lands, Phase 1 is still the existing provider; interactive paths are first hung on new Phase 2 orchestration                                                          |
| PR3 | Phase 1 switching to pure AuthProvider + refreshUnderLock (locks + merge + deterministic error CAS invalidation) + obtained_at/expires_at migration + discovery TTL + 403 unionScope passing + Phase2→1 handoff. **Fix root cause 1**. PR3 must come after PR2: after Phase 1 switches to pure AuthProvider, SDKs no longer spontaneously initiate interactive authorization; if PR2 is not in place, users cannot authorize |

## 3. Execution Contract

1. **Spec first**: First update `docs/mcp-oauth-client-auth.md` (promote the cross-process OAuth leader/lease and refresh single-flight two items that were deferred to v4 design, add two-phase timing diagrams; repository specs see apps/zcode-cli/.claude/CLAUDE.md). Create new `docs/mcp-oauth-two-phase.md` or merge into the previous one, judge yourself, keeping document structures consistent.
2. **Each PR as independent commit** (conventional commits, e.g., `fix(adapters): ...`), run `npm run lint` and related tests before committing. Work on the current branch `exa-oauth-analysis` (based on staging bfc91c54a9), do not push, do not create MRs, stop after completion and report.
3. **Test matrix** (acceptance criteria per PR, using production package client@2.0.0, existing e2e switched from sdk@1.29 direct imports):
   - PR1: Error state requests arrive first, correct requests arrive later → still succeeds; access_denied → fails immediately.
   - PR2: Two real subprocesses compete for leaders → exactly one listener/one DCR/one authorization URL; A times out, B takes over; A's late saveTokens must fail (fencing); ServerError/403 paths when old canonical still exists, leaders must not treat old tokens as new generations.
   - PR3: First connection without credentials asserts zero discovery/zero DCR/zero listeners; rotation-strict servers + barriers dual-process only one refresh request (reference feat/cli-opt branch 22ba5d86c4's test `mcp-oauth-proactive-refresh.test.ts`, note file layouts have forked and cannot directly be cherry-picked); invalid_client asserts client+tokens pairs wholely invalidated; old canonicals without time fields → exactly once refresh attempt, not repeatedly.
4. **Reference implementations** (read-only references, cannot be cherry-picked, file layouts have forked): `git show e2b55fcd46` (fixed-port direction, already rejected, only look at static client config parts); `git show 22ba5d86c4` (refresh lock and barrier testing approaches).
5. Known limitations written into specs, not fixed in this pass: issuer does not participate in keyPrefix keying (stored field only); remote SSH/container scenarios callbacks cross-host unreachable (existing issues).
6. When encountering design-level dilemmas (e.g., final review conclusions conflict with this brief and cannot be reconciled), stop and list them in the report, do not independently make architectural changes.

## 4. Runtime Evidence (Collected at Localization, For Verification)

- Logs: `~/.zcode/cli/log/zcode-2026-08-1{1,2,3}.jsonl`; 8-11 11:27 the only successful authorization, 8-12 09:00 refresh failure after 121 authorization.required, 0 completed.
- Credentials: `~/.zcode/v2/credentials.json` key prefix `mcp:oauth:c50fd1fa...`; exa's `client_information` (redirect_uris locked to 127.0.0.1:54735), `tokens` already deleted. notion/linear/canva/atlassian similarly lock historical random ports, same-class risks.
- Reproduction: Authorization pages rendering error pages for mismatched redirect_uris has been tested (auth.exa.ai renders error pages in-place).
