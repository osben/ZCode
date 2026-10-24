# Todo127: Built-in Config Online Release and Update Chain Fix

> Status: **code and review complete; the Pro desktop refresh whole chain, macOS two-process and final file checks passed;
> phone / SSH limits remain.** The Goal was authorized. Download, lifecycle, Account alignment and recovery are connected;
> verification and release limits are in the [implementation review](./todo-127-implementation-review.md). A downloadable
> CDN file is not "usable on every end".
>
> Review evidence: [online release chain review](../research/builtin-online-release-review-2026-09-11.md). Builds on
> Todo18's download/cache mechanism; Todo18's historical completion does not mean the new URL protocol works.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-127-builtin-online-release.md`

## 1. Background and Confirmed Rulings

At survey time the server already returned a CDN URL in `data.configs.builtin_provider_config_json` while the App/CLI
still read the old `configs.zcodeBuiltin` object. The original production file was schemaVersion 1, revision 19. That same-
version conclusion is outdated: locally revision 21 this round; online still 19 and containing the deleted
`teamApiKeyManagementUrl`, which the new strict validation rejects (keeping the local candidate), so a new file must be
published separately.

- User confirmed: **every release publishes a new URL; the same URL is never overwritten**, so long CDN caching needs no
  random query bypass.
- Bundled, CDN and Active keep one shape `{ schemaVersion: 1, revision, config }`; Provider and Model are replaced
  atomically together; no new Overlay, config file or table.
- Revision rises monotonically across bundled and online releases; a rollback is published with a higher revision and a new
  URL (never by deleting the cache or lowering the revision).
- Environment authority, Personal overrides and the frozen execution boundary stay; no rewriting of model selection, old
  fields, messages, statistics, history or running Models.
- This Todo owns release transport and reliable effect; Todo113/116 own the actual model catalog, capability and default
  enablement content.
- The abandoned client business-completeness gate is not reopened: format/regex/CEL reuse the existing Parser; integrity
  and real parameters are proven by pre-release verification, with no promise that every parseable content works.

## 2. Target Chain

### 2.1 Publisher

```text
prepare full config + higher revision -> verify the exact content to upload -> upload to a new CDN URL and confirm readable and correct
  -> update client/configs.builtin_provider_config_json
