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

M1 has established a unified `Model` / `ModelRequest` invocation boundary. Production model requests from main Agent, Compact, Subagent, Title, Goal, Memory, model-type tools, Git, workspace generateText, and Repo Wiki have all entered this path. Production code scanning found no business clients still bypassing Model and directly calling OpenAI, Anthropic, or other Provider SDKs.

This review found no P0 issues. P0 here refers to issues that would cause main model invocation to become unavailable in large-scale environments, cause data destruction or loss, leak credentials, fail security boundaries, or simultaneously disable major entry points like Desktop, CLI, and Remote. There is currently no such evidence.

The highest priority issue is that Workflow Child production assembly does not carry the formal `modelFactory`. It still creates Models through Core's compatibility factory, breaking the completion condition that "formal runs uniformly obtain immutable Models from Model Factory." This is a well-scoped P1 closure gap: it may cause Workflows to be affected by Registry updates within the same Loop, but will not disable ordinary Agent main chains or the entire product.

Therefore, M1's more accurate status is:

```text
Public invocation boundary     Completed
Production call entry migration Completed
Ordinary Agent lifecycle       Completed
Production assembly closure    Still has Workflow gap
Historical compatible entry    Not completed
```

A short M1.1 closure is recommended, without reopening the entire M1 or mixing these issues into M2 Registry design.

## Review Scope

This review revolves around four questions: whether phase goals are fully implemented, whether model calls still have side paths, whether migration changes existing functional semantics, and whether the new boundary truly prevents old designs from continuing to spread.

The check covers production `AgentRuntime` construction locations, `Model` creation and invocation points, Model Properties and Options validation, dynamic header refresh, Guide's Loop behavior, Usage / Trace attribution, and Repo Wiki migration results. CLI changes merged in the latest `staging` are concentrated in Desktop presentation context and do not change M1's Model, Adapter, or Workflow assembly conclusions.

## P1: Workflow Child Does Not Enter Formal Model Factory

The ordinary Runtime assembly chain is now clear:

```text
createZCodeApp
    |
    v
Runtime Model Factory
    |
    v
AgentRuntime
    |
    v
Loop holds immutable Model
```

Direct Expert Workflow and Script Workflow Children, however, only inject `modelAdapter` into the new `AgentRuntime`:

```text
Parent Agent Runtime
    |
    +-- Ordinary Subagent
    |      └─ Inherits or obtains formal Model Factory
    |
    +-- Direct Expert Workflow Child
    |      └─ modelAdapter -> Core Compatibility Model
    |
    └-- Script Workflow Child
           └─ modelAdapter -> Core Compatibility Model
```

Corresponding code located in:

- `apps/zcode-cli/packages/bootstrap/src/app/workflow-facade.ts`
- `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-child-runtime.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/runtime-model.ts`

The compatible Model still satisfies the surface interface of `Model.generateText()` / `streamText()`, so ordinary model call scanning will not identify it as a side path; the difference lies in how the Model is formed. The compatible path uses loose default values and re-queries the mutable Registry at Adapter invocation time. As long as `providerId/modelId` has not changed, API Key, Endpoint, or physical Provider object updates may affect a running Workflow Loop.

This is inconsistent with M1's lifecycle goal:

```text
Expected
Loop start -> Create Model A -> All Steps use A -> Loop end

Workflow current risk
Loop start -> Compatibility Model
          -> Step 1 queries Registry A
          -> Registry updates
          -> Step 2 queries Registry B
```

Both types of Workflow Children need to explicitly obtain the formal Model Factory. Tests should cover scenarios where the Registry changes during the Child Loop: model identity, connection, and bound Options should remain stable; when a Child explicitly selects another model, a new Model is created from the formal factory.

## P1: "Unknown" Property May Be Interpreted as "Not Supported"

M1 has Models uniformly validate images, PDFs, Tool Calls, and Structured Output before requests are sent. This boundary itself is valid, but the current Catalog merge result uses boolean values to express capabilities, and some unknown facts are filled as `false`. Once this value enters Model Properties, requests are hard-rejected.

```text
Catalog has no explicit fact
        |
        v
Merge result filled with false
        |
        v
Model Property = false
        |
        v
Request rejected before Adapter
```

The most obvious risk scenario is custom models not yet cataloged but actually supporting images or PDFs. The old chain might hand the request to the Provider, while the new chain might pre-reject based on the default `false`. Structured Output has the same modeling problem; currently, the Memory Selector that actually sends JSON Schema sits in a default-disabled Semantic Recall branch, so it is not currently an online P0, but must be handled before enabling that branch in the future.

Tool Call's default is currently `true`, with no similar regression; explicitly configured as `false`, Coding Agent tool requests are correctly rejected per declared semantics.

Simply removing unified validation is not appropriate here. Each Property needs a separately confirmed fact source and unknown state strategy: which capabilities are hard prerequisites for entering the Registry, which can still attempt when facts are missing, and which need three-state expression. Until this ruling is complete, no new hard validation fields should be added.

## P2: Guide's Model Semantics Have Changed, But Product Semantics Remains Undecided

M1 fixed the Agent Loop's Model. The Guide, however, inlines a user input within the current Loop without starting a new one. When a user selects model B before sending a Guide, the Session Selection can update to B, but the current Loop still holds A:

```text
Turn start, bound to Model A
        |
        v
User selects Model B in Composer
        |
        v
Guide inlines current Turn
        |
        +-- Current Turn continues using A
        |
        └-- Next new Turn uses B
```

