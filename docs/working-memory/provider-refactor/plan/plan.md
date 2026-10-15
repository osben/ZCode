# Provider Refactoring Release Wrap-up Master Plan

> Status: Phase A completed; Phase B automation implemented, key E2E awaiting human gates
>
> Last updated: 2026-08-25

## 1. Plan Positioning

The Provider Refactoring's target architecture and Todo 00 through Todo 10 are complete. This plan no longer designs another Provider architecture, nor reopens already-ruled issues; it advances the current large branch from "main implementation complete" to "verifiable as Release Candidate."

Subsequent work is uniformly categorized into four types, advancing in the following order:

```text
Current Provider Refactoring Branch
        |
        v
A. Merge latest staging
        |
        |  Form single integration baseline
        v
B. Supplement automation tests and gates
        |
        |  Machines can continuously prove critical paths correct
        v
C. Complete real-environment and release-artifact verification
        |
        |  Prove build artifacts, accounts, and upgrade paths truly work
        v
D. Complete engineering and documentation wrap-up
        |
        v
Provider Refactor Release Candidate
```

Each phase forms its detailed plan, impact assessment, and verification checklist before starting. This master plan only fixes major direction, phase boundaries, and completion criteria, avoiding prematurely hard-coding specific fix solutions before running evidence is obtained.

## 2. General Principles

1. **Use the merge result of the latest staging as the single verification baseline.** Results from the current branch alone cannot replace final merged tree verification.
2. **Preserve the single Provider/Model architecture already formed.** Merges and fixes must not reintroduce old Provider Registry, Model Connection Port, ModelRef, Runtime capability map, or strategy hardcoded to specific models.
3. **Code fixes continue test-first.** Newly discovered regressions are first fixed by unit tests or E2E scenario tests, then production code is modified.
4. **Automated verification and real verification are separate.** Unit tests and type checks prove static contracts; real artifacts, real accounts, and real upgrade data prove the system can go live; the two cannot substitute for each other.
5. **Failures must have clear attribution.** Critical test failures can only be fixed, or proven as pre-existing baseline on the latest staging with a clear handling conclusion; they cannot be silently ignored due to sporadic occurrence, historical existence, or temporarily irreproducible states.
6. **Phase-by-phase closure.** The previous phase forms stable results and evidence before entering the next phase, avoiding merging staging while simultaneously modifying gates while investigating real account problems and losing attributable baselines.
7. **Do not expand refactoring scope.** Remote Provisioning, ordinary task queues, model selection lifecycle, `modelContextBudget.strategy`, and new product capabilities are not part of this plan.

## 3. Phase A: Merge Latest Staging

### Goal

Absorb product changes and infrastructure changes from the latest `origin/staging` into the current branch, forming the integration baseline shared by all subsequent tests and real verification.

### Main Work

- Update remote references and confirm commit differences between both sides.
- Merge the latest staging.
- Resolve each text conflict item-by-item against current Provider Design, not by simply selecting one side over another.
- Review automatically merged but simultaneously modified protocol, authentication, Session, Trajectory, Telemetry, and UI files.
- Rescan retired Provider/Model abstractions, old capability projections, and specific model hardcodes to confirm staging did not bring old paths back into production code.
- Run type checks, targeted unit tests, and static checks that can quickly detect integration breaks.

### Currently Known Semantic Boundaries

- Host-to-Worker only syncs Account Provider Config; cannot restore complete Local Provider Registry sync.
- staging's new cold-open telemetry can be retained, but cannot use it to restore already-deleted `modelProviderService` UI dependencies.
- Models facts new to staging must enter existing Built-in Provider Config or Built-in Model Config Rules; no separate remote or runtime fact sources.

### Completion Criteria

- Latest staging entered the current branch.
- All conflicts resolved by design semantics with test protection.
- Clean merge workspace, fast gates passed.
- Old abstractions and specific model hardcodes remain zero.

## 4. Phase B: Supplement Automation Tests and Gates

### Goal

Have the automation system truly cover the Provider Refactoring core implementation and prevent Core, Adapter, Bootstrap, or physical Built-in Config regressions from entering the release process.

### Main Work