```

No automatic publishing of online data and no invented publishing platform here; the result gives reusable check steps.
The old-client support range is checked via the existing app_version / platform control-plane routing; the same
schemaVersion does not imply all old versions support new fields, enums or protocols. Only one production version/platform
combination was measured.

### 2.2 Transport Entry

```ts
interface BuiltinClientConfigFields {
  builtin_provider_config_json?: string; // the real schema restricts it to a legal download URL
}
```

The value is only a URL (not compatible with a JSON string or mixed object); types derive from the schema. A missing field
does not clear the current config; an illegal field, HTTP failure, timeout, bad JSON or unsupported schemaVersion enters a
failure path with a reason and keeps a valid local candidate. App Services and the standalone CLI share the parse /
download / Release decode logic with network injected through dependencies (no two diverging implementations, no
unification of all client/configs consumers). Whether to delete the old `zcodeBuiltin` decode export is decided after
checking references; no dual-protocol priority or permanent compatibility branch by default.

| Item                               | Final ruling                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timeout                            | the two phases (client/configs request and CDN download) share **20 seconds in total**, spanning response headers and body consumption of both requests; the existing 30 s lease is kept, so the download budget is below the lease |
| Body limit                         | CDN body **10 MB**, implemented as decimal `10,000,000` bytes (replacing the earlier 5 MiB suggestion); accumulated while reading, not by Content-Length alone |
| URL                                | HTTPS in production; usernames/passwords in the address are rejected                                                                                 |
| Credentials                        | the CDN request carries no account Token or API Key and copies no auth header from the control-plane request                                         |
| Missing field                      | keeps the current config (no online release this time, not a clear command)                                                                          |
| Illegal field / HTTP failure / timeout / parse failure | keep a valid local candidate, record the reason, enter the existing download backoff                                                |
| Exit                               | cancel the request and body read, stop further application                                                                                           |

Actual file size and the timeout/size boundary tests are added at implementation; the limits are not adjustable by the
implementer. The ApiClient timeout implementation is not changed globally; the reproduced issue is fixed at the shared
Built-in download boundary.

### 2.3 Refresh Lifecycle

Keep "load bundled / valid cache first, check in the background" and the settings manual refresh; startup never waits for
the network and no download gate is added before each model request. Shared download, refresh and scheduling code lives in
`provider-node` with App/CLI injecting network capability. App/Server Host start and release it within the existing
Provider Runtime lifecycle; the standalone CLI's continuous refresh moves to the long-running runtime (the entry function
only prepares paths and the local baseline and no longer holds a refresh object destroyed after one download). Managed
Workers only read/watch the Host-injected Active file and run no download loop; the phone reuses the connected target Host.

```text
App / Server Environment Host: download + scheduling -> Active file -> Managed Worker reads / watches
Standalone CLI long-running runtime: download + scheduling -> Active file -> read by this process's config system
```

| Trigger         | Confirmed behavior                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Startup         | serve local config first, try a background refresh, obeying the shared TTL                                            |
| While running   | **check once per minute whether due**; after a normal success the network request interval is one hour (not a download every minute) |
| Download failure | existing nextEligibleAt and backoff: about 1, 2, 4 minutes increasing to a one-hour cap; only retried when due       |
| Manual refresh  | bypasses the TTL, still obeys a valid lease                                                                           |
| Exit            | stop periodic checks, cancel downloads, release resources, never block CLI exit                                       |

The per-minute check reads only the existing nextEligibleAt (no second download retry time). Several window Hosts may
check separately, with the shared lease merging network requests (no claim of one Host per machine). Config takes effect
through change notification and version alignment, not by timed waits. In-process in-flight reuse and cross-process control
file lease reuse; force bypasses only the TTL, not a valid lease; exit cancels downloads and scheduling resources without a
timer blocking CLI exit; after wake/network recovery the due state is checked without piling up missed periods; control-plane
Endpoint switching keeps the isolated path and CDN URL changes do not change source identity.

### 2.4 Commit and Effect

```text
full CDN Release -> Parser validation -> compare revision inside the file lock -> atomic Active replace
  -> Config change -> Account rebuilt on that Built-in  (+ same-version full snapshot) -> Registry
  -> settings and all model selectors / later newly created Models
Managed Worker: watches Active + receives Host Account;  Standalone: watches Built-in + credentials, derives Account itself
```

Standalone's Built-in changes and credential changes share one serial rebuild flow that reads the current Built-in and real
credentials to derive Account, with no re-login and no new API Key request for a config update; with no logged-in account a
fail-closed snapshot on the new Built-in is still generated so ordinary API Providers update.

```text
Built-in 20, Account 19 -> keep serving complete Registry 19 and start an Account rebuild
  during the rebuild Built-in goes to 21? yes: discard the 20 result and recompute for 21;  no: Account 20 + Built-in 20 -> publish full Registry 20
