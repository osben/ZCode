# Provider Refactoring Release Wrap-up Master Plan

> Status: Phase A completed; Phase B automation implemented, key E2Es awaiting human gates. Last updated: 2026-08-25.

## 1. Plan Positioning

The Provider Refactoring's target architecture and Todo 00 through Todo 10 are complete. This plan designs no new architecture and reopens no settled issue; it advances the current large branch from "main implementation complete" to "verifiable as Release Candidate".

```text
A. Merge latest staging  -> single integration baseline
B. Supplement automation tests and gates -> machines continuously prove critical paths
C. Real-environment and release-artifact verification -> artifacts, accounts, upgrade paths truly work
D. Engineering and documentation wrap-up
   -> Provider Refactor Release Candidate
```

Each phase forms its detailed plan, impact assessment, and verification checklist before starting. This master plan fixes only direction, phase boundaries, and completion criteria — specific fixes are not hard-coded before running evidence exists.

## 2. General Principles

1. **The merge of the latest staging is the single verification baseline.** Current-branch results alone never replace final merged-tree verification.
2. **Preserve the single Provider/Model architecture.** Merges and fixes must not reintroduce the old Provider Registry, Model Connection Port, ModelRef, Runtime capability map, or strategies hardcoded to specific models.
3. **Code fixes stay test-first.** New regressions get a unit or E2E scenario test before production code changes.
4. **Automated and real verification are separate.** Unit tests and type checks prove static contracts; real artifacts, accounts, and upgrade data prove the system can ship. Neither substitutes for the other.
5. **Failures need clear attribution.** A critical failure is fixed, or proven pre-existing on the latest staging with a written conclusion — never silently ignored for being sporadic, historical, or temporarily irreproducible.
6. **Phase-by-phase closure.** One phase forms stable results and evidence before the next begins; never merge staging, modify gates, and investigate account problems simultaneously and lose attributable baselines.
7. **No scope expansion.** Remote Provisioning, ordinary task queues, model selection lifecycle, `modelContextBudget.strategy`, and new product capabilities are not part of this plan.

## 3. Phase A: Merge Latest Staging

Goal: absorb the latest `origin/staging` product and infrastructure changes into the single integration baseline for all later tests and real verification.

Main work: update remotes and confirm both sides' commit differences; merge; resolve each text conflict against current Provider Design, never by simply picking a side; review auto-merged but jointly modified protocol, auth, Session, Trajectory, Telemetry, and UI files; rescan retired Provider/Model abstractions, old capability projections, and model hardcodes so staging reintroduced none; run type checks, targeted unit tests, and fast static checks.

Semantic boundaries: Host-to-Worker syncs only Account Provider Config (never full Local Provider Registry sync); staging's new cold-open telemetry is kept but must not restore the deleted `modelProviderService` UI dependency; model facts new to staging enter existing Built-in Provider Config or Built-in Model Config Rules — no separate remote or runtime fact sources.

Completion: latest staging in the branch; all conflicts resolved by design semantics with test protection; clean merge workspace and fast gates; old abstractions and model hardcodes at zero.

## 4. Phase B: Supplement Automation Tests and Gates

Goal: automation truly covers the Provider Refactoring core and blocks Core, Adapter, Bootstrap, or physical Built-in Config regressions from the release process.

Main work: permanent tests loading the real `config/provider/zcode-builtin.json` verifying Provider members, Model Rule resolution, and Effective Model Config completeness; prove API Key, Account, and Request Auth paths reach the Adapter via Resolver → Registry → ModelFactory with the real config; audit that normal requests, Compact, Memory, Subagent, and Off-Peak use the same Active Model and add only truly missing breakpoints; promote the four key E2Es (Provider identity, Registry cold start, idle sub-agent, candidate filtering) through human review; run targeted typecheck, tests, and full regression for the related packages, recording environment issues separately instead of expanding into full-repo infrastructure changes.

Completion: core packages' typecheck and critical tests run stably in supported environments; all critical suites pass on the latest integration tree; remaining failures have reproducible evidence, clear attribution, and written conclusions; physical Built-in Config completeness protected by permanent tests rather than manual script audits.

## 5. Phase C: Complete Real-Environment and Release-Artifact Verification

Goal: prove real release artifacts, real accounts, real servers, and real historical data work under the new architecture.

```text
Source Code and Built-in Config
  +--> Desktop formal artifacts (macOS / Windows / Linux)
  +--> Standalone CLI / SEA
  +--> Server / Remote bundle
        v
Installation and cold start -> Real Provider / Account / Request Auth
  -> Model requests, error handling, Usage, historical data upgrade
```

Main work: build and install Desktop, Standalone CLI, Server, and Remote artifacts; verify every artifact locates and loads `zcode-builtin.json`; verify config, connectivity checks, and model requests with real API Key Providers; verify login, refresh, logout, account switching, dynamic Request Auth, and server rejection with real Start Plan, Individual, Team, and Off-Peak accounts; verify normal requests, Compact, Memory, Subagent, and idle tasks use the right Providers, Models, and access contexts; verify schema migration, historical Usage queries, and rollback boundaries with real historical databases; execute Provider-critical Desktop/CLI E2Es.

Completion: supported platforms' artifacts installable, startable, and able to execute model requests; API Key and account-type Provider critical paths verified against real servers; historical-data upgrades correct with clear release and rollback boundaries; no Provider contract that works only in test fixtures.

## 6. Phase D: Complete Engineering and Documentation Wrap-up

Goal: delete structures with no real responsibility so code, Feature Graph, Design, implementation records, and release conclusions describe one landed system.

Main work: clean Runtime shells that only wrap ModelFactory but keep artificial start/destroy states; clean naming remnants like `official` that left the Provider Config domain; update the Feature Graph for deleted symbols, call chains, and capability sources; mark historical review, roadmap, and research "current facts" as historical evidence to stop conflicting with completed states; fix formatting, unused exports, obsolete comments; clarify legacy importer compatibility windows, exit conditions, and deletion ownership; summarize final tests, real verification, known limitations, and release risks into Release Candidate acceptance records.

Completion: no second Provider/Model business semantics or lifecycle kept only for the old architecture in production code; Feature Graph and Design consistent with production code; legacy boundaries all have existence reasons and exit conditions; final commits pass complete release gates with a clean workspace and reviewable evidence.

## 7. Items Confirmed as Not Handled as Issues

- Built-in Model Config does not set `support_pdf` or `support_audio` to `true`: a confirmed config fact, not an open issue.
- Legacy `modalities`, `supportsImages`, `supportsPdf`, `supportsVideo` may exist only at one-time importer/reader boundaries; as long as they never re-enter formal Config, Registry, or Runtime, they are not production dual-routes.
- Remote Provisioning and remote settings sync are independent product capabilities outside this release wrap-up.

## 8. Next Steps

Phase A completed per [`01-staging-integration.md`](./01-staging-integration.md). Phase B's permanent tests, Runtime coverage audit, and full regression completed per [`02-provider-automation-proof.md`](./02-provider-automation-proof.md); the four key E2Es' fixture contracts passed but still require human review, formal replay, and Docker admission in Xvfb or Docker environments. These gates do not count as formal coverage, and Phase C does not start prematurely.
