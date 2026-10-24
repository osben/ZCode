# Todo 94–97 Execution And Review Records

> Latest ownership (2026-09-09): 95C completed (`2c1addd3d8`); 96 explicit Subagents completed by Todo99; 97 Wiki one-shot migrations completed (`9cd1ae31dd`); 98 layout and keyboard fixes completed (`a5fb82ec4a`). All development items closed; remaining verification debt advances only in [Todo102](../steps/todo-102-verification-debt-closeout.md).
> Full history: `git show 8d54b233:docs/working-memory/provider-refactor/research/todo94-97-execution-and-review.md`

## Scopes And Execution Constraints

Baselines `00c5fa2e66`, branch `provider-refactor-e2e-recovery`. Sequence 94 → 95 → 96 → 97, each first testing, implementing, verifying, then reviewing requirements and Provider/Selection abstractions item-by-item. Involving new product semantics or protocol boundaries required explicit decisions — never independently expanded. Excluded: Web releases, restored novels, un-authorized old drafts. Existing un-submitted source/test/document modifications retained, never mixed into deliverables.

## Todo 94: Wiki Unified Output Limits

```text
Wiki selections / generation-settings (no output budgets)
    -> Target Workspace's generateText
    -> Wiki parsed target Model maxOutputTokens Limits (passing values as-is)
    -> Option Maps -> real API requests
```

- Catalogs, Pages, tool loops, and compression finals share this chain and do not compute budgets themselves. ModelFactory intentionally does not bind output values; ModelClients read Limits from target Views and pass them through existing interfaces — no Factory changes, no default value resolvers.
- Cuts still fail; plain maxRetries and deadlines retained; extra rescue counts deleted. Old `generationOptions.maxOutputTokens` reads are ignored, normal writes do not carry it, histories are not batch-rewritten.
- Wiki tests' outdated `BUILTIN_MODEL_PROVIDER_IDS.zai` (runtime value undefined — potential fake pass) was replaced with named-test Providers.
- 15 files/160 unit tests passed (two request types, multiple model limits, tool loops/static fallbacks/compression finals, old Wikis/Drafts read-not-write-disk and normal-save-removing-old-budgets, plain retries, cancellations, timeouts). Pro generation-settings and generation-produces-wiki E2Es passed. Second review: no Wiki budget coverage remains anywhere; no Factory defaults, Provider special-casing, remote send synchronization, or in-progress model swapping. Mobile real machines/Windows/real provider requests not claimed.

## Todo 95: Reasoning Maps (A/B implemented; C later completed by 95C)

