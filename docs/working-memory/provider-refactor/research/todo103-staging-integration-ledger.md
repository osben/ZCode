# Todo103: Staging Fixed-Range Integration Ledger

> Integrates fixed staging `790884b1ce4b990583ab40625b5f283e2169eb36` into recovery baseline `f0174b57f5c9157760879d17a5ebeeacf90bb85d`; complete SHAs from the source JSON are the mechanical verification basis. Groups, suggested directions, and evidence are recorded separately; "planned to retain" is not "retained". Different intents inside one source commit may get split rulings.
> Full history: `git show b8c59dc1d442417454c5199b9e85367832aeaeda:docs/working-memory/provider-refactor/research/todo103-staging-integration-ledger.md`

## 1. Sources and Status

[Full Goal](../steps/todo-103-staging-safe-integration.md); [per-commit / file inventory](todo103-staging-source-inventory.json).

Source inventory: 193 non-merge commits, 60 merge commits, 941 net-change paths, 950 history-touched or conflict paths. 235 dual-change paths = 107 explicit conflicts + 128 auto-merge dual-change paths. Paths with no net change still keep history sources; no-diff-at-HEAD does not mean irrelevant. All work ran in an independent worktree; no real user configuration or remote application data was modified.

## 2. Functional Groups and Required Boundary Checks

| ID  | Function / source direction                                                              | Intersection with the refactor, handling basis                                                                                                                            | Final status                                                                                |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| G01 | Windows installer, per-platform release and preflight                                    | Retain installer fixes; version stays 3.12.0, no rollback to 3.11.x; verify CUA packaging, server capabilities, artifacts. Existing 85/m2 recovery must prove equivalence | Sources ruled/implemented; NSIS compile verified; Windows real execution pending (§18, §46) |
| G02 | Help config, internal skills, repo architecture gate                                     | Non-conflicting features retained; new gates must not hide refactor violations; unrequested MR creation is not external write authorization                               | Ruled/bulk retained; gate registered, §21/37                                                |
| G03 | CUA lifecycle, removal gray-out, plugin icons                                            | Reconnect per current service boundaries; producer upgrades use atomic tools, no manual SHA edits; local/remote and plugin resource closure                               | Reconnected, built, unit-tested, §25/38                                                     |
| G04 | Subagent availability, plugin model coverage                                             | Plugin settings retention intent; protocol/internal ModelSelection; explicit choice reuses 99, implicit inheritance unchanged; no plugin Markdown writes                  | Implemented/reviewed, §12–16                                                                |
| G05 | Bot restored tasks, Feishu send errors                                                   | Bot-bound Session is the single source; public command/effective-choice parsing not rolled back; retain new recovery and error prompts                                    | Implemented, group review, §20                                                              |
| G06 | Wiki global default, remote routing and lane sync                                        | 94 output limit, 97 one-shot migration, 99 Worker facts — no rollback; no old Provider store, generationModel formal reading, or second-send sync                         | Reconnected; Pro Wiki passed, §23/38                                                        |
| G07 | In-session OffPeakCreate/List, tail cards and editing                                    | Bound Ticket not remapped across accounts; bound Session separated from this off-peak execution choice; verify protocol/events/permissions/storage                        | Reconnected; OP10 and OP-CHAT-02 passed, §41/42                                             |
| G08 | Official-version security validation: isolation, cancel, timeout, retry                  | Retain security challenge behavior; no old workspace catalog or auto-recovery bypass; keep precise connection-test prompt and 99 application confirmation                 | Reconnected; Pro four scenarios passed, §26/31/39                                           |
| G09 | OAuth expiry, stale401, candidate endpoint isolation                                     | Expired responses must not log out a new login; config/Account/OAuth boundaries do not override each other; errors must not impersonate entitlements                      | Five sources implemented/reviewed; Pro 2/2, §19                                             |
| G10 | Plan responsiveness, claim time, purchase entry and telemetry; remove dead purchase flow | Keep 93 status-change prompt + manual CTA; owned plans ≠ current; removing dead flow keeps live entries; new telemetry adapts to Account facts                            | Reconnected; Pro claim/purchase/responsive passed, §33/38                                   |
| G11 | Conversation share / Web share                                                           | Retain independent feature; verify Session/ModelSelection contract, privacy boundaries, resources, dependencies, version; no separate mobile Host                         | Reconnected/reviewed; public release not live-run, §31/41                                   |
| G12 | Permission denial feedback, routing fields, side chat / fork reminders                   | continuous/replayable, CommandInbox, frozen execution, workspaceIdentity isolation; old model fields must not flow back into formal operation                             | Retained/protocol reviewed; Pro permissions 5/5, §41                                        |
| G13 | Subagent / usage / stop / error telemetry                                                | Keep categorization, first settlement, low-level error attribution; current model id/provider id structure; de-identification and duplicate-report prevention             | 10 sources implemented/reviewed, §7/9/10/11                                                 |
| G14 | Memory sampling, Session event retention, background subtask release                     | Bounded retention must not break replayable recovery, persisted history, Subagent inheritance, frozen models; bounded high-frequency logs                                 | Retained, lifecycle reviewed, §40                                                           |
| G15 | Browser recovery / screenshot / viewport / DPI                                           | Original behavior retained or proven restored; verify CUA and plugin entry dependencies; screenshots must not change execution ownership                                  | Retained; Mac two passed / one pre-existing failure, §37/39                                 |
| G16 | mention selection, file links, plugin search, add menu                                   | Retain interaction; keep new Composer draft and submission semantics; all entries bilingual/theme/mobile compatible                                                       | Retained, §37                                                                               |
| G17 | remoteSessionId saved, scope logs, MCP watchdog test                                     | path is not identity; the settings tab must not lose the remote session; tests waiting for changes must verify real lifecycle                                             | Implemented/unit-tested; real SSH acceptance pending, §22/46                                |
| G18 | workspace / sidebar / terminal / settings layout and regression                          | Separate display from business state; keep model-settings smart config, Map layout/keyboard isolation; mobile and per-OS acceptance separate                              | Reconnected; Pro layout/editor passed; Windows pending, §37/39                              |

## 3. Impact Map Summary

Mode: planning; spans presentation / option-source / draft-default / validation / commit-effect / persistence / recovery, but verification is narrowed per functional group — no full-product cartesian product.

| User entry                  | Display / draft                                       | Shared mechanism                              | Submission and authority sink                                                 | Must stay isolated                                                                          |
| --------------------------- | ----------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Composer / existing Session | local uncommitted draft, Session authority            | Selection View, V4 command                    | Session saves after successful submit; existing runs frozen                   | menu refresh must not clear persisted intent; desktop continuous ≠ mobile replay            |
| Account / Provider settings | current page, account state, personal draft           | settings Facade, Config/Account/Overlay       | Config transactions; account actions via Account service                      | page display ≠ real connection; do not mix visibility, entitled, current                    |
| Subagent / plugin override  | settings page draft                                   | public selection resolution, Subagent service | user MD original fields or internal JSON override; Agent load migration entry | plugin/project MD not auto-rewritten; implicit inheritance and internal override precedence |
| Wiki                        | Wiki settings draft / this request                    | public selection, target Host request         | Wiki file after one-shot migration; frozen for this run                       | no Session preference change, no private output budget                                      |
| Automation / OffPeak        | task config and edit draft                            | task service, Ticket, this run's selection    | normal task config; off-peak Ticket/bound Session each own state              | Ticket binding unchanged; off-peak execution must not change Session models                 |
| Bot                         | bound-Session projection                              | Session command and selection mechanism       | the same Session; /model immediate save is a ruled exception                  | no second copy of the current model                                                         |
| Web share / phone remote    | independent share view, shared-host remote projection | their own protocol and attachment identity    | share service; Session stays with the existing Host/Agent                     | share business not pushed into relay; no separate remote-control Agent                      |

```text
Config / Account facts -> complete resolved snapshot -> existing Host / Worker delivery
                                       |
saved intent / current draft ----------+-> public effective selection
                                             |
                       new-execution submit boundary fixes this run's selection
                                             |
                       Factory precise validation, execution
```

Workers may temporarily use complete old snapshots; splicing new and old facts, claiming applied when not, wrongly clearing user intent, or silently swapping models are not allowed.

### Relation grading and sources

- must-inspect: G04/G05/G06/G07/G08/G09/G10/G12 share ModelSelection / Account / protocol / persistence upstream-downstream; each group lists concrete call paths before implementing.
- should-inspect: G13/G14 telemetry, usage, event retention vs. the new frozen-execution boundary; G18 shared UI components and post-recovery settings behavior.
- conditional: G01/G03/G11/G15 OS, dependency, and artifact closures; verify per actually changed platform / product entry.
- invariant-only: untouched Provider Built-in rules are not declared safe for all consumers just because "the core package did not change".
- evidence-only: unit tests, compilation, and static reachability are separate evidence; none alone means product equivalence.

### Codegraph and graph drift

No codegraph tool was available; fixed Git diffs and precise source references were used — no claimed depth-2 codegraph analysis. Seeds: Subagent service/bootstrap, ModelSelection public entries, Wiki/OffPeak/Bot services, SessionPane, Account snapshot and runtime headers. Old graph clauses (Renderer/Host accepted queue, runtime defaultModelRef, Subagent pending protocol ruling) lag behind current CommandInbox, ModelSelection, and Todo99; retrieval hints only, never overriding the latest rulings. Graph nodes update per group once stable relations are confirmed; no wholesale rewrite from this review.

## 4. Confirmed Initial Risks (status updated per item)

| ID      | Source                       | Evidence / conflict                                                                                                                                           | Handling                                                                                              | Final status                                |
| ------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| I103-01 | dbb3ec0ce8 / G04             | Read-only merge-tree auto-passed subagents-types.ts while adding a plugin override interface referencing undefined AgentProfileModel, plus model/thoughtLevel | Reconnect plugin overrides on current structured interfaces; do not restore old types just to compile | Implemented/verified, §13/14/16             |
| I103-02 | 32f6cb43eb / G10             | staging deleted old native purchase components, locally modified → modify/delete conflict                                                                     | Trace by live entry; retaining valid behavior ≠ restoring retired whole files                         | Resolved — panel retired, §33               |
| I103-03 | 8423f78274 / G06             | Upstream added old registry lane push while 99 already delivers complete facts                                                                                | Check the remote Wiki lane for equivalent coverage / gaps; fill only missing behavior                 | Resolved, §23                               |
| I103-04 | 84c4fcfc1d, 89817f5be2 / G01 | Upstream releases 3.11.x; current explicitly moved to 3.12.0                                                                                                  | Keep 3.12.0; retain other platform release fixes file by file                                         | Version verified; release history kept, §18 |
| I103-05 | 79413e33cb / G13             | Upstream spec says "no nested cause keeps original behavior" but the implementation uses the single Error itself as cause                                     | Keep low-level attribution intent; correct the no-nesting case per upstream spec; do not copy the bug | Fixed and verified (G13-A), §7              |

## 5. Item Template and Check Rules

Each item appends: source SHA / intent / current / conflict / decision + spec basis / implementation result and commit / test command and result / reverse review / still open. A JSON item flips to done only when every source fragment has an explicit disposition; when a file is touched by several groups, one group's evidence never substitutes for another's; merge commits are checked for their own manual resolution diffs, not blanket-marked "no content".

Each group's accepted cases are written into the current domain spec / catalog / matrix before the code. Tests must first distinguish "upstream correct behavior" from "regression to the old architecture". Key errors are not rerouted through Todo102; historical failures and new regressions are tracked separately.

## 6. Progress Record

2026-09-09: clean integration branch confirmed; fixed-SHA read-only merge-tree executed (no merge state entered); source inventory recomputed (early smaller intersection counts corrected), 18 investigation groups routed — all sources still awaiting behavior-level rulings, not 193 new features. Planning and recording only; afterwards per-group tests and implementation, then the real merge and overall review.

## 7. G13-A: Streaming Error Root Cause (implemented, reviewed)

Source `79413e33cb`; all six source files handled; the other nine G13 commits were still pending here — this subgroup did not stand in for the group.

- Upstream intent: terminal stream errors must not swallow the low-level network cause; OTel adds sanitized `error.cause.type/code/message`; same-source errors recorded only on the first span. Current code already had generic sanitization and WeakSet claiming, but TerminalStreamChunkError carried no cause and the wrapped low-level reason was not exported.
- Decision: keep all behavioral intent, wired locally; keep `model-execution.js` and flat `statusContext.providerId/modelId`; no old Registry / nested Model reference. A single wrap chain needs no breadth-first queue — the existing bounded loop suffices; no new retry, state, or Provider selection logic.
- I103-05, verified by running the upstream source function: `new Error("plain")` returns a cause duplicating itself, conflicting with upstream spec item 3. The implementation requires "at least two independent error objects" instead; eight-level cap, cycle guard, and cause → adapterError → error priority unchanged.

Evidence: `docs/trace/model-attempt-error-diagnostics.md` G13-A01–04 first (7 of 38 cases failed as expected); sanitizer run in memory against pinned source (no real config touched); post-implementation telemetry + runner-retry + failure-classifier 137/137. A baseline gap found by wider regression: `openai-compatible-stream-usage-wire.test.ts:63` still instantiated the deleted `AiSdkModelRegistry` — only that entry moved to `TestProviderConfigFixture`, keeping the partial-text / normalized-other / raw max_tokens assertions. Final run 14 files 151/151 with a real InMemorySpanExporter verifying root-cause sanitization, first-span-only recording, and no new cause on plain errors. Root typecheck passed; lint 39 pre-existing warnings / 0 errors; the root oxlint binary re-run in CLI cwd on the 7 changed TS files (root ignores exclude CLI): 0/0.

