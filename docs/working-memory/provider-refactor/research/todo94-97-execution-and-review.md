# Todo 94–97 Execution And Review Records

> Latest ownership (2026-09-09): 95C completed (`2c1addd3d8`); 96 explicit Subagents already completed by Todo99; 97 Wiki one-shot migrations completed (`9cd1ae31dd`); subsequent 98 layout and keyboard fixes also completed (`a5fb82ec4a`). Above development entries all closed, remaining verifications only advancing in [Todo102](../steps/todo-102-verification-debt-closeout.md). Below retaining historical records by time, "three decisions pending", "pending implementations", "targets uncompleted" etc. no longer representing current states.

## Scopes And Execution Constraints

- Target startups: 2026-09-08; baselines `00c5fa2e66`, branches `provider-refactor-e2e-recovery`, startup freshness checks passed.
- Sequences: 94 → 95 → 96 → 97. Each first testing, implementing, verifying, then reviewing item-by-item requirements and Provider / Selection abstractions.
- Small-blocker accounting continuing independent work; involving new product semantics or protocol boundaries needing explicit decisions, not independently expanding.
- Final pushing current branches, reviewing recent two days' Todos / commits, then pushing runable E2Es in Pro.
- Excluding Web releases, restored novels, un-authorized old drafts. Existing un-submitted source codes, tests, document modifications retained, not mixed into this round's deliverables as submissions.

## First-Round Progress And Evidence (Historical Snapshots, Current Conclusions See Page Headers)

| Items                                                             | Statuses                                                                               | Processing And Evidence                                                                                                                                  | Pending Verifications / Decisions                                                                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 94 Wiki unified output Limits                                     | Implementations And Reviews Completed                                                  | Wiki-related 15 files / 160 unit tests passed; Pro two formal Electron E2Es passed; deleting private budget full chains                                  | Mobile real attachments / Windows not re-real-tested, cannot substitute Pro passes                                                                                    |
| 95 reasoning maps                                                 | A/B implementations And Reviews Completed                                              | 340 Provider/Option Map unit tests passed; Pro new tier real requests, whitelists, and smart configurations regressions passed                           | C closing tier renames affecting plans only covering Maps' Personal configs, already separately requesting decisions, unimplemented, not counting as full completions |
| 96 Offline Selection migrations                                   | Core implementations And Reviews Passed, Protocol items pending decisions              | Root workspaces 438 items, Agents 73 items unit tests; Pro two real-interaction E2Es passed                                                              | Explicit Subagents' Host resolution protocols pending decisions, not writing core completions as whole-item completions                                               |
| 97 Subagent old field migrations And full-domain old field audits | Core implementations, expanded regressions passed, full-domain items pending decisions | User directories in-place migrations, sharing formal codecs, built-ins JSON one-way imports; Pro 4 items passed; see todo97-selection-storage-audit.md   | Wiki reading-not-writing-disk and full-domain one-shot migration principles conflicting, pending decisions; mobiles/real SSIs unverified                              |
| Final audits And pushing                                          | Partially verified pushed; targets uncompleted                                         | todo88-97-final-quality-review.md recording discoveries, fixes, and uncovered scopes by submission/contracts; a0f686fc38 already pushed current branches | Three decisions still unanswered, targets not marked completed                                                                                                        |

## Todo 94 Design Closures

```text
Wiki selections / generation-settings (no output budgets)
    -> Target Workspace's generateText
    -> Wiki parsed target Model maxOutputTokens Limits (passing values as-is)
    -> Option Maps -> real API requests
```

- Catalogs, Pages, tool loops, and compressions final sharing this chains, not calculating budgets themselves. Tracing to ModelFactorys confirming they intentionally not binding output values, therefore retaining ModelClients reading Limits from target Views and explicitly passing existing interfaces; not changing Factory, not adding default value resolvers.
- Cuts still failing, plain maxRetries and deadlines retained; deleting extra rescue counts.
- Old generationOptions.maxOutputTokens readings ignored, normal writings not carrying, not batch-rewriting histories.
- Overlapping tests' existing differences are supportsJsonSchemaOutput renames; this round not rolling back, not falsely claiming these changes.
- Already discovered and corrected Wiki tests' outdated `BUILTIN_MODEL_PROVIDER_IDS.zai`: runtime values undefined, possibly forming fake passes; changed to named-test Providers.
- First-round ModelClient red-lights fixing directories 16384 / bodies 8192 old budgets; new assertions requiring two paths using test models' 32000 Limits as-is, 12 items passed.

