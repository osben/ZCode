# Todo99 Implementation Review and Verification Ledger

Date: 2026-09-09. Baseline `86bbe157c88e8e599694afb53c39f6dac125ac08`; implementation in a recovery worktree, does not cover concurrent Provider document/migration changes elsewhere. Scope based on the narrowed ruling at [Todo99](../steps/todo-99-worker-account-selection-repair.md).

## 1. Impact Surface and State Ownership

This round adds no pages, menus, or ModelFactory. UI still consumes the same target Host View; what changes is Host/Worker delivery, explicit subtask resolution, and Bot/attachment dispatch. Desktop and mobile display surfaces are the same, but that does not mean delivery or workspace identities can be swapped.

```text
Settings / Identity / Entitlements -> Account result -> Host applied Registry
                        |
                  existing Client queue (read + RPC)
                        |
                 Worker Source: received
                        |
             config source match -> Registry overall applied
                        |
           common Facade + original selection -> temporary effective selection
                        |
                submit / dispatch fixes this selection
                        |
                ModelFactory precise validation
```

| State                                      | Unique owner                                 | Explicitly not done this round                                                         |
| ------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| Original persistent selection              | Session, task, or profile original storage   | Do not write null on query/refresh; do not create new Bot binding selection            |
| Account current/entitlements/dynamic model | The same Host Account Source result          | Do not write current into Provider config; do not extend to ordinary Provider/off-peak |
| Worker executable set                      | Worker applied Registry                      | Do not treat Source received as applied                                                |
| This model                                 | admission fixes Selection / Active Model     | Factory does not remap, does not replace fixed request due to background update        |
| Mobile connection and recovery             | Existing shared-host attachment / replayable | Do not start a separate mobile Host/Agent, do not change desktop continuous            |

## 2. Five Fixes: Itemized Review

| Item                     | Implementation and Evidence                                                                                                                                                                                                                                      | Not Overstated                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| P100-01 Complete states  | Shared strict schema, Host serialization, Worker parse/source carry throughout; ordinary managed accounts entitled=true but missing current are rejected. Real Built-in test personal→Team→personal Registry set and Facade result                               | In-process roundtrip does not equal real SSH deployment upgrade verification                                                      |
| P100-02 Received/applied | Changed to receivedRevision; failure does not record received success. Same-value replace=false still refreshes. Protocol Server calls production delivery method to verify Source B/Registry A, then applies config B                                           | Uses ensure/queue as before, does not rebuild lifecycle or add new latest barrier                                                 |
| P100-03 Explicit child   | Node Facade constructor shared by Host/Worker; passed via DI to Core, Workflow, Script. override takes priority; explicit failure cannot inherit; implicit retains parent Active Model                                                                           | Ordinary child and Script child current config disables creating another Subagent; cannot fabricate unlimited nesting for testing |
| P100-04 Bot              | After binding, reads Session complete original selection→same View→send passes effective selection; invalid does not dispatch, does not change original intent. `/model` and reasoning save to same Session immediately, complete setter validates before saving | Synthetic Bot harness is not substitute evidence for Feishu/real Worker requests                                                  |
| P100-05 Attachment       | task adapter, Agent params, strict protocol and Core intent all carry Selection/modelExecution; execution credentials only enter non-persistent deps. legacy background waits for real completion before releasing this round's ownership/controller             | Does not construct legacy send into a new V4 replay/ACK path                                                                      |

Additional creation chain evidence: `workflow-effective-selection.test.ts` runs real Workflow child, whose Agent tool launches an explicit Subagent, asserts final model execution uses new Provider, parent Session and profile unchanged.

`session-selection-cold-resume.test.ts` creates a real persisted Session, full setModel then closes App/SQLite, reopens database and App and resumes, final model execution observes same Provider/model/high; illegal complete selection leaves no half-modification. Model executor is an isolated stub, so this is runtime integration evidence, not written as online model or cross-device E2E.

## 3. Consumption Entry Itemized Conclusions

