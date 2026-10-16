# M1 Implementation Log

> Status: Phase audit and gap fixes completed
>
> Start date: 2026-08-11
>
> Implementation target: [`01-model-and-request.md`](./01-model-and-request.md)
>
> Target design: [`../design/model/model.md`](../design/model/model.md)
>
> Subsequent ruling: Guide/"immediate" was determined to take effect within the current Loop, see [`../design/interaction/interaction.md`](../design/interaction/interaction.md). The main text preserves the unresolved state at the time of implementation.

This document records decisions made independently during implementation that went beyond the original plan but were necessary to continue progress. The starting baseline, verification results, and progress checklist are preserved as implementation evidence for M1; subsequent phase implementation logs no longer record normal commits and routine command output item by item.

Implementation logs do not modify existing designs. When conflicts arise, the phase design takes precedence, and conflicts are handed off to phase review or subsequent Design discussions.

## Continued Implementation After Completion Audit

On 2026-08-12, after re-auditing based on phase completion criteria, it was confirmed that the model invocation entry point had converged, but the following semantics were not yet closed:

- Microcompact and Reactive Compact did not fully inherit the Model held by the current Agent Loop.
- Child Agents that did not explicitly select a model could still re-select from mutable Session defaults.
- Context Usage, Compact persistence, and some Sidecar Usage could still record the ModelRef before the request, rather than the actual Model.
- `workspace/generateText` still mixed current Runtime model properties when creating the target Model.
- After Repo Wiki migration, error boundaries needed reconfirmation: public error categories must be preserved, but Provider-echoed source code must not be written to logs or persisted tasks.

All these issues are directly ruled by the existing implementation constraints of `01-model-and-request.md`. This round continues implementation without adding new phase design.

Whether Guide/"immediate" replaces the Model within the current Loop remains an unresolved item explicitly retained in the phase document. The current implementation fixes the Loop Model, which already differs from the old per-Step reading behavior; this round does not arbitrarily choose Guide semantics when fixing other lifecycle issues, and instead preserves the current state while continuing to document differences here.

Pre-request Property validation has been implemented per phase design. Whether validation failures use errors, fallback, or only log observable events remains an undecided unified ruling; this round only supplements inheritance and attribution, without expanding this policy.

## Starting Baseline

Before implementation, `origin/staging`'s `38d37ca50a` was merged into `provider-refactor`, with the merge commit being `07e4ba350f`. The merge produced no conflicts.

When completion audit was reached, `origin/staging` had already advanced to `d8cf5a49a7`. The current branch merged again, and workspace changes were restored as-is via Git autostash; the added Core token estimate fix and M1's Model invocation boundary have no design conflicts.

The latest staging deleted some request shapes and tool admission auxiliary logic, and simplified several model invocation tests. The main chain still retains the following facts:

```text
Business callers
    -> ModelTextRequest (carrying model / providerOptions / transport controls)
    -> AiSdkModelAdapter
    -> Each request resolves ModelRef from mutable Registry
    -> Provider SDK
```

Therefore M1's target does not need adjustment. Implementation must avoid re-introducing the recently deleted old auxiliary abstractions, and instead directly establish new boundaries using the final `Model` / `ModelRequest` contract.

## Independent Decisions During Implementation

### 1. Existing Adapter as the First Version Model's Execution Core

M1 does not rewrite Provider SDK, stream recovery, header refresh, and error normalization. The first version Model wraps the existing `AiSdkModelAdapter` within the Adapter package; business callers only contact the new Model interface. The old `ModelTextRequest` temporarily becomes Adapter-internal compatible input, and gradually exits the business boundary as M1 callers migrate.

### 2. Fixed Ordinary Registry Resolution Result at Model Creation Time

Ordinary Models resolve Provider, model, capability, and connection information once at creation time. After the Agent Loop holds that Model, subsequent Steps no longer re-decide model identity or ordinary API Key from the mutable Registry. Configuration changes only affect subsequently created Models.

Dynamic Header links such as Start Plan still allow the Adapter to update request-level authentication material after explicit execution header refresh. This exception must not change the Model's `providerId`, `modelId`, Properties, and Options.

### 3. Transport Controls Remain Inside the Model Implementation

