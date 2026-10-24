# Stage B: Provider Refactor Automated Proof Wrap-up

> Status: automation complete; four key E2Es await manual review and a graphics/Docker environment. Last updated: 2026-08-25.
>
> Full history: `git show 45f808f7:docs/working-memory/provider-refactor/plan/02-provider-automation-proof.md`

## 1. Objective

Prove the Provider refactor's correctness with automated evidence only. This stage does not modify the full-repository CI, workspace, Node, lockfile, or formatter baseline.

Chain: real Built-in Config completeness → real Config-to-Active-Model vertical integration → Runtime branch coverage audit and gap-filling → Provider key E2E promotion → targeted and full regression verification.

## 2. Automated Proofs

1. Read the real `config/provider/zcode-builtin.json`, add minimal execution-period access materials for API Key, Account, and Request Auth Providers, and prove every Built-in Provider and model member resolves into a complete Registry Config.
2. Traverse Overlay, Resolver, Registry, ModelFactory, and Adapter with the real Built-in Config, proving the final Provider/Model Config is never re-inferred.
3. Verify that normal requests, Compact, Memory, Subagent, and Off-Peak all consume the same Active Model; linkages with existing direct evidence are not duplicated.
4. Complete fixture, replay, and manual-review gates for the four pending E2Es; no promotion without manual confirmation.

## 3. Test Boundaries

- Completeness tests fix no Provider, Rule, or Model total counts and never require universal Rules to hit Built-in members.
- The Built-in API Key Provider gets a test key via Personal Overlay; the Account Provider gets accessId and Team scope via Account Overlay; Request Auth keeps request-period injection.
- Tests may reference real model IDs as fixed configuration facts; production code never branches on specific model IDs.
- `support_pdf: false` and `support_audio: false` are confirmed inputs in this stage; configuration facts are not modified.
- Remote Provisioning, real accounts, production artifacts, historical-data upgrades, queue, and recovery semantics are out of scope.

## 4. E2E Decisions

First-batch candidates:

- `conversation-session-same-model-draft-provider-identity`
- `conversation-session-provider-registry-prewarm`
- `conversation-session-offpeak-subagent-model-inheritance`
- `conversation-session-model-provider-list-filtering`

Not promoted in this stage: `model-switch-compact` and `model-switch-queue` (known transport/product state issues, broader Queue cross-faces) and `model-provider-session-isolation` (reserved for a session lifecycle project).

Manual review on 2026-08-25 confirmed the proof boundaries:

- Same-name model identity uses the existing `same-model-draft-provider-identity`: two Providers expose the exact same modelId with different Provider IDs and Base URLs; composite selection values, menu selected state, draft configuration, and real request URLs must all keep the target Provider. The old `same-model-provider-identity` uses different modelIds and covers only ordinary cross-Provider switching — it does not carry this stage's same-name identity isolation proof.
- Candidate filtering proves with representative negative samples that hidden Providers, hidden Models under visible Providers, and disabled or incomplete Providers stay out of normal candidates; it also covers real ZCode Built-in Provider + Personal same modelId to prove Built-in members remain selectable and sendable during conflicts. Repeated arrangements and issue codes stay proven by Resolver unit tests; the E2E does not duplicate Resolver's full state space.
- In normal tasks, Subagents without an explicit model inherit the parent ModelFactory; explicit models create their own Models. Off-Peak is an execution-scope constraint: all foreground children keep this round's idle-time Provider/Ticket/Request Auth; background children are rejected before any request; when idle-time rotation ends and normal messages resume, the user Provider returns.
- Registry prewarm must prove — beyond provider/model, toolbar, and last-selected — via case-local Base URLs that the first request hits the cold-start configured custom Provider.

## 5. Completion Criteria

- Every Provider and model member of the real Built-in Config is protected by permanent tests.
- API Key, Account, and Request Auth paths each have real config-to-Active-Model vertical evidence.
- Normal requests, Compact, Memory, Subagent, and Off-Peak have clear automated evidence.
- The four E2Es pass auto-executable fixture/replay verification; only manually reviewed cases enter the formal directory and Docker preset.
- Provider targeted tests, related package typecheck, root typecheck, lint, and full unit tests pass.
- No old Provider/Model abstractions, specific-model runtime hardcoding, or second model fact sources are restored.

