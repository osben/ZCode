# Model Selection and Provider Mega-Regression Matrix Plan

## Feature Summary

| Field                | Value                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Developer intent     | List every factor related to model providers, model selection, thinking depth, model capability, request projection and model-related product features, and give later Cartesian products, pruning and test generation a stable input.                                                                 |
| Capability           | Model selection / Provider Registry / Model Runtime / Model Request Projection                                                                                                                                                                                                                         |
| Change layer         | option-source, draft-default, validation, commit-effect, persistence, recovery; presentation only as a low-weight cross dimension                                                                                                                                                                      |
| Operating mode       | planning                                                                                                                                                                                                                                                                                               |
| Primary catalog      | [model-selection-regression-factor-catalog.yaml](./model-selection-regression-factor-catalog.yaml); implicit decisions in the [backlog](./model-selection-regression-decision-backlog.yaml), with a directly fillable [decision questionnaire](./model-selection-regression-decision-questionnaire.md) |
| Current product code | [ModelSelection](../../packages/shared/src/model-selection.ts), [Provider Resolver](../../packages/provider/src/resolver.ts), [V4 model command handler](../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/model-config.ts)                                              |
| Out of scope         | No product code this round, no direct generation of formal E2E, no treating undefined or bug-candidate as accepted assertions, no unconstrained full permutation of all literal model IDs.                                                                                                             |

## 1. Semantic Layers

```text
Provider / account / entitlement / personal config
                         │
                         ▼
              Resolver + Provider Registry
                         │
                         ▼
               visible candidates / preferred
                         │
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
        Chat Draft   Session Runtime  Automation/Subagent
           │             │             │
           └─────────────┼─────────────┘
                         ▼
                V4 Command / Service
                         ▼
                 Canonical Submission
                         ▼
                 ModelFactory / Model
                         ▼
       API format / auth / history / option projection
                         ▼
              provider request + usage + events
```

Four layers must be asserted separately:

1. `ModelSelection`: provider/model plus explicit option overrides.
2. Active Model: the execution object created by ModelFactory after filling defaults from the current Registry.
3. Request Projection: request shapes for Anthropic, OpenAI Chat, OpenAI Responses and OpenAI-compatible.
4. Provenance: the provider/model actually used by the final reply, compaction, title, Subagent, Automation and other results.

A model ID is an opaque value. The display form may be encoded as `providerId/modelId$variant`, but the V4 command, Agent snapshot and persistence must not treat that display string as a new cross-process protocol; `/`, `:` and `$` inside a model ID keep their original meaning.

## 2. UI Surface Matrix