| Entry                      | Verification Result / Decision                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer                   | `useModelSelectionView` subscribes to target service; consumers carrying original intent re-read after events, do not directly accept broadcast results without caller intent; generation/requestId discards old responses. Read failure retains ready View. Existing tests pass; no React changes this round |
| Scheduled tasks            | `automationModelSelection.ts` gets view(selection) at new submission boundary; returns effectiveSelection with issue/missing tier failure; uses preferred only if selection unspecified. Fixed run does not re-resolve. Existing tests pass                                                                   |
| Wiki                       | `RepoWikiModelClient.readConfig(resolveIntent)` clearly distinguishes new generation and fixed supplement pages. Former carries selection to get effective value, latter keeps already-fixed config; workspaceIdentity passed to target read. Related existing tests pass                                     |
| Explicit/implicit Subagent | Explicit goes through Worker local public port; implicit, internal override, execution scope do not remap. Real Agent tool tests and recovery child-then-input tests all have request assertions                                                                                                              |
| Workflow                   | Explicit profile of real Workflow sub-Runtime verified; parent Workflow itself inherits original Session execution conventions, does not auto-select another model for it                                                                                                                                     |
| Script                     | `agent(..., opts.model)` is current explicit program call parameter, precise provider-qualified selection; no params inherits parent selection. Script child forbidden from starting Subagent, but DI still passed. Did not change this API semantics this round                                              |
| Title / Goal title         | Sidecar uses explicit title config or Session selection, precisely creates after applying existing auxiliary low-cost options; not any arbitrary UI draft consuming. No new UI independent model selection entry, this round does not change its contract, does not claim it automatically follows accounts   |
| Compact                    | Running prioritizes reusing input Active Model; default independent path creates precisely from Session. Cannot treat each request inside compression as new user intent; this round keeps as is, does not swap in Factory                                                                                    |
| Memory                     | Extraction captures Model that produces work; Dream defaults to precise creation from Session. `captureProjectMemoryAgentContext` fixes model and context; this round does not redefine Dream dispatch contract                                                                                               |
| Off-Peak                   | Ticket/selectionScope/requestAuth fixed with input; attachment supplements execution deps, original Ticket does not migrate across accounts; internal override not blocked by profile failure                                                                                                                 |
| Bot busy/Guide/queue       | This round resolution only added to idle new input branch. Existing busy branch keeps CommandInbox/accepted input semantics, no dequeue remap or second accepted queue                                                                                                                                        |
| Mobile/SSH                 | New read uses task target's workspaceIdentity; Session setter/attachment protocol reuses original service, does not change attachment, owner/lease or deliveryKind. Actual deployment/multi-device same Session still needs separate product evidence                                                         |

"Keeping" here does not mean all historical auxiliary features have implemented future multi-account products; only that they are not confused with Todo99's newly ruled intents/frozen execution boundaries. Todo101 is out of scope this round.

## 4. Two Local Races

### R100-02: Reproduced and partially fixed

Controlled Source.read delay makes old implementation log delivery order become account-4→account-3; original queue only serializes RPC, not reads. Moving read into the same Client original queue, tests fail first then pass, complete Host providerRegistry test 14/14 pass. No new merge queue/clock/retry added.

### R100-01: Observable scope switch reproduced and partially protected

Isolated memory experiment: readSettings first gets A's personal selection, then identity changes to B, settings change to Team; identity/API query uses B, but outputs personal current=true, Team current=false. Not a guess that "all async has problems."

Resolver now copies this round's settings, re-reads identity and settings at end; observable changes lead to rejecting this round's result. Specifically guarantees not updating previousScopes before rejection, otherwise unpublished B would pollute last-known-good judgment. Two interleaving tests (switch connection, switch identity) fail first then pass, subsequent successful rounds can still correctly resetPrevious.

Limitation: No global monotonic account generation introduced, cannot claim to solve all A→B→A or cross-service atomicity after query completion. Uses original AccountService events/failure recovery, allows complete old snapshots temporarily available; future global account assembly changes handled separately.

## 5. Verification Ledger (continually appended, does not pretend partial pass means done)

This round ran:

- Bootstrap accounts, protocol selection, Session facade, Provider runtime, Workflow: 6 files 28 pass; plus 1 new SQLite cold recovery pass.
- Core/Subagent/Script/Workflow/protocol group: 167 pass, 1 fail. Failure is baseline remote Cron denylist, see next section; not all green.
- Host providerRegistry: 14 pass, including delayed read reverse-order regression.
- Account Resolver + AccountService: 24 pass.
- Composer hook, scheduled dispatch, Wiki client/target, AccountService: 5 files 38 pass.
- Root `pnpm typecheck` pass; bootstrap `tsc --noEmit` pass; `pnpm lint` 0 error, 39 existing warnings. Above checks need to run on final incremental.

Test fixture correction: process-provider-registry-runtime's old template missing nameMap/config shell, models missing required reasoningLevel, Personal fixture carrying deprecated matchRules causing 4 failures. Only align test inputs, do not relax production Schema, do not add unshipped format compat; complete 10 cases restored to pass.

Product verification: Air creates isolated directory `/Users/dev/zcode-todo99-e2e.AurUlf`, does not touch running daily App; offline install still triggers keychain -25308 failure due to private CUA Git dependency. User authorized to switch to Pro, SSH management available, isolated directory `/Users/dev/zcode-todo99-e2e.1lO3PN`. W99-E01..06 remain pending until corresponding request/process/cross-device evidence obtained; cannot advance based on this page's integration tests alone.

### Additionally discovered existing failures

`zcode-protocol.test.ts` "remote SSH/WSL default disable all Cron" still fails: actual denylist only has Bash, expected 4 more Cron. Baseline has same difference; production source code retains unused remote tool constants/identity imports. Did not delete assertions for all-green this round, did not modify Cron product semantics without justification, needs separate verification of original disable contract.

## 6. Document and Diagram Correction

Codegraph currently unavailable; review by actual symbols/call chains, do not claim full-repo index. Feature diagram's old "explicit Subagent still awaiting protocol design" updated with this round's actual DI assembly; added Node Facade, Subagent resolver codeSeeds and Todo99 links. Lifecycle unification, independent CLI, migrations, and Todo101 explicitly excluded.