- Add permanent tests directly loading real `config/provider/zcode-builtin.json`, iterating to verify Provider members, Model Rule resolution, and Effective Model Config completeness.
- Use real Built-in Config to prove API Key, Account, and Request Auth three paths can enter Adapter via Resolver, Registry, ModelFactory.
- Audit ordinary requests, Compact, Memory, Subagent, and Off-Peak usage of the same Active Model; only supplement truly missing test breakpoints.
- Verify and promote four key E2Es through human review: Provider identity, Registry cold start, idle sub-agent, and candidate filtering.
- Run targeted typecheck, tests, and full regression for Provider Refactoring-related packages; environment issues recorded separately, not expanded into full-repo infrastructure changes.

### Completion Criteria

- Provider Refactoring core packages' typecheck and critical tests can stably execute in supported repository environments.
- All critical suites on the latest integration tree passed.
- All remaining failures have reproducible evidence, clear attribution, and written handling conclusions.
- Physical Built-in Config completeness protected by permanent tests, no longer relying on manual script audits.

## 5. Phase C: Complete Real-Environment and Release-Artifact Verification

### Goal

Prove that real release artifacts, real accounts, real servers, and real historical data work under the new architecture.

### Verification Chain

```text
Source Code and Built-in Config
        |
        +--> Desktop formal artifacts (macOS / Windows / Linux)
        |
        +--> Standalone CLI / SEA
        |
        +--> Server / Remote bundle
        |
        v
Installation and cold start
        |
        v
Real Provider / Account / Request Auth
        |
        v
Model requests, error handling, Usage, and historical data upgrade
```

### Main Work

- Build and install Desktop, Standalone CLI, Server, and Remote formal artifacts.
- Verify all artifacts can locate and load `zcode-builtin.json`.
- Use real API Key Providers to verify config, connectivity checks, and model requests.
- Use real Start Plan, Individual, Team, and Off-Peak accounts to verify login, refresh, logout, account switching, dynamic Request Auth, and server rejection behavior.
- Verify ordinary requests, Compact, Memory, Subagent, and idle tasks use correct Providers, Models, and access contexts.
- Use real historical databases to verify schema migration, historical Usage queries, and rollback boundaries needed for release.
- Execute Provider critical Desktop/CLI E2Es.

### Completion Criteria

- Formal artifacts for supported platforms are all installable, startable, and capable of executing model requests.
- Critical paths for API Key and account-type Providers verified through real servers.
- Historical data upgrade results correct; release and rollback boundaries clear.
- No Provider contracts that work only in test fixtures but cannot work in real deployments.

## 6. Phase D: Complete Engineering and Documentation Wrap-up

### Goal

Delete residual structures no longer having real responsibilities, so code, Feature Graph, Design, implementation records, and release conclusions uniformly describe the same landed system.

### Main Work

- Clean Runtime shells that only wrap ModelFactory but still retain artificial start/destroy states.
- Clean naming remnants like `official` that have exited the Provider Config domain.
- Update Feature Graph with deleted symbols, call chains, and capability sources.
- Clearly mark historical review, roadmap, and research "current facts" as historical evidence to avoid conflicts with completed states.
- Fix formatting, unused exports, obsolete comments, and other code hygiene issues.
- Clarify legacy importer compatibility version windows, exit conditions, and subsequent deletion responsibility.
- Summarize final tests, real verification, known limitations, and release risks into Release Candidate acceptance records.

### Completion Criteria

- No second Provider/Model business semantics or lifecycle preserved only for old architecture in production code.
- Feature Graph and current Design consistent with production code.
- Legacy boundaries all have clear existence reasons and exit conditions.
- Final commits pass complete release gates, workspace clean, release evidence reviewable.

## 7. Items Confirmed as Not Handled as Issues

- Current Built-in Model Config does not set `support_pdf` or `support_audio` to `true`; this is a confirmed config fact, not an unresolved issue for this plan.
- Legacy `modalities`, `supportsImages`, `supportsPdf`, `supportsVideo` only allowed to exist at one-time importer/reader boundaries; as long as they do not re-enter formal Config, Registry, or Runtime, they do not count as production dual-routes.
- Remote Provisioning and remote settings sync are independent product capabilities, not part of this Provider Refactoring release wrap-up.

## 8. Next Steps

Phase A completed per [`01-staging-integration.md`](./01-staging-integration.md). Phase B's permanent tests, Runtime coverage audit, and full regression completed per [`02-provider-automation-proof.md`](./02-provider-automation-proof.md); fixture contracts for four key E2Es passed, but still require human review, formal replay and Docker admission in Xvfb or Docker environments. These gates do not pretend as formal coverage, nor advance to Phase C prematurely.