| User scenario                         | Entry                           | Draft/display owner      | Default/inherit                      | Validation                       | Commit sink                           | Authority                          | Must isolate                              |
| ------------------------------------- | ------------------------------- | ------------------------ | ------------------------------------ | -------------------------------- | ------------------------------------- | ---------------------------------- | ----------------------------------------- |
| New conversation                      | V4 composer toolbar             | renderer draft           | Recent -> Host preferred -> fallback | target Host Registry             | `createSession.config` / `firstInput` | Session runtime + Snapshot         | Existing Sessions unchanged               |
| Switch model in existing conversation | V4 composer toolbar             | Conversation Snapshot    | current Session config               | CAS, target model capability     | `switchModelConfig`                   | CLI session runtime                | Other Sessions unchanged                  |
| Historical task restore               | Session/task switch             | Snapshot hydrator        | persisted Session config             | cold-resume + Registry           | resume path                           | Session timeline                   | Task index is not authority               |
| Automation edit                       | `AutomationEditView`            | automation form draft    | inherit or automation record         | automation model options         | automation save                       | automation record/run snapshot     | Chat Session unchanged                    |
| Automation run                        | scheduler / manual dispatch     | run snapshot             | saved selection                      | run-time Registry/auth           | dispatch                              | automation execution               | Does not re-read the Chat Draft           |
| Off-Peak edit                         | `OffPeakEditView`               | Off-Peak form            | task record                          | hidden exact model + entitlement | offpeak save                          | Off-Peak task record               | Does not write Recent/default             |
| Off-Peak execution                    | scheduler                       | task/run record          | persisted selection                  | ticket, JWT, Team scope          | task dispatch                         | Off-Peak runtime                   | Does not create an ordinary Chat runtime  |
| User Subagent                         | `SubagentsSection`              | profile/Markdown         | parent inherit                       | child profile + Registry         | Markdown save / child create          | child runtime/timeline             | readonly child has no picker              |
| Built-in Subagent                     | Built-in model control          | built-in override        | built-in profile                     | Registry                         | built-in override save                | child runtime                      | Does not pollute the parent timeline      |
| Provider settings                     | provider settings section       | settings form            | source overlay                       | schema/complete/revision         | Provider facade                       | personal/account config + Registry | Does not create a runtime model directly  |
| Initial selection at login            | login/welcome                   | login form               | family/provider first model          | key/OAuth/entitlement            | account connection                    | account settings                   | Does not bypass the Provider Registry     |
| Bot                                   | Bot `/model`                    | bot config               | bot default                          | model selection view             | bot service                           | bot config/request                 | Assumes no Chat toolbar state             |
| Official MCP                          | official MCP credentials        | account/family selection | active plan provider                 | coding plan access               | credentials service                   | auth context                       | MCP provider facts are not Registry owner |
| Git commit message                    | git generator                   | request-local            | current/explicit model               | output budget 256                | generateText                          | commit result provenance           | Main session thought unchanged            |
| Title/Goal title                      | sidecar                         | request-local            | configured title model/current model | JSON/no tools                    | sidecar request                       | title provenance                   | Reasoning forced off                      |
| Goal verifier                         | runtime verifier                | start-time snapshot      | Session model                        | verifier policy                  | verifier request                      | goal execution                     | Does not follow mid-run model switches    |
| Compact                               | compact runtime                 | request-local            | current model                        | context/output budget            | compact request                       | compact timeline                   | Creates no ordinary user row              |
| Project memory                        | memory helpers                  | request-local            | current model                        | memory policy                    | generateText                          | memory result                      | Creates no extra product turn             |
| Connectivity                          | provider/model test             | request-local            | explicit model                       | credentials/provider facts       | connectivity service                  | result only                        | Session model unchanged                   |
| CLI/TUI                               | `/model`, `/effort`, `/variant` | CLI config               | CLI current config                   | runtime validation               | CLI command                           | CLI runtime                        | Verified separately from the UI display   |

Shared UI does not mean shared behavior. `ModelConfigSelect`, `buildModelSelectGroups` and `useModelSelectionView` share only the candidate source or display conventions; each surface's draft, default, commit and persistence must be asserted independently.

## 3. State Owners, Validation Points and Persistence

| State/fact           | Authority                             | Mirrors/cache                   | Validation/commit                            | Persistence                                 |
| -------------------- | ------------------------------------- | ------------------------------- | -------------------------------------------- | ------------------------------------------- |
| Provider/Model facts | target Host Provider Registry         | Settings/Selection facade       | `ProviderConfigResolver`, `validateComplete` | Built-in/Account/Personal config            |
| User selection       | surface-local draft or product record | toolbar, form, recent           | target Worker Registry + ModelFactory        | Session/Automation/Subagent/Off-Peak record |
| Active Model         | CLI runtime                           | Snapshot, usage, provenance     | ModelFactory, Adapter capability checks      | session model timeline / message provenance |
| Session config       | CLI Session runtime                   | Conversation Snapshot, Renderer | V4 command barrier/CAS                       | Session persistence                         |
| Queue Submission     | CLI CommandInbox/FIFO                 | renderer optimistic journal     | admission/queue guard                        | queue facts/discard ledger                  |
| Recent selection     | workspace-keyed renderer storage      | draft initializer               | selectable check                             | workspaceKey: identity trim, otherwise path |
| Plan/entitlement     | Account/plan services                 | provider UI badges/usage        | account/provider access resolution           | account settings/usage data                 |
| Request auth         | execution service/provider access     | request-local only              | fail before network                          | Dynamic credentials are not persisted       |
| Delivery profile     | trusted Host attachment               | connection subscription         | host injection                               | Not chosen by the renderer                  |

