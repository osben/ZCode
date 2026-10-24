# Todo127 Implementation, Verification and Review

> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-127-implementation-review.md`

## Implementation Boundary

Implemented under the 2026-09-11 Goal authorization, keeping the existing layering and Release schema: no data migration,
no restoring of the deleted field, no change to other client/configs consumers.

```text
App / Server Environment (existing ApiClient)   Standalone Prompt / TUI (existing fetch)
   -> provider-node shared URL download: control plane -> HTTPS CDN -> validation -> Active
   -> Config change -> AccountProviderService (Built-in / credentials share one serial queue, stale results dropped)
   -> same-version Registry publication
Environment per-minute check: download (existing lease + TTL + failure backoff); rebuild Account only when misaligned (not blocked by the download result)
Managed Worker: consumes the file and Host Account only, owns no download loop
```

- Two-phase total budget 20 s including the body; real byte cap 10,000,000; HTTPS CDN, URL userinfo forbidden, redirects
  not followed, no account header/Cookie. Failures report only the phase, schema path / error category (no URL query, body or Key).
- Success interval one hour; failure 1/2/4 minutes up to one hour; 30 s lease; an explicit refresh bypasses the TTL, not the
  lease. Normal checks log debug, updates info; cancellation is not counted as a network failure.
- The CLI entry only materializes the bundled resource and passes paths; the new bundled-environment path is used only by the
  long-lived Standalone (a Managed process inheriting that field creates no downloader).
- The Account source is built from the current Config; credentials and Built-in share one refresh queue and old async
  results are not published. A first concurrent read is merged (a second reader is not mistaken for a new fact causing
  fail-closed and a repeated start failure).
- A failed Account rebuild keeps the complete old Registry; the per-minute check rebuilds only when versions are misaligned,
  with no re-login, Key request or forced CDN re-download.
- The Registry version guard, fixed execution and original Personal/Selection are kept. A late Active write at exit was
  fixed; file-lock cleanup still completes asynchronously.

## Verification Mapping

| Item           | Evidence                                                                                                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BR117-01/02/03 | `zcode-builtin-download.test.ts`: new URL, missing field, HTTP/JSON/schema/regex/CEL, both sides of 10 MB, two-phase total 20 s, cancellation; Services tests use the real NodeApiClient assembly with no auth spread                                                  |
| BR117-03       | `zcode-builtin-http.test.ts`: real HTTP returning headers but never ending the body is cancelled at about 20 s on the socket and the next request succeeds; the CDN test maps transport to localhost and is not a real CDN TLS test                                    |
| BR117-04/05    | Release 16 items + lifecycle 2 items: lease/force/version/Endpoint/exit, minute scheduling, one-hour TTL, 1/2/4/8/16/32/60-minute backoff; the mechanism that an old owner does not overwrite the control file is kept                                                 |
| BR117-06       | Bootstrap 12 items: new long-lifecycle two-phase download -> Active -> Registry; credentials unchanged / no account still follows, Managed does not download; existing real credential change, invalidation, first-read failure keep passing                           |
| BR117-06/07    | AccountService 9 items, stale Built-in queries not published; `providerBuiltinRecovery.test.ts` uses real Config/Account/Registry: failure keeps the old version, within TTL the next minute recovers only Account                                                     |
| BR117-08       | `zcode-builtin-consumption.test.ts`: new Registry model update, the already-obtained config unchanged, Personal byte-identical, personal override and selection kept; the whole-batch execution verification of a truly created Core Model still needs the final batch |
| BR117-09       | `zcode-builtin-process.test.ts`: two real child processes observe the atomic file replace and all output Built-in and Account on the same version; passes on Linux and Pro macOS, Windows untested                                                                     |
| BR117-10       | Pro full Electron BR117-N02 passes: settings refresh -> formal HTTPS download -> Registry -> new Model wire; phone shared-host / SSH joint acceptance not tested, no continuous/replayable protocol change                                                             |
| BR117-11       | the final revision-22 file after Todo113 Round 2: 14 items pass, SHA256 in the whole-batch final review; the earlier revision-21 copy is history, not "published online"                                                                                               |

Root typecheck, CLI Bootstrap/CLI typecheck, root lint (0 errors, 42 existing warnings) and architecture (0 new / 0 total
violations) pass. The first batch run was 479 passed / 2 failed: one was Todo128's new local argument misusing the retired
name `providerRevision` (changed to the real `registryRevision`, no behavior change); the other was a test deleting its temp
directory before the background lease write finished (now waits for the refresh to finish); the two files then pass 55
items. No boundary test was loosened and no sleep fallback added. Review logs:
`/tmp/provider127-{all-unit,review-fixes,standalone3,entry,integration,recovery,consumption,api-client,artifact,types2,cli-types,lint,arch}.log`;
real HTTP+process tests 2 items and CLI Entry 4 items pass. Integrity copy `/tmp/provider127-release-FPDKMA/zcode-builtin-21.json`
SHA256 `e9403074ad99eca33538d8c76cc6cce9bffeca8daa84f767c44a2c51151cad08`.

## Pro Supplementary Acceptance (2026-09-12)

- `zcode-builtin-http/process/consumption.test.ts` pass 3 files / 3 items on Pro (Node 24.14.0, Darwin arm64): the real slow
  body is cancelled at the 20 s budget then retried; two real processes each publish the same-version Built-in/Account;
  Personal bytes and overrides and the already-obtained config object are kept (config-object retention is not proof of
  frozen created Core Models, which the whole-batch SDK/Core cases cover). Log `/tmp/provider-20260912-pro-builtin-runtime.log`.
- New accepted pending BR117-N02: the real Electron app obtains a versioned CDN URL from an isolated test HTTPS control
  plane; only the new URL returned by the control plane changes, the settings refresh is clicked, and capacity goes
  500K -> 700K. The real connection-test request's `top_p` is 0.17 / 0.37 before/after with the same model identity;
  Personal is byte-identical and the preset recent-selection cache unchanged. No mocked downloader, Registry, platform or
  Model; no Active write, no daily account, no real CDN publishing. Case:
  `packages/desktop/test/e2e/settings/manual-review/pending/provider-builtin-refresh.test.ts`. Model responses are
  synthetic / fast-text and the manifest states two requests (not "no model requests"); the control plane and CDN answer
  via the existing MITM test proxy with a configured CA, without loosening the product HTTPS validation.
- The settings refresh does not become a business pre-send wait and still uses the established Host update notification /
  Account alignment path. It does not cover running Models and does not replace paid-account entitlement or phone/SSH acceptance.
- The first run and the second run with the supplementary persisted-selection assertion both passed; the second run's
  evidence was wrongly written into the test workspace cleared by afterSession and now uses the existing report directory
  to keep network and wire evidence (product unchanged). Final result: the whole-batch final review.

## Online Prerequisite and Unfinished Parts

The control plane and CDN actually returned HTTP 200, but the new shared downloader rejects the online revision 19: both
template accesses still contain `teamApiKeyManagementUrl` (an old published artifact of a field this round deleted; no
compatibility is restored). The local / last-known-good config is kept; publishing the new versioned URL is done by an
authorized person, nothing was uploaded or pointer-changed automatically.

Before the actual release run
`ZCODE_BUILTIN_RELEASE_TEST_FILE=/absolute/path/final-file.json pnpm exec vitest run packages/provider-node/test/zcode-builtin-integrity.test.ts`,
record the file hash and compare it with the downloaded hash after upload. A pass on the current copy does not replace the
final-file acceptance after later Todo113 changes, and a decoder pass does not replace the integrity assertions.

The code, desktop refresh whole chain and final-file check are done; phone / SSH, Windows and real online verification
limits stay on the Goal (not handed to 102 to hide them) and full release acceptance is not declared.
