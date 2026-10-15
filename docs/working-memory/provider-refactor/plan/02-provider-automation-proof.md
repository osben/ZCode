# Stage B: Provider Refactor Automated Proof Wrap-up

> Status: Automation implementation completed; key E2E awaiting manual review and available graphics/Docker environment
>
> Last updated: 2026-08-25

## 1. Objective

This stage only completes automated evidence that directly proves the correctness of the Provider refactor. It does not改造 (modify) the full repository CI, workspace, Node, lockfile, or formatter baseline.

```text
Real Built-in Config completeness
            |
            v
Real Config to Active Model vertical integration
            |
            v
Runtime branch coverage audit and gap-filling
            |
            v
Provider key E2E promotion
            |
            v
Targeted and full regression verification
```

## 2. Automated Proofs

1. Directly read the real `config/provider/zcode-builtin.json`, add the minimal execution-period access materials for API Key, Account, and Request Auth Providers respectively, proving that each Built-in Provider and model member can resolve into a complete Registry Config.
2. Use real Built-in Config to traverse Overlay, Resolver, Registry, ModelFactory, and Adapter, proving that the final Provider/Model Config is not re-inferred.
3. Review that normal requests, Compact, Memory, Subagent, and Off-Peak all consume the same Active Model; linkages with existing direct evidence do not duplicate test creation.
4. Complete fixture, replay, and manual review gates for the four pending E2Es on Provider identity, Registry cold-start, idle-time sub-agents, and candidate filtering; not promoted without manual confirmation.

## 3. Test Boundaries

- Completeness tests do not fix Provider, Rule, or Model total counts, nor do they require universal Rules to hit Built-in members.
- Built-in API Key Provider is injected with test Key by Personal Overlay; Account Provider is injected with accessId and necessary Team scope by Account Overlay; Request Auth maintains request-period injection.
- Tests may reference real model IDs as fixed configuration facts; production code must not branch on specific model IDs.
- `support_pdf: false` and `support_audio: false` are confirmed inputs in this stage; configuration facts are not modified.
- Remote Provisioning, real accounts, production artifacts, historical data upgrades, queue, and recovery semantics are not part of this stage.

## 4. E2E Decisions

The first batch candidates are:

- `conversation-session-same-model-draft-provider-identity`
- `conversation-session-provider-registry-prewarm`
- `conversation-session-offpeak-subagent-model-inheritance`
- `conversation-session-model-provider-list-filtering`

This stage does not promote `model-switch-compact`, `model-switch-queue`, or `model-provider-session-isolation`. The first two have known transport/product state issues and broader Queue cross-faces; the latter is reserved for a session lifecycle special project.

Manual review on 2026-08-25 confirmed the following proof boundaries:

- Same-name model identity uses the existing `same-model-draft-provider-identity`: two Providers expose the exact same modelId, with different Provider IDs and Base URLs; composite selection values, menu selected state, draft configuration, and real request URLs must all maintain the target Provider. The old `same-model-provider-identity` actually uses different modelIds and can only serve as ordinary cross-Provider switching coverage, not bearing this stage's same-name identity isolation proof.
- Candidate filtering E2E uses representative negative samples to prove that hidden Providers, hidden Models under visible Providers, disabled or incomplete Providers do not enter normal candidates; simultaneously covered by real ZCode Built-in Provider + Personal same modelId to prove that Built-in members remain selectable and sendable during conflicts. Repeated arrangements and issue codes continue to be proven by Resolver unit tests; E2E does not duplicate Resolver's full state space.
- In normal tasks, Subagents without explicit models inherit the parent ModelFactory; explicit models create their own Models; Off-Peak is an execution scope constraint, all foreground children must continue to use this round's idle-time Provider/Ticket/Request Auth; background children are rejected before sending requests; idle-time rotation ends and normal messages resume the user Provider.
- Registry prewarm, beyond provider/model, toolbar, and last-selected, must also prove through case-local Base URLs that the first request actually hits the cold-start configured custom Provider.

## 5. Completion Criteria

- All Providers and model members of real Built-in Config are protected by permanent tests.
- Three paths — API Key, Account, Request Auth — all have real config-to-Active Model vertical evidence.
- Normal requests, Compact, Memory, Subagent, Off-Peak all have clear automated evidence.
- Four E2Es complete auto-executable fixture/replay verification; only manually reviewed cases enter the formal directory and Docker preset.
- Provider targeted tests, related package typecheck, root typecheck, lint, and full unit tests pass.
- Old Provider/Model abstractions, specific model runtime hardcoding, or second model fact sources are not restored.

