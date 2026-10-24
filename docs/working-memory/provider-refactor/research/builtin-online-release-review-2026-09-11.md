# Built-in Online Release Chain Review (2026-09-11)

> Nature: Code facts and runtime verification; this round does not modify product code. Implementation entry is [Todo127](../steps/todo-127-builtin-online-release.md).
>
> Baseline: `af5843586b`, Builtin revision 19. Local staging was 5 commits behind origin/staging; the Provider, Provider Node, Services download entry points, and CLI startup implementations relevant to this review were compared with the remote and showed no differences. Recheck before implementation.

## 1. Summary

The transport and caching infrastructure has reuse value, but "previously written" or "old unit tests pass" is not proof that online release is reliable. Three issues are confirmed: new fields not connected, Standalone updates not taking effect, and App body read timeout failure. Refresh scheduling and release acceptance also need filling. No reason found to redo the Provider domain architecture or add a persistent schema.

## 2. Live Tests

Requesting `https://zcode.z.ai/api/v1/client/configs?app_version=3.12.0&platform=linux-x86_64` returns HTTP 200, business code 0:

```json
{
  "data": {
    "configs": {
      "builtin_provider_config_json": "https://cdn-zcode.z.ai/zcode/config/zcode-builtin.json"
    }
  }
}
```

(Irrelevant fields omitted.) The old `configs.zcodeBuiltin` was not returned; feeding the real response to the current `decodeZCodeBuiltinClientConfigEnvelope` yields `null`.

CDN download HTTP 200, `Content-Type: application/json`, `schemaVersion: 1`, `revision: 19`; the current production `decodeZCodeBuiltinRelease` succeeds — 17 templates, 8 built-in Providers, matching the repository file after normalization. `Cache-Control: max-age=31104000` (360 days); each new release gets a new URL without overwriting the same URL, so the long cache is not a bug to fix.

Limits of this evidence: only the production environment for this version/platform combination is proven to return the correct URL; the test environment request failed, so its configuration is unproven; not all server version/platform splits were verified; no online fields, uploads, or file changes were made.

## 3. Current Chain

```text
App / Server Environment Host                 Standalone CLI Entry
  Services.fetchZCodeBuiltinRemoteRelease       fetchCliZCodeBuiltinRelease
                    \                         /
                 Old configs.zcodeBuiltin decode
                              |
                   RemoteSynchronizer
            Shared control file lease / TTL / failure backoff
                              |
             Source.applyRemoteRelease + file lock
              max revision / same-version content consistency
                              |
               Atomic replacement of Active, notify config changes
                              |
              ConfigService + Account Source
                              |
          Registry (Built-in versions from both sources must match)
                     /                    \
             Settings / model selection    ModelFactory
             projection              New execution uses new config
```

Workers managed by the Host receive the same Active file path through environment variables and read/monitor the file themselves; Accounts deliver through the existing protocol. Phones attach to the target Host without independently downloading, storing, or assembling Built-in; SSH/WSL/Docker/Server maintain the target Environment authority.

## 4. Confirmed Issues and Implementation Gaps

### R1: New fields not connected, production response treated as missing

- The Envelope decoder in `packages/provider-node/src/zcode-builtin-release.ts` only reads `zcodeBuiltin`.
- Both `packages/services/src/model-provider/zcodeBuiltinRemoteConfig.ts` and `apps/zcode-cli/packages/cli/src/provider-runtime-env.ts` call only that decoder after requesting client/configs once, without URL download.
- Real production responses decode to `null` in tests; the Synchronizer treats missing as a normal result, writes the next allowed refresh time, and does not report network errors.
- Required fix: both ends share new-field parsing, downloading, and Release validation. Missing fields can remain local; but fields present with wrong types / illegal URLs / download or decode failures must be distinguished from normal defaults.

### R2: Standalone's Built-in has changed, Account version has not followed, Registry retains old version

