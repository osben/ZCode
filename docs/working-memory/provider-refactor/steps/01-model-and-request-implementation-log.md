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

This document records decisions made independently during implementation that went beyond the original plan but were necessary to continue progress, plus the starting baseline and completion-audit gaps. Implementation logs do not modify existing designs: when conflicts arise, the phase design takes precedence and conflicts are handed off to phase review or subsequent Design discussions.

## Starting Baseline

Before implementation, `origin/staging`'s `38d37ca50a` was merged into `provider-refactor` (merge commit `07e4ba350f`, no conflicts). The main chain still held: business callers → `ModelTextRequest` → `AiSdkModelAdapter` → per-request `ModelRef` resolution from the mutable Registry → Provider SDK. M1 therefore avoided re-introducing the recently deleted old auxiliary abstractions and built the new boundary directly on the final `Model` / `ModelRequest` contract.

## Completion-Audit Gaps (all closed by the decisions below)

- Microcompact and Reactive Compact did not fully inherit the Model held by the current Agent Loop → decision 11.
- Child Agents that did not explicitly select a model could re-select from mutable Session defaults → decision 11.
- Context Usage, Compact persistence, and some Sidecar Usage recorded the pre-request ModelRef instead of the actual Model → decision 12.
- `workspace/generateText` mixed current Runtime model properties when creating the target Model → decision 6/16.
- After Repo Wiki migration, error boundaries needed reconfirmation → decision 14.
- Pre-request Property validation policy (error vs fallback vs log-only) remained an undecided unified ruling; this round only supplemented inheritance and attribution.

## Independent Decisions During Implementation

### 1. Existing Adapter as the First Version Model's Execution Core

M1 does not rewrite Provider SDK, stream recovery, header refresh, or error normalization. The first version Model wraps the existing `AiSdkModelAdapter` within the Adapter package; business callers only contact the new Model interface. The old `ModelTextRequest` temporarily becomes Adapter-internal compatible input, exiting the business boundary as callers migrate.

### 2. Fixed Ordinary Registry Resolution Result at Model Creation Time

Ordinary Models resolve Provider, model, capability, and connection information once at creation time. After the Agent Loop holds that Model, subsequent Steps no longer re-decide model identity or ordinary API Key from the mutable Registry. Configuration changes only affect subsequently created Models. Dynamic Header links such as Start Plan may still update request-level authentication material after explicit execution header refresh — this exception never changes the Model's `providerId`, `modelId`, Properties, or Options.

### 3. Transport Controls Remain Inside the Model Implementation

`statusSink`, Trace, stream recovery, idle timeout, Provider stream boundary, and runtime header refresh never enter the public `ModelRequest`. They arrive through an internal execution context injected at Model creation; business callers cannot freely assemble transport parameters per request.

### 4. ModelResult and ModelEvent First Converge Semantics, Then Clean Up Old Names

M1.1 uses the currently normalized `ModelTextResult` and `ModelStreamEvent` fields as the migration basis, defines the final public names, and removes input business sides should not control. Provider SDK raw types stay isolated by the Adapter. After caller migration, aliases and request types serving only the old `ModelPort` are deleted.

### 5. Properties Derived from Existing Capabilities and Connection Judgment

`contextWindow`, images, PDF, Tool Call, and Structured Output first reuse existing `ModelCapability` facts; Native Web Search and Mid-conversation System reuse the current judgment logic at Model creation time. Core subsequently reads only Model Properties — never inferring capabilities from Provider kind, URL, or model name.

### 6. Repo Wiki Uses Unified Model, No Independent Provider Client

Services requests CLI through `workspace/generateText`; CLI internally creates and executes the Model. The client that previously handled API Key, Endpoint, OpenAI/Anthropic requests, Tool loops, and Usage independently for Repo Wiki was deleted. The workspace request carries an operation id; Host's AbortSignal simultaneously ends local waiting and notifies CLI to abort the corresponding model task.

### 7. Internal Invocation Context Uses AsyncLocalStorage

Core writes the invocation context at the model invocation boundary; the Adapter reads it within the same async chain. Stream calls additionally wrap `next`, `return`, and `throw` of AsyncIterator, so context is not lost during actual consumption after iterator creation.

### 8. "Disable Reasoning" for Auxiliary Tasks First as Model Construction Intent

Title, Git Commit Message, and Memory Selector previously rewrote Anthropic/OpenAI/OpenAI-compatible parameters in business code. M1 converges callers to `reasoningMode: "disabled"` compatible factory input; old Provider dialect logic is retained only in the unique compatible Model Factory for Core's old tests and migration calls. This adds no public Reasoning level and changes no user-selectable tiers.

### 9. Properties Formed at Model Creation Time

The old Provider kind/URL/model-name judgment for Native Web Search and Mid-conversation System moved to the Model creation path. Main Agent, Compact, Project Memory, and model-type tools read Model Properties. Non-execution previews in the tool catalog may still use the old connection judgment without a Model (no model requests); this path was deleted once M2's Registry/Descriptor became the formal viewing source.

### 10. Old ModelPort Reduced to Single Compatible Entry Point

All production callers use `Model.generateText()` or `Model.streamText()`. Direct calls to the old `modelAdapter.generateText/streamText` in Core exist only in the compatibility factory in `runtime-model.ts`, for tests and old embedding calls that construct `AgentRuntime` without Bootstrap assembly — deletable when M2 replaces the Model source.

### 11. Agent Loop, Compact, and Child Agent Share Immutable Model

Ordinary Agent Loops create a Model at start time; subsequent Steps, automatic Compact, Microcompact, Reactive Compact, and Child Agents without an explicit model all use that object. Child Agents with an explicit model create their own. Session default model, Config, or Registry changes during the Loop never rewrite already-referenced ordinary Models; dynamic Header Providers still refresh authentication material via the existing pre-request path without changing Model identity.