## 4. Delivery Boundary

```text
desktop / SSH / WSL / Docker
  -> window-scoped Local Host
  -> Local Agent or Remote Workspace connection
  -> desktop-continuous

mobile /remote
  -> attach existing shared host
  -> same CLI Session Runtime
  -> web-remote-replayable
```

Must hold:

- The relay and main only do authentication, pairing, heartbeat, passthrough and attachment scheduling; they own no Session/Task/Queue/Snapshot.
- Mobile does not start its own Agent, Local Host or independent remote runtime.
- Desktop continuous and mobile replayable are two delivery contracts and must not be stitched together.
- Remote requests carry `workspaceIdentity` and `remoteSessionId` end to end.
- `workspacePath` is for execution and display; `workspaceIdentity` is for identity isolation and keys.
- Accepted input has exactly one authoritative FIFO: the CLI/runtime CommandInbox.

## 5. Factors and Combination Strategy

The full factor list is maintained in the [YAML catalog](./model-selection-regression-factor-catalog.yaml); the first-level dimensions are:

```text
surface × operation × provider/access/entitlement
        × api/auth/endpoint
        × model capability/reasoning/max-output
        × selection/default/draft/session/queue
        × recovery/persistence/delivery/workspace
```

No direct global Cartesian expansion. Models use the following equivalence-class signature:

```text
provider access profile
+ API transport profile
+ auth profile
+ model capability profile
+ reasoning wire profile
+ context/max-output profile
+ lifecycle/recovery profile
+ product operation profile
```

Generation rules:

1. First round pairwise, covering every behavior dimension and shared owner.
2. 3-wise for high-risk relations such as Provider/API/reasoning, Registry/session/queue, remote/recovery.
3. Full Cartesian only inside explicitly declared cross-products.
4. Presentation dimensions (color, theme, language, viewport, keyboard/mouse) use shared-UI representatives and are not crossed with all models.
5. Only `accepted` enters formal E2E; `undefined` needs a decision first; `bug-candidate` becomes a regression after the product contract is confirmed.
6. Every pruning needs an explicit guard or invariant; "too many combinations" is not a reason to delete.

## 6. First Batch of High-Risk Cases

The YAML already holds the complete seed cases. The main line to land first:

| Case             | Scenario                                            | Evidence focus                               |
| ---------------- | --------------------------------------------------- | -------------------------------------------- |
| MSR-REG-001      | Personal custom Provider selected and first send    | UI, Registry, real request body, persistence |
| MSR-REG-002      | Same-named models under two Providers               | full provider/model identity                 |
| MSR-REG-003      | Remote Registry loading does not fall back to local | target Host authority                        |
| MSR-REG-004      | Built-in/Account revision mismatch                  | atomic Registry publish                      |
| MSR-AUTH-002     | entitlement loading keeps the saved selection       | plan gating                                  |
| MSR-REASON-001   | GLM-5.2 max/high/nothink                            | reasoning wire mapping                       |
| MSR-REASON-002   | Qwen/Kimi/MiMo toggle                               | extra-body minimal projection                |
| MSR-REASON-003   | Anthropic fixed/adaptive budget                     | max output and thinking budget               |
| MSR-REQ-001      | modality/tool/structured output                     | adapter preflight + request body             |
| MSR-DRAFT-002    | First send after a draft model switch               | createSession/firstInput freeze              |
| MSR-SESSION-002  | noop/stale/duplicate/failed switch                  | protocol ACK/CAS                             |
| MSR-SESSION-003  | switch barrier races with send                      | command ordering                             |
| MSR-SESSION-004  | provider.notInRegistry one refresh/retry            | remote identity                              |
| MSR-SESSION-005  | model switch during streaming                       | in-flight model immutability                 |
| MSR-QUEUE-002    | Desktop + mobile busy input share one FIFO          | CommandInbox + delivery                      |
| MSR-RECOVERY-001 | Anthropic unsigned reasoning repair                 | canonical history immutability               |
| MSR-RECOVERY-002 | empty completion retry                              | exactly-once output                          |
| MSR-REMOTE-001   | remote workspace identity isolation                 | workspaceKey + reconnect                     |
| MSR-SURFACE-001  | Automation runs after save                          | record/run snapshot                          |
| MSR-SURFACE-002  | Subagent inherited/explicit model                   | child authority/provenance                   |
| MSR-OFF-001      | hidden Off-Peak provider internal execution         | hidden Registry + ticket                     |
| MSR-SIDE-001     | title forces no reasoning                           | sidecar projection                           |
| MSR-SIDE-002     | Git commit explicit thought semantics               | querySource-specific behavior                |

