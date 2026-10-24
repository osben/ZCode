# 15 Provider Refactor unified release validation

> Status: abandoned (no longer an independent Todo) — 2026-08-25
>
> Current decision: only the pre-release validation scope is kept in one place and not executed; it does
> not block the structural closure of Todo 12-14.
>
> Related plans: [`../plan/plan.md`](../plan/plan.md), [`../plan/02-provider-automation-proof.md`](../plan/02-provider-automation-proof.md)
>
> Related design: [`../design/design.md`](../design/design.md),
> [`../design/registry/configuration.md`](../design/registry/configuration.md),
> [`../design/registry/runtime.md`](../design/registry/runtime.md)

## 0. Position

This file keeps the historical release-validation scope and is no longer an execution entry. If a release
gate is needed later, build a dedicated Release Checklist/Todo from the then-current release process and
final staging baseline instead of reviving this file. Historical handling rules for findings:

1. Design is clear but implementation deviates: write a failing test, then a minimal bugfix.
2. Design undefined, or the real service cannot meet an existing contract: stop validating and request a decision.
3. Environment, account or external-service failure: save evidence and mark a blocker; never disguise it as a product failure or green result.
4. Items without real evidence stay pending; typecheck, fixture checks or mock results do not substitute.

## 1. Validation scope

### 1.1 Provider key E2E

Four pending cases stay as they are; when this Todo is resumed, finish manual review, formal replay,
promotion and Docker admission for: identity isolation of the same modelId under different Provider
ID/Base URL; Provider Registry cold-start prewarm and the first-request Endpoint; Off-Peak foreground
Subagent Provider/Request Auth inheritance; Provider visibility, Model enabled/completeness filtering and
Built-in-wins duplicate-name and order projection.

Order: fixture contract check -> pending replay + artifact review -> human confirmation -> promotion
dry-run + apply -> case-local replay + default replay -> single-spec Docker admission -> conversation
Docker preset.

### 1.2 Three real access paths

- API Key: Personal API Key and Endpoint overrides apply last; the Effective Provider's `api.type/baseURL/access` go unchanged into ModelFactory/Adapter; a Provider without an API Key does not enter the executable Registry; Config updates affect only later-created Models (created Models stay frozen); requests never read the Legacy Provider Store or old CLI Config.
- Account: Account Built-in Overlay handles only account Providers declared by ZCode Built-in; Start, Individual and Team Plan use structured `family/planKind/accessId` with Team Scope completed per the existing contract; entitlement overrides `builtinModelIds` only when the interface really returns a model set, otherwise Built-in members are used; Personal Overlay still applies last; dynamic credentials are resolved per request, never written to Provider Config, and the server keeps final authorization.
- Request Auth: Config stores only `access.type = "request-auth"`; the Request Auth Source is assembled only as this Model execution's dependency; missing execution-time material returns a typed auth error before any network IO; Request Auth never enters Personal Config, the Registry View, Session Snapshot, persistence or logs.
- Reasoning replay: DeepSeek Anthropic continuation replays standard canonical reasoning, with no synthetic empty-thinking, model-ID hardcode or Compatibility Config; an independent server protocol issue is a new Adapter-contract question, not a reason to restore the deleted generic compatibility container.

### 1.3 Historical config and persistence

- A fresh install builds the Registry from Built-in + empty Personal + the current Account.
- Old `.zcode/v2/config.json` gets a content-hash backup before the same-path migration, then is atomically replaced with the formal versioned Personal Config. Old `model-providers.json` is a one-time read-only source, never modified and never re-entering the steady Registry.
- Explicit user facts of Custom Providers migrate in full to Personal; for Built-in Providers only explicit user differences migrate. Legacy `modalities` and published flat capability fields convert only in the importer-private boundary. Catalog enrichment, Preset, remote static model facts and specific model hardcodes are not frozen into Personal.
- On migration, backup, parse or integrity failure the original file is kept and no half-new config is produced. Files with a formal `schemaVersion` go only through adjacent-version migration (never the unversioned Legacy importer). Repeated starts do not re-migrate and leftover old files do not override an established Personal Config.
- The one-time Credential Store migration of the Account Personal Coding Plan Key stays separate from the Provider Config migration.