Bidirectional: all six source files dispositioned; their old tests (old model state shape) rewritten against the real AdapterError identity. No changes to Registry, Account, Selection, request payload, retry caps, shutdown tiers, or persisted fields; runner-stream still throws the original adapterError — user copy and retry decisions unchanged. No new interaction → no new UI E2E. Graph: 2 seeds + spec link added; 336 node IDs unique; 4 dangling edges pre-existing (matched against fixed recovery), left for the G02 governance group.

Shipped with `fix(telemetry): integrate staging stream error cause diagnostics`.

## 8. Staging's Own Merge-Resolution Audit

2026-09-09: all 60 inventory merges inspected via `git show --format= --remerge-diff <sha>` (Git 2.43.0) — not just titles or first-parent diffs. 58 had no independent remerge diff; their features still ride the source-group reviews (not a pass).

| merge        | Independent resolution                                                                                                                                                            | Ruling                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `5ded50a096` | CHANGELOG merged 3.11.2 and removed a duplicate pacman entry; package/lock chose 3.11.2; runtime-asset test kept both the missing-Helper hint and the Helper-path regex assertion | G01: current 3.12.0 wins; keep the changelog intent and both packaging assertions — no version rollback, no dropped assertion |
| `a1026cad35` | UnifiedBrowserView test kept two comments (enabled menu does not write aria-disabled=false; menu closes on click, reopen to inspect DevTools)                                     | G15: comments and test intent retained; not new product state or a Provider implementation                                    |

The source JSON records every merge's audit result, extra paths, and group. No new feature fragments beyond the diffs above; the final real merge still checks its own result — the remerge audit is not feature acceptance.

## 9. G13-B: Stop-Source Production Diagnostics (implemented, reviewed)

- Sources `8e3e10df4d`, `ee30f2ad33`: distinguish button vs Esc when investigating mis-stops; the second fixes the first using plain info (silent in production) — both kept as one behavior.
- Current code already had `canStop`, focused/readOnly, dialog Esc yielding, and `expectedForegroundExecutionId` mis-stop protection. Only source diagnostics added: no other old Provider recovery flows in SessionPane, no changes to command protocol, Session persisted state, or remote sync timing.
- `docs/monitoring/session-stop-source-diagnostics.md` first, then two failing tests (neither emit nor skip path logged); implementation also covered the Esc branch and the real production Logger "no plain info forwarding" assertion.
- SessionPane model-switch/stop + Logger: 55/55 (existing remote direct-send and no-updateProviderRegistry assertions kept). Root typecheck passed; lint 39/0.
- Bidirectional: all source logs, both parameter sets, and the send-failure warning wired; command content and lifecycle guards untouched. The lifecycle log proves an emit attempt, not that a stop happened. No new interaction; final integration still needed the batch regression.

## 10. G13-C: Low-Level Error Structured Details (rewired to the current privacy contract)