## 6. Implementation Results

### 6.1 Permanent Automated Evidence

| Proof Layer                       | Automated Evidence                                                                        | Result                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Real Built-in Config completeness | `packages/provider-node/test/zcode-builtin-integrity.test.ts`                             | Real JSON's Providers, model members, access material Overlays, complete Model Config, hidden idle-time models, and old-field zeroing all pass |
| API Key vertical chain            | `apps/zcode-cli/packages/bootstrap/tests/zcode-builtin-model-runtime-integration.test.ts` | `builtin:zai` flows from Built-in + Personal Overlay through Resolver/Registry/ModelFactory natively into Adapter                              |
| Account vertical chain            | Same as above                                                                             | Start Plan Account member constraints take effect; Personal Provider Overlay keeps last-override                                               |
| Request Auth vertical chain       | Same as above                                                                             | Hidden idle-time Providers are precisely creatable via normal Registry; Request Auth Source binds only at execution                            |
| Request Auth missing              | `apps/zcode-cli/packages/adapters/tests/model.test.ts`                                    | generate/stream both return `ModelRequestAuthMissing` before network calls                                                                     |
| Model freeze                      | `apps/zcode-cli/packages/bootstrap/tests/provider-registry-model-runtime.test.ts`         | Registry updates affect only subsequently created Models                                                                                       |

The real Built-in integration tests capture only Adapter creation parameters, send no network requests, and add no execution Registry, capability DTO, Provider snapshot, or test-specific production API.

### 6.2 Runtime Branch Coverage Audit

| Runtime branch  | Direct evidence                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Normal requests | `packages/adapters/tests/model.test.ts`, `packages/core/tests/runtime-model-lifecycle.test.ts`                                                                           |
| Compact         | `packages/core/tests/compact-media-capability.test.ts`, `packages/core/tests/compact-summary-model-request.test.ts`                                                      |
| Memory          | `packages/core/tests/memory-agent-loop.test.ts`, `packages/core/tests/runtime-memory-extraction.test.ts`                                                                 |
| Subagent        | `packages/core/tests/subagent-inherited-model-factory.test.ts`                                                                                                           |
| Off-Peak        | `packages/core/tests/runtime-model-selection.test.ts`, `packages/bootstrap/tests/v4-native-commands.test.ts`, `packages/services/test/offPeakModelSelectionView.test.ts` |

All read the same Active Model or ModelFactory; no gaps required new production branches or a second model fact set. CLI targeted collections: 9 files, 203 tests passed.

### 6.3 Key E2E Gate Status

All four pending cases' case-local manifests and replay fixtures passed mechanical validation. Remaining non-blocking warnings: three title fixtures lack an E2E marker, and the Off-Peak fixture has two uncovered markers; they do not change the fixture-contract pass and are left to manual review. Local pending replay built Desktop, CLI, Adapter, and Bootstrap; the first run hit a Zod resolution conflict from old dependency install state, recovered by the repository-standard `pnpm bootstrap`; re-runs bypassed builds, but the host lacks `xvfb-run` and Docker/Podman, so Chrome WebDriver sessions exit before business pages and case assertions. This is a verification environment blocker, not a product failure, and is not reported as green replay. The four cases remain in `manual-review/pending` — no execution promotion, no Docker admission.

### 6.4 Regression Results

- `@zcode/provider`: 13 files, 115 tests passed; typecheck passed.
- `@zcode/provider-node`: 4 files, 20 tests passed; typecheck passed. Concurrent package tests once caused an existing file-watcher test to see an extra `watch-error`; serial re-runs pass stably and the new integrity tests always pass.
- Services targeted: 5 files, 30 tests passed.
- Real Built-in Bootstrap integration: 1 file, 3 tests passed.
- Root `pnpm typecheck`, `pnpm lint`, and Desktop E2E typecheck passed; lint keeps repository-existing warnings, 0 errors.
- Root `pnpm test:unit`: 1467 files, 12418 tests passed (25 skipped).

Remaining gate: manual review, formal replay, and Docker admission of the four pending E2Es. They need graphics/Docker runtime conditions; no Provider production-code change is needed or permitted to bypass them.