### 1.4 Release artifacts and cross-platform startup

Desktop dev and packaged builds locate `config/provider/zcode-builtin.json`; CLI/TUI/SEA materialize and read the same Built-in Config from an embedded asset or explicit path; Server builds start from the embedded asset or the supported explicit env var; macOS, Windows and Linux use the current Environment's `.zcode/v2/config.json` with path, permission, file-lock, atomic-write and watcher behavior verified; `ZCODE_DATA_BASE_DIR`, test isolation dirs and explicit Built-in/Personal paths cause no cross-Environment pollution; cold start, normal restart, config update and post-failure recovery give a consistent Config/Registry lifecycle; packaged artifacts omit neither Built-in Config nor carry real API keys or test credentials.

### 1.5 Final release gate

Targeted tests of Provider, Provider Node, Services, Bootstrap, Core, Adapters, Shared, Desktop/UI; root `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm test:unit`; affected release builds and platform smoke; formal replay and Docker suites of promoted E2E; Legacy/hardcode/second-fact-source mechanical zero checks; a Release Candidate record summarizing commits, environments, commands, artifacts, known limits and blockers.

## 2. Equivalence wording

"Fresh install equals historical upgrade" does not mean identical config. Correct wording: with the same
Built-in version, account state and explicit user intent, a Personal Config written directly and one
migrated from published old config resolve to equivalent Effective Provider/Model and equivalent request
assembly. Migration keeps only facts the old file explicitly expressed and that belong to the user, and
does not reproduce incidental Effective Snapshots once derived by Catalog, Preset, remote sync or
model-name hardcode.

## 3. Relation to other Todos

Todo 12 (Selection final validation relocated) -> Todo 13 (target Host / Environment selection authority)
-> Todo 14 (Factory, MCS, Legacy DTO and dead-code mechanical zero) -> Todo 15 (unified real validation and
release evidence; historical draft, abandoned). Todo 11 remains a separate draft whose implementation needs
its own decision. Todo 12-14 unit tests and mechanical acceptance are closed separately. This section keeps
the historical stage relation only and is neither the current order nor an acceptance promise.

## 4. Explicit exclusions

Remote Provisioning, remote settings editing and config sync; new Provider/Model product capabilities or
Access Types; Agent parameters such as `modelContextBudget.strategy`; changing Account plans, entitlement
interfaces or server auth product semantics; Queue, Goal, Background, recovery state machine or new mobile
replayable design; changing confirmed PDF/Audio Built-in config facts; restoring Legacy Catalog, Preset,
remote model facts or model-specific runtime hardcodes to make validation pass.

## 5. Conditions to resume (Draft -> pending execution)

1. Todo 12-14 done, or it is explicitly recorded that this release excludes one with its risk.
2. The release branch is merged into the target staging baseline and structural changes are frozen.
3. Desktop graphical environment, Docker daemon, platform build machines and needed test accounts/credentials are available.
4. Reviewers and artifact storage for the four pending E2E manual reviews are named.
5. Account, quota, environment and redaction rules for real-service validation are confirmed.
6. Someone owns the bugfix / design-decision flow for validation failures (no changing criteria after results appear).

## 6. Definition of done

Real or equivalent isolated-environment request evidence for the three Access types; reviewable results for
fresh install, historical upgrade, restart and config update; Desktop, CLI/TUI/SEA, Server and target
platform artifacts load the same Provider/Model facts; four Provider E2E completed manual confirmation,
formal replay and the agreed Docker admission; the full release gate passes with every failure attributed;
no environment problem, pending case or unexecuted item reported as green; the Release Candidate record
supports release, rollback and the later decision to delete the Legacy importer.