- Sources `e690365f2e` (extract the deepest non-wrapper error) and `a5f4687368` (fill gaps in events, V4 projection / Schema, UI conversion).
- Kept: Core selecting the same low-level frame's message/detail; 12-level cap and cycle guard; TurnErrorPayload → ProductProjection → lastError schema → SessionPane / normalizeZCodeUiError end-to-end; message diagnostics reporting. Missing fields stay omitted; classification, copy, retry, security validation, feedback, and effective selection unchanged.
- Privacy ruling: `docs/monitoring/conversation-telemetry-v4.md` forbids uploading full detail, URLs, auth headers, response bodies. Upstream's `error_detail_text` (verbatim low-level detail upload) conflicts and is **not restored**; the internal field is kept. New message telemetry keeps a 500-character cap with fixed redaction hints for detected auth/credential, URL, and HTML content — no claim to recognize arbitrary private text; error producers still must honor the original contract.
- Spec `docs/chat-error-detail-telemetry.md`; tests first (UI 10 / CLI 3 failures located the gaps; the privacy review's "must not upload detail" assertions failed 4 against the original forwarding before the disallowed upload was removed).
- Verification: Core turn-errors + Bootstrap ProductProjection 188/188; shared protocol, Schema, UI Banner/normalization/stop/Logger 225/225. Types: root typecheck, CLI contracts/core/bootstrap pass (Bootstrap after a contracts build — stale dist types); lint 39/0; CLI's 5 related files carry 2 pre-existing unused-escape warnings.
- Bidirectional: all 13 source code/test files and the spec dispositioned (including the explicitly excluded raw-detail upload); optional-field plumbing only — no new state source, retry, or execution fallback; the schema keeps the new field and rejects wrong types. No real ARMS send; the final desktop error-Banner regression remained open.

## 11. G13-D: Background Subagent Statistics and Standalone Wake Identity (implemented, reviewed)

Sources `e45f22f213`, `f25fe79f5a`, `253f01d496`, `c726bc27e3`, `805b943fc9` — five iterations treated as one final behavior, not stacked twice.

### Rulings and wiring

- Per-tool zero-usage steps for child tools; one Agent summary at the first terminal/stopped, counting only usage already confirmed by then. No backfill of finished parent turns, no new child completion, no waiting for late usage, no timer/outbox. After stopped, started tools and permission waits drain; late tools do not reopen accounting.
- Main completion composition judged by what the turn actually consumed (active-loop and standalone wake covered); Bash is not a Subagent; a standalone batch subdivides message_source only when the whole batch shares one source. Standalone wake and normal commands share UUID v7; the persisted synthetic messageId never impersonates an input ID.
- Flat `ModelNetworkStatus.providerId/modelId`, ModelFactory, ModelSelection, 99 effective resolution, the command persistence ledger, and frozen executions retained; wired per the five sources' concrete hunks, not whole files. Foreground/background share the step builder with parent-turn vs detached-child state. `dep:refs` misses were supplemented by a precise rg (static tool misses are not "no callers").
- Schema adds only an optional body-less source field. Mobile replayable does not backfill history; live facts still come from the trusted desktop-continuous attachment; no new remote/Host/Account sync.

### Verification and new findings

- Tests first (UI/shared 34 of 143, CLI 12 of 279 failing; new init-cancel tests reused `createTestAgentRuntime`), then UI/shared 144/144, widened attachment/error regression 251/251, CLI 278/279. The single CLI failure ("Core admission ACK does not wait for TurnStarted projection; old revision retry/file rewind only stale") also failed pre-change — routed to G12.
- **I103-06**: source self-contradiction — e45's BG26 asserted no Agent step for background failure, while later 805 requires settlement without usage. E2E fixed to exactly one failed Agent, 0 confirmed usage requests, 0 tokens, keeping the provider error and "no child completion" — not deleting the case.
- **I103-07**: first Pro run 3/4 — BG13's notification wait failed because the child Bash in the new draft hit `mode.build.highRisk` awaiting approval; the suite set Full Access once in before while new drafts reset mode. Fixed in the test (select Full Access after each draft creation); product permission rules untouched.
- Pro: isolated copy `/Users/dev/zcode-todo99-e2e.1L03PN` (no .git; build-meta "unknown" is not version evidence), strict case-local replay. After the fix `desktop-e2e-20260909-142100-814` 5/5; `…-142145-836` BG26 1/1; `…-142254-924` BG13/BG18 2/2 with final HTTP evidence in `.e2e-artifacts/todo103-g13D-final-http/{BG13,BG18}-token-identity.capture.raw.json`: child Bash 0 tokens, Agent summary 2 requests / 284 tokens attributed to the launch message; wake uses a different UUID v7; captureStages = http-final / renderer-pre-ipc / main-send-custom. Test-captured only — nothing sent to real ARMS; raw machine/account-identified captures not committed.
- Root and CLI typecheck/lint as usual (39/0; CLI `oxlint --no-ignore` on 17 files: 42 pre-existing warnings, 0 errors).

Bidirectional: five sources' final statistics, identity, classification, tests, spec all retained; only key diff vs pinned staging is the normalizer's current flat Model identity; frozen parent/child execution, 99 explicit resolution, implicit inheritance, permission rules, and CommandInbox ledger unchanged. Shipped with `fix(telemetry): preserve subagent usage and wake attribution`.

## 12. G04-A: Subagent Candidate Availability (implemented, reviewed)

- Source `5161e0914f`, 7 files dispositioned; plugin override source `dbb3ec0ce8` separate.
- Kept: an invalid model's editor shows "Select model", adds no candidates, does not clear the draft, does not write the original file. The source UI's deleted Provider snapshot/Family keys became the current Selection View — trigger only, read/write boundary unchanged. Upstream's enter-page explicit refresh is covered by the public hook's first-read + subscription (new unmount/remount and Start→Individual→Team event tests).
- Upstream Storage deduplicated by endpoint (merging Start/Individual lists); current builds the Account Overlay by Provider ID. `modelProviderServiceStorage` and its tests stay deleted; a new real AccountResolver→ProviderResolver regression proves same-endpoint isolation, non-current Individual not entering the Registry, API unaffected.
- Tests first (only the new copy assertion failed), then 71/71 incl. the Account resolver package. Pro SE-03 1/1 (`desktop-e2e-20260909-143258-266`): after really removing a member — "Select model" copy, no old member, reasoning hidden, save disabled, Markdown bytes unchanged. Root typecheck (incl. E2E), lint 39/0, diff check passed.
- Bidirectional: no metadata/catalog dual source, Family selected key, Registry push-down, old Provider types, or on-disk migration restored; main model explicit choice of the highest tier and 99 explicit execution resolution kept.
- Commit `fix(subagents): preserve unavailable selection without misleading labels`.

## 13. G04-B1: Plugin Override Storage and Startup Wiring (foundation done; source commit not yet complete)

- Override storage / Agent-load half of `dbb3ec0ce8` (cache discovery, inline UI, store refresh went to B2/B3; the file was not marked reviewed early). Full contract in the Subagent spec's G04-B section.
- Kept: stable plugin identity, whole-group model/tier override, canonical name == bare-name alias, defaults only from plugin Markdown, upgrades do not affect keys. The old `AgentProfileModel` and dual-map writes are not restored: writes use `pluginAgentModelSelectionOverrides`, Service/RPC pass `{agentId, modelSelection?}`, formal Host/Agent reader reuses strict structured parsing.
- The staging dual map imports through the existing shared-storage import boundary (one-time import, not runtime compatibility; unreleased intermediate Markdown fields incompatible). Reuses offline Provider identity rules, file lock / atomic write; no new migration system, account query, or Registry dependency. The formal map is authoritative: empty/corrupt is not re-read, model-only does not backfill old tiers, old formal IDs stop guessing migrations.
- The Agent reuses `loadZCodeAgentProfiles` state, injecting the plugin loader at create-app assembly; no new synchronous IO. Plugin profiles still go through 99 explicit resolution; ModelFactory, implicit inheritance, off-peak frozen execution untouched.
- Tests first (shared+Host 5 of 39, Agent 1 of 9 failing), then shared/Host/store 6 files 59/59 and agent profile/bootstrap/runtime-config 3 files 57/57 — real temp-file concurrent saves, clearing/model switch, alias handling, original-Markdown byte protection, real disk reads with cross-plugin isolation. Root/CLI types pass (contracts built first); lint 39/0; CLI's 3 changed files carry 2 pre-existing unused-type warnings.
- Foundation only — no new UI operation opened; B3 must add real Settings/cold-start request verification. Commit `feat(subagents): adapt plugin model overrides to selection state`.

## 14. G04-B2/B3 UI: Official Cache Discovery and Plugin Inline Override (done; cold request and store refresh pending)

- Default-enabled lists for the three Settings resource kinds moved to the shared market contract; Node-only scan in the shared Node entry (no cross-domain import of the Plugins implementation). Current computer-use default-enabled kept (upstream's four-item list missed it), compared item by item against the CLI definition.
- Cache discovery only fills official identities with no install record; explicit false and suppressed win; install records are not resurrected. Numeric 0.1.10 beats 0.1.9; backup/temp dirs not read; a higher version with mismatched manifest.name falls back.
- Plugins and built-ins share the existing inline control: complete Selection saved by stable agentId; explicit model choice takes the highest tier; manual effort edits save atomically; other plugin fields read-only; existing save-failure rollback / refresh-failure no-rollback boundaries kept; both language prompts migrated; no old model/thoughtLevel writes.
- **I103-08**: `settingsUserOnly` clipped out pluginAgents → fixed to a separate read-only resource projection (agents still user/builtin only; no project profile read, no runtime alias, project Markdown bytes unchanged).
- **I103-09**: the file list finished before the CLI plugin seed completed and the user page skipped inventory init without a targetWorkspace → reuses that entry with an available local workspace as context, explicit user scope, refresh on completion; no new polling/timeout/Account sync; only the active page consumes the result.
- Pro `desktop-e2e-20260909-150213-807` SE-02/04 2/2 (judge on first page load after fresh seed; whole-group model/highest tier/explicit high on disk; no old-map write; plugin row not editable; judge bytes unchanged) — the cold-start defect not bypassed by loosened timeouts. Final Host/Skills/Commands/UI 111/111; CLI 58/59 — the only failure is the pre-existing packaged CUA seed assertion (0.5.13 constant vs 0.5.14 wrapper), routed to G03. Root typecheck (incl. E2E), lint 39/0, diff check passed.
- Bidirectional: no plugin/project Markdown writes; 99 resolution/Factory/implicit inheritance, user-scope storage, desktop/phone message flow unchanged. Plugin cold-start request loop and store auto-refresh still pending. Commit `feat(subagents): expose official plugin model overrides in settings`.

## 15. Execution Strategy Supplement: Safe Merge, Risk-Based Batch Acceptance (2026-09-09)

- User rulings in the full Goal: fix only merge regressions, missed old-interface wiring, and issues blocking this round's retained behavior; unrelated pre-existing issues are recorded only.
- Low-risk no-intersection items go in batches (implement, review, commit, shared build/typecheck/lint/regression); high-risk intersections keep discriminating focused verification instead of the full pipeline per small item.
- Failures are triaged first: merge regression / pre-existing product issue / outdated test / environment precondition. Failures without evidence stay open; pre-existing issues are fixed only if they block retained behavior or intersect a pending source — never auto-expanded by adjacent group names. Two standing examples: the CUA packaged seed 0.5.13-vs-0.5.14 version mismatch (pre-existing; G03 rechecks only on source intersection) and the stale-revision ACK assertion failing before G13's change (baseline failure; G12 decides after checking impact on retained behavior).
- Passed shared evidence (111 Host/UI tests, SE-02/04, typecheck, lint) is reusable for the corresponding commits; incremental verification follows related code changes — Pro builds and identical cases are not unconditionally repeated.
- Standards unchanged for the bidirectional total review, all sources dispositioned, final key acceptance, the real merge, and safe merge-back: no auto-push, no diverting key acceptance to Todo102. The Goal tool only supports create/read/complete-blocked — supplements land as contract updates, never faked completions.

## 16. G04 Closeout: Official Store Refresh, Plugin Override Cold Start, Source Review

- Store behavior of `dbb3ec0ce802826aa6a807a4a33e1e441234ada3` retained: entering the page auto-refreshes only the ZCode official catalog, skipped within ten minutes of the last refresh/attempt; in-module placeholder prevents duplicate requests; manual refresh refreshes the whole market, ignoring the auto window; the Claude market is not auto-refreshed; no new polling. Current Host user inventory, configScope, and workspaceIdentity wiring kept.
- All 29 source paths dispositioned (storage/RPC/loading via B1; cache discovery, Commands/Skills, settings page/bilingual via B2/B3; store helper/page and WDIO fixture in this batch; docs and feature graph synced). 24 G04-only paths verified; 5 cross-group paths record only the G04 fragment complete.
- New PLM-LC-020 cold-start case (reuses SE-04's save format): after a full Desktop/Host/CLI restart, the plugin judge's child request is alternate/high while the parent continuation stays original model/max, distinguished by latest user block type; queue-empty, finished-execution, and persisted-override-unchanged assertions included.
- Store store/listing/error-target 4 files 52/52 (after the helper-import module-load failure); root typecheck (incl. E2E) and lint 39/0 re-passed after the new case. Pro: `desktop-e2e-20260909-152018-653` PLM-LC-018/019 2/2 (skip in window; no re-refresh after a real CDN update); `…-152419-828` PLM-LC-020 1/1 (isolated replay, real capture, no real model account). Build/fixture environment failures (missing `VITE_ZCODE_E2E_STORE_BRIDGE=1`; fixture in the wrong directory) were fixed as test issues only.
- PLM-LC-018/019/020 stay pending — a local pass is not a CI promotion; 019's real CDN boundary unchanged; mobile acceptance not claimed.
- Bidirectional: both G04 sources dispositioned; the old dual map only crosses the one-time import boundary; 99 explicit resolution, internal frozen override precedence, implicit inheritance, Factory precise validation unchanged; no project/plugin Markdown writes; continuous/replayable boundaries unchanged. G04 and G13 completed group-internal review; the remaining groups, the real merge, the bidirectional total review, and the merge-back remained open.

## 17. G01 First Batch: Dev Resource Preparation and Existing Equivalent Build Contracts

| Source                                               | Ruling and disposition                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `b68966b818` dev startup no longer downloads old GLM | Keep. Update the two runtime/bundle specs and failing assertions first, then remove the old native Agent check from preflight and its local-only helper. Script results match pinned staging; native-search verifier, macOS window helper, Windows browser helper opt-in kept. |
| `a91244048b` pacman default compression              | Already equivalent: current `a19cfe3f63` removed the explicit compression; the test file matches pinned staging. No re-stacking.                                                                                                                                               |
| `d9234670a3` restore darwin x64 mapping assertion    | Current tests already keep the exact assertion; verified. Not removed or re-added due to the adjacent Linux filter source still pending.                                                                                                                                       |

Intersection: `dev-desktop-env.mjs` still runs pre-dev → build-desktop-agent-cli → runtime; the process manager prefers workspace `dist/zcode.cjs`. Removing the old native download does not remove the Agent build or change remote deployment, Provider readiness, account sync, or session selection. 3.12.0 kept. Tests failed first on the remaining `label: "glm"`; after the change 3 files 57/57; typecheck and lint (39/0) and diff check passed. The full pre-dev was not run; unit tests are not per-platform installer runs. Only these three sources and their exclusive paths are settled; Windows installer, signing/notarization, and the Linux update filter continue in §18.

## 18. G01 Second Batch: Installer / Signing / Linux Update and Release Identity

- Eight Windows sources (`049b2a539b`, `36368ef523`, `acb87a9a18`, `4b9f3844cf`, `a698fede1c`, `22d92c5dac`, `43839fd9a1`, `dd0b06f91c`) keep pinned staging's final behavior: ownership manifest limits managed-update cleanup; HKCU/SHELL_CONTEXT cleanup diagnostics; silent error boxes exit by default; install-detail phase and per-file cleanup logs; `.zcode` protection scan decided by the old uninstaller manifest's capability; production/Preview AUMID matches the packaged appId. Not extended in: old-version backup/rollback, redone NSIS native retry, junction scanning. The old spec's "atomic on-disk write" had no implementation evidence → rewritten as an accurate ship-with-package description.
- `50a9c63c12` + `bbcc946c38`: Helper signIgnore keeps electron-builder from re-signing signed/notarized nested Helpers; the doctor's required-Helper gate adds a local staple check and only checks xcrun after the file exists and codesign/spctl pass. No signing/notarization/release operations run.
- `7beb6487b2`: Linux manifest pacman/rpm/deb filtering kept, with explicit failure when the filter empties the list; macOS/Windows not filtered; a direct real-resolveFiles call proves the filter reaches the actual resolution entry and AppImage address/checksums survive.
- `84c4fcfc1d` + `89817f5be2`: 3.11.1/3.11.2 historical release entries and `5ded50a096`'s duplicate-pacman removal kept; no unrelated old changelog formatting restored; line-by-line check: 0 lines missing vs staging. package.json stays 3.12.0; only the two root lock version fields were aligned to 3.12.0, no dependency-lock content changed.

**I103-10 (formal UAC state mis-wiring):** the source's `ZCODE_INSTALLER_IS_ELEVATED_INNER` defaulted always-false and only the smoke fixture set it — real electron-builder templates never inject it, so the source's elevated-inner protection never took effect in formal builds. Fixed: include the same UAC.nsh by default and reference `UAC_IsInnerInstance` (fixture may still override); no elevation-flow redo. New formal-default assertion failed first, then passed; real NSIS compilation also covered the non-overriding preserve-files fixture.

Verification: 9 files 138 passed / 2 Windows-only skipped after implementation (10 assertion + 2 collection failures before); formal manifest/version assertions added (first 3.11.1 != 3.12.0, then corrected); final affected files 17/17 (combined 141 / 2 skipped). One real NSIS template dependency check read the current app-builder-lib installSection.nsh, modified only a temp copy, verified phase order/idempotence, restored bytes. Locked NSIS 3.0.4.1 / resources 3.4.1 from the electron-builder checksum downloader; native makensis compiled installer-nsh-smoke and preserve-files installer/uninstaller variants (uninstaller with /WX); artifacts isolated in `/tmp/todo103-nsis-compile-fqZl75`. No real uninstall or user-data deletion. Root typecheck (incl. main/host/E2E), lint 39/0, syntax and diff checks passed.

- **Real Windows execution remained open**: on Linux the two Windows-only tests are skipped, not passing; file retention, lock-file failure, logs, and shortcuts need the existing two smoke suites on isolated Windows. Compile variants do not substitute. Kept as the G01 key acceptance — not diverted to 102, not blocking other groups.
- macOS doctor tests run real shells with isolated tools: they prove check order, arguments, and failure propagation, not a notarized production package.
- Bidirectional: installer, helpers, and domain-spec behaviors dispositioned; UAC wiring has its own evidence; no new Provider/Selection state or persistence migration; electron-builder keeps only the current Built-in Provider Config assets (no old chinaLlm catalog); main/index gains only the Windows AUMID call (packaged reads build-time ZCODE_ENV; macOS/Linux untouched). Windows items stay `implemented-awaiting-windows-smoke`; shared main/index and package.json keep other groups' pending entries.

## 19. G09: OAuth 401 and Failure-Page Interaction (implemented, group review)

| Source     | Intent and disposition                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| d17cb6a800 | Login failure allows cancel back to the channel list; new flow clears stale errors; failure not beside the channel list. Keep; WelcomeScreen uses the original hook/store/retry-channel ownership; no new UI state source      |
| a172e9c398 | 401 from the current business access token's userinfo/customerInfo reuses the original logout prompt. Keep the strict origin/path/current-token scope; payments, model API keys, business-body errors excluded                 |
| 71a195b6be | Late 401 after re-login/refresh does not log out wrongly; refresh writes into the existing queue. Rewired: conditional re-check, session cleanup, and generation guard kept plus the current accountIdentity cleanup parameter |
| f26d4e75fb | One illegal URL config must not block another endpoint's 401 classification. Keep two candidates' independent safe construction; no domain/path loosening                                                                      |
| 846b31c21b | credentials.json full-domain audit document. Kept as historical audit with pinned-baseline/current-architecture notes; its CLI/MCP/encryption/cross-process issues are not auto-promoted                                       |

**Intersection I103-11:** staging's logout callback carries only provider; the current one also carries accountIdentity and deletes derived credentials per account. The new conditional logout reads the original profile.id inside the same session queue before clearing, then hands off to the current notifyProviderLogout(provider, accountIdentity). Manual logout/unlink/logoutAll and startup expiry recovery keep account-identity semantics; node.ts changed only this 401 assembly group.

```text
NodeApiClient HTTP 401 -> strict credential/endpoint first classification -> URL + request headers
                                                  |
                                 OAuthService existing session write queue
                                                  |
                   new login/refresh already submitted -> no match -> no cleanup, no broadcast
                   still matches the old request     -> take original account identity -> clear credentials
                                                  |
                              current identity-derived cleanup -> original expiry broadcast
```

State owner stays the current OAuthService; no cross-Host transaction, second sync system, RPC method, or pre-send gate; existing cross-process transient boundaries untouched. The failure page reuses the current hook/state and shared login panel (case-local fixtures/pending identity; no layout redesign).

Evidence: jwt-401-auto-logout, jwt-invalid-restart-prompt, oauth-login-failure-copy, auth/config acceptance lists updated first; after the classifier 51 classification cases passed while the conditional-logout suite failed 11 (missing logoutIfCurrentCredentialRequest); after implementation 4 files 167/167, plus endpoint/UI 14/14, existing five login files 25/25, oauthProviderLogout 1/1 — **207 distinct tests**. UI: 3 of the upstream 5 failed pre-fix, then 5/5 (included above). Root typecheck/lint 39/0. Pro: one shared build, serial AUTH-05 + AUTH-06 **2/2** (`desktop-e2e-20260909-155636-836`); no real requests/credentials/restarts; AUTH-06 asserts RelaunchApp at the IPC boundary, not a full restart, and stays pending. Service micro-races proven by controlled promises; the Pro run proves Host request, cleanup, broadcast, and UI wiring — not misrepresented as mobile/Windows acceptance.

Bidirectional: login cancel, access-token whitelist, in-queue re-check, refresh non-resurrection, bad-candidate isolation, cleanup-failure prompts all covered; no old family/preset source; only the current OAuth and identity-derived credentials cleared (Bot's independent credentials kept); the UI never reads/writes credentials; Web shares UI and broadcasts; continuous/replayable and workspaceIdentity boundaries unchanged. G09-exclusive production files match pinned staging; the remaining OAuthService diff is the current account-identity protection. Shared node.ts/wdio.conf.ts/auth-config docs keep other groups' pending sources.

## 20. G05: Bot Deleted-Task Recovery and Feishu Delivery Diagnostics (implemented, group review)

| Source     | Intent and disposition                                                                                                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 65ad97769b | Deleted desktop active task receiving a Bot message → create a new task, clear old interactions, notify once. Keep tombstone detection + notification; rewired to current draft init, Selection View, V4 create/dispatch — no old model/thoughtLevel path             |
| 3c53fe008f | Feishu HTTP/business failures keep code, log_id, receiving identity type; independent delivery errors, success clearing, popup refresh. Keep; sends keep open_id, card updates keep message_id; no retry or chat_id downgrade; current run state and UI logger reused |
| 35ba050592 | Original author's real long-task and protocol acceptance record. Kept as explicitly-marked historical evidence; its tenant/CUA/cross-end/protocol tests are not this round's runs                                                                                     |

**Intersection I103-12:** upstream Bot config/creation used old interfaces. Fixtures keep v3; bound, non-deleted tasks treat the Session's persisted selection as the only fact; only a confirmed tombstone returns to the existing draft path. The new task's effective selection comes from the public View, then flows complete through V4 create/config/send. No second Bot model-state copy, implicit plan selection, remote-disconnect fallback-to-local, or new sync gate.

```text
Authorized Bot normal message -> deletion records of the target workspaceIdentity
                          |
             not tombstone -> original Session selection/command chain (Todo99)
             is tombstone  -> clear old bindings and pending interactions -> original draft init
                                                     |
                                public Selection View -> fix this run's selection
                                                     |
                                      V4 create/bind -> notify once -> original message dispatch
```

Rules kept: notification failure only logs a warning (the inbound message's dedup is not released to redo the task); archiving, list filtering, and query failures are not deletion evidence; the tombstone query reuses the actual target TaskService, never crossing workspace identities; delivery errors and WebSocket state never impersonate each other; an active abort does not overwrite delivery diagnostics; the popup refreshes serially only while visible, closing cancels later polls/write-backs; no new session/model state owner.

Evidence: bots spec/catalog/matrix first; upstream tests failed 10 / passed 44 (unhandled tombstone, lost HTTP-200 business error detail, missing delivery UI); after implementation 139/139, plus intersection assertions 29/29 — **161 distinct unit tests** (public preferred Selection fully into V4 and send; no create/dispatch without an available selection; Session single-source). Root typecheck/lint 39/0. Pro `desktop-e2e-20260909-160553-706`: 5 specs **9/9**; DT-01/DF-01/effective-selection/remote-disconnected are synthetic service-harness evidence, CF-01 real Electron UI; not misrepresented as a real Feishu tenant or real SSH. New candidates stay pending; no outbound Bot messages or real account changes.

Bidirectional: deletion recovery, single notification, duplicate protection, old-interaction cleanup, error details, delivery-state clearing, group-chat rejection, state refresh, and the historical record all dispositioned; v3 Config, structured selection, V4, Todo99 Session authority, /model immediate submit, and normal-message effective resolution kept; continuous/replayable and shared-host routing unchanged. Shared botsService (G14) and i18n keep other sources pending; group pass ≠ global merge completion.

## 21. G02-A: Help Config client/configs (implemented, batch review)

| Source     | Intent and disposition                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 294e520687 | Help community/feedback uniformly reads the current endpoint client/configs; Desktop/Web platform readers share one public in-memory cache and per-field defaults; keep |
| b87559143a | From one mock test to case-local HTTP, language/cache/failure-recovery, narrow-screen Web; keep the full matrix, fixtures, and graph seed                               |
| 29b0a87dde | User-authorized HC-01–05 promoted; keep the root formal spec and 8 cases; the two moved pending files are not restored                                                  |
| d3bdf049dd | Remove the uncalled old CDN URL constant/constructor and stale tests; keep the built-in default.json, the valid-field helper, and the old client's online resources     |

No new product rulings. The four core files were byte-identical to pinned staging; adopted only where the current file had no recovery changes from the merge base. Shared index/main/platform take only this batch's imports/reader/parameters — no G03/G11/G14 piggybacked. Public help reads attach no user OAuth and do not reuse account gray-release caches; Provider/Selection persistence, session owner, shared-host, and continuous/replayable semantics untouched.

```text
Desktop native menu/platform actions -----+
                             +-> public help reader (URL isolation, concurrent merge, 1h success cache)
Web platform actions ---------------------+                     |
                                current endpoint/version/platform -> client/configs
                                                    |
                                     code=0 + per-field valid values
                                                    |
                         same-language built-in defaults -> external link / built-in feedback dialog / platform unavailable
```

Evidence: spec/matrix/fixtures first; then shared/web/desktopCommands/NodeApiEndpoint 5 files **44/44**. `dep:refs` traced 9 old-URL-constructor references (all this batch's), none left after. Root typecheck passed; first lint 40/0 — the extra warning was a now-unused ZCODE_VERSION import, removed (that file then 0/0); the other 39 pre-existing. Pro: first run **6/8** — English Help not found and feedback showing Chinese "提交反馈" were proven test locale-preparation mismatches (runtime DOM error text vs Main SetApplicationLocale/Renderer IntlProvider); fixed by isolating locale/localePreference + reload. Same build then **8/8** (`desktop-e2e-20260909-161710-536`): real menu links, language match, 1 concurrent/cached HTTP call, false→dialog, true→external, failure recovery, no-config unavailable, 390×844 real Web resolver. The Linux overlay branch assertion is a G18-source assertion kept pending G18. Artifact summary kept on Pro.

Bidirectional: success-cache/no-cache-on-failure, no-store/credentials omit, 10s timeout, endpoint/version/platform isolation, same-language fallback, false valid override, Web omitting platform, Desktop native feedback toggle, and the question-mark menu behavior kept; only the help config's remote source changed — connection selection/model config/runtime authority unchanged; Main still only performs platform actions; removing the old URL does not delete the online CDN. G02's remaining MR skill, governance gates, and Obsidian/skill sources were not in this batch.

## 22. G17: Settings Overlay Remote Workspace Identity and Subscription (implementation done, SSH gate pending)

| Source     | Ruling and disposition                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| c8a001ee48 | Keep the covered workspace's remoteSessionId fix; Root recovers identity from the window's existing tabs by workspaceKey — no new Host or subscription channel           |
| b3111a9f4c | Keep the one-shot lifecycle warning when the endpoint mismatches the actually registered agent; observe only — no key rewriting, no reconnect, no generation rule change |
| 6fb1fd00ac | Keep the watchdog test's 8s exit wait; Windows process-tree reclamation is not bound by the original 1s window; production timeout unchanged                             |

**I103-13:** workspaceIdentity was already restored, but Settings activation still lacked remoteSessionId — the completion notification and the sidebar built different endpoint-keyed stores for the same remote Agent; the CLI's later subscription on the same connection/topic replaced the earlier one, so the sidebar showed subscribed but received no frames.

```text
Remote tab (workspaceKey, remoteSessionId)
                  |
         Settings opens over the tab
                  |
Root recovers the full identity from the window's tab set
                  |
Notification, sidebar -> same endpoint/workspaceKey store -> one effective subscription
```

Root gained only target-resolution parameters and tab-set reuse; remoteWorkspaceSessionStore gained only an identity query for registered agents; the existing agent-generation change, release handling, and Provider refactor stay (no old Provider Registry sync). The registry keeps current-generation comparison and non-blocking transport replacement; log dedup plays no part in routing. Existing desktop-continuous / web-remote-replayable subscription tests kept passing; no new recovery flow.

Verification: spec/pending E2E/fixtures first; 11 new cases failed 7 first (missing identity, duplicate store, missing diagnostics), then Root/subscription/diagnostics/registry **23/23** + remote runtime/persistence **19/19** = **42/42**, covering stale proxy, generation change, both deliveryKinds. The watchdog targeted run was 1 pass / 42 filtered — not a full-file pass. Root typecheck/lint 39/0; diff check passed. The SSH-P0-TASK-03 fixture check passed; the candidate stays pending. Pro had no `ZCODE_E2E_SSH_*` environment; no colleague credentials or real-account cleanup were used to force acceptance. **Sidebar convergence after toggling Settings on a real SSH run remained the key gate** — acceptance not declared, not diverted to 102.

## 23. Execution Strategy Adjustment and the Current G06 Batch Closeout (2026-09-09)

The user ruled again: per-source porting-and-acceptance of every staging item is **not** a precondition for the real merge. Todo103 replaced that order; earlier commits/evidence stand; after the G17/G06 closeout, the fixed staging normal merge proceeded. Low-risk independent changes are retained wholesale by the merge; intersections are ruled per feature. Bidirectional review of the full candidate and cross-group acceptance remain the merge-back gates; no auto-push. The source inventory gained three dimensions — decisionStatus / implementationStatus / verificationStatus — commit counts are not completion rates, and implementation is not verification.

### G06 fragments completed at that point (not the whole group)

- `aa2cf0448e`: "no private fallback to Start" kept; the current Wiki already uses the target public View, not the old family/entitlement projection. The source E2E's old generationModel assertions and static Provider seed were to be handled in the full candidate per the current contract.
- `8423f78274`: numeric protocolErrorCode diagnostics added; raw error text not persisted; tests red first. No old registry mirror; Wiki lane tests strengthened to prove the complete Account Config (current + basedOnZCodeBuiltinRevision) delivered before a new Worker request, not re-delivered to the same client, re-delivered to a new client after release-rebuild; reverse credentials handler and terminal-state reclamation unchanged.
- `69d2ad76aa` / `0ec3b13d56`: all Wiki RPCs routed by target project, reads skipped while waiting, re-read after registration — reusing the public workspace resolver, no bespoke disconnect proxy. The selected project's public ModelSelectionView unchanged; only the mis-routing into other projects' expansions fixed.
- `11230d9a1e`: a concise root-cause comment; the old registry sync comment is superseded by the current Account Config facts, not restored.
- Pre-merge shared unit tests **11 files 83/83** (G17's 42 + G06's 41); root typecheck/lint 39/0. Pro (one shared build): the three existing Wiki UI cases **3/3** (`desktop-e2e-20260909-163844-844`) — settings without an independent output budget, real generation persisted, historical Wiki reading/deletion; the generation test uses a Host modelGenerator fixture. Not full staging acceptance: cross-remote-project routing and G17's real SSH still awaited the candidate stage.

## 24. Real Merge Candidate Started (not yet accepted)

Committed `c4f8619d96`, then a normal `git merge --no-commit --no-ff 790884b1ce4b990583ab40625b5f283e2169eb36` on the isolated integration branch (`MERGE_HEAD` pinned; no commit discards, no per-source re-creation, no ours strategy). Initial 153 conflicted paths plus many clean auto-merges; the full diff was in the working tree, not a preview.

| Intersection                 | Ruled / implemented                                                                                                                                                                  | Verification                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Root version and lock        | 3.12.0 kept; everything else merged normally                                                                                                                                         | Candidate build pending                                                      |
| G17 Root, remote store       | Synonym-comment/signature conflicts resolved keeping workspace identity and generation protection; Root's auto-merged G11 content reviewed separately                                | §22/23 are checkpoint evidence, not whole-candidate                          |
| G06 Wiki routing / tests     | Keep the public workspace resolver, real disconnect proxy, test cleanup; no old family projection, independent output budget, or test-only service injection                         | Three test files matched the checkpoint; Pane/E2E/auto intersections pending |
| G09 OAuth three files        | Keep accountIdentity-before-clearing, serialized invalidation notifications, both platform tests; no provider-only cleanup revert                                                    | Byte-identical to checkpoint; §19 evidence reused                            |
| G01 installer and tests/docs | Real UAC inner-instance check kept (not always-false); template idempotence/recovery and Linux updater tests kept; manifest docs do not re-promise unimplemented atomic transactions | §17/18 evidence stands; Windows execution pending                            |

A clean auto-merge is not a review; both-side intersections, new files' old-interface dependencies, and protocol/config/build keep being handled per feature. The source inventory keeps source tracking; the candidate inventory (`todo103-real-merge-candidate.json`) lists actual conflict paths; counts are not completion rates. Full type/regression runs were skipped while many conflicts remained. The newly merged architecture gate ran clean (`pnpm architecture:check --changed` → 0 violations), but `architecture:context ui` returns module-not-registered (managed=false) — a green gate is not automatic architecture proof; the baseline was not modified. The candidate was not yet commit-merged, merged back, or pushed.

Continued per-feature conflict handling:

- G06 Pane (17 blocks): kept the target Host's public Selection View, frozen generation selection, output Limit, routing/readiness/refill; no old family projection, menu-first-item fallback, or ad-hoc session hydration. An auto-merged `activeRepoWikiService` variable renamed back to the declared `repoWikiService` — clearing markers while leaving an unusable subscription is not a resolution. The mid-request-disconnect loaded criterion extracted as a local variable, semantics unchanged. Both Wiki specs keep current boundaries.
- G02/G09 help/auth records: kept the current Renderer-locale test precondition and historical-evidence markers; the source JWT-401 scenario restored as AUTH-JWT-401 (original numbering collided with AUTH-05, noted). Source run IDs not counted as this round's acceptance.
- G10 E2E credentials: Personal-only/accountless fork keeps no-account seed; only `provider-family-responsive.test.ts` gained the local balance-mock JWT exception (general fake-login scope not widened). Targeted `e2eStartupCredentials.test.ts` **13/13** — seed boundary only, not responsive UI.
- G13 error telemetry: bounded-safe `error_detail_message` kept; raw `error_detail_text` upload not restored; RPC wrap normalization and active-loop consumption attribution tests kept; the security-validation cancel/retry chain stayed with G08.
- G05 Bot: v3 fixture, public View init, full V4 first-send kept; UI deliveryError was a synonym conflict. G14's Bot memory-counter registration auto-merged cleanly (callbacks read four existing table sizes only).
- The historical credentials audit and WSL investigation kept current factual statements only; no CLI/MCP widening.

**107** conflicted paths remained at that stage; the candidate was not runnable. Progress is recorded by the ruling/implementation/verification dimensions, not path counts.

## 25. Real Candidate: CUA / Shared Protocol / Subagent Intersection Closeout (2026-09-09 17:13 UTC)

20 newly resolved conflict paths plus auto-merge duplicate/test fixes; 87 remained — **not** a runnable or accepted candidate.

- G03: Helper/Agent lifecycle isolation, on-demand recovery, reuse of published pipe/token, idle-watchdog cancellation, and Agent recycle assembly kept; `node.ts` resolved block by block (CUA, OAuth-equivalent holder, Provider DI, new share/Off-Peak wiring) — never whole-file. Windows Host kept the post-ready `this.handle` assignment; a definite regression (late ready after explicit stop re-wrote the old tuple; next generation timed out) was reproduced by test, then fixed by checking stopped/epoch/current generation before publishing in onMessage — existing guards reused, no new timer/Agent state. CUA spec gained the timing/ownership.
- G03 producer: catalog/lock/upstream-consistent `908b247399423195d0cb0039e1755a333c4c1ff` kept; `check-cua-baseline.mjs` passed; **the installed node_modules still contained recycleUntilStable — a matching wrapper version does not prove dependency alignment** (old compatibility-method tests stayed until the exact pin landed; no manual SHA edits).
- G04: the shared package's auto-merged duplicate `createPluginAgentStateId` and interface-merged old `model/thoughtLevel` removed — one stable ID and the structured override interface. Service (18 blocks) and Agent (5 blocks) reviews kept structured state/formal reader/complete saves, shared Node migration and cache scan, install-record/suppression precedence, settingsUserOnly plugin projection, startup snapshot with Selection-first-then-aliases, `create-app.ts` `modelSelectionOverrides` (no `storageRoot` loader or dual-map reader). Two source-added tests checking old storage/API kept their assertions on the structured interface; old files load through the existing migration first.
- G04 modify/delete paths stay deleted (`modelProviderServiceStorage.ts`, `modelProviderEnablement.test.ts`): the source's only new intent — same-endpoint Start/Individual member isolation — is covered by `packages/provider/test/resolver.test.ts` (§12); both exports show 0 references via dep:refs + text check.
- G08 shared success response is a strict union: `headersApplied=true` must include the current `requestAuth` (apiKey/headers) — no bare `runtimeProviderHeaders`/providerRevision; the cancel notification keeps independent request/session/workspace identifiers. Cancel/3007-retry full chain still open.
- G07/G11: shared Off-Peak tool policy and `sharedContextRefs`/`importedHistory` kept; the same block's old workspace provider upsert/remove/default-model mutations not restored; Service/Shared barrels merge valid new exports without losing Provider Facade/Auth/Provisioning.
- G10: claim response uses the source's independent claim entitlement type (id/name/effectiveAt); preview-only grant/meter fields not forced in; server_time ms / effective_at s / 0 semantics kept.

Verification: `windowsCuaDevHelperHost` + `zcodeProtocol` + `nodeCuaInstallerExports` + `codingPlanSubscriptionService` **4 files / 168 passed** (the new late-ready case failed 1/34 pre-fix); `subagentsService` + `subagentSelectionAuthority` + `subagentStateMigration` **3 files / 49 passed** (first failures attributed to outdated interface assertions); CLI `vitest --root apps/zcode-cli packages/bootstrap/tests/subagents.test.ts` **10 passed** (root Vitest excludes CLI tests — passing an extra path to the root command is not a run). Preconditions were shared-index/export parse failures, not CUA runtime failures. architecture check 0 violations (services/shared/zcode-cli unmanaged — not a manual-review substitute); Node 24.19.0 vs pinned 24.14.0 stayed on the acceptance list. No merge commit, no recovery change, no push.

## 26. Real Candidate: Security-Validation Retry and Bound Request Authentication (2026-09-09)

Ten more CLI conflict paths (77 remaining), mostly G08. **Low-level passes are not Host/UI completion.**

- Kept: the source's one extra retry, cancellation, network retry budget, stream-output boundaries; identity judgment rewired to the bound Model.accountAccess.mode=start-plan (no old builtin-ID guessing, no re-reading the current connection); Invocation/Runtime uses the complete requestAuth.
- resolveModelForAttempt merged the source's cancellable wait with per-request private auth: pass bound providerId/modelId + attempt/reason; on requestAuth, rebuild the same bound request — Registry and persisted selection untouched. `ModelRequestAuthMissing` kept, never swallowed by a generic wrapper.
- Regression found by the source's concurrent/HTTP assertions: old lowercase vs new uppercase security-validation headers merged into a stale value by Headers. `applyModelRequestAuth` now replaces same-named entries case-insensitively on a private copy — static config and other concurrent requests unpolluted.
- Source tests moved from old ModelRegistry/ref/adapter.generateText interfaces to the current bound-execution fixture; OpenCode Go assertions kept; a cancel test conflicting with the new early-abort changed to abort inside the first SDK call — cancel-does-not-retry still verified, not loosened. Telemetry keeps the bounded cause/adapterError/error chain.
- **Key open item:** the Adapter receives trusted complete requestAuth and must not reuse the source's filter that keeps only the security-validation header (it would break other account auth); the UI must not inject Authorization. Written into the spec — **malicious-header isolation still had to be verified at the Host/UI assembly entry**; port-migrated Adapter tests are not that evidence.

Verification: five Adapter test files **193 passed** (two real local HTTP Server + AI SDK round-trips, 26 retry cases, non-Start bindings excluded from the extra retry). Desktop dialog/Host cancel/cross-group acceptance open. frozen-lockfile + ignore-scripts install succeeded (pnpm 10.33.2); pins and lockfile unchanged — install success is not native-run success.

## 27. Real Candidate: Settings Projection and Protocol Factory Deduplication (2026-09-09 17:37 UTC)

Eleven conflict paths (66 remaining); auto-merged files reviewed in sync; no merge commit formed.

- G04 SubagentsSection: current Local Host Selection View — non-ready does not corrupt intent, structured complete override saved, explicit choice takes the highest tier; source's shared helpers/comments kept; auto-merged duplicates (persistedModel/modelAvailable, modelProvidersLoading) removed; a synonymous source plugin test not kept twice; re-entry refresh covered by `useModelSelectionView.test.ts`'s Start→Individual remount→Team case — no private forced refresh or Family state.
- Model groups kept the current read-only projection (the source's deleted Family connection-selection algorithm is not restored); the Resolver explicitly excludes non-current/unavailable accounts; the UI infers no fallback. Visual badges follow Todo88 R12's support_image fact (audio/video/pdf are not all Vision); the source's precise-prefix/multi-segment model-ID behavior added as View tests.
- UI Store types keep the source's timelineBottomRequest/requestId; the consumer-less draftPreferredModel/ThoughtLevel/Mode seeds not restored.
- G03: after the exact pin, cuaWorkspaceRegistry.js/d.ts no longer contain recycleUntilStable (only setEnabled/snapshot/pruneDisabled); two old recycle compatibility tests deleted; the file's execution was still blocked by unresolved markers in zcodeAgentService — **no run-pass claim**.
- G11: input persistence/queue metadata keep modelSelection + mode + sharedContextRefs, none overwriting the others; canonical goal case gained a combined-save assertion.
- G12: fork merged the import intersection only; the current selection-copy behavior unchanged. G14 server-types keep async createZCodeApp + the event-store injection point.
- G08: the source's standalone provider-runtime-headers module wired in (a real factory regression first reproduced duplicate requestIds under a fixed clock), keeping ModelSelection/accountAccess/requestAuth and all Account entries; the old inline Date.now copy deleted; ordinary APIs still bypass account RPC via the binding layer. The modify/delete workspace-model-catalog stays deleted — its only source change was extracting the Port, now wired; no old overlay/default-Model mutation.

Verification: UI Subagents + public View + model groups 3 files **50 passed** (after the shared Store conflict marker cleared); new precise-ID case + Provider Resolver 2 files **17 passed**; Core fork + input intent 2 files **27 passed** + combined-metadata assertion **2 passed**; security-validation Port **3 passed / 1 skipped** (the skipped case needs the full server's real pending/180s timeout/late response). §26's Host/UI Authorization boundary remained open. No whole-candidate typecheck/lint/build while explicit conflicts remained.

Next high-risk entry located: zcodeAgentService, one block interleaving G07 Off-Peak policy, G08 request auth, and G14 memory diagnostics — keep current Account sync/request-time auth, rewire the source's policy/cancel/diagnostics dispose, exclude old ProviderRegistry branches; its block 11 spreading UI response.runtimeProviderHeaders must be checked against the whitelist boundary (§26).

### G07 located interface mis-wiring (historical location; Host/storage rewired in §28, UI/dispatch joint verification pending)

The normally merged Agent Tool Bridge still took `OffPeakClientConfig.allowedModels/allowedModelConfigs` and called createTask with `{model,thoughtLevel}`; the current config only has `modelSelectionView`, and createTask must receive the complete ModelSelection — as-is the exposure gate would be always false and creation would fall back to guessing the highest tier by model. The fix selects the hidden Provider from the current Off-Peak View and logged-in account support facts, reuses ordered optionSpecs (highest tier last), and keeps D49's tool-default last-position model, explicit-model normalization, and D50 binding/error classification; no old allowlist/static tier-strength table, no multi-account scheme. The form path and ticket binding stay untouched. The old tech design's ClientConfig/default-tier wording updates with the spec and does not override the current Registry contract.

## 28. Real Candidate: Host Off-Peak Tools, Security Validation, and Bound Persistence (2026-09-09)

Seven conflict paths, 66 → 59; checkpoint and pinned MERGE_HEAD unchanged. These conclusions do not cover the still-unmerged UI, CLI server, and desktop dispatch.

- G07 `45a0078032`: D49 OffPeakCreate/List, exposure gate, tool defaults, error sanitization, and D50 session binding kept. The Host reads members from OffPeakClientConfig.modelSelectionView, confirms the Family via getCodingPlanSupport, selects the exact hidden Provider; completeNewModelSelection yields the highest tier (values' last position). No other-domain candidates, no old allowedModels/allowedModelConfigs/static tier-strength table. createTask submits a structured modelSelection plus boundSessionId/workspace; old tests rewritten to the new contract. Host create/resume compat + V4 flag + TaskAdapter denylist kept: OffPeakCreate disabled only on idle turns; Cron's mutation constants not mixed in.
- G07 Repo INSERT keeps both model_selection and source session_id; the Service keeps the binding precheck and DB unique-index error classification after the current selection validation; ticket acquisition and bound Tickets unchanged; the source's degradation for pre-existing duplicate rows (precheck-only) kept, no real-data cleanup. Repo keeps old selection-isolation tests plus the source's binding/title/unique-index tests.
- G08 `218102a0f8`/`74fa583639`: request-private validation material and cancellation wired to the current accountRequestAuthService. A real Host callback test reproduced four failures (arbitrary UI headers mixed into auth; failed UI still resolving an account; late response after cancel during account IO). Fixes stay in assembly/pending-identity boundaries: attach only the security-validation headers (Host apiKey/Authorization kept); cancel during IO with the original pending identity checked at completion; one responder per pending identity; empty auth reports no false success. No Registry/persisted-selection changes, no new timeout system.
- G06 re-affirmed via the Account snapshot mirror; G14 `a008e4e12c` memory-counter registration and dispose kept.
- An auto-merge check found skillsService/commandsService re-importing DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS (source's private four-item list vs the shared five-item list including the ruled CUA default). Duplicate import removed in favor of the shared authority; discovery behavior unchanged.
- Off-Peak tech-design/glossary updated (in-session tools/binding/tail-card semantics kept; turnRuntimeModel/remote model lists excluded; Host interface rewiring clauses added); the security-validation spec gained cancel-during-IO and auth-assembly boundaries.

Verification: Host tool bridge/gate/internal errors/security-validation auth/cancel workspace isolation **5 files 26 passed** (the four new cases failed first); Repo + Service + legacy Task Adapter **3 files 130 passed** (real isolated SQLite, binding unique constraint/precheck, Session selection not overwritten, idle-turn denylist); skills/commands **2 files 46 passed**. Targeted oxlint 0/0; full typecheck/lint/build deferred until conflicts resolve. CUA Product Agent Env remained import-blocked (candidate-incomplete/auto-merge syntax issues, not CUA failures); §27's CUA file still had **no pass evidence**. Open: CLI server/turn flags joint verification with Host bound dispatch; G08 UI/controller/real Port timeout; full cross-group regression.

## 29. Real Candidate: CLI Dispatch and Share Import Intersections (2026-09-09 18:14 UTC)

Six index conflicts (5 CLI, 1 desktop remote assembly), 59 → 53; no half-done merge commit, no merge-back, no push.

- G07 `45a0078032`: server keeps workspaceUpdateOffPeakToolPolicy; createRecord's async factory assembles the OffPeakPort (explicit switch or Host runtime preference as the exposure gate); prompt-turn keeps the source's idle marker, anti-recursion denylist, and end/queued/rejected/exception recovery markers plus the current complete modelExecution and sharedContextRefs; session-flow does not restore turnRuntimeModel/apply/clear or model rollback and does not recompute the tool list already unified in startPromptTurn; the foreground promotion lease still releases in finally.
- G08: Port factory and cancellation kept; zcode-protocol tests moved the source's private-material assertions into the complete requestAuth, keeping unique concurrent requestIds under one clock — no old workspace Provider mutation or runtime overlay tests.
- G11 `84be5103f9`: the share-context atomic import's auto-merged new branch referenced non-existent providerID/modelID and threw ReferenceError (two real createSessionRecordForV4 tests added first); changed to the same optional structured modelSelection as ordinary imports — no fabricated source, no Registry executability requirement. Body, model-only, provenance, resume kept; documented in conversation-share-v1.
- G14 `3d87e89955`/`228c641268`: event-store factory injection, create/generate/close/failure cleanup and prune kept; createWorkspaceZCodeApp still awaits; no DeferredModelAdapter. `5eb47d9039`'s child publisher parent attribution kept; the two-parameter assertion updated to three (the source itself added the parameter — a stale assertion, not a behavior change).
- remoteWorkspaceServiceCollection keeps both the real share HTTP Client/remote artifact source and the current AccountCredentialStore logout, Provider provisioning, runtime-preferences bridge; localModelProviderService not reintroduced.

Verification: 4 CLI files first 23/3 (retention failures were stale `@zcode/contracts` dist — after `pnpm --filter @zcode/contracts build`, pass); the two new share cases reproduced the ReferenceError then passed; the batch **6 files 57 passed** (including the 180s timeout and late response); shared run **130 pass / 7 fail**: 5 MCP failures were stale adapters/dist calling the deleted isCuaGrayEnabled (deferred to the full build), 1 remote Cron default-denylist is a known Todo102 issue — not all 7 written off. New factory-gate/share/concurrent-auth cases **7 passed**; desktop remote assembly + OffPeak dispatch plan/settlement **3 files 15 passed**. Root oxlint excludes CLI by default — a CLI-cwd check exposed the server's pre-existing max-lines/unused items (present at HEAD); the new session-flow duplicate computation and empty catch were cleaned. Next located: desktop host bound-first-run still reading the deleted request.thoughtLevel and writing the tier via setConfigOption — to be rewired with the resume branch per the "idle single execution does not overwrite Session selection" ruling; CLI tool-test passes do not make the D50 desktop chain done.

## 30. Documentation Intersections Closed per Ruled Contracts (2026-09-09)

Four doc conflicts, 53 → 49; formatting/synonym text did not re-run product tests.

- CONTEXT: auto refresh is user-invisible; manual refresh refreshes the whole market and ignores the auto throttle (same as current); no second refresh mechanism.
- conversation-protocol-declaration: tables compared by invariant key/value. Keep the current attachment-only, queuedSubmissionPreservesSelection, acceptedGuideSwitchesAtModelStepBoundary; do **not** restore the source's queuedPromptUsesLatestSessionConfig. The security validation moves to the ruled one ModelInvocation retry. Only that item differs from HEAD after processing; all other current invariants retained.
- WSL/Start Plan bridge docs: keep the source's workspace headless controller, request-private security validation, late-subscriber replay, cancel/in-model retry — wired to the current ModelSelection/accountAccess/requestAuth; no builtin-ID guessing or old Runtime Model/Registry fallback; the stale "the whole bridge is deprecated" header corrected to "only the old config-rewrite scheme is deprecated".
- The staging 2026-09-08 test numbers stay as source evidence, not candidate all-green.

Off-Peak follow-up: `conversation-session-offpeak-create-existing-session` still asserted the old model/thought_level SQL columns and only reached queued (no bound dispatch); `offpeak-subagent-model-inheritance` covers form-created dispatch and the next ordinary turn, not bound-first-run. The former needs the complete Selection plus pre/post-execution selection-unchanged assertions for a bound session; neither claimed implemented here.

## 31. Real Candidate: Security-Validation UI and Session Share Intersections (2026-09-09 18:32 UTC)

Eleven conflicts, 49 → 38.

- G08: one in-request retry, cancel of validation/config waits, and the workspace headless controller kept, wired to the current ProviderSettings View's structured access; a request's existing accountAccess wins — updated settings state must not rewrite in-flight request semantics. The UI returns only the security-validation headers; the Host assembles auth via requestAuth; scope keeps workspaceIdentity/session/request isolation; cancel the subscription first, then replay the request. The source-deleted auto-restore hook and tests, the old refresh/discard/next-edit material staging helper and its 6 contract tests, and the unused global setProviderRuntimeHeaders helper all removed (dep:refs + text check: zero UI references after; Git-recoverable).
- G11: all three share send entries keep context_refs with the current complete Submission (existing Session, prewarmed first send, create-then-send); the merged entry uses conversationShareService + modelSelectionService — no modelProviderService, no pre-send Registry sync; prewarm admission/failure-no-resend/model-draft boundaries retained.
- SessionPane stop: both sides equivalent — current button/Esc/goal-verifier/idle-log tests kept, the source's stable button callback connected; a conflict-tool splice into the pending-ACK prewarm test was separated per feature (stop covered by the existing 3 cases; no duplicate tests).
- Toast: current dedupeKey + the source's per-id progress (including pre-mount) kept; current safe-area/top-right layout. i18n: both languages' new recent-activity copy and the manual plan-switch copy kept.

Verification: the two bound-accountAccess UI tests failed first (unexpectedly reading the newer Settings View), then security-validation UI **5 files 31 passed**; SessionPane **55 passed** (including the 3 new three-entry assertions; first blocked by a locale conflict, solved before running); Toast/i18n **5 files 15 passed** (real-DOM pre-mount merge + dedupe); targeted lint 0/0. The source's pending four-scenario retry E2E awaited mock-infrastructure conflicts and a full Pro build — UI unit tests are not desktop end-to-end. Next: G07 desktop bound dispatch; G10 plan UI/E2E fixtures; full-candidate bidirectional audit.

## 32. Real Candidate: Off-Peak Bound Dispatch and Entry Merges (2026-09-09 18:44 UTC)

Five conflicts, 38 → 33: Host/index, Main/index, Web/main, Automations, OffPeakNewTaskEntry.

- G07 D50 bound first run: keep the deleted/busy prechecks, resume stamp attribution, original prompt, mode setting, retry classification — wired to modelSelection/modelExecution. The new branch reading the deprecated request.thoughtLevel deleted; the resume branch no longer writes thought_level; both pass only the frozen complete Selection and execution-scoped Ticket Auth in sendPrompt. D49 disables CronCreate/OffPeakCreate together; read-only List stays.
- D33: off-peak rounds must not pollute the Session selection. Real Host tests found the checkpoint writing a hidden idle Provider in init createTask and a separate idle tier on resume — blocking "ordinary chat after off-peak". Necessary intersection fix only: init returns to ordinary Session initialization; the off-peak sendPrompt still uses the selection frozen at ticket acquisition, never re-reading the current connection. Tickets, migration, account sync unchanged.
- The Host unit test reads and compiles the real dispatchOffPeakRun function asynchronously, replacing only external services (not a copied implementation, not a source-string assertion). Seven cases: bound first-run/continuation payloads, busy/deleted pre-write rejection, unavailable-selection rejection, send-failure cleanup, ordinary new-session init.
- OffPeak/Automations keep the purchase inventory loading/error/retry entries; plan facts from the current ProviderSettingsView; upgrade target is a concrete Individual Provider; the home-navigation vs form-selected-support difference kept.
- The two OffPeakCreate pending E2E cases now read model_selection and validate against the shared schema; the cold-recovery case gained session_id binding and an empty un-dispatched conversation_id. The post-dispatch Session-unchanged E2E still needed adding.
- Main AUMID was a synonym-comment conflict; the duplicate readHelpConfig declaration deduplicated (help config stays separate from the auth gray-release fetcher). Web main keeps the share routes, OAuth safe return-to/language/theme entries, and the current community/help reads; mobile shared-host untouched.

Verification: the new Host tests reproduced both failures (2/7) then passed; Host dispatch/plan/settlement + UI OffPeak/EntryGate/Automations **6 files 48 passed**; Web share/preview/OAuth + Windows identity **4 files 29 passed**; targeted lint 0/0. E2E files updated but not yet run. Remaining high risk: G10's purchase panel vs. Provider responsive state, E2E mock/launch config; Host providerRegistry old tests to be compared case by case — not dropped wholesale.

## 33. G10: Purchase Entry / Responsive Settings and Claim Test Intersections (UI batch rewired, overall acceptance incomplete)

Part of the conflict closeout; `coding-plan-upgrade-entry-decoupling.md`'s integration contract written first.

- `32f6cb43eb`/`b5e8874696`: native purchase panel retirement kept — CodingPlanPurchasePanel, its pricingCards.tsx namesake, purchaseTelemetry, and three native payment tests deleted (dep:refs + text search: zero references); the in-use new pricingCards.ts and enterpriseTiers helpers kept. Native PlanSelect/payment telemetry/private card-detail cases retired with the implementation; the Start upgrade helper's new file referenced a deleted Coding Plan ID → changed to a concrete same-domain Individual Provider.
- `5865499161`/`85533a0c8c`/`8f08e49127`: responsive Header, Start-count quick entries, tooltip/aria kept; counts from the current Account entitlement input (owned ≠ selected/current). Template creation, dynamic model editing/sorting, Settings View, manual connection switching kept. The current useModelProviders already wraps ProviderSettingsService — not deleted for sharing a name.
- `cc32e0ca98`/`3feb9299ef`: Start entry telemetry classification and the syncing-Subscribe disable/feedback kept; the native panel's visibility/token/funnel props removed; the Team status card audience kept (must not silently become personal); the existing team banner's Team key kept.
- `dd73d8259f` + claim polling: empty-activity, hidden recovery, concurrent dedup, failure retention, post-claim polling, late-preview-no-overwrite, claim/balance time isolation wired to the current ProviderSettings refresh — no old refreshCodingPlanApiKey; one late-entitlement fixture updated to the approved claim entitlement.effectiveAt contract; cross-claim-request isolation kept.
- The old primary-action helper's tests not restored: the formal entry is fixed to "Model settings" with DOM tests covering pending-effective/effective not auto-switching; no executable "start experience" path introduced for a test-only switch.

Verification: 18:54 **8 files 278 passed** (pricing, enterprise tiers/products, funnel, modelProviderCodingPlan, upgrade intent, embedded WebView, manualClaim); incremental lint **12 files 0/0**. Index unresolved **33 → 18**. Group ruled/implemented with group-internal passes; full build, E2E launch/fixtures, Pro interaction, and the candidate's bidirectional acceptance continued — not declared complete.

## 34. Documentation / E2E Conflict Batch Closeout and Current Interface Alignment

- Six conflicted docs: keep the current plugin-only-official-source auto refresh/throttle, cold-state override, and remote Provisioning Environment verification boundaries; merge the source's CDN fixture, SSH reconnection, share/menu/security-validation case catalogs. Historical verification and the earlier Pro BG45 checkpoint do not represent full-candidate acceptance. The claim doc keeps polling, claim/balance timing, and failure acceptance, excluding the ruled auto-experience/auto-switch; the seed became a structured connection selection.
- WDIO: merge the source's inventory hold/fail, security-validation fixture/dedicated timeout, Wiki plan mocks; keep the current Personal/Model Selection files and structured account selection — no old 400-line Registry seed or family selected keys; the duplicate shared metadata-save helper deleted; ordinary scenarios do not inherit the security-validation timeout.
- E2E intersections: Background keeps Full Access draft init and the ruled subagent failure usage; Subagent keeps the structured built-in override/cold-start and original-field Markdown contract (rejecting the old dual-field runtime fallback); claim keeps the manual CTA plus the source Hero's real 4:3 geometry.
- WebView E2E keeps inventory loading/error/ready, app-reporting matching the WebView context, reload not double-reporting. The old `readModelProvider(Account).apiKey` read only Personal and could not prove an account key refresh — changed to asserting a new Key-copy request with no leak into Personal; no encrypted credentials read or printed.
- First E2E tsc found auto-merged responsive/Wiki tests still reading old fields: the responsive navigation key moved to `team:family:product:org:project`; persistence assertions use structured connections; the Wiki's Individual ID, Registry group, modelSelection on disk, and configuredDefault seed aligned, keeping the same-domain Start-has-entitlement-but-does-not-replace-current-plan intent. Todo101 multi-connection not implemented.
- A missing-three-OffPeak-IDs error was stale TS project-reference artifacts (the source exports them) — resolved by the full typecheck rebuild, no duplicate declarations.

Verification: mock-env / config seed / startup credentials / replay contract / lifecycle **5 files 30 passed**. Docs 18→12, then E2E and service-test closeout took the index **12→0**; no conflict markers remained. "Zero conflicts therefore deliverable" was not inferred.

## 35. Auto-Merge Old-Interface Gaps, Security-Validation Test Disposition, First Full Check

- providerRegistry.test's two large conflict segments were mostly both-sides-ancestor tests already deleted in the current branch; the real increments were the security validation's private response and the no-runtime/registry-rewrite rule. Kept the current Account mirror/Selection readiness/read-only workspace tests; parameterized the source's invariant over local/SSH/WSL/Docker and different models — no deprecated cache fallback, auto model fallback, or old thoughtLevel push. The parameterization proves path isolation and the response contract only.
- Full tsc caught the App UI and Agent sharing one success-response type (protocol success is requestAuth; the UI had only runtimeProviderHeaders). The spec defined two trust boundaries; Services got an independent UI input type; the Host's security-validation header whitelist and account-service assembly kept; the Agent protocol still rejects bare headers; the Renderer gains no credential-construction power.
- G10's new entry-statistics hook still called the old no-argument useModelProviders and identified plans by apiKey/old Coding Plan ID — rewired per the root Settings read-only View + Inspection Access + entitlement hook (fixtures first, 5 RED): no current/enabled/executable requirement, no new query cache; Team keeps authenticated pricing; new first-failure/manual-retry tests added; old async cancellation and generation guards kept.
- 19:14 Services **4 files 24 passed**; 19:16 G10 **4 files 15 passed**; UI fixtures no longer fabricate the old apiKey.
- First full `pnpm typecheck` failures were attributed to these merge gaps (not widened); one later miss (optional errorMessage on the success response) restored the originally legal type. First `pnpm lint` **0 errors / 44 warnings**; this round's redundant WDIO spread cleaned, the rest awaited source classification.

This batch closed explicit conflicts and discovered auto-intersection interfaces only. The real merge still awaited key verification; the full candidate's bidirectional review, CLI rebuild and cross-group tests, and Pro acceptance continued — no merge-back, no push.

## 36. Full Candidate Shared Verification and Failure Classification (in progress)

- 19:18 full `pnpm typecheck` passed; 19:27 changed architecture gate **0 violations**.
- Root full unit run: **1631 files / 14267 passed, 2 files / 2 cases failed, 26 skipped** (log `/tmp/todo103-candidate-unit-20260909-1919.log`). Both failures were old-interface tests (share composition init missing options; Wiki lane re-introducing the old whole-Registry push) — adjusted per the current complete Account delivery semantics, keeping SSH/WSL coverage; targeted **2 files 8 passed**. The 14k suite was not re-run for test-only changes; the first result was not rewritten green.
- CLI: nested `build` lacked the turbo bin (environment) — workspace recursive build built contracts/shared-types/adapters/core/i18n/telemetry/bootstrap (**7 packages**). Wide suite: **395 files / 5265 passed, 21 files / 87 failed, 45 skipped, 2 todo** (log `/tmp/todo103-candidate-cli-unit-20260909-1926.log`); failures to be classified per cause — neither all 87 widened into fixes nor unverifiably called pre-existing.
- Confirmed: the share-title test asserted the source-retired `sharedContextImportTitle` (both source and candidate return `sharedContextImport.title`); the off-peak test allowed no denylist at all, conflicting with D49's new OffPeakCreate restriction — assertions adjusted, keeping the follow-up ordinary-turn unpolluted check. The Host's CronCreate disable vs. V4's OffPeakCreate are two entries' responsibilities; automation write-tools are not mixed into off-peak rules.
- The auto-merged security-validation E2E fixture still wrote old config/cli-config and family mode — changed to an isolated Built-in API override, structured connection, independent Model Selection seed (dynamic members still from balance); JWT admission gained the security-validation/Wiki controlled profiles. **3 RED** first, then fixture/startup **2 files 16 passed**; pending fixture-check passed — not promoted to formal E2E.
- The Pro isolated copy `/Users/dev/zcode-todo99-e2e.1L03PN` was synced with the full candidate (old logs/artifacts kept; daily project and real user data untouched). The newly pinned CUA HTTPS clone failed on inaccessible keychain credentials; the machine's pnpm content-addressed cache for the same locked SHA `908b247399423195d0cb0039e1755a333c4c1ff` (860 entries, ~9.8 MB) was reused — pins, credentials, and keychain policy unchanged; Pro frozen/ignore-scripts install passed in 1.8s; full-candidate desktop and Agent builds passed; the two CLI assertion adjustments **2 files 67 passed**.
- Pro first round `desktop-e2e-20260909193459481-p44025-5975c43ad85e6cc3`: claim passed; purchase matched English only while the app correctly showed Chinese "正在查询套餐…"; responsive demanded 1000px height vs. an 876px work area; Wiki focus did not mount the action row. Fixed as bilingual assertions, 1800/480 width breakpoints with an 800px height, and a real hover — no product logic, timeout, or core assertion loosened; the three specs re-ran.

## 37. G02/G15/G16/G18 Independent Source Batch Retention and Intersection Review

Method: pinned-source vs. candidate content comparison + source intent + both-sides diff; no re-created source commits.

| Group | Path disposition                                                                                                       | Intersection review                                                                                                                                                                                                                                                                                                                                                                    | Verification                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| G02   | 53 of 66 paths identical to pinned source; 2 moved test paths not resurrected; rest current docs/assembly/graph/skills | Help private/public fetcher separation, 3.12.0, Provider typecheck kept; the MR skill does not authorize push/MR creation; Obsidian/skill docs kept without acting on external repos                                                                                                                                                                                                   | Help batch evidence stands; gate tests 8/8, final gate re-run pending               |
| G15   | 26 of 28 identical; Main and WDIO shared intersections                                                                 | Main keeps owner BrowserWindow injection, transparent screenshot presentation, workspace/session owner isolation; recovery/cached URL/CDP idle/viewport/zoom/DPI/temporary UnknownVizError kept; no old Registry seed in WDIO                                                                                                                                                          | Root unit suite covers the group, no failures; Pro screenshot/recovery runs pending |
| G16   | 68 of 79 identical; 3 retired files confirmed deleted; 8 shared intersections                                          | Composer keeps source + menu/plugin entries, unified attachment copy, mention editor; current in-memory draft, frozen Submission, per-ID attachment cleanup kept — no localStorage drafts, no clearing new input on a late ACK; share context from snapshot, URLs not stuffed into prompts; local HTML preview/localhost/file-link decoding/smart quotes per current platform protocol | Related root tests pass; final cross-group desktop regression pending               |
| G18   | 78 of 95 identical; 5 retired files deleted; 12 shared intersections                                                   | Settings keeps the source's 68/268 navigation width, 4px desktop inset, unified window controls/question entry, per-platform radii + the current ProviderSettingsView/remote attachment; Automation/claim merge layout only; Model Editor smart config/Map layout/keyboard isolation stay current                                                                                      | Root UI tests pass; Pro layout/editor joint acceptance pending                      |

G02 found the new policy did not register the refactored provider/provider-node: spec + repo policy test added, RED `missing module: provider`, then **8/8** after registering the two source roots; the source's `managed:false` kept — no baseline refresh, no repo-wide migration. With `managedOnly:true` and all modules unmanaged, zero violations prove little; recorded, manual review stands. Source-identical path counts are not verification progress.

## 38. Pro Account/Wiki Intersection Passes and CLI Failure Classification Corrections

- Pro's second responsive CTP-12 passed (1800/480 breakpoints, tooltip, real connection save). Inventory kept failing empty: the fixture returned empty org/project before payment and the WebView profile's JWT was filtered — the Account could not get an initial connection (not copy). Two tests added (RED first), mock control-front precondition fixed: **2 files 24 passed**; JWT stays only in the controlled WebView scenario.
- The Wiki default seed lacked reasoningLevel, so it could not become the configured default and another model was recommended — a complete GLM-5.2/max seed added; no product fallback/validation change.
- Pro's third purchase/Wiki run **2 specs passed** (log `/tmp/todo103-candidate-pro-account-rerun2.log`): full inventory, same funnel, post-purchase refresh/no Personal key leak, Wiki default plan/candidate isolation/generation/new-field persistence. With round 1's Start claim and round 2's responsive, four groups completed current-candidate verification — not "four green in one run". The security-validation pending run started separately (explicit common+case replay, not promoted).
- CLI: part of the wide-run failures were execution cwd — core Browser doc tests resolve resources by package cwd. Re-run per package cwd: browser-client/browser-manifest **50 passed**; runtime-unbound-resume still 1/1 (error-wrap assertion needs separate attribution — not a browser regression).
- G03's CUA gray removal added `plugin:computer-use:computer-use` to the default MCP connections; four old cases outdated — complete-list assertion kept plus the official server; the user-defined `zcode-cua` no-broker-credentials assertion and disabled path unchanged; **18/18 passed**.
- Retained CLI failures: old runner-options/config/PDF tests on retired interfaces; 7 auth/telemetry schemaVersion=2 fixtures; marketplace nested self-copy; plugin packaged sharp fixture; two unbound expectations; known-Todo102 remote Cron/V4 ACK — all with checkpoint evidence, not auto-widened. The earlier **87 failed is not this round's net-new count** and was not overwritten green.
- Latest full `pnpm typecheck` passed; `pnpm lint` **0 errors / 43 warnings**. Final bidirectional review/cross-platform acceptance incomplete — no merge-back, no push.

## 39. Full Candidate Platform Verification: Security Validation, Browser, Settings Editor

- Pro security-validation E2E `desktop-e2e-20260909194622186-p46656-08ed4ad96f7ee423` **1 spec passed** (four retry/cancel/timeout scenarios), exitCode=0; kept pending. No real API requests or allowlist changes.
- `@zcode/web-share build` and `@zcode/web build` passed (chunk-size/plugin-timing warnings only) — not a deployed package or verified public sharing.
- Pro hidden-guest screenshot smoke passed (2×2 → 640×300, no focus steal, still hidden). The surface smoke's exact-RGBA assertion failed first (255,0,0 vs 234,51,35) and passed with `--force-color-profile=srgb` (1280×720, four distinct corners, no tiling) — product color config unchanged.
- The background-activity smoke still read `visibility=visible / frames=96 / timers=80` after `win.hide()`; the script is byte-identical to the pinned source and calls Electron directly — a source-script failure on the current Pro/Electron, recorded as-is (no deadline change, no lifecycle refactor). Mac results do not replace Windows.
- Pro UI-polish: 8/1/1 — the Windows-only `UP-00` returns early on Mac (not Windows-tested); 7 executed and passed. MP-UI-06's first failure was a test sampling race (fixed by waiting for the control's animation); its re-run found the old assertion requiring the user Map's original text without spaces — contradicting the implemented Todo98 contract — so the assertion moved to the input text and the extra canonical constant was deleted. Final `desktop-e2e-20260909-195812-279` **passed** (zh/en, light/dark, 390px, hover/focus, smart config, personal Map save, visual badges); no product code/style changed.
- OffPeakCreate cold recovery: first run masked by `ffmpeg ENOENT`; the Darwin arm64 encoder installed isolated (`/Users/dev/zcode-todo103-tools.MLS5xf`, explicit `ZCODE_E2E_FFMPEG_PATH`). The real failure was no OffPeakCreate in requests (all Account/Off-Peak entitled=false — the fixture had only the ticket gateway); four cases added (RED first) reusing the Coding Plan mock: **2 files 13 passed**; the live run was in progress.

## 40. G14 Bounded Retention and Process Diagnostics Intersection Review

- The retention policy/store, process sampler, v4 gateway, resident pool, and per-end diagnostics bodies merged normally; the 17 paths differing from pinned source concentrate in shared assembly/barrels, protocol/Session types, and existing tests — not a reimplementation.
- server-operations keeps eventStore injection/create-failure cleanup; the entrypoint runs rebalance, prune stores, prune detached publishers, and gated sampling logs in one 60s callback, stopping on close. The current process Registry/Selection owners and async init remain — no RuntimeModel/DeferredAdapter.
- The gateway child keeps explicit parent attribution, terminal-state grace, and no-release while subscriptions or standalone records exist; release calls the existing cleanup with `clearCommandInbox:false`, `notifyIndexRemoved:false` — memory cleanup is never task deletion; live ingest/topic and cold-recovery boundaries unchanged.
- Host/Main/Bot/Task-adapter read-only counter registrations pair with disposes; the UI App useEffect creates one per-window sampling owner with cleanup stop — no new business cache. Retention removes only the four defined transient event classes; the monotonic seq/live sink, persisted history, and existing recovery mechanisms keep their own responsibilities.
- Evidence reuses the full root/CLI suites (this group absent from failure lists); §29's three retention cases passed after the rebuild; the shared tests' child-call parameters were adjusted to the source's parent parameters — parent information not removed. Old static-audit memory issues were not widened into fixes.

## 41. G11/G12 Reverse Intersection Review and G07 Dispatch Evidence

- G11: 167 of 231 paths identical to pinned source; the 64 differing are protocol/Session/Store/assembly/UI intersections reviewed with §29/31 — path identity does not replace call-chain checking. All three send paths keep context_refs and the frozen Submission; history/store keeps the share attachment with current providerId/modelId metadata; the import restores no modelProviderService, selection fields, or pre-send sync; the share service's publish/sanitize/integrity/atomic-import bodies merge per source.
- The public share E2E calls the real publish API; this round published no user content and gained no external write permissions — completed: isolated service tests, three send entries, build verification; whether extra controlled HTTP end-to-end evidence is needed stayed in the final-gate review.
- G12: permission options, broker, flow, PermissionDialog/V4InteractionDialogs, and the pending adapter match pinned source; the shared projection keeps the new mirror-routing/scheduled-tool attribution fields with the current structured modelSelection and continuous/replayable boundaries; side-chat/fork reminders stay history attachments/system reminders (no ModelRef or old selection fields). Pro `desktop-e2e-20260909201222791-p52186-4667f2beb6768e88` **5/5 passed** (Allow, Allow ignoring feedback, fourth-row Enter/button denial, blank denial; provider-visible tool_result and no-file-write assertions hold).
- G07 OP10's first run passed the scheduler/four foreground subtasks, same Ticket/model, background prohibition; the next ordinary round hit account recommendation because the default seed lacked reasoning (DeepSeek captured empty) — a case-local complete configuredDefault added, no product change. Pro `desktop-e2e-20260909201131066-p51724-fc89c2f309bf19b8` **OP10 passed** (next ordinary round goes DeepSeek, not the off-peak gateway; the hidden off-peak list has only the mock GLM-5.2).
- Cold-recovery OP-CHAT-02 had passed create/card/edit but without bound dispatch; the same case was extended to observe actual scheduler completion, same-Session attribution, and unchanged persisted model_selection, reusing the capture gateway — in progress, not yet recorded as passed.

Windows installer execution, real SSH settings toggling, and the overall final gates remained incomplete — no merge-back, no push; existing failures keep their §36/38/39 classifications.

## 42. Real Merge Candidate Closeout Checks (not merge-back acceptance)

- Pro `desktop-e2e-20260909201818194-p53379-3d3ab94fcf83e6b7` **OP-CHAT-02 passed**: ordinary first round persisted → Electron/Host cold restart → off-peak task on the old Session → card/edit → scheduler dispatch completes; conversationId/sessionId keep the binding, persisted `runtime/model_selection` equals pre-creation, the gateway request uses the task's off-peak model and Ticket. The earlier capture scenario failed by forwarding upstream — switched to the script's fixed-text responses; product execution logic unchanged, the failure record not overwritten.
- G07 now has both branches evidenced (OP10 form-created + follow-up round; OP-CHAT-02 bound dispatch); the two are not double-counted as full off-peak product acceptance.
- Latest repo-wide `pnpm typecheck` passed; `pnpm lint` **43 warnings / 0 errors**; only tests/records changed — the 14k root tests were not repeated. A mechanical scan of the candidate's production additions vs fixed recovery found no references to modelProviderService, turnRuntimeModel, applyTurnRuntimeModel, selectedModel, generationModel, RuntimeModel, setProviderRuntimeHeaders, or the old updateModelProviderConfig/registrySync — a mechanical supplement, not a replacement for per-group review.
- The CLI native-boundary's three import warnings (session-flow → model-execution, goal-compact/prompt-turn → session-residency) already exist in the checkpoint; related old tests were not opportunistically restructured. §38's recorded failures stand.
- The source JSON carries independent decisionStatus/implementationStatus/verificationStatus plus group evidence for all 193 non-merge sources; all verification stays partial. The old status/evidence stays as history; progress is not expressed by re-creation commit counts.
- Per the user-approved early-merge strategy the candidate may be saved as a two-parent merge commit with review continuing on that branch. **Committing the candidate is not permission to merge back to recovery**: G01 Windows execution, G17 real SSH settings toggling, and the final bidirectional/cross-group review remain this round's gates — not diverted to 102, no push, no release.

## 43. Two-Parent Merge Committed and File-Disposition Final Review

The full candidate was committed as `e1c611be98cd421efc725e80eb43b923994ee3a2`, parents `c4f8619d96` and pinned staging `790884b1ce`; the tree was clean after; recovery stayed at `f0174b57f5`, unpublished, unpushed. Final acceptance continued on the integration branch; no independent sources re-created.

- Mechanical comparison of the 950 source/conflict paths: **647** same blob as pinned staging or both deleted; **298** combined modifications; **5** retained from recovery (3 continuing deletions of old implementations). No path is "staging-only modified, yet the candidate reverted to recovery without basis". Identical hashes do not prove implicit-dependency safety — intersection semantics still follow the per-group reviews.
- The 5 recovery-retained paths reviewed individually: workspace-model-catalog stays deleted (security-validation behavior moved to the current request-auth port, §26/31); modelProviderServiceStorage/modelProviderEnablement tests stay deleted (same-endpoint Start/Individual isolation covered by the current provider resolver tests); modelSelectionGroups keeps the Selection-View-only implementation; repoWikiPaneState keeps the new tests — no familySelectedKeys/entitlement self-built grouping. Wiki ordinary-plan vs. coexisting Start isolation is covered by §38's Pro cases.
- The staging-internal 60-merge audit (§8) remains valid; merge commits were not ignored wholesale.
- This batch's E2E typecheck passed; the OffPeak fixture check passed (the edited title is not a network matcher — that warning kept); fixture control-plane/replay contract **2 files 13 passed**; the pre-commit full index diff check passed (only a trailing blank line trimmed from a source skill doc — instructions unchanged, no MR executed).

No final completion declaration: combined-file intersection final review, key platform gates, and the cross-group closeout continued; old independent test failures neither hidden nor widened.

## 44. File-Level Disposition Closeout and Remaining Failure Classification

Audit object fixed to the real merge `e1c611be98`, not the later-moving remote staging; recovery unmoved. All 950 paths carry independent ruling/implementation/verification fields; all 193 non-merge commits have source-file references; no orphan sources. The 647/298/5 counts match §43. **File fingerprints prove disposition only, never implicit-dependency safety; verification stays uniformly partial — the bulk merge is not rewritten into full acceptance.**

Auto-merged shared boundaries re-checked: RemoteServiceAccessor's conversationShare proxy pairs with its descriptor/interface; remote-workspace share reads use remote data with only auth reusing local OAuth; FileStat.mtime pairs with the concurrent-read check; the new share/import external-file channel pairs with per-end registration; the CUA gray removal left no old assembly; the canonical user intent keeps the frozen modelSelection/mode while adding context_refs; the OffPeak port is passed explicitly from runtime/executor/tool dependencies, never auto-enabled for ordinary subtasks, with the executing offPeakTurn separate from the ordinary persisted selection. No additional production changes were needed.

CLI wide-run failures keep their per-source classification — the total is not the merge-regression count:

- The MCP OAuth cross-process case passes in the adapters package cwd; the Bash background-descendant termination case still fails (1/1, 126 skipped) — implementation unchanged vs. checkpoint; process termination not widened. Log `/tmp/todo103-cli-io-failure-classification.log`.
- Two MCP PATH expectations differ from the current Node tool-path injection; the marketplace local-import test self-copies (destination inside the source subdirectory); the plugin packaged fixture depends on the old sharp location — implementations unchanged by this merge (§15/38 records stand).
- Retired runner-options/config/PDF interfaces, auth/telemetry schemaVersion fixtures, unbound config-default/error-wrap expectations, and the three native-boundary imports all have checkpoint evidence; the known V4 ACK / remote Cron items remain known debt — no repo-wide refactor.
- The core Browser cwd 50 cases passed; the CUA default MCP list's four outdated assertions were corrected per the retained behavior (18/18). "Old test" is not a blanket excuse to skip new interface contracts.

The full candidate additionally ran the plugin explicit-Subagent and Composer draft first-send cross-group replays. The old queue-model-switch case was deliberately not chosen to change frozen semantics (it demands a later model choice affect an already-queued message — it cannot roll back the frozen-Submission contract). Two run-setup mistakes executed no behavior assertions; corrected, then run, results listed separately.

G01's real Windows installer execution and G17's isolated real SSH settings toggle still need environments; the user was asked for an isolated test machine/connection config — no plaintext passwords, no real user data. Key gates were not diverted to 102 nor merged back early.

## 45. Full Candidate Bidirectional Code Review and Cross-Group Regression Closeout

Pro `desktop-e2e-20260909-203731-261` **2 specs / 2 cases passed** (log `/tmp/todo103-pro-cross-selection-rerun2.log`): the plugin cold-start case captures the child's alternate/high and the parent continuation's original model/max (override config not rewritten); Composer I10/I47/I52 capture the first-send model/tier — a post-admission draft re-selection does not overwrite the Session, and a full cold start still restores the draft. Not the old "queued-then-reselected affects the queue" semantics; pending cases not auto-promoted.

The candidate's two review rounds:

| Direction                                         | Coverage and conclusion                                                                                                                                                                                          | Key evidence                                |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| staging → result                                  | 193 non-merge + 60 merge sources, 950 paths all dispositioned; independent changes retained, intersections rewired per function; no unexplained one-sided drops                                                  | §8, per-group tables, §43–44 / inventory    |
| Refactor → result: Provider / Account / Selection | Concrete Provider identity, settings write ownership, complete Account snapshots, execution-selection vs. persisted-intent distinction retained; no old family/Registry bypass or pre-send sync                  | §25–35, §38, §42–44; live runs              |
| Refactor → result: Session / share / off-peak     | Share context attaches to the frozen submission; the off-peak Ticket and this execution stay isolated without changing the bound Session's ordinary selection; implicit/explicit subagents keep their boundaries | §31–32, §40–42, §45's regressions           |
| Refactor → result: remote / protocol / lifecycle  | Remote identity/session scope did not regress to path-only; continuous/replayable and owner-routing boundaries retained; transient memory reclamation is not task deletion; new fields pair with their assembly  | §22, §29–31, §40, §44; G17 real SSH pending |
| Build and verification                            | Full-candidate typecheck/lint, CLI/Web builds, batch tests evidenced; wide-run failures classified, not claimed green; Mac does not replace Windows                                                              | §36–44                                      |

The final round changed only audit records — no product source, no repeat builds/suites. File-audit field check 950/950 complete; disposition counts match the fixed candidate. **Code-review closeout is not Goal completion**: G01's real Windows install/uninstall smoke and G17's isolated SSH in-run settings toggle were the remaining key platform gates — not diverted, no merge-back, no push.

## 46. Remaining Platform Gates: Environment Recheck and Resumption Entry

Read-only recheck after `f1589ef797`: workspace clean, freshness passed; Linux found no wine, `qemu-system-x86_64`, docker, or virsh; the Pro SSH management connection is reachable (Darwin); the non-interactive PATH has no docker/prlctl/VBoxManage/qemu and no `ZCODE_E2E_SSH_*` is injected. This describes the available environment only — not a claim the machine lacks VM software absolutely.

G01: the two existing scripts check win32 and create/clean temp fixtures. Once an isolated Windows environment is provided, install dependencies on the full candidate and run:

```text
pnpm --filter @zcode/desktop test:installer-nsh-smoke
node packages/desktop/scripts/test-installer-preserve-files.mjs
```

Keep the actual installer/uninstaller logs and script exit results; a Linux skip does not clear the gate. Do not self-provision cloud Windows, create system users, or alter real installs to keep automation running.

G17: `readSSHRuntimeConfig` / `toSSHConnectOptions` explicitly use password and will not read the management alias's private key — a reachable management connection is not the case's precondition. Requirements: safe injection of ZCODE_E2E_SSH_HOST / USERNAME / PASSWORD / PORT into the test process; two explicitly different isolated WORKSPACE_PATHS (not the default `/root,/home`); a target account allowing reverse forwarding whose server/Agent data this test may write (an empty work directory alone does not isolate the same account's default data directories). Then run the pending `conversation-session-ssh-remote-settings-overlay-sidebar-status.test.ts` on Pro with common + the case-local replay — running only mocks does not clear the real-SSH gate.

The environment was requested; no passwords recorded, no colleague credentials reused, no product auth widened or tooling reworked to bypass the missing environment. No acceptance processes were running to wait for. Resuming these two items needs the user's isolated environment or new explicit authorization; until then the candidate is retained — no merge-back, no push.

## 47. 2026-09-10 Independent Re-Review: Both Sides' Expectations and the Provider Core

### Premises and scope

HEAD `d82b547348` is a docs commit after the real merge `e1c611be98`; the integration branch clean, recovery unmoved. This round re-reviewed and re-tested without presuming the platform gates passed. The Goal tool kept the original blocked objective (a new review objective was rejected as unfinished-goal; the old one was not falsely completed or deleted). The architecture-governance skill provided the Provider design/module context; all sources were re-accounted; the E2E skill's Pro isolated copy with explicit replays was used. No product code, tests, or fixtures changed; no pending promotion, push, or real user data touched.

### Independent verification results

1. **Source retention.** The 950 paths recount to 647/298/5 with zero inventory mismatches; the five continued dispositions reference §43. Fixed recovery → candidate shows no changes in `packages/provider/src`, `packages/provider-node/src`, `config/provider/zcode-builtin.json` — the core config implementation was not overwritten.
2. **Config/settings.** Settings and selection take model/account facts from the applied snapshot; a config/Account Built-in revision mismatch keeps the old complete snapshot and never publishes spliced state. Dynamic member writes/first Personal root, sparse overrides, revision conflicts, model integrity, ordering (core/config/facade tests); Host routing and read-parameter isolation (service tests).
3. **Worker/execution.** Account-delivery tests verify received vs. applied through the real server.handleMessage; an ordinary entitled account without current is refused; Off-Peak is not forced into ordinary-account conditions. Model Registry/App binding, explicit subagents, legacy identity loading, request endpoint/headers, security-validation cancellation, ordinary message execution each verified. The security-validation port is entered only via a complete Account Access request; ordinary APIs do not trigger it; random requestIds/cancellation handle only request interaction.
4. **New features vs. existing selection.** Bot deletion detection honors only the target workspace's tombstone; after rebuild it resolves through the public View and V4 first-send. Share context_refs only appends beside the frozen submission. The Off-Peak port/dispatch passes a single modelExecution; bound tasks do not write the ordinary Session selection; queued/rejected/completed restore turn attribution without a second accepted queue. No new merge regressions found.

```text
Built-in + Account + Personal -> one complete Registry snapshot
                                      |
          original selection/draft -> effective resolution -> frozen submission -> target Model
                                      |
        share context / off-peak execution constraints ride only this submission
        no write-back to original intent, no changes to already-created Models
```

Mechanical scan of the candidate's production additions vs fixed recovery: modelProviderService, turnRuntimeModel, applyTurnRuntimeModel, setProviderRuntimeHeaders, ModelConnectionPort, AiSdkModelRegistry, familySelectedKeys — 0 hits (an aid only; hit counts do not prove abstraction correctness).

### This round's test evidence

| Scope                                                                                     | Result                                             | Log                                           |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------- |
| provider / provider-node full unit tests                                                  | 24 files / 328 passed                              | `/tmp/todo103-second-review-provider.log`     |
| Host config/account/selection/subtask/Wiki/off-peak focus                                 | 14 files / 108 passed                              | `/tmp/todo103-second-review-services.log`     |
| Worker delivery, Registry, routing, subtask, off-peak, selection changes                  | 14 files / 100 passed (bootstrap package cwd)      | `/tmp/todo103-second-review-worker.log`       |
| Bot deletion/messages/config, share import/composition, Host off-peak dispatch/settlement | 10 files / 187 passed                              | `/tmp/todo103-second-review-cross-entry.log`  |
| Root typecheck (incl. E2E tsconfig)                                                       | passed (incremental)                               | `/tmp/todo103-second-review-typecheck.log`    |
| Root lint                                                                                 | 43 pre-existing warnings / 0 errors                | `/tmp/todo103-second-review-lint.log`         |
| architecture:check --changed                                                              | 0 violations (limited scope — not repo-wide proof) | `/tmp/todo103-second-review-architecture.log` |

**62 files / 723 unit tests passed** in total — not stacked with the previous round's identical tests. All architecture-policy modules are managed=false with global.managedOnly=true and no public contracts, so the green gate proves little; the core conclusions rest on the manual diff review and behavior tests. No governance expansion or baseline refresh for green.

### Pro new real-request evidence and an outdated case

Pro copy WDIO/effective-model-selection/server-operations SHAs verified against the local candidate before running (the previously synced/built copy reused — no other branch's package treated as the candidate). I13 `conversation-session-same-model-provider-identity.test.ts`:

- Default run `desktop-e2e-20260910-011336-440` **failed**: the Provider currentValue and target-model request assertions passed, but the old test expected high while the actual was max. The test prepares the old model as high then actively selects the alternate; Todo88 R11 / the public completeNewModelSelection take the target's highest tier. The test has zero diff in this merge (last touched by `e24db74d05`) — a stale expectation, not a merge regression (log `/tmp/todo103-second-review-pro-provider.log`).
- With `E2E_PROVIDER_THOUGHT_LEVEL=max`, `desktop-e2e-20260910-011540-519` **1/1 passed** (cross-Provider currentValue, target model/max, reply content, return-to-idle). No assertion/fixture modified; the parameterized pass does not cover the default run's failure and does not alone prove the high → max active re-selection — the previous round's capture and existing core tests provide that evidence.
- Despite the filename, the case is really a cross-Provider primary/alternate (flash/pro) selection, not a full same-name-model cross-endpoint comparison — doc I13 uses the accurate description.

### Conclusions and retained items

Within this round's scope, no new merge regressions, Provider core abstraction regressions, or newly needed product rulings were found — this does not prove both sides' existing features are absolutely bug-free. The I13 default-tier assertion stays on the books as an existing-test issue. Earlier root/CLI wide-run failures keep their §36–44 classifications.

**G01's real Windows installer and G17's isolated real SSH settings toggle remained unverified** — not diverted to 102, no merge-back to recovery. Todo101 / independent CLI / a redone sync system remain unimplemented. The few open items the user allowed to stay open are recorded as-is; this review does not replace the original Goal's final completion conditions.
