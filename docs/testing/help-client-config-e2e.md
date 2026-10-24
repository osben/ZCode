# Help Config Validation and E2E Coverage

> Todo103: this file keeps the established staging behavior and the historical acceptance record; historical pass counts do not count as passes for the current integration.
> Current integration evidence is recorded separately in todo103-staging-integration-ledger.md; the Provider/Selection boundary is unchanged.

## Feature Summary

Todo103 retest correction: `setApplicationLocale` is Main native-menu state, not the Renderer
language setting. The formal case first writes English into the isolated config and reloads, then
runs the English UI assertions, and restores the original setting at the end. Otherwise, on a
Chinese system, the existing Help/feedback entries would be misjudged as missing. No change to the
product language mechanism is needed.

| Item                  | Decision                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| Purpose / mode        | Verify the client/configs migration, implementation-handoff                                           |
| Layers                | option-source, validation, commit-effect, persistence                                                 |
| Established semantics | Follows settings-community-link-config.md and the migration rules confirmed by the user for this task |
| Out of scope          | Ticket submission, Agent/session, owner, continuous/replayable, server changes                        |

## UI Surface Matrix

| Scenario / entry                                         | Shared implementation / owner                            | Default and validation                                       | Commit target              | Mode difference / isolation                                 |
| -------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ | -------------------------- | ----------------------------------------------------------- |
| Question-mark menu community                             | WorkspaceHelpMenuButton -> platform -> desktopHelpConfig | current-language remote -> built-in                          | shell.openExternal         | Desktop / Web platforms open separately; sessions untouched |
| Native menu / command palette feedback                   | desktopCommandHandlers -> helpAppConfig                  | false -> built-in dialog; true -> remote or built-in address | OpenFeedbackDialog / shell | Web platform always opens the address                       |
| Windows caption / command candidate community visibility | canOpenCommunity                                         | false when the same language has no remote and no default    | read-only                  | Display state is not treated as an opened link              |
| Question-mark menu issue report                          | helpMenuActions / feedbackStore                          | does not read the feedback switch                            | built-in Dialog            | independent of the platform feedback mode                   |
| Browser config read                                      | resolveWebHelpConfig / readHelpConfig                    | envelope, same-language default                              | fetch + in-memory Map      | Web omits platform; no remote-control Host additions        |

## Shared and Divergent Behavior / State Owners

HTTP and in-memory cache rules are shared through helpAppConfig; the feedback UI entries do not
share the switch. The remote API is the config authority, the built-in JSON holds defaults, and the
Map keeps only successful responses for 1 hour; there are no persistent writes.

```text
config state -> user entry / platform action -> request to current endpoint -> code=0 validation
                                      |
                     in-memory success cache <-+-> per-field / same-language fallback
                                      |
                       external link call / built-in dialog / unavailable
```

## Feature Relationships / Must-Preserve Invariants

- must-inspect: reader -> Desktop/Web; neither may request the old CDN, cache failures, or pollute
  across endpoints.
- should-inspect: menu language, actual external link, built-in dialog appearance; "external link
  call count is zero for now" must not pass as dialog success.
- invariant-only: task, remote attachment, continuous/replayable are not on this request path.
- evidence-only: the original HC-01 used a net.fetch mock, which only proves request options, not
  real HTTP transport or disk cache behavior.

## Codegraph Evidence / Graph Drift / Graph Delta

The current tooling offers no codegraph index query; direct callers were checked with rg from fixed
file seeds, depth 2. Seeds: helpAppConfig, desktopHelpConfig, desktopCommandHandlers, communityUrl,
WorkspaceHelpMenuButton. The graph has no help-config capability yet; the confirmed capability seed
is added, with no inferred business dependencies.
Drift candidate: the question-mark menu always shows the community item, while only the Windows
caption and command palette have a visibility gate. Tests distinguish platform availability from the
question-mark menu explicitly and do not claim every entry hiding was verified.

## Clarification / Boundary Decisions / Dimensions

The user confirmed the migration rules and authorized completing the verification; established
semantics are not re-asked.
Dimensions: zh-CN/en-US, remote full/partial/failure, same/different endpoint, first/repeated
request, Desktop/Web. Workspace identity, model and theme do not affect pure config results, so the
full Cartesian product is pruned; desktop verifies a representative path with real entry clicks.
Exact TTL expiry and switching endpoint while a request is in flight stay in controllable-clock unit
tests; the E2E does not wait 1 hour.
This round is local-machine verification only; browser narrow-screen config integration is not a
full mobile remote-control acceptance.