- 19 old special expressions and all rule positions fixed first; config revision 10 → 11 (same revision with different content avoided). 24 files/340 tests passed: special legal inputs compared per-item on final JSON; basic bodies test empty/existing fields, budgets, nulls; illegal values rejected by public validations — Maps never guess highest tiers.
- Old integrity tests asserting `"effort": "max"` strings were changed to compiling executions then asserting corresponding requests — not downgraded to string existence.
- Real semantic changes are only fallbacks: known models under some APIs without special maps change from `{}` to explicitly-closing fields — the confirmed B boundary; not claiming all compatible APIs lossless. Users' Maps-only; fixed configs still authoritative via original Overlays.
- Pro C91-04/SC90-01 passed, including real Model request capture. Pending case `provider-reasoning-fallback.test.ts`: unknown models with only values=[high] — Personal maps still default, network bodies contain four groups of high fields, original models and probe prompts, 5000 auxiliary budgets, no thinking budgets, configs not rewritten by test requests; not auto-promoted.
- Builtin difference check: removing revisions and reasoning maps, the new entire Built-ins JSON is identical; special rule value-ranges, API/site/template/Provider matching, priorities, capabilities, maxOutputTokens maps untouched.
- C (closing tier renames affecting plans only covering Maps' Personal configs) was queried, then implemented as 95C (`2c1addd3d8`).

## Todo 96: Offline Selection Migrations

- Bots: old strings retain clear identities, models, and tiers even when candidates are empty; BotsRepo migration contexts and Hosts' `readMigrationAccountAccess` deleted without affecting real connection-settings migrations/OAuth. Bots menus' cross-Workspace global caches (showing other Hosts' models after target Views failed) and local-borrowing paths deleted; original persistent selections unchanged; regressions save real Bot contexts then overwrite same-path different-remote identities.
- Automations/Wikis: migration-only injection callbacks removed — storage + static transformations; new-field priorities, SQL NULL vs JSON null distinction, CAS, and old-file non-write-backs retained.
- Sessions: recovery returns saved original intents; Runtimes bind only Registry-validated selections (deleted Providers, deleted models, and invalid tiers lose nothing). Session Stores removed migration-parsing callbacks, retaining transactions/CAS; old async-account waiting tests became no-account-interface offline imports, concurrency idempotency, and new-selection-priority tests.
- Deleted old-migration-dedicated `session/resolveLegacyModelProvider` RPCs, Host assembly callbacks, and Agent injections; real account-connection migrations/OAuth queries unchanged. Protocol recovery tests assert recoveries do not send the migration RPC.
- Root 28 files/438 and Agents 6 files/73 tests passed; Pro SR87-01, SR87-06/SM96-02/05 passed (old SQLite selections: current Teams do not affect their fixed move to Individuals; Runs' real requests use Teams/high; task intents and old rollback columns retained).
- Second review: no storage versions added; history messages, currently-executing selections, and Off-Peak Tickets unchanged; no pre-send synchronizations. Desktop's redundant pre-migration `listAutomations` call deleted; Repos' `ensuringReady` guarantees offline migrations complete.

## Todo 97: Old Field Migrations And Full-Domain Audit

- Formal Markdown codecs and Node file migrations shared; Hosts and independent Agents process user directories first; projects/plugins never enter writing scopes. Full-profile memory identity-swapping, Markdown intermediate-state dual-reads, and Hosts' duplicate parsers deleted.
- Built-ins JSON: one-way import writes to disk first, then formal reading of new maps; empty/bad/missing-tier new values never respawn from rollback old maps.
- Per-storage tracking: [audit tables](todo97-selection-storage-audit.md). Session entries' `thoughtLevels` were confirmed as staging already-shipped writes and moved from plain codecs to SQLite migration entries; history message display decoders retained, never confused with current-selection recovery.
- Root 61 files/900 and Agents 17 files/201 regressions passed. Second review added `custom:` Provider ID encoding ambiguity red-lights; fixed with existing encodings. Pro SE three + I20 total 4 items passed, twice.
- Off-Peak Tickets exception unchanged: no universal modifications, following the user's already-decided exceptions.

## Final Combination Regressions And Push

- [Todo88–97 quality review](todo88-97-final-quality-review.md) persisted, including this round's own two new-field over-compatibilities tightened by negative tests.
- Pro final combination `desktop-e2e-20260908173912732-p98589-498cb410db57162d` 13 passed, 1 real-remote skipped; final source rebuild 5/5 (Wiki two, Probe one, API fallback one, Subagent I20 one).
- Submissions: 94 `a56dc32c26`, 95A/B `9b0f11e996`, 96 core `dd38abe9fb`, 97 core `0c32ba2b59`; post-review patches pushed as `a0f686fc38` (pre-push lint and 103 changed-file tests passed, no hook bypass). In Pro isolated copies the 7 overlapping files with users' un-submitted modifications were replaced with HEAD versions before running 11 files/198 tests — no fake greens from un-submitted modifications.
- Not pushing m2, not merging subsequent stagings, not publishing Web; skipped items and pending-human-review cases never counted as completions.

### SA97-09: Execution-Side Protection

Agents `packages/bootstrap/tests/subagents.test.ts` compares users/projects/plugins loading in the same round: three same old Provider configs, two consecutive real loader executions — user files only modify models' Provider parts; projects/plugins file bytes and explicit old identities unchanged. Not merely judged by static call-graphs; not claiming child-task actual request verification.