### Todo 94 Verifications And Second Reviews

- Final relevant unit tests: `pnpm exec vitest run packages/services/test/repoWiki packages/ui/test/repoWiki packages/shared/test/repoWiki.test.ts --reporter=dot --silent`, 15 files / 160 items passed. Covering two request types, multiple model limits, tool loops/static fallbacks/compression finals, old Wikis/Drafts reading not-writing-disk and normal-saving-removing-old-budgets, cuts plain retrials, cancellations, and timeouts.
- Pro isolated directories `/tmp/zcode-todo94-97.qBney3`, sources from baselines HEAD + current source code differences; not modifying Pro original workspaces or user data. Dependency downloads encountering SSH keychain errors, not unlocking or changing credentials; reusing existing isolated repositories completely same SHA256 lock file dependencies, rebuilding current desktop source codes.
- Pro formal E2E: generation-settings, generation-produces-wiki two passed. Evidence directories: `packages/desktop/.e2e-artifacts/desktop-e2e-20260908161324585-p92955-4b3566c99ee6dd7f` (within above Pro isolated directories). First runs generating cases still clicking single disabled-tier menus, current UI is fixed values, failing because tests outdated; adjusted to verifying fixed values then re-running passed, not modifying products' reasoning behaviors.
- Second reviews: directories/bodies/failure-page supplements/automatic-refresh no longer exist Wiki budget coverages; ModelConfigs getting Limits from target Views, ModelClients passing as-is, final Model validations and Option Maps unchanged. No Factorys default values, Providers special-judgments, remote sending synchronizations, or execution-in-progress model-swaping.
- UIs deleting two entries and bilingual copy from shared components, no new styles; cannot claim mobile real machines, Windows, or real provider requests already verified. E2Es using L2 mocks, real API fields still by existing Map contract tests responsible.
- Submission scopes excluding original supportsJsonSchemaOutput renames etc. un-submitted modifications; specific commits tracked by corresponding Todo94 submissions and this execution records' Git histories.

## Todo 95 A/B Implementations And Reviews

- Red-lights: first fixing 19 old special expressions and all rule positions; original config equivalently tests passing, three APIs fallback requests tests failing. Then only modifying configs, revisions 10 → 11, avoiding same revisions different contents.
- `pnpm exec vitest run packages/provider-node/test packages/provider/test packages/model-option-map --reporter=dot --silent`: 24 files / 340 items passed. Special legal inputs per-item comparing final JSONs; two basic bodies separately testing empty fields and existing fields, budgets, nulls, preventing omissions writing deletions. Illegal values rejected by public validations, Maps not responsible for guessing highest tiers.
- Old integrity tests asserting expressions containing `"effort": "max"`, no longer applicable passthroughs; changed to compiling executions then asserting corresponding requests, not downgrading to string existences.
- Pro: `desktop-e2e-20260908162732756-p93660-3b18fc076970b932`'s C91-04, SC90-01 passed. New cases twice stuck at WebDriver setValue clearing causing inline-editor exiting; confirming inputs entering editing states, switching to keyboard selecting-all replacing, `desktop-e2e-20260908163135228-p95033-03a4490e97708607` passed capturing real Model requests. Not relaxing Maps or bypassing-saving fixes.
- New pending case `provider-reasoning-fallback.test.ts`: real-adding unknown models, only writing values=[high]; Personal maps still defaulting, network bodies containing four groups high fields, original models, original probe Prompts, outputs 5000 (existing auxiliary calling budgets), no thinking budgets, configs not rewritten by testing requests. Not depending on real quotas; pending human reviews, not independently promoting.
- Differences mechanical comparisons: removing revisions and reasoning maps, new-entire Built-ins JSONs completely identical. Special Rule value-ranges, APIs/sites/templates/Providers matching, priorities, model capabilities, maxOutputTokens Maps all untouched; Runtimes unchanged.
- Real semantic changes only fallbacks: including known models under some APIs having no special Maps, changing from `{}` to explicitly-closing fields; this is confirmed B boundaries, not claiming all compatible APIs without-losses. Users Maps-only, fixed configs still by original Overlays authoritative coverages.
- C unimplemented: already queried postponing closing tier renames or continuing designing source compatibilities; without answers retaining off/nothinks, native nones unchanged. Cannot using A/B completion records covering C.
- Todo96 explicit Subagent connections sending separate requests: suggesting Agents starting child-tasks before entrusting belonging Hosts' public getView parsing and fixing, not changing configs, not retreating parent models; needing strict protocol extensions, pending user decisions.

