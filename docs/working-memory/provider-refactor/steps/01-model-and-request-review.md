# M1 Comprehensive Review

> Status: Historical review snapshot; current phase conclusions see [`01-model-and-request.md`](./01-model-and-request.md)
>
> Date: 2026-08-13
>
> Implementation target: [`01-model-and-request.md`](./01-model-and-request.md)
>
> Target design: [`../design/model/model.md`](../design/model/model.md)
>
> Implementation facts: [`01-model-and-request-implementation-log.md`](./01-model-and-request-implementation-log.md)
>
> Subsequent ruling: Guide/"immediate" was determined to take effect within the current Loop, see [`../design/interaction/interaction.md`](../design/interaction/interaction.md). The main text preserves the unresolved state at the time of review.
>
> Review baseline: M1 merge commit `84f12ba306`, latest `staging` `bfc91c54a9`

## Conclusion

M1 established a unified `Model` / `ModelRequest` invocation boundary. Production model requests from main Agent, Compact, Subagent, Title, Goal, Memory, model-type tools, Git, workspace generateText, and Repo Wiki all entered this path; scanning found no business clients still bypassing Model to call OpenAI, Anthropic, or other Provider SDKs directly.

No P0 found (P0 = large-scale main-model-invocation unavailability, data destruction/loss, credential leaks, security-boundary failure, or simultaneous disablement of major entry points like Desktop/CLI/Remote). Status at review time:

```text
Public invocation boundary       Completed
Production call entry migration  Completed
Ordinary Agent lifecycle         Completed
Production assembly closure      Still has Workflow gap
Historical compatible entry      Not completed
```

## P1: Workflow Child Does Not Enter Formal Model Factory

Ordinary Runtime assembly: `createZCodeApp` → Runtime Model Factory → `AgentRuntime` → Loop holds immutable Model. Direct Expert Workflow and Script Workflow Children, however, only inject `modelAdapter` into the new `AgentRuntime` (`apps/zcode-cli/packages/bootstrap/src/app/workflow-facade.ts`, `script-workflow-child-runtime.ts`; `apps/zcode-cli/packages/core/src/runtime/methods/runtime-model.ts`). The compatible Model satisfies the `Model.generateText()` / `streamText()` surface, so ordinary call scanning does not flag it; the difference is that it uses loose default values and re-queries the mutable Registry at Adapter invocation time — API Key, Endpoint, or physical Provider object updates can affect a running Workflow Loop:

```text
Expected
Loop start -> Create Model A -> All Steps use A -> Loop end

Workflow risk
Loop start -> Compatibility Model
          -> Step 1 queries Registry A
          -> Registry updates
          -> Step 2 queries Registry B
```

Both Workflow Children need to explicitly obtain the formal Model Factory. Tests should cover Registry changes during the Child Loop: model identity, connection, and bound Options stay stable; a Child explicitly selecting another model creates a new Model from the formal factory.

## P1: "Unknown" Property May Be Interpreted as "Not Supported"

Models uniformly validate images, PDFs, Tool Calls, and Structured Output before requests — valid boundary, but the Catalog merge result uses booleans, and some unknown facts are filled as `false`, which then hard-rejects requests. Most obvious risk: custom models not yet cataloged but actually supporting images or PDFs (the old chain handed the request to the Provider; the new chain pre-rejects on default `false`). Structured Output has the same modeling problem — the Memory Selector sits in a default-disabled Semantic Recall branch, so not an online P0, but it must be handled before enabling that branch. Tool Call's default is `true` (no similar regression); explicitly configured `false` correctly rejects tool requests.

Removing unified validation is not appropriate. Each Property needs a separately confirmed fact source and unknown-state strategy: which capabilities are hard prerequisites for the Registry, which may still be attempted when facts are missing, which need three-state expression. Until that ruling is complete, no new hard validation fields should be added.

## P2: Guide's Model Semantics Changed, Product Semantics Undecided (at review time)

M1 fixed the Agent Loop's Model; Guide inlines user input within the current Loop. A user selecting model B before sending a Guide updates the Session Selection, but the current Loop still holds A — the current Turn continues using A, the next new Turn uses B. This conforms to "stable model identity within one Loop" but may not match the product mental model of Guide/"immediate". If the product requires immediate switching, it needs an explicit Model switch boundary within the current Loop, simultaneously updating Selection, Model, Usage, and the "model switched" message — a Submission/Guide topic decision, not a per-Step read restoration. (Subsequently ruled: switching takes effect from the next Model Step within the current Loop.)