## Accepted Cases / Coverage Matrix

| ID    | Setup                                                                           | Action                                                                                      | Must assert                                                                                                           | Evidence layer       |
| ----- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------- |
| HC-01 | Local HTTP fixture with full zh/en config                                       | Click community in the real question-mark menu; call zh/en availability and click again     | Correct-language external link, actual request path/params/count; repeated reads hit memory                           | UI + network         |
| HC-02 | Remote has only zh; fixture provides English built-in defaults                  | English platform community action                                                           | Uses the English default; never enters the Chinese remote                                                             | runtime + filesystem |
| HC-03 | Remote false, local true; another endpoint remote true                          | Platform feedback action                                                                    | false shows the real built-in Dialog and does not call the external link; true opens the remote address               | UI + runtime         |
| HC-04 | 503 / business error / invalid JSON                                             | Platform availability and community; recover with a success response from the same endpoint | Default stays available, failure is not cached, new address after recovery; with no value the platform is unavailable | HTTP + runtime       |
| HC-05 | Chromium narrow screen loads the real Web resolver bundle, mutable HTTP fixture | zh/en, concurrency, reload the browser page                                                 | Same-language result, no platform, requests coalesced; reload re-requests instead of using the HTTP cache             | browser + HTTP       |

## E2E Handoff Notes

- After 8/8 passed locally the user explicitly authorized promotion; the formal path is
  `packages/desktop/test/e2e/help-client-config.test.ts`, collected by the default desktop E2E.
- Fixtures are case-local JSON; model request policy is none, all help requests are synthetic with
  `syntheticReason`.
- The local HTTP server listens on loopback only; each case has its own origin and restores settings
  and temporary default config files.
- The existing e2e:fixture:check / e2e:promote only implement the conversation/plugins domains and
  cannot handle settings. This case uses a local fixture contract check and WDIO; it is not moved
  into conversation to bypass the domain limit.
- Per the user's request Docker verification was stopped and only local results are used;
  Windows/Linux real machines and real phones are unverified.

## Unresolved Questions / Planning Handoff

No new product-semantics questions. The question-mark menu display with no config is recorded as
existing drift and is not changed by this pure migration verification.
This file doubles as impact brief, catalog, matrix and pruning record.

## Verification Record (2026-09-04)

- macOS first round 8/8 passed (real HTTP and a 390x844 Chromium browser window).
- The official API was requested for darwin-arm64, win32-x64, linux-x64 and Web (platform omitted):
  all HTTP 200 / code 0, all with the three help fields. This is not real Windows/Linux UI
  verification.
- The old settings/manual-review path was not covered by the default WDIO exclude, so it was moved
  to the existing auth/config `manual-review/pending` to keep candidate cases out of the default
  suite.
- `e2e:fixture:check` returns "unsupported domain" for the new path; tool rules were not changed and
  no provider fixture was faked. Self-check confirmed all 8 synthetic scenarios of the manifest have
  reasons, all files exist, the canonical spec is `./test/e2e/help-client-config.test.ts`, and the
  provider policy is none.
- After moving to a supported candidate directory, the common-provider-fixture rerun passed 8/8;
  provider capture records were 0.
- Help-config unit tests 36/36 passed (shared reader, remote config, Web resolver, desktop
  commands).
- `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck`, `pnpm lint` all passed (lint: 41
  existing warnings, 0 errors).

### Rerun the formal case

```bash
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json \
pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/help-client-config.test.ts
```

Finish typecheck before building/running Electron so the two do not write out/host at the same time.
Docker is not used; the container attempt this round was terminated and does not count.

### Promotion record

On 2026-09-04 the user asked to promote after passing. The promotion dry run rejected the
auth/config path because the script supports only conversation-session; following the domain's
existing practice the case was moved directly to the root formal path with the helper import fixed,
keeping the existing canonical manifest and case-local fixture. No conversation provider fixture and
no Docker preset were added.

After promotion, local verification:

- Formal path default replay: 8/8 passed.
- Formal path common-fixture-only replay: 8/8 passed.
- Neither round set `ZCODE_E2E_MANUAL_REVIEW`; the formal spec ran normally in desktop WDIO.
- `typecheck:e2e`, `pnpm typecheck`, `pnpm lint` passed (41 existing warnings, 0 errors); format and
  diff checks passed.
- Manifest check confirmed the formal path exists, the 8 synthetic scenarios carry reasons, the file
  fixture exists, and the provider policy is none.