Also corrected stale Agent tool pipeline documentation: Markdown formal fields decided back to `model` / `thoughtLevel` by Todo97, cannot continue writing unshipped `modelSelection` dual-read priority; this is document correction, no new migration code this round.

## 7. Pro Live Machine and Final Wrap-up (2026-09-09)

Test directory `/Users/dev/zcode-todo99-e2e.1lO3PN`, Node 24.14.0, Electron/Chrome 146; uses isolated copy of current worktree source, does not change Pro daily data or Git checkout, does not touch keychain. Code baseline as page header, plus this round's pending Todo99 changes. Build shows unknown when missing `.git`, so cannot use build-embedded version as source here.

| Case / run                                                                                                         | Result and actual evidence                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `conversation-session-model-provider-effective-selection`, `desktop-e2e-20260909104713317-p13081-192c13543a9c637f` | 2/2 pass: original selection preserved not sent, Team/high actual request, old scheduled selection actually dispatched                                             |
| `conversation-session-worker-effective-selection`, `desktop-e2e-20260909111544019-p19700-8c54b26069ee4be6`         | 3/3 pass: W99-E01, E02/E03/E06, E04, evidence stratified below                                                                                                     |
| `bots/manual-review/pending/bot-effective-selection`, `desktop-e2e-20260909112059410-p20639-1fd964b954aa4d72`      | 5/5 pass: available/unavailable after binding, proactive highest tier set, first dispatch/menu retains original intent; this group is still synthetic task harness |

Each run's `summary.json`, `summary.md`, `test-results.ndjson` located in above test directory's `packages/desktop/.e2e-artifacts/<run>/`; model request evidence additionally in `network-capture/coding-plan-data-plane.json` and `upstream-provider.json`. Large WDIO logs not committed to Git.

- E01 uses real Electron, Host, Agent tool and child Runtime, captures adapter model-io: profile original personal Provider→actual Team same model/high, parent session still uses DeepSeek, Markdown bytes unchanged.
- E02/E03/E06 are live Node Host→real stdio Worker, do not falsely claim tapping mobile page. Bot entry reuses production Task adapter; only IM and account upstream/model HTTP are isolated stubs. Next round requests Team/high, `/model` immediately max, `/think low` immediately saves, dispose Worker then resume keeps low; attachments use execution/high and FIRST/SECOND ordered, Session low not overwritten.
- E04 controlledly keeps Worker A, Host B; original test exposes real defect rather than just fixture problem: ModelFactory fails outside inner Turn catch, only logs, no TurnError/V4 error. Added Core red-light test proves event is 0; partial fix creates Model's catch, reuses existing outcome, single tests and Pro both pass. Acceptance includes `turn.failed`, V4 `phase:error`, no new model request sent, Session original selection unchanged; delivery B then resubmit actually succeeds. No new send synchronization barrier added.
- 3 new cases do not directly advance to formal. fixture check passes but with marker warning: Account request handled by existing independent Coding Plan mock data plane; rejection marker should not have sent HTTP; `E2E_PLAN_NON_DEFAULT_MODEL` is constant name, PARENT_DONE is response text. DeepSeek's two parent requests recorded in case-local manifest as synthetic/fast-text. Subsequent Docker/formal advancement needs to collect corresponding fixtures through original manual process, do not treat current warning as production request anomaly.

Final check: root `pnpm typecheck` pass; `pnpm lint` 0 errors, 39 existing warnings; Core build, Bootstrap typecheck, desktop typecheck:e2e pass. Host/shared targeted 7 files **257 pass**, Agent/Core/Bootstrap targeted 10 files **81 pass**, existing desktop/remote/web service regression 6 files **42 pass**. These counts are per-round scopes, do not accumulate repeated runs as independent case count. Previous full protocol group's existing Cron failure still retained in Section 5, not pretending full-repo all-green.

**Final second ruling:** User replied "not yet, never mind," clearly deferring same-version Web page and W99-E05 mobile shared-host+SSH joint live machine for now. This round's implementation and review can wrap up, do not claim this item passes. Sync lifecycle, A→B→A global transaction, independent CLI, Todo101 still ruled as not done per original ruling. Host/Worker must use the same protocol artifacts; this round did not deploy Web package for the user.

### Independent Re-verification of Submitted Source

Implementation commit: `b4ffe44db0` (`fix(provider): complete worker account selection repair`), not pushed. After commit, restored other pending migration source code/tests in Pro isolated copy to that commit's files, does not change local original workspace. Rebuild Desktop and Agent, Worker effective selection spec **3/3 passes again**: `desktop-e2e-20260909112629814-p20925-4b9a692d8243878d`, artifact path rules as above.

Also verified by Git blob SHA-1 `packages`, `apps/zcode-cli`, `config` directory `.ts/.tsx/.json/.mjs/.cjs/.yaml`: **6,754 files match implementation commit, 0 differences** (first unique difference was un-synced new Core single test, subsequently filled; does not affect prior execution artifacts). This avoids using test results contaminated with other dirty production source code to endorse this commit. Did not use deployment package version unknown, build cache, or old pass records as source proof.