## P2: Dynamic Header Refresh Still Reacquires Full Provider Object

Start Plan and similar Providers refresh one-time headers before each physical request; the Adapter re-resolves the same `providerId/modelId` from the Registry after refresh and only checks identity: identity same → accept the new Resolved Model; different → error. This preserves Plan behavior, but the refresh scope exceeds "only update dynamic authentication material" — the same model's Endpoint, API Key, or Provider instance can enter the current Loop with Registry updates. It extends the old Plan chain rather than being a universal M1 regression, but weakens Model immutability. The Builtin Provider / Adapter refactor should separate dynamic authentication material refresh from full Model/Connection re-parsing.

## P2: Compatible Entry Points Still Too Easy to Enter

Core accepts `modelFactory` or `modelAdapter`, automatically entering compatible Models when no Factory is provided — old tests keep running, but production Workflow assembly omissions escape the type system and startup checks. A few Core capabilities also use `modelAdapter` existence as an availability check, and `AgentRuntimeDeps` retains migration fields (`modelConnectionPort`, Runtime limits, Provider Options). These remnants cause no main-chain failures but impede M2's Model-source-only Runtime. M1.1 should separate production and compatible assembly: production-executable Runtimes must provide a formal Model Factory; compatibility objects use explicitly named construction paths — compatibility must not be implicitly triggered by an optional field's absence.

## Confirmed Not Side Paths

- Repo Wiki deleted its own Provider client and uses CLI-internal Models through `workspace/generateText`; truncation recovery stays a Wiki business strategy; explicit failure on old app-server responses missing `finishReason` is a confirmed compatibility boundary.
- Main Agent, ordinary Subagent, Automatic/Micro/Reactive Compact, Title, Goal verifier, Project Memory, WebFetch/WebSearch, Git Commit Message, and workspace generateText all request through Model; Provider-specific reasoning conversion stays in the Adapter.
- Usage, Trace, and message persistence attribute to the actual execution Model; no production path reads Composer or mutable Session default models after request completion to record Usage.

## Severity Summary

| Level | Conclusion                                                                | Impact                                                                             |
| ----- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| P0    | Not found                                                                 | No evidence of large-scale unavailability, data destruction, or security incidents |
| P1    | Workflow Child not using formal Factory                                   | May mix updated connections or configs within the same Workflow Loop               |
| P1    | Unknown Properties hardened to `false`                                    | May reject actually working custom image/PDF models                                |
| P2    | Guide continues using current Loop Model                                  | Product semantics (since ruled); affects local interaction                         |
| P2    | Dynamic header refresh reacquires full Provider                           | Inherited risk; affects immutability of special Plan Providers                     |
| P2    | Compatible entry and old dependencies can still enter production assembly | Incomplete closure; increases subsequent migration risk                            |

Confidence boundary: "no P0 found" rests on static production call scanning, construction-chain checks, full and key test records, and incremental staging review — not a proof that none exist. Targeted testing of Workflow and custom multimodal models was still needed.

## Recommended M1.1 Closure Order

1. Fix Workflow Child's formal Model Factory assembly and establish lifecycle tests (the only structurally confirmed gap entering production functionality).
2. Define unknown-state strategies per Property, prioritizing custom image/PDF models; keep Semantic Recall disabled until Structured Output strategies have test protection.
3. Make the production Runtime's Model Factory requirement a mechanical constraint; delete Core remnants that judge model capabilities by old Adapter existence.

Guide and dynamic Plan Header belong to the Submission and Builtin Provider topics — not to be combined with Workflow closure. M1.1 completion conditions: every production `AgentRuntime` executing model requests explicitly obtains a formal Model Factory; Workflow Children keep creation-time facts and connections during Registry updates; custom model images/PDFs/Structured Output are not misjudged "unsupported" due to missing facts; compatible entry conditions are explicitly visible with tests proving production assembly never falls into that path; unresolved Guide/dynamic-header semantics stay in their topics without temporary fallbacks.
