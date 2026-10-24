# Todo99 Implementation Review and Verification Ledger

> Date: 2026-09-09. Baseline `86bbe157c88e8e599694afb53c39f6dac125ac08`; implementation in a recovery worktree. Scope based on the narrowed ruling at [Todo99](../steps/todo-99-worker-account-selection-repair.md). Implementation commit: `b4ffe44db0` (`fix(provider): complete worker account selection repair`), verified in Pro against a blob-SHA-identical isolated copy (6,754 files match, 0 differences).
> Full history: `git show 45f808f7:docs/working-memory/provider-refactor/research/todo99-implementation-review.md`

## 1. Impact Surface and State Ownership

No new pages, menus, or ModelFactory. UI still consumes the same target Host View; what changed is Host/Worker delivery, explicit subtask resolution, and Bot/attachment dispatch. Desktop and mobile display surfaces are the same, but delivery or workspace identities must not be swapped.

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

| State                                      | Unique owner                                 | Explicitly not done this round                                                       |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Original persistent selection              | Session, task, or profile original storage   | No null written on query/refresh; no new Bot binding selection created               |
| Account current/entitlements/dynamic model | The same Host Account Source result          | current not written into Provider config; no extension to ordinary Provider/off-peak |
| Worker executable set                      | Worker applied Registry                      | Source received is not treated as applied                                            |
| This model                                 | admission fixes Selection / Active Model     | Factory does not remap; fixed requests not replaced by background updates            |
| Mobile connection and recovery             | Existing shared-host attachment / replayable | No separate mobile Host/Agent; desktop continuous unchanged                          |

## 2. Five Fixes

| Item                     | Implementation                                                                                                                                                                                                                                                     | Not Overstated                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| P100-01 Complete states  | Shared strict schema; Host serialization and Worker parse/source carry throughout; ordinary managed accounts with entitled=true but missing current are rejected                                                                                                   | In-process roundtrip is not real SSH deployment upgrade verification              |
| P100-02 Received/applied | Changed to receivedRevision; failure does not record received success. Same-value replace=false still refreshes. Protocol Server calls the production delivery method                                                                                              | Uses ensure/queue as before; no lifecycle rebuild or new latest barrier           |
| P100-03 Explicit child   | Node Facade constructor shared by Host/Worker; passed via DI to Core, Workflow, Script. override takes priority; explicit failure cannot inherit; implicit retains parent Active Model                                                                             | Ordinary child and Script child current config disables creating another Subagent |
| P100-04 Bot              | After binding, reads Session complete original selection → same View → send passes effective selection; invalid does not dispatch, original intent unchanged. `/model` and reasoning save to the same Session immediately; complete setter validates before saving | Synthetic Bot harness is not substitute evidence for Feishu/real Worker requests  |
| P100-05 Attachment       | task adapter, Agent params, strict protocol, and Core intent all carry Selection/modelExecution; execution credentials only enter non-persistent deps. legacy background waits for real completion before releasing ownership/controller                           | Legacy send is not constructed into a new V4 replay/ACK path                      |

Creation chain evidence: `workflow-effective-selection.test.ts` runs a real Workflow child whose Agent tool launches an explicit Subagent — final model execution uses the new Provider, parent Session and profile unchanged. `session-selection-cold-resume.test.ts` persists a real Session, full setModel, closes App/SQLite, reopens and resumes — same Provider/model/high; an illegal complete selection leaves no half-modification (isolated stub executor, so runtime integration evidence, not online or cross-device E2E).

## 3. Consumption Entry Conclusions

| Entry                      | Conclusion / Decision                                                                                                                                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composer                   | `useModelSelectionView` subscribes to the target service; consumers carrying original intent re-read after events — broadcast results without caller intent are not accepted; generation/requestId discards old responses. Read failure retains the ready View |
| Scheduled tasks            | `automationModelSelection.ts` gets view(selection) at the new submission boundary; returns effectiveSelection with issue/missing-tier failure; preferred used only if selection unspecified. Fixed runs do not re-resolve                                      |
| Wiki                       | `RepoWikiModelClient.readConfig(resolveIntent)` distinguishes new generation (carries selection for effective value) from fixed supplement pages (keeps already-fixed config); workspaceIdentity passed to the target read                                     |
| Explicit/implicit Subagent | Explicit goes through the Worker local public port; implicit, internal override, and execution scope do not remap. Real Agent tool tests and recovery child-then-input tests all have request assertions                                                       |
| Workflow                   | Explicit profile of real Workflow sub-Runtime verified; the parent Workflow inherits the original Session execution conventions — no auto-selection of another model for it                                                                                    |
| Script                     | `agent(..., opts.model)` is the current explicit program call parameter (precise provider-qualified selection); no params inherits the parent selection. Script child forbidden from starting a Subagent, but DI is still passed                               |
| Title / Goal title         | Sidecar uses explicit title config or Session selection, precisely created after applying existing auxiliary low-cost options; no arbitrary UI draft consumption. No new independent model selection entry — does not automatically follow accounts            |
| Compact                    | Running prioritizes reusing the input Active Model; the default independent path creates precisely from the Session. Requests inside compression are not new user intent — kept as is, no Factory swap-in                                                      |
| Memory                     | Extraction captures the Model that produced the work; Dream defaults to precise creation from the Session. `captureProjectMemoryAgentContext` fixes model and context; the Dream dispatch contract is not redefined                                            |
| Off-Peak                   | Ticket/selectionScope/requestAuth fixed with input; attachment supplements execution deps; the original Ticket does not migrate across accounts; internal override not blocked by profile failure                                                              |
| Bot busy/Guide/queue       | Resolution added only to the idle new-input branch. The busy branch keeps CommandInbox/accepted-input semantics — no dequeue remap, no second accepted queue                                                                                                   |
| Mobile/SSH                 | New reads use the task target's workspaceIdentity; Session setter/attachment protocol reuses the original service — attachment, owner/lease, and deliveryKind unchanged. Real deployment/multi-device same-Session still needs separate product evidence       |