```

The Registry's same-version check is not removed and an old Account's revision is not just edited to fake a rebuild. A stale
result is never published when Built-in or credentials change during the rebuild; startup initialization interleaved with a
background download follows the same rule. On rebuild failure the old complete Registry is kept and the §2.3 per-minute
check decides **whether Built-in and Account are still misaligned**, retrying the Account rebuild only when misaligned;
this recovery check is not blocked by the download TTL, download failure or CDN unchanged, needs no re-download and adds no
timer. App covers the same recovery path (a successful download is not equal to a successful application).

The normal App Account rebuild and Worker protocol are reused. A Managed Worker may receive the file and Account in either
order; a same-version later publish creates the new Registry while the old complete snapshot keeps serving. File updated,
Registry updated and Worker observed are accepted separately; no second config authority and no pre-send global barrier.
Created Models stay frozen and later new Models read the updated config.

### 2.5 Implementation Order and Landing Points

1. Shared download boundary: `packages/provider-node/src/` takes the new field parsing, two-phase download and existing
   Release validation; Services `zcodeBuiltinRemoteConfig.ts` and CLI `provider-runtime-env.ts` assembly change; first
   pass BR117-01/02/03.
2. Account alignment and recovery: around `apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts`,
   Standalone Account derivation, Provider Node Runtime and App Account assembly: change triggers and stale-result handling,
   keeping `ProviderRegistryService`'s version guard; first pass BR117-06/07.
3. Lifecycle scheduling: the per-minute check and existing refresh coordination in the shared Provider Node runtime with
   App/Standalone lifecycle starting and stopping it; the same entry drives misaligned-Account recovery; verify
   BR117-04/05; nothing in Renderer or Managed Worker.
4. Whole-chain acceptance: BR117-08 to 11 with Personal, frozen execution, real consumers and the final published file,
   then gates and untested platforms. Each step failing test first, with no expansion into a global ClientConfigService or
   Account protocol refactor.

## 3. Review Items

| Item                                        | Conclusion and action                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Old field means no download                 | measured; App/CLI share URL download                                                         |
| Standalone file updated but Registry old    | reproduced at the lower layer + production subscription gap confirmed; fix version derivation and startup race |
| App body timeout ineffective                | local HTTP measurement; fixed at this feature's download boundary, not all ApiClients        |
| Only TTL, no automatic scheduling           | confirmed statically; add Environment lifecycle scheduling and real failure recovery         |
| Active only guaranteed parseable            | existing design boundary; verify the final content before publishing, no new client business gate |
| File lock / version / cache / notification  | existing targeted tests support them; keep the design and add two-phase URL download and consumer-chain integration verification |

Logs distinguish at least: missing / not yet due / being refreshed by another process / version unchanged / version older /
updated / failing phase, via the existing logger; update records contain revision and source identity and never config
bodies or full URLs with sensitive queries; normal unchanged timed checks do not flood info; downloaded/updated is not
treated as all-end application success.

## 4. Impact Brief

Planning mode; capability Built-in online config supply; layers option-source, validation, persistence, lifecycle. Seeds:
`fetchZCodeBuiltinRemoteRelease`, `fetchCliZCodeBuiltinRelease`, `ZCodeBuiltinRemoteSynchronizer`,
`NodeProviderConfigRuntime`, `NodeProviderRegistryRuntime`, `ProviderRegistryService`, Standalone Account assembly.

| Scenario / entry                                      | Shared source and commit                                                | Display / draft and authority                                  | Mode and isolation                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| Model settings refresh, template list, smart params   | useModelProviders -> ProviderSettingsService -> refreshSources -> Registry | Renderer drafts unchanged; Host Config/Registry is authority, download only writes Active | desktop and phone reuse the Host; unsaved drafts not cleared, Personal not written |
| Chat, automation, Subagent, Wiki model selection      | each reads the public Selection / Registry projection                   | each entry keeps its own commit and save ownership             | new candidates may change; history and bound executions not rewritten |
| CLI / TUI                                             | Standalone download owner -> file Source / Account -> Registry           | the CLI long-running runtime owns the config lifecycle         | no UI network download owner; no timer left by a short-lived initializer |
| Phone remote control, remote workspace                | shared-host attachment / target Environment services                    | the phone consumes the target Host; a remote Host manages its own config | no extra Agent, no copied local Registry, no mixing of workspacePath and identity |

Shared: App and CLI share Release, download and refresh algorithms (network injected by the assembly layer) while Account
derivation sources differ; the cache is written only by the owning Environment Source; Personal Repository and business
save entries are not driven by online download; Managed Workers consume Host Active and the Account protocol; Standalone
aligns Built-in/Account itself. Must-inspect: download entry, scheduling owner, file commit, Account version alignment and
Registry publication. Should-inspect: settings refresh, smart parameters, all selectors and later ModelFactory creation.
Conditional: Endpoint changes, cross-process file notification, SSH / WSL / Docker / Server own network and cache.
Invariant-only: Personal manual overrides, selection/history not rewritten, created Models frozen, desktop continuous /
phone replayable separation. Evidence-only: the review's 60 existing tests and runtime reproductions. No codegraph tool was
available (direct source call/subscription tracing and reproductions instead); the semantic graph's old remote provider
authority / defaultModelRef text has drifted, and current Design V2's target-Environment authority prevails.

Open points: no publishing backend is required first. The 10 MB cap, 20 s total timeout, 30 s lease, per-minute due check
and one-hour normal download interval are fixed. Whether the old-field decode export still has callers and the exact
helper/lifecycle signatures are decided after checking references, obeying §2. Client business gates, a changed Account
product state, new persisted fields or migration, or auto-publishing online config require a separate discussion.

## 5. Verification Plan

Dimensions: App / Standalone / Managed Worker; first start / running update / exit; missing / failure / low-equal-high
revision; normal / slow body / over lease; single / multi process; Account same-version / lagging / failing; valid / corrupt
cache. Pruned: no model x account-plan Cartesian product (one ordinary API model and one Account Provider prove
config/Account alignment; real model specs belong to Todo113/116); no UI layout change.

| ID       | Setup and action                                                                                             | Must assert / evidence layer                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| BR117-01 | client/configs returns a real-shaped URL, CDN returns a valid new release                                    | App/CLI two-phase requests, version/platform params correct, URL not treated as JSON; download -> file -> Registry consistent |
| BR117-02 | missing field, illegal URL, 404/500, bad JSON, old schema, bad regex/CEL                                     | missing vs failure distinguished; valid cache not overwritten, error diagnosable; other client/configs consumers unchanged |
| BR117-03 | slow cumulative response across phases, fast headers then slow/never-ending body, missing or false-small Content-Length, body exactly 10,000,000 and one byte over | 20 s total over both requests, body-count limit 10 MB, over-limit/timeout cancels the body, in-flight released and retryable; same semantics App/CLI |
| BR117-04 | concurrent refresh, valid lease, over-lease takeover, late old version, same version different content       | bounded dedup, no downgrade or torn write, an old owner does not overwrite a new control record; exit / Endpoint switch does not cross sources |
| BR117-05 | new version download / unchanged; fake clock per minute, covering the one-hour success interval and 1/2/4-minute-to-one-hour failure backoff; dispose | checks happen without requests when not due; refresh when due; no second retry time, duplicate scheduling or background leak; no per-model download request |
| BR117-06 | Standalone updates Built-in while running with credentials unchanged or no account; interleaved initialization; rebuild 20 then update to 21 / credential change | Account auto-rebuilds to the latest facts; stale results not published, ordinary API not stuck; no re-login, no new Key request, not just a revision edit |
| BR117-07 | App/Standalone Account rebuild fails once while download is within TTL or unchanged; Worker both arrival orders | the same per-minute check retries Account only for the misaligned state without downloading; the old Registry kept, same version after recovery; receivedRevision does not pose as applied, guard stays |
| BR117-08 | update with personal overrides / unsaved settings drafts / created executions                               | Personal file, history selection and drafts not written; new Models adopt inherited new values, old Models not replaced   |
| BR117-09 | two processes watching a shared file; Windows/macOS/Linux atomic replace                                     | consumers actually read the new revision; offline restart still has a usable baseline, a corrupt Active falls back to bundled |
| BR117-10 | desktop settings manual refresh, phone connected to the same Host, remote Environment                        | display / later execution come from each target Registry; real UI+Host / protocol evidence, no separate phone runtime      |
| BR117-11 | integrity test on the final published file, then new URL download and comparison                             | the verified object equals the uploaded object; a decoder pass cannot publish business-missing parameters; rollback uses a higher revision |

E2E handoff: follow e2e-case-lifecycle into existing Provider settings / config test directories, using a controllable
local HTTP server for client/configs and CDN, temporary Environment directories, a controllable clock and two real
consuming processes; no paid model requests. UI acceptance chains at least settings refresh -> target Registry -> a later
created execution config; the phone uses the existing shared-host attachment; uncoverable systems and remote modes are
recorded, not written as passing.

## 6. Checklist

2026-09-11 Goal design: current source still had the old inline field. Shared download module in provider-node with the
network injected via `request` (ApiClient network assembly stays, its generic timeout unchanged); the download module owns
the 20 s total budget, actual body byte cap and exit signal, with errors reporting the phase only (no URL query or config
body). The lifecycle reuses Node Config Runtime with the download owner running the shared check each minute; Account
recovery is independent of the download (not blocked by TTL/missing/failure); Standalone reuses the existing
AccountProviderService serial/change mechanism instead of a new queue and adds a pre-publish staleness check; Managed
Workers keep the Host Account Source and have no download owner; the short CLI entry only materializes the baseline and
network refresh moves to the long-running runtime.

- [x] Baseline refreshed, online field and CDN rechecked, failure-scenario tests added.
- [x] Shared URL download connected; body timeout, cancellation and resource limits fixed; Release schema kept.
- [x] Standalone Account/Builtin alignment and startup race fixed; App/Worker recovery boundaries covered.
- [x] Lifecycle scheduling and observable results added, reusing lease / backoff / file lock / revision with no second state authority.
- [x] Core integration, Pro desktop refresh E2E, final revision-22 file check and affected tests, typecheck, lint and architecture gates done.
- [ ] Phone shared-host / SSH joint verification and untested platforms (not inferred from desktop passing).
- [x] Real release limits recorded; online publishing is done by an authorized process; this Goal authorizes only pushing the working branch.

Core integration and gates were executed; real UI / multi-end and the final published file after Todo113's catalog update
close in the whole-batch acceptance. This Todo and the current Design V2 prevail; Todo18's old inline-field examples are
history only.

## 2026-10-12: Remote Refresh Failure Isolated from Business Refresh

Defect: Settings `refreshSources` put the remote Built-in and Account refresh in one `allSettled` and then threw any
failure. When the remote download-address validation failed, the whole Settings RPC failed even though Bundled/Active were
valid and Account had refreshed, so the connection switch rolled back and the post-login entitlement refresh was interrupted.

The single coordination entry remains Services `ProviderRuntime.refreshSources`. A remote download error is logged as warn
there and degraded; an Account refresh error keeps propagating; the final Registry refresh still validates the consistency
and availability of the existing Config and Account snapshot. The UI must not swallow errors, fake entitlement or store a
separate availability state.

```text
Settings refresh -> Built-in remote update: failure only a warning, valid local candidate kept
                 -> Account entitlement refresh: failure still returned to the caller
  -> Registry reads existing Config + Account -> valid and consistent: return View;  read/parse failure: failure semantics kept
```

No change to the remote download protocol, HTTPS validation, revision order, backoff or cache selection, and no
config/database migration. Concurrent refresh and event order keep the existing owner; the call still waits for both source
checks (no new background task or timeout). Desktop and Web share the Services boundary; Host attachment, task queue,
desktop-continuous and web-remote-replayable delivery semantics are unchanged. Standalone CLI download calls keep their
original failure semantics.

Regression: for HTTP address rejection, HTTP 503, bad JSON and cancellation/timeout failures, a usable Bundled/Active still
refreshes Team/Start entitlement and the model catalog; an account query failure must not be masked by the remote error;
when no valid config exists success must not be faked. The UI uses an isolated control plane to reproduce an invalid remote
address and asserts the team selection does not roll back and Start models stay selectable; the test file goes to pending
and is not promoted without manual review.
