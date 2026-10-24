# Todo 57: Provider E2E Real Run and Regression Closeout

> Current status (2026-09-09): this verification Todo is closed; remaining items are owned solely by
> [Todo102](todo-102-verification-debt-closeout.md) and are not scheduled independently. The statuses and failures
> below are historical records; closing does not mean the original failures passed.

> Status: Implemented; 45 macOS Provider E2E cases passed, only 1 real SSH Remote Environment case not run for lack
> of credentials
>
> Date: 2026-09-01
>
> Inputs: the Provider E2E migrated by Todo 52, Todo 55's final Provider Template semantics, the 2026-08-31
> regression analysis, and the Remote Environment Provisioning behavior added by Todo 56.

## 0. Goal

Todo 52 migrated test code, Fixtures and current product semantics, but its main evidence was E2E typecheck, fixture
checks, unit tests, lint and repo-wide typecheck; that does not mean the 37 affected Desktop E2E cases all passed a
real WDIO run. After Todo 56's production semantics stabilized, this Todo actually starts Desktop/Electron, reproduces,
fixes and runs the Provider-related E2E group by group until Case-level execution evidence exists: Todo 56 production
baseline stable -> E2E precheck -> single-case WDIO run -> batch fixes by common root cause -> Provider regression
group run -> container/whole-group verification and report.

## 1. Evidence caliber

| Evidence                       | What it proves                                          | Equals E2E pass?        |
| ------------------------------ | ------------------------------------------------------- | ----------------------- |
| `typecheck:e2e`                | E2E TypeScript compiles                                 | No                      |
| fixture check / coverage audit | Fixture, manifest and coverage matrix structure correct | No                      |
| unit tests                     | helper/service local behavior correct                   | No                      |
| WDIO single spec               | the case's setup/action/assertion really completed in Electron | Yes, that case   |
| Docker single spec             | the case passes in the standard isolated environment    | Yes, that environment   |
| Provider/Conversation preset   | batch of cases in the suite pass                        | Yes, that suite         |

The final report must not use "related checks passed" for "E2E ran and passed"; not-run, environment-blocked,
product failure and obsolete cases are listed separately.

## 2. Product boundaries

- The Z.ai / BigModel Provider Family and structured Connection Selection stay; their formal E2E must not be deleted
  again. The old `mode/selectedKey` unreleased compat cases stay deleted, no compat migration restored.
- Todo 55 is the production baseline: normal third-party Providers are created from a Template as Personal
  instances; Z.ai/BigModel pay-as-you-go API is no longer a Family Connection Selection.
- Account scenarios are driven by the formal Account API/Credential mock, never disguised as Personal API-key
  Providers; Personal Provider scenarios write the formal Personal Overlay.
- Model Selection uses the complete `{ providerId, modelId, options }`.
- Personal Config hot update tolerates the production polling gap with a uniform 2-second wait (raised to 3 seconds
  in the same helper only if CI proves it insufficient).
- Do not restore the deleted Registry revision push, old Provider mode, old double reasoning map or specific model
  hardcodes.

## 3. Shared test infrastructure

Todo 52's common boundary stays; no second Effective Registry fixture: `seedPersonalProviderConfig(...)` (or
existing equivalent) writes only Personal Provider/Overlay; the formal Coding Plan mock + Credential Store prepares
account, plan, quota, activity and opportunity upstream facts; the atomic persisted Model Selection helper is for
cold-start/restart cases only; `waitForSelectableModel(...)` waits on the formal Selection View;
`waitForProviderConfigPolling()` handles only the 2-second Personal Config hot update tolerance; the Bot minimal
non-empty Selection fixture only lifts the Bot execution precondition and does not replace card/terminal
assertions; the Provider Family Selection fixture writes only the current structured selection, never old
mode/selectedKey. Todo 56's Remote Provisioning E2E helper must trigger from the real connection lifecycle, not
call the Target Store directly to fake the user chain.

## 4. Execution groups

### 4.1 Group 1: Smoke and infrastructure

Pick the smallest, highest-diagnostic cases to prove the MacBook Pro standard working directory can really start
Electron, connect the mock provider and complete assertions: one Personal Provider add + first send; one Coding Plan
Settings case; one cold-start Model Selection recovery case; one Bot Selection/Card case. If Smoke cannot start, fix
the E2E harness, build artifacts or test environment first, without changing Provider production semantics.

### 4.2 Group 2: Todo 52's 37 regression cases