"Keeping" does not mean all historical auxiliary features have implemented future multi-account products; only that they are not confused with Todo99's newly ruled intents/frozen execution boundaries. Todo101 was out of scope.

## 4. Two Local Races

**R100-02 (delivery read ordering)**: a controlled Source.read delay made the old implementation deliver account-4→account-3; the original queue serialized only RPC, not reads. Read moved into the same Client original queue; complete Host providerRegistry tests 14/14. No new merge queue/clock/retry.

**R100-01 (observable scope switch)**: isolated memory experiment — readSettings first gets A's personal selection, then identity changes to B and settings change to Team; identity/API query uses B, but output claimed personal current=true, Team current=false. The Resolver now copies this round's settings and re-reads identity and settings at the end; observable changes reject this round's result. `previousScopes` is not updated before rejection (otherwise unpublished B pollutes last-known-good). Limitation: no global monotonic account generation — cannot claim to solve all A→B→A or cross-service atomicity after query completion; complete old snapshots remain temporarily available; future global account assembly changes handled separately.

## 5. Verification Ledger

- Bootstrap accounts/protocol/Session facade/Provider runtime/Workflow 6 files 28 pass + 1 new SQLite cold recovery; Core/Subagent/Script/Workflow/protocol group 167 pass, 1 fail (known remote Cron denylist, below); Host providerRegistry 14 pass; Account Resolver + AccountService 24 pass; Composer hook/scheduled dispatch/Wiki client/AccountService 5 files 38 pass. Root typecheck, bootstrap `tsc --noEmit`, lint 0 errors (39 existing warnings).
- Fixture correction: process-provider-registry-runtime's old template lacked nameMap/config shell, models lacked required reasoningLevel, Personal fixture carried deprecated matchRules — test inputs aligned only; production Schema not relaxed, no un-shipped format compat added.
- Known existing failure: `zcode-protocol.test.ts` "remote SSH/WSL default disable all Cron" — actual denylist has only Bash, expected 4 more Cron; same difference at baseline; production retains unused remote tool constants/identity imports. Assertions not deleted for all-green; needs separate verification of the original disable contract.

## 6. Document Corrections

Feature diagram's old "explicit Subagent still awaiting protocol design" updated with the actual DI assembly; Node Facade and Subagent resolver codeSeeds and Todo99 links added. Lifecycle unification, independent CLI, migrations, and Todo101 explicitly excluded. Stale Agent tool pipeline documentation corrected: Markdown formal fields are `model` / `thoughtLevel` per Todo97 — un-shipped `modelSelection` dual-read priority no longer documented.

## 7. Pro Live Machine and Final Wrap-up

Test directory `/Users/dev/zcode-todo99-e2e.1lO3PN` (isolated copy of the implementation commit; build shows "unknown" without `.git` — build-embedded version is not source proof). Artifacts in `packages/desktop/.e2e-artifacts/<run>/`, model request evidence in `network-capture/coding-plan-data-plane.json` and `upstream-provider.json`.

| Case / run                                                                                                         | Result and evidence                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversation-session-model-provider-effective-selection`, `desktop-e2e-20260909104713317-p13081-192c13543a9c637f` | 2/2 pass: original selection preserved not sent, Team/high actual request, old scheduled selection actually dispatched                          |
| `conversation-session-worker-effective-selection`, `desktop-e2e-20260909111544019-p19700-8c54b26069ee4be6`         | 3/3 pass: W99-E01, E02/E03/E06, E04 (stratified below)                                                                                          |
| `bots/manual-review/pending/bot-effective-selection`, `desktop-e2e-20260909112059410-p20639-1fd964b954aa4d72`      | 5/5 pass: available/unavailable after binding, proactive highest tier set, first dispatch/menu retains original intent (synthetic task harness) |

- E01: real Electron Host, Agent tool, and child Runtime — profile's original personal Provider → actual Team same model/high; parent session still DeepSeek; Markdown bytes unchanged.
- E02/E03/E06: live Node Host → real stdio Worker. Bot entry reuses the production Task adapter (only IM and account upstream/model HTTP are stubs). Next-round requests Team/high; `/model` immediately max; `/think low` immediately saves; dispose Worker then resume keeps low; attachments use execution/high and FIRST/SECOND order; Session low not overwritten.
- E04: keeping Worker A while Host B exposed a real defect — ModelFactory failure escaped the inner Turn catch (only logged; no TurnError/V4 error). Core red-light test proved the event count was 0; the fix creates the Model's catch, reusing the existing outcome. Acceptance: `turn.failed`, V4 `phase:error`, no new model request, Session original selection unchanged; delivery B then resubmit actually succeeds. No new send synchronization barrier.
- New cases stay pending with a fixture marker warning (account requests via the existing independent Coding Plan mock data plane; rejection markers must not have sent HTTP). Docker/formal advancement needs fixtures collected through the original manual process.

Final checks: root typecheck/lint, Core build, Bootstrap typecheck, desktop typecheck:e2e pass; Host/shared targeted 7 files 257 pass, Agent/Core/Bootstrap 10 files 81 pass, existing desktop/remote/web regression 6 files 42 pass. **Final ruling:** the user deferred the same-version Web page and W99-E05 mobile shared-host+SSH joint live machine ("not yet, never mind") — this round wraps up without claiming those pass. Sync lifecycle, A→B→A global transactions, independent CLI, and Todo101 remain not done per the original ruling. Host/Worker must use the same protocol artifacts; the Web package was not deployed.