- `apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts:80` subscribes to credential changes to rebuild Account, with no corresponding Built-in change subscription.
- `packages/provider-node/src/provider-registry-runtime.ts:40` only creates a fail-closed snapshot of uninitialized Accounts at startup.
- `packages/provider/src/registry-service.ts:204` explicitly requires Account's `basedOnZCodeBuiltinRevision` to match Config; when inconsistent, it retains the previous complete Registry. This consistency check is correct and must not be removed to make updates take effect.
- Runtime reproduction: temporary file loads revision 19, starts `NodeProviderRegistryRuntime`; updating only the file revision to 20 and reading Config, then explicitly refreshing the Registry, yields Config at 20 while Account and Registry remain 19 and refresh returns the old snapshot. Tests depend on no timer waits or real accounts, proving the underlying stall; the Standalone production assembly subscription gap is confirmed separately by code.
- Same-class startup race: when a Built-in update occurs between credential initialization and background download, startup alignment must also be covered, not just post-start updates.
- Fix direction: Standalone serially rebuilds Accounts for both Built-in and credential changes within the same lifecycle, deriving from real current credentials; if results are stale, recalculate. fail-closed snapshots based on the new Built-in must be generated even without accounts. Do not fake new parsing by merely changing the revision of old Accounts, and do not redo the login protocol.

### R3: App request timeout does not cover body read

- `packages/services/src/providers/api/nodeApiClient.ts:168` clears the internal timeout after `fetch()` returns the Response; `readApiJson` then executes `response.json()`.
- Local HTTP reproduction: headers sent immediately, JSON body ends 220ms later, `timeoutMs: 40` set; the read actually succeeds after ~228ms, not a timeout — the body phase loses timeout protection.
- CLI's current `AbortSignal.timeout(15000)` still associates with the Response body, so App and CLI behaviors must not be conflated.
- After the URL chain adds a second request, hold a cancel/timeout signal spanning response body consumption in the shared download boundary for this feature, and limit download size. The entire pull budget must match the 30s lease; do not stack two full 15s plus infinite body reads.
- Do not auto-refactor all ApiClient calls through this; start with the minimal fix for the Built-in download path, with general fixes evaluated separately.

### R4: TTL and backoff are not automatic scheduling; success does not equal Registry applied

- `NodeProviderConfigRuntime.start()` triggers only one background refresh; settings pages trigger forced refresh through `useModelProviders → ProviderSettingsService → refreshSources`.
- Standalone `prepareCliProviderRuntimeEnv` is also a single background refresh, disposing Source/Synchronizer upon completion; an unowned timer on that finished object does not claim long-running support.
- `nextEligibleAt` only constrains when the next `refresh` call occurs, not self-waking; failure backoff likewise. Writing success TTL for missing fields does not trigger automatic retries in the current process.
- App `AccountProviderService` subscribes to config changes and re-parses, so the normal path is more complete than Standalone. But if updated Account rebuilding fails, the old Account is retained and subsequent unchanged remotes will not emit config changes again — recovery verification must cover Account re-alignment, not rely on periodic repeated downloads.
- `applyRemoteRelease`'s `updated` only indicates Active has been submitted, not that all Workers/Registries have observed it; manual refresh may also be `skipped` while another process holds the lease. The current UI needs no new status enums, but logs/tests must not treat these results as "all endpoints applied."

## 5. Existing Mechanisms: Retainable, with Clear Boundaries