`statusSink`, Trace, stream recovery, idle timeout, Provider stream boundary, and runtime header refresh do not enter the public `ModelRequest`. The first version implementation receives these capabilities through an internal execution context injected at Model creation time. Business callers cannot freely assemble transport parameters per request.

### 4. ModelResult and ModelEvent First Converge Semantics, Then Clean Up Old Names

M1.1 uses the currently normalized `ModelTextResult` and `ModelStreamEvent` fields as the migration basis, defines the final public names, and removes input that business sides should not control. Provider SDK raw types remain isolated by the Adapter. After completing caller migration, delete aliases and request types that serve only the old `ModelPort`.

### 5. Properties Derived from Existing Capabilities and Connection Judgment

`contextWindow`, images, PDF, Tool Call, and Structured Output first reuse existing `ModelCapability` facts; Native Web Search and Mid-conversation System reuse the current judgment logic at Model creation time. Core subsequently only reads Model Properties, and no longer infers capabilities from Provider kind, URL, or model name.

### 6. Repo Wiki Uses Unified Model, No Independent Provider Client Retained

Repo Wiki's access method must be selected based on the actual dependency direction of current Services and Core. Whether it ultimately obtains Model capabilities through the existing workspace protocol, or reuses a lower-level Model implementation, at the end of M1 it must use the same `ModelRequest` semantics, and no longer independently resolves API Key, Endpoint, and protocol requests.

The actual implementation retained existing process boundaries: Services requests CLI through `workspace/generateText`, and CLI internally creates and executes the Model. The client that previously handled API Key, Endpoint, OpenAI/Anthropic requests, Tool loops, and Usage independently for Repo Wiki has been deleted. To preserve cancellation semantics, the workspace request adds an operation id; Host's AbortSignal simultaneously ends local waiting and notifies CLI to abort the corresponding model task.

### 7. Internal Invocation Context Uses AsyncLocalStorage

Transport controls such as Trace, status sink, stream recovery, and header refresh do not enter the public `ModelRequest`. Core writes invocation context at the model invocation boundary, and the Adapter reads it within the same async chain. Stream calls additionally wrap `next`, `return`, and `throw` of AsyncIterator, avoiding the scenario where context is established only at iterator creation time but lost during actual consumption.

### 8. "Disable Reasoning" for Auxiliary Tasks First as Model Construction Intent

Title, Git Commit Message, and Memory Selector previously directly rewrote Anthropic, OpenAI, and OpenAI-compatible parameters in business code. M1 converges callers to `reasoningMode: "disabled"` compatible factory input. The formal Bootstrap factory passes this intent to the Adapter for conversion; the old Provider dialect logic is retained only in the unique compatible Model Factory, for directly constructing Core's old tests and migration calls.

This does not add a public Reasoning level, nor does it change existing user-selectable tiers. Complete Reasoning configuration models remain reserved for subsequent Provider/Registry phases through dedicated research.

### 9. Properties Formed at Model Creation Time

The old Provider kind, URL, and model name judgment for Native Web Search and Mid-conversation System has moved to the Model creation path. Main Agent, Compact, Project Memory, and model-type tools read Model Properties. Non-execution previews in the tool catalog can still use the old connection judgment without a Model; this path does not initiate model requests and waits for M2's Registry/Descriptor to become the formal viewing source before deletion.

### 10. Old ModelPort Reduced to Single Compatible Entry Point

All production callers use `Model.generateText()` or `Model.streamText()`. Direct calls to the old `modelAdapter.generateText/streamText` in Core only exist in the compatibility factory in `runtime-model.ts`, for tests and old embedding calls that construct `AgentRuntime` directly without going through Bootstrap assembly. This single entry point can be deleted entirely when replacing the Model source in the second phase.

### 11. Agent Loop, Compact, and Child Agent Share Immutable Model

Ordinary Agent Loops create a Model at start time; subsequent Steps, automatic Compact, Microcompact, Reactive Compact, and Child Agents that did not explicitly select a model all use that object. Child Agents that explicitly select a model create their own Model. Session default models, Config, or Registry changes during the Loop will not rewrite already-referenced ordinary Models; dynamic Header Providers such as Start Plan still refresh authentication material via the existing pre-request path, but must not change Model identity.