## 6. Implementation Results

### 6.1 Permanent Automated Evidence

| Proof Layer                       | Automated Evidence                                                                        | Result                                                                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Real Built-in Config completeness | `packages/provider-node/test/zcode-builtin-integrity.test.ts`                             | Real JSON's Provider, model members, access material Overlays, complete Model Config, hidden idle-time models, and old field zeroing all pass |
| API Key vertical chain            | `apps/zcode-cli/packages/bootstrap/tests/zcode-builtin-model-runtime-integration.test.ts` | `builtin:zai` flows from Built-in + Personal Overlay through Resolver/Registry/ModelFactory natively into Adapter                             |
| Account vertical chain            | Same as above                                                                             | Start Plan's Account member constraints take effect; Personal Provider Overlay retains last-override                                          |
| Request Auth vertical chain       | Same as above                                                                             | Hidden idle-time Providers can be precisely created by normal Registry; Request Auth Source binds only during execution                       |
| Request Auth missing              | `apps/zcode-cli/packages/adapters/tests/model.test.ts`                                    | generate/stream both return `ModelRequestAuthMissing` before network calls                                                                    |
| Model freeze                      | `apps/zcode-cli/packages/bootstrap/tests/provider-registry-model-runtime.test.ts`         | Registry updates only affect subsequently created Models                                                                                      |

Real Built-in integration tests only capture Adapter's creation parameters, do not send network requests, and add no execution Registry, capability DTO, Provider snapshot, or test-specific production API.

### 6.2 Runtime Branch Coverage Audit

| Runtime Branch  | Direct Evidence                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Normal requests | `packages/adapters/tests/model.test.ts`, `packages/core/tests/runtime-model-lifecycle.test.ts`                                                                           |
| Compact         | `packages/core/tests/compact-media-capability.test.ts`, `packages/core/tests/compact-summary-model-request.test.ts`                                                      |
| Memory          | `packages/core/tests/memory-agent-loop.test.ts`, `packages/core/tests/runtime-memory-extraction.test.ts`                                                                 |
| Subagent        | `packages/core/tests/subagent-inherited-model-factory.test.ts`                                                                                                           |
| Off-Peak        | `packages/core/tests/runtime-model-selection.test.ts`, `packages/bootstrap/tests/v4-native-commands.test.ts`, `packages/services/test/offPeakModelSelectionView.test.ts` |

The above tests have directly read the same Active Model or ModelFactory, without discovering gaps requiring new production branches or second model fact sets. Relevant CLI targeted collections total 9 files, 203 tests passed.

### 6.3 Key E2E Gate Status

The case-local manifests and replay fixtures for all four pending cases have passed mechanical validation. The existing non-blocking warnings are that three title fixtures have no E2E marker, and Off-Peak fixture's two markers are uncovered; these do not change the fixture contract pass conclusion, and are left for manual review to determine whether additional observation points are needed.

Local pending replay has completed Desktop, CLI, Adapter, and Bootstrap builds. The first run exposed a Zod resolution conflict caused by old dependency install state, which recovered after using the repository-standard `pnpm bootstrap`; re-running bypassed builds, but the host lacks `xvfb-run`, Docker/Podman, and Chrome WebDriver sessions exit before the business pages and case assertions. Therefore this is recorded as a verification environment blocker, not as a product failure, and does not disguise itself as green replay. The four cases remain in `manual-review/pending`, without execution promotion or Docker admission.

### 6.4 Regression Results

- `@zcode/provider`: 13 files, 115 tests passed; typecheck passed.
- `@zcode/provider-node`: 4 files, 20 tests passed; typecheck passed. Concurrent package tests previously caused existing file watcher tests to additionally receive one `watch-error`; serial re-runs pass stably, new integrity tests always pass.
- Services targeted: 5 files, 30 tests passed.
- Real Built-in Bootstrap integration: 1 file, 3 tests passed.
- Root `pnpm typecheck`, `pnpm lint`, Desktop E2E typecheck all passed; lint retains repository existing warnings, zero errors.
- Root `pnpm test:unit`: 1467 files passed, 1 skipped; 12418 tests passed, 25 skipped.

The remaining gate is the manual review, formal replay, and Docker admission for the four pending E2Es. They need graphics/Docker runtime conditions to continue; no Provider production code modification is needed or permitted to bypass them.