## Todo 96 Process Records (Not Yet Completed)

- First group sharing identities/Bot tests: 5 files / 37 items passed; old strings even when candidates empty still retaining clear identities, models, and tiers. Deleting BotsRepo migration contexts and Hosts' readMigrationAccountAccess, not affecting real connection-settings migrations/OAuths.
- Automations/Wikis: removing migration-only injection callbacks, changing to storage + static transformations; related 2 files / 76 items passed (subsequent full-runs still need re-running). Retaining new-field priorities, SQL NULLs and JSON nulls distinguishing, CASs, old files not writing-backs.
- Sessions: first supplementing real SQLite recovery tests, reproducing three original-intentions-losses (deleted Providers, deleted models, invalid tiers). After fixing 12 items passed; Runtimes still only binding Registries validating-successfully selections, recovery results returning saving intentions.
- Session Stores already removing migration-parsing callbacks, retaining transactions/CASs; old async-account waiting tests changed to no-account-interfaces offline-imports, concurrency idempotencies, and new-selection-priority tests.
- knip full-library checks reporting existing unused items, not batch-deleting from this; dep:refs giving Host references for protocol symbols, but missing independent Agent workspaces, additionally using rg tracking Agent imports, protocol strings, and tests, avoiding mistaken deletions.

### Todo 96 Core Verifications And Second Reviews

- Root workspaces 28 files / 438 items passed: Bot full groups, Subagents, Automation Repos, Wiki selections, ZCodeAgentServices, shared identities, Account resolvers, Host dispatches, Draft controls. Agents 6 files / 73 items passed: real SQLite migrations, App/Protocol recoveries, Subagent initializations, and cold recoveries. First Agent tests hitting old adapters dists, rebuilding contracts/adapters then re-running, not using changed assertions covering old builds.
- Root `pnpm typecheck`, `pnpm lint`, and Agent bootstrap typechecks passed; Lints 41 warnings / 0 errors. Final clearing existing unused items separately counted, not claiming whole-libraries zero-warnings.
- Deleting old-migration-dedicated `session/resolveLegacyModelProvider` RPCs, Host assembly callbacks, and Agent injections; real account-connection migrations/OAuth queries unchanged. Protocol recovery tests simultaneously covering continuous/replayables, and asserting recoveries not sending this migration RPCs.
- Bots menus originally cross-Workspace global caches showing other Hosts' models after target Views failing; deleting these caches and local-borrowing paths, original persistent selections unchanged, target recoveries normally re-reading. Regression tests explicitly saving real Bots contexts then overwriting same-paths different-remote identities, cannot using non-persisted testing contexts faking switching successes.
- Pro `desktop-e2e-20260908170825961-p95934-accbbb3745ff04c4`: SR87-01, SR87-06 / SM96-02/05 two passed. Latter implanting old SQLite selections after isolating Electrons stopping; current Teams not affecting their fixed-moveding to Individuals, Runs nows' real requests using Teams/highs, tasks original intentions and old rollback columns still retained. Not auto-promoting pending cases.
- Second reviews: not adding storage versions; not changing history messages, currently-executing selections, Off-Peak Tickets; not adding pre-send synchronizations. Runtimes' final Registry validations retained, but no longer deleting original intentions from recovery results because of this. Deleting Desktop dispatching redundant listAutomations pre-migration calls, actual Repos ensuringReady guaranteeing offline migrations completing.
- Remaining: explicit Subagents' execution-side public-resolution protocols pending decisions; Markdowns current memory-imports will be replaced by Todo97's user directories' in-place migrations, not treating this transitional states as final completions. Real SSIs and mobile real machines not yet re-verified.

## Todo97 Core Implementations And Second Reviews