### 12. Execution History and Usage Attributed to Actual Model

Assistant messages, Compact records, Tool persistence diagnostics, Context Usage, Usage Facts, and Trace no longer read mutable `defaultModelRef` after request completion. All these paths receive the actual requesting Model or a ModelRef derived from it. Independent tasks like Title with disabled reasoning form a Model with `reasoningLevel: "disabled"`, so Usage records the actual execution option, not the Session's old reasoning tier.

### 13. Output Budget Selected by Caller, Strictly Validated by Model

Upon review, the initial implementation projected the Provider fixed thinking minimum budget to `maxOutputTokens.min` and provided a public clamp to help callers silently adjust requests. This allowed Provider dialects to leak into the general Model contract, and caused general entry points like `workspace/generateText` to change caller inputs.

The corrected public Options only declare default values and maximums. `maxOutputTokens` represents the total generation hard limit shared by reasoning and final answer; Models only accept positive integers not exceeding the upper limit. Compact, Memory, WebFetch, WebSearch, and ReadSessionContext fixed budgets belong to their respective task strategies, with the caller explicitly selecting the smaller value between task budget and model upper limit. `workspace/generateText` no longer silently adjusts inputs; out-of-bounds requests return errors from the Model.

Existing Adapter reasoning mapping and wire requests remain unchanged. Fixed thinking continues to limit tier budgets to `maxOutputTokens - 1` within the Adapter, without exposing associated constraints as public Option Specs. Native effort/adaptive migration and fixed-budget `3/4` allocation strategy are left for subsequent Adapter topics.

### 14. Repo Wiki Retains Safe Error Boundaries

Repo Wiki already uses CLI-internal Models through `workspace/generateText`. Provider-returned raw exceptions may contain request bodies, and Repo Wiki further persists failure reasons to tasks, so the Services boundary only retains publicly safe HTTP status codes, with all other error bodies normalized to general failure messages. Abort and Repo Wiki's own Deadline errors continue to retain their original control semantics.

### 15. Compatible Old Minimum Model Adapter Injection

The formal production Adapter provides `createModel()` and `resolveConnection()`, and Bootstrap uses the formal Model Factory. Some unit tests and old embedding calls only inject the minimum `generateText/streamText` Adapter; Bootstrap does not install the formal factory for these objects, letting them uniformly fall to Core's single compatibility factory. This branch does not add a second production call chain.

### 16. Truncation Recovery for Repo Wiki Is a Business Strategy

After Repo Wiki migrated to `workspace/generateText`, the unified Model could produce structured `finishReason` and Usage, but the first version of the workspace protocol only returns text and model identity. When the old Wiki client was deleted, truncation upgrade retries relying on `finish_reason=max_tokens` were also lost: catalogs could fail with half JSON, and pages could save half Markdown as successful results.

The fixed workspace results pass through `finishReason` and Usage. Repo Wiki normalizes `length`, `max_tokens`, and `max_output_tokens` to truncation errors at its own invocation boundary, and existing Catalog/Page retry strategies increase the request budget by one tier: Catalog from 16384 to 32768, Page from 8192 to 16384. Upgrades occur at most once, not counting toward user-configured ordinary retries, and final requests are still validated by the Model against the model's `maxOutputTokens` upper limit.

This strategy continues to belong to Repo Wiki. The Model only returns real invocation results and validates requests, without being aware of Wiki's budget upgrades, and does not restore Wiki's old Provider, Endpoint, or protocol clients.

`finishReason` remains optional in the workspace wire schema, allowing other callers that do not depend on end reasons to still read old app-server responses. Repo Wiki cannot safely compatible with results missing that field: half Markdown is structurally still valid, and Services cannot recover completeness facts from the body. Therefore Wiki explicitly fails on old responses, prompting users to update or restart ZCode, without tool fallback or ordinary retries, and does not save this Catalog/Page.

## Post-Implementation Review Conclusions