| Stage                 | Review Result                                                                                                                                | This Round's Handling                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Release validation    | Strict envelope, schemaVersion, non-negative integer revision; Provider/Model parser validation; regex legality and CEL compilation in formal schema | Direct reuse, no duplicate schema                                                                                                    |
| Atomic persistence    | Comparison within Active file lock, temp file atomic replace; Provider and Model whole replacement, no cross-source assembly                  | Retained, adds post-URL download integration coverage                                                                                |
| Version comparison    | Lower version stale; same-version same-content unchanged; same-version different-content rejected; same-version cache conflict at startup falls back to bundled | Retained; content rollback emits higher revision                                                                                     |
| LKG / bundled         | Parseable candidates take newer; damaged, old schema, lower version can fall back to bundled; both candidates invalid errors                   | No new empty config or fake-success fallback                                                                                         |
| Environment isolation | Platform/App version/control plane Endpoint path split; revision contains source path identity                                                | CDN URL is only this source's current transmission address; changing URL does not change cache identity or clear historical revision |
| Concurrent refresh    | In-flight merging within process, inter-process lease; force does not bypass valid lease; final file lock+revision prevents rollback          | Retained. Lease is expiring dedup, not permanent exclusion; adds two-stage slow requests, takeover, late-response regression          |
| Exit/Endpoint         | Existing post-download disposed/Endpoint check and old source dispose                                                                        | Added download body, pre-submission, and timer lifecycle verification; does not claim coverage of all switch timings                 |
| Change projection     | Source→Config→Registry complete publish; Host Account changes notified to Workers through protocol; Workers listen to Active                  | Linux unit tests already supported; real desktop/mobile, multi-process cross-platform still need acceptance                          |
| Personal/execution    | Online source belongs to the same Built-in candidate, Personal preferred; created Models frozen                                              | Does not rewrite selection, history, or running models; subsequent executions parse new config normally                              |

### Validation Capability Limits: Not a New "Design Violation"

Runtime reproduction: delete general Model/Model+API/Site rules from a real release, keep template list and exact enable/disable, use a higher revision. `decodeZCodeBuiltinRelease` still succeeds, `applyRemoteRelease` returns updated and writes to disk; parsing GPT-6 makes `validateComplete()` report 2 missing items. Thus **parseable does not equal model usable**; such content replaces Active rather than automatically rolling back to the previous version.

This aligns with the [Todo19 ruling](../steps/todo-19-zcode-builtin-release-integrity-validation.md): the first version of remote sync adds no client-side business integrity validators and injects no fake accounts or API Keys to validate the entire Registry. This round does not quietly restore abandoned Todo19, nor reject public configs based on current Personal/account rejections. Releases must run the existing real Built-in integrity/rules/request tests on the final file before upload, adding this feature's two-stage download acceptance; do not hardcode tests to only verify repository files while uploading different content. Whether to add independent release tools, fully automated pipelines, or client-side business gates later needs separate rulings. Configuration business errors cannot promise automatic rollback; the current recovery method is correction releases at higher revisions.

## 6. Runtime Verification and Limitations

| Evidence                                                                                                          | Result                                                                                                |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Production client/configs → CDN → production decoder → local file normalization comparison                         | Success; old Envelope returns null for the same response, see §2                                      |
| Root Vitest: Services download, Provider Node release/runtime, Services config runtime, Provider Registry Service | 5 files, 46 passing                                                                                   |
| CLI `tsx --test packages/cli/tests/provider-runtime-env.test.ts`                                                  | 4 passing                                                                                             |
| CLI's own Vitest: `packages/bootstrap/tests/process-provider-registry-runtime.test.ts`                            | 1 file, 10 passing                                                                                    |
| Temporary Runtime, HTTP, missing-rule Release reproduction                                                        | Proves R2, R3, and business integrity boundaries respectively; no production config or tests modified |

Root Vitest does not collect the CLI target files by default; separate runners were used (giving bootstrap's Vitest file to node:test once caused a runner error — passing 10 under CLI Vitest is not a product defect). Total 60 existing tests passing; **none are new URL chain acceptances**.

Reproduction scripts: `/tmp/builtin-review-repro.mts`, `/tmp/builtin-timeout-review.mts` (read-only code; test state in the system temp directory, cleaned up). During implementation, convert these scenarios to repository-persistent tests. Logs: `/tmp/builtin-online-full-review-tests.log`, `/tmp/builtin-online-cli-entry-review-tests.log`, `/tmp/builtin-online-bootstrap-review-tests.log`.

No actual desktop/mobile E2E, real cross-process updates, Windows/macOS file watcher, SSH/WSL/Docker/Server network verification was performed; no paid model requests sent, no online releases executed. Do not claim the above have passed.