### 12. Execution History and Usage Attributed to Actual Model

Assistant messages, Compact records, Tool persistence diagnostics, Context Usage, Usage Facts, and Trace no longer read mutable `defaultModelRef` after request completion — all receive the actual requesting Model or a ModelRef derived from it. Independent tasks like Title with disabled reasoning form a Model with `reasoningLevel: "disabled"`, so Usage records the actual execution option, not the Session's old reasoning tier.

### 13. Output Budget Selected by Caller, Strictly Validated by Model

The initial implementation projected the Provider's fixed thinking minimum budget to `maxOutputTokens.min` with a public clamp that silently adjusted requests — this leaked Provider dialects into the general Model contract and let general entry points like `workspace/generateText` change caller inputs. Corrected: public Options declare only default values and maximums. `maxOutputTokens` is the total generation hard limit shared by reasoning and final answer; Models accept only positive integers not exceeding the upper limit. Compact, Memory, WebFetch, WebSearch, and ReadSessionContext fixed budgets are their own task strategies — the caller explicitly selects the smaller of task budget and model upper limit. `workspace/generateText` no longer silently adjusts inputs; out-of-bounds requests return errors from the Model. Fixed thinking still limits tier budgets to `maxOutputTokens - 1` inside the Adapter without exposing associated constraints as public Option Specs; native effort/adaptive migration is a later Adapter topic.

### 14. Repo Wiki Retains Safe Error Boundaries

Provider-returned raw exceptions may contain request bodies, and Repo Wiki persists failure reasons to tasks, so the Services boundary keeps only publicly safe HTTP status codes, normalizing all other error bodies to general failure messages. Abort and Repo Wiki's own Deadline errors keep their original control semantics.

### 15. Compatible Old Minimum Model Adapter Injection

The formal production Adapter provides `createModel()` and `resolveConnection()`; Bootstrap uses the formal Model Factory. Unit tests and old embedding calls may inject only the minimum `generateText/streamText` Adapter — Bootstrap then does not install the formal factory and they fall to Core's single compatibility factory. No second production call chain.

### 16. Truncation Recovery for Repo Wiki Is a Business Strategy

The fixed workspace results pass through `finishReason` and Usage. Repo Wiki normalizes `length`, `max_tokens`, and `max_output_tokens` to truncation errors at its own invocation boundary, and existing Catalog/Page retry strategies increase the request budget by one tier (Catalog 16384 → 32768, Page 8192 → 16384). Upgrades occur at most once, never count toward user-configured ordinary retries, and final requests are still validated against the model's `maxOutputTokens` upper limit. The Model only returns real invocation results and validates requests — unaware of Wiki's budget upgrades, and Wiki's old Provider/Endpoint/protocol clients are not restored.

`finishReason` stays optional in the workspace wire schema (callers not depending on end reasons can still read old app-server responses). Repo Wiki cannot safely compat results missing that field: half Markdown is structurally valid and completeness cannot be recovered from the body — Wiki explicitly fails on old responses, prompting users to update or restart ZCode, without tool fallback, ordinary retries, or saving this Catalog/Page.

### 17. Video Input Enters Unified Model Property

`ModelProperties` explicitly carries `supportsVideo`; Models validate video file input before Provider calls; Core's media projection removes original video data and retains a traceable text placeholder when the model explicitly does not support video. The old Factory conservatively treats the field as `false` when not provided; Registry-created Models must explicitly provide it from complete Model Config. No change to Provider Config, Registry, or Adapter layering.

## Post-Implementation Review Conclusions

- The first version of Property conflicts returned `InvalidModelRequest`; no OTEL invariant added yet — product fallback strategy awaited subsequent per-Property decisions.
- Invocation context uses AsyncLocalStorage, covering Promise and AsyncIterable consumption boundaries.
- Dynamic Header Providers can refresh authentication material before Adapter retry; refreshed model identity must match the current Model.
- Repo Wiki accesses through the existing Host → CLI workspace protocol; layered issues did not spread to the public Model interface.
- Old `ModelPort` and `ModelTextRequest` remain Adapter/compatibility-factory internal; business callers no longer construct them.
- Full production call scanning found no remaining Repo Wiki/OpenAI/Anthropic direct model clients (scripts, test tools, and historical documents are not production callers).
- Embedded Search still branches on old Connection information but initiates no model requests — recorded as a subsequent Provider/Capability cleanup item, not blocking M1.
- Guide/"immediate" unified to take effect within the Loop: on successfully entering the current Loop, the Model Selection and Model used by subsequent Loop Steps switch together. Ordinary Submissions still fix their Model at new Loop start time.

## Verification Records

Root workspace typecheck and lint (0 errors, existing warnings unchanged); CLI Contracts/Adapters/Core/Bootstrap/CLI and 23 other packages typecheck; full root unit tests before the final staging merge 1148 files / 9831 passed / 8 skipped; Adapter full tests 75 files / 1159 passed; after gap fixes Contract tests 28 files / 202 passed and Adapter 77 files / 1191 passed. After the final merge `d8cf5a49a7`: 1171 files / 9989 passed / 4 failed — all failures from Settings source-text assertions newly merged in that staging round, identical on `origin/staging`; 155 Provider/Core-related merge-back regression tests passed. Post-audit full run: 9989 passed / 5 failed (four Settings source-text assertions and one Web Remote reconnection timing test, all in unmodified files; reproducible on staging or independent timing). CLI Core full-test existing failures (old steering tests, local cc-run path dependencies) reproduce in unmodified staging workspaces — not introduced by this migration.