- The first version of Property conflicts returned `InvalidModelRequest`; no OTEL invariant was added yet. Product fallback strategy still awaits subsequent per-Property decisions.
- Invocation context uses AsyncLocalStorage, covering Promise and AsyncIterable consumption boundaries.
- Dynamic Header Providers can refresh authentication material before Adapter retry; refreshed model identity must match the current Model.
- Repo Wiki accesses through existing Host -> CLI workspace protocol; layered issues did not spread to the public Model interface.
- Old `ModelPort` and `ModelTextRequest` remain Adapter/compatibility factory internal migration objects; business callers no longer construct them.
- Full repository production call scanning found no remaining Repo Wiki/OpenAI/Anthropic direct model clients; scripts, test tools, and historical documents are not counted as production callers.
- Embedded Search still branches on old Connection information, but it does not itself initiate model requests; already recorded as a subsequent Provider/Capability cleanup item, not blocking M1.
- Guide/"immediate" unified to take effect within the Loop: when successfully entering the current Loop, simultaneously switch the Model Selection and Model used by subsequent Loop Steps. Ordinary Submissions still fix their Model at new Loop start time.

### 17. Video Input Enters Unified Model Property

The design document already defined `supportsVideo` as a Model Property, but M1's executable contract initially only implemented images and PDFs. The gap was discovered and filled when M2 prepared to access the Registry Model Factory:

- `ModelProperties` explicitly carries `supportsVideo`;
- Models validate video file input before Provider calls;
- Core's media projection removes original video data and retains a traceable text placeholder when the model explicitly does not support video;
- Old Factory conservatively treats the field as `false` when not yet provided; newly created Models from the Registry must explicitly provide it from complete Model Config.

This change completes the existing Model contract without changing the Provider Config, Registry, or Adapter layering.

## Verification Records

Passed:

- Root workspace `pnpm typecheck`.
- ZCode CLI's Contracts, Adapters, Core, Bootstrap, CLI, and 23 other packages typecheck.
- Root workspace `pnpm lint` (0 errors; existing warnings unchanged).
- Full unit test at root workspace before final staging merge: 1148 files, 9831 passed, 8 skipped.
- Adapter full tests: 75 files, 1159 passed, 3 skipped.
- M1 Core key tests: Model lifecycle, Compact, Memory, WebFetch, WebSearch, ReadSessionContext, etc.
- Services key tests: Git Commit Message, Repo Wiki, ZCode Protocol Client.
- Bootstrap workspace model generation and cancellation protocol tests.
- Full Contract tests and new stream invocation context regression after gap fixes: 28 files, 202 passed.
- Full Adapter tests after gap fixes: 77 files, 1191 passed, 3 skipped.
- Services key tests after gap fixes: 5 files, 82 passed.
- Root workspace `pnpm typecheck` and `pnpm lint` after gap fixes; lint is 0 errors, 35 existing warnings.

After final merge `d8cf5a49a7`, full unit tests at root workspace ran again: 1171 files, 9989 passed, 4 failed, 8 skipped. All failures come from Settings source text assertions newly merged in this staging round; the current branch and `origin/staging` have no differences in the relevant implementation and test files. All 155 Provider/Core-related merge-back regression tests passed.

Full unit tests at root workspace after completion audit: 1170 files passed, 4 files failed, 1 file skipped; 9989 passed, 5 failed, 8 skipped. Four Settings source text assertions and one Web Remote reconnection timing test are all in unmodified files; Settings failures can be directly confirmed on staging code, and Web Remote is an independent timing failure in this full run. Bootstrap full tests' steering, resume title, marketplace, v4 boundary, and telemetry mock failures were also verified on staging or unmodified files, not belonging to Provider migration regressions.

Several existing failures in ZCode CLI's Core full tests were reproduced in unmodified staging workspaces, including old steering tests and local cc-run path dependencies; these failures are not introduced by this migration. CLI full lint still hits the repository's existing max-lines baseline; individual file linting of changed files shows 0 errors.

## Progress

- [x] Merge latest staging and check model invocation changes.
- [x] M1.1: Public types, compatible Model Wrapper, unit tests.
- [x] M1.2: Main Agent Loop, Automatic Compact, Usage, Trace.
- [x] M1.3: Child Agent, Title, Goal verifier, Project Memory.
- [x] M1.4: Git, workspace generateText, WebFetch, WebSearch.
- [x] M1.5: Repo Wiki.
- [x] M1.6: Delete old reads from business side, complete executable gate; record existing baseline failures separately.