- Sharing formal Markdown codecs and Node file migrations; Hosts, independent Agents first processing user directories, projects/plugins not entering writing scopes. Deleting full-profile memory identity-swapping, Markdown intermediate-state dual-readings, and Hosts' duplicate parsers.
- Built-ins JSONs first one-way importing and writing-to-disks, then formally reading new maps; new values empty/bad/missing-tiers cannot respawn from rollback old maps.
- Per-storage tracking see [audit tables](todo97-selection-storage-audit.md). Session entries' thoughtLevels confirmed as stagings already-shipped writings, moving them from plain codecs to SQLite migration entries; history messages displays decoders retained, cannot confusing with current selections recoveries.
- Roots 61 files/900 items, Agents 17 files/201 items expanded regressions passed. Second reviews adding custom: Provider IDs encoding ambiguity red-lights, after fixing shared 3 files/25 items passed. Root typecheck/lint, Agent bootstrap typechecks passed.
- Pro `desktop-e2e-20260908172422561-p96860-3f1d8f499a4468d5`: SE three + I20 total 4 items passed, saving products and actual child requests separately verified; final source code re-runs `desktop-e2e-20260908173630157-p97784-4db43b3562850f6d` equally 4 items passed.
- Small-blockers continuing accounting: Wikis old-file reading not-writing-disk and 97 one-shot-migration principles conflicting, already requesting decisions; not independently rewriting. Mobile real machines/real SSIs not testing. Un-shipped intermediate states not reverse-migrating, Off-Peak Tickets exceptions not changing.

## Final Combination Regressions And Recent Quality Reviews

- [Todo88–97 quality reviews](todo88-97-final-quality-review.md) already persisted, including this round's own introducing, second-review discovering two new-fields over-compatibilities; already using negative tests tightening. 13 files/184 items and Wiki UI 5 files/25 items passed, root typecheck/lint passed (39 warnings/0 errors). Retaining existing un-submitted file modifications, only clearing this round's two unused items.
- Recent settings/accounts supplementary 29 files/420 items, connection migrations and selection-supplementary 6 files/62 items passed; groups having overlaps, not accumulating counts.
- Pro `desktop-e2e-20260908173912732-p98589-498cb410db57162d`: 13 passed, 1 real-remote skipped; final source code rebuildings `desktop-e2e-20260908174309069-p99900-5e27de7ecbaf9767`: Wiki two, Probe one, API fallback one, Subagent I20 one, 5/5 passed.
- Submitted 94 `a56dc32c26`, 95A/B `9b0f11e996`, 96 core `dd38abe9fb`, 97 core `0c32ba2b59`. Subsequent second-review patches and pushing results see corresponding commits/final replies; not writing pending-decisions as implementations completed.

### Pushing And Submission Version Supplementary Verifications

- `a0f686fc38` post-second-review patches, normal `git push origin HEAD:provider-refactor-e2e-recovery` succeeded. pre-push lints and 103 changed-files-triggered direct/related unit tests passed, not bypassing hooks; actual remotes advancing from `7cd5f57462` to `a0f686fc38`.
- Original workspaces' 7 overlapping source/test files having users' existing un-submitted modifications, not mixed into submissions. In Pro isolated copies replacing these 7 files with HEAD versions, then running Wikis, old Providers-importing, protocol tests, 11 files/198 items passed, avoiding depending on un-submitted modifications fake-greens.
- This round not pushing m2, merging subsequent stagings, or publishinging Web; not treating mobiles/real-SSIs skipping items or pendants-human-reviewed as completions. Targets retaining actives, pending 95C, 96 protocols, 97 Wikis three decisions then continuing.

### SA97-09 Execution-side Supplementary Verifications

- In Agents `packages/bootstrap/tests/subagents.test.ts` supplementing same-round loading users/projects/plugins comparisons: three same old Provider configs, continuously executing twice real loaders, user files only modifying models' Provider parts, projects/plugins file bytes and explicit old identities unchanged. Not merely judging by static call-graphs plugins not migrating; this item not claiming child-tasks actual request verifications.
- Agents-related initializations/loaders two files 9 items passed; root `pnpm typecheck`, `pnpm lint` (39 warnings/0 errors) and Agent bootstrap typechecks passing again. This only strengthening already-decided-scope protection tests, not changing product behaviors, not crossing three-pending-decisions boundaries.