By common cause, not file order: Bot 4; CTP/QR and Upgrade WebView; CW/OTB/Personal Provider hot update;
Restart/Family Connection Selection; Turbo/reasoning; Subagent structured selection. Todo 55's final semantics
representatives must also be added and run for real: several Provider instances from one Template with isolated
Personal Overlay and real request identity; Z.ai/BigModel pay-as-you-go API created through the normal Template, not
entering the Account Family Connection Selection; each Welcome API key creating a new Personal Provider instance
(no reuse of a fixed Provider ID); Template defaults, Personal modification and restore-all-defaults using one
Resolver baseline; Provider top-level `enabled`, `standard-builtin` and the normal Built-in resurrection entry at
zero in UI, protocol and persistence.

Per group rules: reproduce with the original spec and save the full failure log/screenshot; classify as production
bug, Fixture drift, outdated assertion or environment problem; production bug — first add a test that pins the root
cause then minimally fix production code; Fixture drift — change only setup, never weaken the original
action/assertion; outdated behavior — delete or rewrite a case only with an explicit product decision and sync the
catalog/matrix; if Provider/Account/Selection product semantics must change, stop and ask for a decision.

### 4.3 Group 3: Todo 56 Remote Provisioning

Add or promote a minimal but complete Remote Environment behavior proof: opening a second Workspace of the same
Environment does not trigger a second first-sync; after a local Personal Config save, later remote-created Models use
the new config; Configured Default/Account/Credential changes trigger sync; clearing local Personal Config or
deleting an allowlist credential propagates; continuous saves during a sync converge on the latest snapshot;
Provisioning failure does not block the Remote Workspace (later superseded by Todo 59, see below); no impact on the
remote Workspace `workspaceIdentity` routing and the phone replayable boundary. New cases go into the case
catalog/coverage matrix first; interactions needing manual confirmation go to `manual-review/pending` and are not
passed off as formal coverage.

## 5. Run procedure

Each case: `pnpm --filter @zcode/desktop typecheck:e2e`, then
`pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/<path>/<case>.test.ts'`. Conversation
replay cases additionally: run `e2e:fixture:check`; run with `common.json + case-local fixture` to prove no
dependence on the legacy shared fixture; then the default replay; for cases entering the container suite, a
single-case Docker admission proof.

Batch regression by increasing risk: Provider/Account/Selection/Provisioning directed unit tests; `typecheck:e2e`;
the four Smoke WDIO; the six Provider WDIO groups; Remote Provisioning formal case; `pnpm typecheck`; `pnpm lint`;
`pnpm test:unit`; `pnpm test:e2e:container:conversation` or the preset actually including the Provider cases. On the
MacBook Pro always build and run from the standard repo directory — never mix half-built artifacts, old Electron
processes or another clone's output. Temporary logs and artifacts use the test framework's existing directories; no
second permanent environment config.

## 6. Fix discipline

E2E does not write Effective Provider Config, Registry Snapshots or executable markers directly; no arbitrary sleeps
to mask unknown races (Personal Config polling uses only the uniform 2-second helper); no turning account Providers
into Personal API-key Providers; no restored unreleased old migrations; no `providerId`/`modelId` hardcoding to infer
runtime capability; no weakening of terminal, interaction card, request routing, recovery identity, reasoning or
quota assertions; production bug fixes keep a root-cause comment and the matching regression test; after each group
review the diff so no unrelated CI/workspace baseline gets changed along the way.

## 7. Result matrix and states

Each case records: Case, environment, first result, root-cause class, change, final command, final result, artifact.
Allowed states: `passed` (actual WDIO/Docker execution passed), `failed-product`, `failed-fixture`,
`blocked-environment`, `not-run`, `deleted-by-decision`.

## 8. Completion gates

Todo 52's retained Provider E2E all have actual WDIO results (not static prechecks only); Todo 56's Environment-level
sync has at least one formal remote lifecycle E2E (other combinations covered by unit/integration tests); Family
formal behavior stays under test and old mode/selectedKey compat stays at zero; every production bug has
fail-first-then-pass evidence; `typecheck:e2e`, root typecheck, lint, full unit and relevant container presets pass;
environment blockers are recorded separately and never written as passed; case catalog, coverage matrix and Todo
52/56 status and final verification matrix updated; Conventional Commit.

## 9. Outcome (2026-09-01)

This round corrected the real inputs and real run chain instead of maintaining the old Provider Registry fixtures:

- Draft Model Selection resolved as "recent valid selection -> current Account Provider's first model -> Host
  preferred"; when Account Registry publishes late, the Selection View revision re-hydrates a prewarmed Draft with no
  explicit model intent so an early DeepSeek fact is not frozen forever. (**Superseded by Todo 59**, see 9.3.)
- The Provider Template representative case uses two DeepSeek Template instances to verify instance identity
  isolation, sparse Personal Model Rule, restore defaults and the real OpenAI Chat Completions request fields.
- The OpenAI Chat Completions Fixture moved from the old `max_tokens` to the formal Option Map's
  `max_completion_tokens`; Anthropic Fixtures keep `max_tokens`.
- Coding Plan, Upgrade WebView, Subagent, cold resume, output budget, Restart, Turbo and Bot cases keep their
  original business assertions.
- Three selected-key migration cases that lost their product object stay deleted per the existing decision (no
  restored Family mode/selectedKey compat).
- SSH-P0-TASK-01 adds a formal Remote Environment proof: the first Workspace produces a Provisioning state record and
  a second Workspace of the same SSH Environment produces no second first-sync record.

### 9.1 macOS Electron/WDIO evidence

| Scope                                   | Result | Artifact / state                                                                                 |
| --------------------------------------- | -----: | ------------------------------------------------------------------------------------------------ |
| Bot automation / Feishu lifecycle       |    5/5 | `desktop-e2e-20260901-123836-685`                                                                |
| Coding Plan Team / quota reset          |  18/18 | `desktop-e2e-20260901-134307-916`                                                                |
| Upgrade WebView refresh                 |    2/2 | `desktop-e2e-20260901-140456-210`                                                                |
| Built-in Subagent model selection       |    1/1 | `desktop-e2e-20260901-132851-878`                                                                |
| Context Window cold resume              |    1/1 | `desktop-e2e-20260901-134040-202`                                                                |
| Model output token budget               |    1/1 | `desktop-e2e-20260901-134123-921`                                                                |
| Provider settings transition            |    3/3 | `desktop-e2e-20260901-134207-163`                                                                |
| Provider restart recovery               |    4/4 | `desktop-e2e-20260901-133355-002`                                                                |
| Turbo recovery                          |    3/3 | `desktop-e2e-20260901-133648-823`                                                                |
| Turbo switch                            |    3/3 | `desktop-e2e-20260901-133743-135`                                                                |
| Output-token preflight                  |    1/1 | `desktop-e2e-20260901-134931-393`                                                                |
| Output-token preflight smoke            |    2/2 | `desktop-e2e-20260901-135009-362`                                                                |
| Provider Template add/edit/restore/send |    1/1 | `desktop-e2e-20260901-140409-625`                                                                |
| selected-key migration                  |      — | `deleted-by-decision`                                                                            |
| SSH Remote Environment Provisioning     |      — | `blocked-environment`: MacBook Pro has no `ZCODE_E2E_SSH_HOST/USERNAME/PASSWORD`; static checks not counted as pass |

All runs used an independent clean runtime clone on the MacBook Pro at the same commit through the standard
`mise`/WDIO chain, reusing no old workspace Electron artifacts.

### 9.2 Repo gates

Provider/Provisioning/Selection directed unit tests: 8 files, 64 passed; the 9 affected Conversation Fixture checks
all passed; `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm typecheck` passed; `pnpm lint` passed (pre-existing
warnings only); `pnpm test:unit`: 1501 Test Files, 12797 Tests passed, 1 file and 25 tests skipped per existing
config; changed-file format check and `git diff --check` passed; repo-wide `pnpm fmt:check` still blocked by existing
Electron doc example HTML and `apps/zcode-cli/tests/gb2312.js`; Conversation coverage audit's OTB manifest/fixture
are consistent again, the remaining failures being only the independent Hooks Lifecycle ledger order/wording and three
stale generated docs; neither the local machine nor the MacBook Pro has a usable Docker CLI, so the Conversation
container preset is `blocked-environment`, not recorded as pass.

### 9.3 Todo 59 correction

The "recent -> current Account Provider's first model -> Host preferred" rule added during this Todo is historical
only and was superseded by Todo 59. The sole current rule: a valid Recent wins; when Recent is missing or invalid use
the target Host's `preferredSelection` directly. Renderer no longer understands the default model priority of Account
Providers, and reasoning options are resolved by Host uniformly and carried in full.