This conforms to M1's rule of "stable model identity within one Loop," but may not match the product mental model of Guide/"immediate." If the product ultimately requires Guide to switch models immediately, it needs to be defined as an explicit Model switch boundary within the current Loop, simultaneously updating the current Selection, Model, Usage, and "model switched" message. This decision belongs to the Submission / Guide topic; M1 should not resolve it by restoring per-Step reading of Session default models.

It is currently a localized, expected behavioral difference, not a P0.

## P2: Dynamic Header Refresh Still Reacquires Full Provider Object

Start Plan and other Providers need to refresh one-time headers before each physical request. The current Adapter re-resolves the same `providerId/modelId` from the Registry after refresh, and only checks that model identity has not changed:

```text
Bound Model A
    |
    v
Refresh one-time header
    |
    v
Re-resolve providerId/modelId
    |
    +-- Identity same: accept new Resolved Model
    └-- Identity different: error
```

This preserves existing Plan behavior, but the refresh scope is larger than "only update dynamic authentication material." The same model's Endpoint, API Key, or Provider instance may also enter the current Loop with Registry updates. It extends the behavior of the old Plan chain and is not a universally introduced regression by M1; from the target architecture perspective, it still weakens Model immutability.

When subsequently refactoring Builtin Provider / Adapter, separate dynamic authentication material refresh from full Model/Connection re-parsing. This phase is not the time to change Plan's authentication protocol.

## P2: Compatible Entry Points Still Too Easy to Enter

Core currently accepts `modelFactory` or `modelAdapter`, automatically entering compatible Models when no Factory is provided. This design ensures old tests and embedding calls continue running, but also prevents production Workflow assembly omissions from being discovered by the type system or startup checks.

Additionally, a small number of Core capabilities use the existence of `modelAdapter` as an availability check, and `AgentRuntimeDeps` also retains migration fields such as `modelConnectionPort`, Runtime limits, and Provider Options. The current formal Runtime has both Adapter and Factory, so these remnants do not cause main chain functional failures; they will impede M2 from establishing a Runtime that depends only on Model source.

M1.1 should separate production and compatible assembly: production-executable Runtimes must provide a formal Model Factory; true state-only Runtimes and test-compatible objects use explicitly named construction paths. How long the compatible entry is retained can be separately determined, but it should no longer be implicitly triggered by the absence of an optional field.

## Parts Confirmed Not to Form Side Paths

Repo Wiki has deleted its own Provider client and uses CLI-internal Models through `workspace/generateText`. Truncation recovery still belongs to Repo Wiki's business strategy; the Model only returns `finishReason` and Usage. When the old app-server lacks `finishReason`, explicit failure is a confirmed compatibility boundary, not a regression newly discovered by this review.

Main Agent, ordinary Subagent, Automatic / Micro / Reactive Compact, Title, Goal verifier, Project Memory, WebFetch / WebSearch, Git Commit Message, and workspace generateText all initiate requests through Model. Provider-specific reasoning parameters are still converted by the Adapter path and not re-exposed to business callers.

Usage, Trace, and message persistence already attribute to the actual execution Model. Current scanning found no production paths that read Composer or mutable Session default models after request completion to record Usage.

## P0 Judgment and Confidence Boundaries

No P0s have been confirmed. All discovered issues have clear scoping: Workflow assembly only affects Workflow Child; Property defaults primarily affect some custom multimodal models and default-disabled Semantic Recall; Guide only affects current Turn inline input; dynamic header risk only exists for Providers needing pre-request authentication material refresh.

This is not "proven that no P0s exist at all." The judgment is based on static production call scanning, construction chain checks, full and key test records before and after M1 merge, and incremental review of the latest staging. The current environment previously had some tests that could not be re-run due to insufficient disk space, and the repository also has pre-existing failures unrelated to Providers, so confidence still needs to be raised through targeted testing of Workflow and custom multimodal models.

If severity is ranked by current evidence:

| Level | Conclusion                                                                | Impact                                                                             |
| ----- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| P0    | Not found                                                                 | No evidence of large-scale unavailability, data destruction, or security incidents |
| P1    | Workflow Child not using formal Factory                                   | May mix updated connections or configs within the same Workflow Loop               |
| P1    | Unknown Properties hardened to `false`                                    | May reject actually working custom image/PDF models                                |
| P2    | Guide continues using current Loop Model                                  | Product semantics undecided, affects local interaction                             |
| P2    | Dynamic header refresh reacquires full Provider                           | Inherits risk, affects immutability of special Plan Providers                      |
| P2    | Compatible entry and old dependencies can still enter production assembly | Incomplete closure, increases subsequent migration risk                            |

## Recommended M1.1 Closure Order

The first step fixes Workflow Child's formal Model Factory assembly and establishes lifecycle tests. This is the only structurally confirmed gap entering production functionality.

The second step defines unknown state strategies for each Property per item, prioritizing verification of custom image/PDF models; keep Semantic Recall disabled until Structured Output strategies have test protection.

The third step makes the production Runtime's Model Factory requirement a mechanical constraint, so the compatibility factory only serves explicit compatibility scenarios. Then delete Core remnants that judge model capabilities by old Adapter existence.

Guide and dynamic Plan Header are left for Submission and Builtin Provider topics separately. They need explicit product/protocol semantics and should not be combined with Workflow closure.

M1.1 completion conditions:

- All production `AgentRuntime`s that execute model requests explicitly obtain a formal Model Factory.
- Workflow Children continue using the Model facts and connections from creation time during Registry updates.
- Custom model images, PDFs, and Structured Output are not incorrectly judged as "not supported" due to "missing facts."
- Compatible Model entry conditions are explicitly visible in code, with tests proving production assembly does not fall into this path.
- Unresolved semantics of Guide and dynamic headers remain in their respective subsequent topics, without changing behavior through temporary fallbacks.