## 7. Implicit Decision Audit Result

An earlier version listed only 3 hard blockers, which over-compressed the scope. The separately maintained decision backlog now has 114 items, but they do not all need a product ruling one by one:

| Category               | Count   | Meaning                                                                  | Next step                                                   |
| ---------------------- | ------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `undefined`            | 64      | Real product behavior is undefined, must be ruled first                  | Rule on 3-7 per round                                       |
| `contract-conflict`    | 12      | New/old specs, implementation and existing cases contradict each other   | Fix the authoritative reading first, then update docs/tests |
| `resolved-needs-proof` | 38      | Strong design or implementation leaning exists; do not ask product again | Prove with unit/integration/E2E/logs                        |
| **Total**              | **114** |                                                                          |                                                             |

### 7.1 The 12 contract conflicts to converge first

- Registry: `DEC-019`, `DEC-020`, `DEC-021`: whether old legacy sources, identity scope and atomic publish are still valid.
- Entitlement: `DEC-030`: whether the silent fallback of old I56/I58/I61 is still current behavior.
- Reasoning: `DEC-041` is ruled as a frozen Submission; at queue consumption the latest Session Selection must not rewrite the Provider, Model and thinking depth of an already queued item.
- Session: `DEC-046` is ruled that the Provider, Model and thought of a queue item are frozen at admission.
- Product surface: `DEC-065`, `DEC-066`, `DEC-067`: Automation/Subagent inheritance and the Recent write point.
- Migration: `DEC-091`, `DEC-092`: how old snapshots/cases are reclassified and migrated.

The current evidence chain for the Queue conflict:

```text
accepted input
      │
      ▼
CommandInbox admission
      │ freeze complete Submission: provider/model/thought
      ▼
queue wait ───────────────┐
                          │ refresh latest provider facts/credentials only
                          ▼
                   ModelFactory
                          │
                          ▼
                 request + provenance

desktop-continuous  ─────┐  same business facts
web-remote-replayable ───┘  only the delivery and recovery boundary of snapshot/gap/owner changes
```

The newer Provider interaction design, `conversation-product-state-space.md` and the current `input-intent.ts` all support a frozen Submission; `conversation-protocol-declaration.md` / `conversation-product-protocol.md` have been unified to `queuedSubmissionPreservesSelection`. So `MSR-QUEUE-001` and related items may enter formal E2E with frozen Submission semantics.

### 7.2 The 64 edge domains that really need product decisions

Full questions, options, recommendations, evidence and blocking cases are expanded per item in the backlog. Coverage:

1. Empty selection, Recent, Host preferred, provider default, same-named provider/model and atomic draft rollback.
2. Registry changes after the picker opens, disabled/deprecated, revision, old snapshots and remote target Host authority.
3. entitlement loading, account switching, OAuth refresh, personal key / team proxy, org policy and operation-level capability.
4. missing/default/explicit-off thought, effort/budget priority, nothink wire, conflict between reasoning and tools/schema.
5. Queue admission, FIFO, Guide boundary, cancel/stop/timeout, Edit/Retry, compact, Goal and internal Submissions.
6. Automation, Subagent, Off-Peak, Bot/TUI/CLI, MCP, Git commit, Title, Verifier, Memory.
7. desktop continuous and mobile replayable, shared-host attachment, workspaceIdentity, remoteSessionId, owner/lease, gap recovery.
8. Long-list sorting/search/keyboard/touch/accessibility, dual theme/i18n/narrow screen, plus migration, correlation ID, redacted logs, error classification and pruning report.
9. Node persistence: schema/corruption/legacy import/watcher/dispose of the Configured Default, and Bundled/Active/LKG, revision, retired provider, remote refresh lease, backoff and atomic write of the Built-in Release.

Suggested first-round rulings, whose answers most strongly affect Cartesian pruning:

1. `DEC-046`: ruled; the Queue freezes the Submission Selection; Provider config reads the latest facts at Model creation.
2. `DEC-067`: whether Recent is written at the picker, the switch ACK or an accepted Submission.
3. `DEC-030`: whether an unavailable explicit model may silently fall back.
4. `DEC-066`: the inheritance source of a Subagent without an explicit model.
5. `DEC-001`: empty state and send behavior when no selectable model exists.
6. `DEC-016`: whether a Provider endpoint/config change affects the Active Model.
7. `DEC-091`: how to restore when an old snapshot lacks provider/thought information.

### 7.3 29 items with an established reading that need evidence

These are not "one more product preference to ask" but need tests or runtime evidence: structured round-trip of ModelSelection, the accepted-Submission timing of Recent, immutability of the Active Model against Provider config, reasoning repair, Edit/Retry copying the complete selection, cross-client queue provenance, Automation/Subagent/Off-Peak isolation, remote snapshot authority, workspaceKey migration, redacted logs and the pruning report.

## 8. Graph Drift and Scope Gaps

- There is no live codegraph index now, so the code evidence in this directory is marked source-reading/rg evidence; an unindexed graph must not be misread as a missing feature.
- `OffPeakEditView` is an actual model-selection entry, but the feature graph describes its independent surface incompletely.
- Login, Bot, official MCP, Git commit, title, Goal verifier and Project memory are all actual model consumers, but the current graph expresses only part of their semantic edges to model-selection.
- Old client-config, `magic_name`, fallback and tombstone paths serve only as migration/legacy boundaries and must not remain a source of the current Provider Registry.
- The new backlog records implicit edges found across spec, resolver, input-intent, ModelFactory and case catalog beyond the code graph, and does not hide them in a single `surface` factor.
- `packages/provider-node` is not simple file storage: it decides the Configured Default, Bundled/Active Release, remote sync lease and the startup availability of the Registry; hence `DEC-098`-`DEC-114` were added, and covering only the renderer picker is not enough.

## 9. E2E Handoff Rules

Formal model-focused E2E follows the existing conversation E2E workflow:

1. An accepted case first writes setup/action/assertion and at least one non-UI evidence layer.
2. Provider requests use a case-local fixture; ordinary features use `fast-text`, timing scenarios `controlled-stream`, fault scenarios `fault-stream`.
3. UI-only picker/keyboard cases declare `providerRequestPolicy: none` explicitly; an empty fixture must not mask a missing setup.
4. Desktop cases default to `desktop-continuous`; Remote cases additionally verify the snapshot/gap/owner boundary of `web-remote-replayable`.
5. Only representative cases of provider/model capability signatures go into E2E; mapping details are covered by provider-unit and adapter-wire tests.
6. Pass fixture check and local replay first, then enter formal promotion / the Docker preset.

No `manual-review/pending` spec is generated now because the Queue contract, old fallback, Recent timing, Subagent/Automation inheritance, legacy snapshot migration and others still have undecided or conflicting items. After those are ruled, the accepted cases of the YAML are backfilled into the focused case catalog and coverage matrix.

## 10. Next Execution Order

```text
YAML factor catalog
        │
        ▼
backfill decisions (undefined / contract-conflict)
        │
        ▼
implementation proof (resolved-needs-proof)
        │
        ▼
generate legal combinations + pruning report
        │
        ▼
dispatch by owner: unit / integration / desktop E2E / remote replay
        │
        ▼
backfill conversation case catalog + coverage matrix
```
