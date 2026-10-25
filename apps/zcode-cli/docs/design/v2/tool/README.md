# ZCode CLI Tool Design v2

## Document scope

This directory records the ZCode v2 tool contracts and implementation checklists. The public tool contract has advanced from the early `L1 Candidate Contract` to the runtime-consumption stage: fields, behavior, permission boundaries and failure paths still follow this design as the baseline, but a stable shared TypeScript contract, built-in tool declarations, registry projection and the executor/scheduler consumption loop already exist.

Documents are ordered by current priority:

1. [Read](01-read.md)
2. [Write](02-write.md)
3. [Edit](03-edit.md)
4. [Bash](04-bash.md)
5. [Glob](08-glob.md)
6. [Grep](09-grep.md)
7. [WebFetch](05-webfetch.md)
8. [AskUserQuestion](06-ask-user-question.md)
9. [Subagent](07-subagent.md)
   - [Background Subagent v1 Implementation Plan (historical)](07-subagent-background-plan.md)
   - [RespondToCoordinator current contract](../../../../../../docs/subagent-respond-to-coordinator.md)
10. [TodoRead / TodoWrite](10-todo.md)
11. [Tool Input Normalization](12-input-normalization.md)
12. [WebSearch](13-websearch.md)
13. [Workflow](15-workflow.md)
14. [EnterPlanMode / ExitPlanMode](16-plan-mode.md)
15. [LSP and Language Server Runtime](19-lsp.md)
16. [ToolSearch](19-tool-search.md)

## Public tool shape

Each tool is an object with a runtime schema and lifecycle hooks. Core fields:

- `name`, `searchHint`, `description`, `prompt`
- `inputSchema`, `outputSchema`
- `validateInput`
- `checkPermissions`
- `call`
- `mapToolResultToToolResultBlockParam`
- `isReadOnly`, `isConcurrencySafe`, `isDestructive`
- `requiresUserInteraction`
- `maxResultSizeChars`
- `getPath`, `preparePermissionMatcher`
- UI rendering hooks for summary, activity, result, rejected and error

UI details are not part of the tool contract; the tool layer needs a stable schema, permission metadata, side effect declaration, cancellation semantics, output budget, result persistence strategy, observable events and a serialization strategy for the model-visible result.

For the asynchronous client negotiation of a permission `ask`, see [Permission Broker](../permission-broker.md). The tool layer only produces the permission intent and displayable context; whether to continue is decided by the broker after waiting for the client result.

## Unified lifecycle

The ZCode v2 tool runtime schedules in this order:

1. `parseInput`: validate and normalize input with the runtime schema.
2. `backfillObservableInput`: fill derived fields only into the input visible to observation, hooks and permission judgment; it must not modify the original input sent to the model.
3. `validateInput`: before the `PreToolUse` hook, run tool-specific input validation that needs no user authorization or is low-risk; on failure return a structured error code and actionable hint, and run no `PreToolUse`, permission judgment, handler or `PostToolUseFailure`.
4. `checkPermissions`: decide allow, ask or deny from the tool declaration, permission mode, allow/deny/ask rules, workspace and path safety policy; `ask` must enter the permission broker and wait for the client reply, and must not be treated as an immediate rejection.
5. `call`: execute the tool. The business layer only expresses intent; actual file, process and network I/O must go through adapters.
6. `recordState`: update first-class state such as read cache, file history, task state, trace span and artifact references.
7. `serializeResult`: convert the internal output into the model-visible tool result; large results go to artifact/storage and only a preview and reference are returned.
8. `renderProjection`: the UI renders from a projection or the event stream and does not read tool internal state.

When a handler finds an expected tool-specific failure at its existing execution position it returns the internal `{ result: false, errorCode, message }`; the success output and normal lifecycle are unaffected. The error code and bare message are maintained by the concrete tool module; the executor only assembles the structured error and the provider-visible `<tool_use_error>` uniformly, and must not branch on tool name or parse English messages. I/O, cancellation, races and other unexpected exceptions keep the generic exception path.

Stable semantic errors that must be rejected before hooks are returned by `ToolEntry.validateInput` in the same `{ result: false, errorCode, message }` shape. A handler that depends on mutable runtime state must still re-check at the actual execution position, to handle races where state changes after validation or a hook modifies the input.

## Public contract requirements

Every ZCode tool must declare:

- `inputSchema`: runtime-validatable; across LLM, SDK, MCP and session storage boundaries it must not rely on TypeScript types alone.
- `outputSchema`: describes the structure of a successful result. Failure paths use stable error types and are not mixed into ordinary strings.
- `capability`: a one-sentence capability description, used for tool search and permission explanation.
- `readOnly`: whether read-only. A dynamically read-only tool must compute it from the input.
- `destructive`: whether it may delete, overwrite, send or cause irreversible side effects.
- `sideEffectScope`: distinguish at least `none`, `workspace`, `git`, `network`, `system`, `session`, `userInteraction`.
- `concurrencySafe`: whether it can run concurrently with other tools.
- `timeout`: default timeout, maximum timeout and whether the caller can override.
- `cancellation`: how external side effects stop, clean up or are marked after cancellation.
- `permission`: permission rule match content, suggested rules, deny priority and user-visible reason.
- `resultBudget`: inline result size, persistence strategy and preview strategy.
- `trace`: all validate, permission, adapter I/O, state update and result serialization steps must carry the same `traceId`.

### Implementation check (2026-05-07)

This check confirms the L0-L3 mainline of the public tool contract has landed; do not re-implement these capabilities as pure plan items:

- The shared contract is in `packages/contracts/src/tools/contract.ts`, covering `capability`, `inputSchema`, `outputSchema`, `permission`, `resultBudget`, `timeout`, `cancellation` and `trace`.
- The core entry types are in `packages/core/src/tool/types.ts`; `ToolEntry` extends the shared contract and adds handler, runtime schema and metadata.
- Built-in tools declare the full public contract in `packages/core/src/tool/handlers/` and also mount `runtimeInputSchema` / `runtimeOutputSchema` as the single Zod source of the JSON Schema; `packages/core/tests/tool-contracts.test.ts` covers declaration completeness, runtime schema presence, provider-compatible JSON Schema and registry projection.
- `toContracts()` in `packages/core/src/tool/registry.ts` projects `outputSchema`, permission, budget and runtime metadata to the model contract.
- `packages/core/src/runtime/methods/tools.ts` and `packages/core/src/tool/scheduler.ts` schedule tools preferring `permission.sideEffectScope` and the concurrency metadata, instead of relying only on the old tool-name read-only table.
- `packages/core/src/tool/executor.ts` consumes `timeout`, `cancellation`, `resultBudget`, `outputSchema` and the artifact store; failure paths return to a structured tool error, and an illegal output is not injected into the model context.
- `packages/core/tests/tool-executor-trace.test.ts` covers resultBudget truncation, artifact writes and outputSchema fail-closed; `packages/adapters/tests/tool-artifact-store.test.ts` covers the Node artifact store.

### L0/L1 landing constraints (implemented, still the gate for new tools)

L0/L1 has landed: the public contract types and declaration completeness of built-in tools. A new tool may not register only `handler` and `inputSchema`; it must also complete the following three kinds of declaration.

A "declaration" here is not a block of prompt text sent to the model but a structured contract. The provider adapter projects only what the model needs, such as `name`, `description`, `capability`, `inputSchema`, `outputSchema`; `permission`, `resultBudget`, `timeout`, `cancellation` and `trace` are mainly consumed by the ZCode runtime, executor, permission, scheduler, artifact/storage and observability chains.

1. Model-visible projection:
   - `name`
   - `description`
   - `capability`
   - `inputSchema`
   - `outputSchema` (it must exist in the ZCode contract even if the current provider does not consume it)

2. Runtime-consumable declarations:
   - `runtimeInputSchema`
   - `runtimeOutputSchema`
   - `readOnly`
   - `destructive`
   - `sideEffectScope`
   - `concurrentSafe`
   - `timeout`
   - `cancellation`
   - `resultBudget`
   - `trace`

3. Permission declarations:
   - `permission.permission`
   - `permission.reason`
   - `permission.riskLevel`
   - `permission.sideEffectScope`
   - `permission.needsApproval`
   - `permission.patternSources`
   - `permission.denyPriority`

`inputSchema` and `outputSchema` are provider-neutral JSON Schema, not Zod objects; but the JSON Schema of built-in tools must no longer be maintained by hand. Built-in tools must take the Zod runtime schema as the single source and derive the provider-neutral JSON Schema through the unified conversion entry of `packages/contracts/src/tools/json-schema.ts`. This avoids problems such as `enum` lacking `type`, optional fields drifting to required, and inconsistent nested object constraints.

External tools (for example MCP and dynamic tools) may carry native JSON Schema, but before entering the registry or provider adapter they must go through the same kind of schema normalization: fill object `properties`, infer an explicit `type` for `enum` / `const`, and remove generation details the provider does not consume such as `$schema` / `$ref` / `definitions`. The provider adapter may consume only normalized JSON Schema and must not pass through schemas of unknown origin.

Zod, Effect Schema or another runtime schema may be kept as `runtimeInputSchema` / `runtimeOutputSchema` for later executor validation; built-in tools currently use Zod uniformly. Long-term parallel maintenance of a hand-written JSON Schema and a Zod schema for the same built-in tool is forbidden.

### L2 Runtime consumption constraints (implemented, coverage keeps expanding)

L2 makes the public contract more than registration and display: the runtime actually reads these declarations. Later changes must keep this loop:

- The executor computes the outer timeout of each tool call with `timeout.defaultMs`, `timeout.maxMs` and `timeout.allowCallOverride`.
- The executor creates a child `AbortSignal` for each tool call; timeout and user cancellation must propagate to the handler and later adapter I/O.
- The executor generates the model-visible `modelContent` with `resultBudget`; the full `output` may stay in internal state, UI or artifact but must not be fed back directly into model message history.
- The scheduler prefers `permission.sideEffectScope` to judge concurrency-safety boundaries, to avoid scheduling by old information after metadata and permission declarations diverge.
- A tool result event should contain truncation state, original size, returned size, budget strategy and available artifact reference, so later UI, audit and recovery chains can take over.
- A handler failure return is not a successful output; it must not enter output schema validation, success serialization, `PostToolUse` or background task tracking; it follows the existing `PostToolUseFailure`, `ToolCallError` and failure log chain.

### L3 Artifact and Output validation constraints (implemented, strengthened incrementally by schema need)

L3 completes two runtime loops:

- A successful tool output must pass `outputSchema` validation. A validation failure is a tool contract violation and returns as a structured `tool_execution_failed`; an illegal result is not injected into model context.
- The first JSON Schema validation covers the subset used by the current tool contract: `type`, `oneOf`, `const`, `enum`, `required`, `properties`, `additionalProperties`, `items`, `minimum`, `maximum`, `minLength`, `maxLength`. If a later schema uses more keywords, the validator and tests must be extended first.
- With `resultBudget.strategy: "artifact"` and `artifact.enabled: true`, a full serialized result over the model budget must be written to artifact/storage through `ToolArtifactStorePort`. The executor may depend only on the port and must not call the filesystem or session sqlite directly.
- An artifact write must carry `sessionId`, `turnId`, `toolCallId`, `toolName` and `trace`, and the returned `uri` or `path` enters the tool result event and the truncation hint.
- If no artifact store is configured, the executor still truncates model content per `resultBudget` but does not forge an artifact reference.

### New Tool checklist

When adding a tool, land it in this order:

1. First write in `docs/design/v2/tool/` the capability, input, output, permission, failure paths, side effect scope, cancellation semantics, result budget and trace propagation.
2. Define the Zod runtime input/output schema and TypeScript types in `packages/contracts/src/tools/`; `*InputJsonSchema` / `*OutputJsonSchema` must be derived from the Zod schema by a unified helper and not hand-written except for external tool schema normalization.
3. Register the `ToolEntry` in `packages/core/src/tool/handlers/`, which must include `capability`, `inputSchema`, `outputSchema`, `runtimeInputSchema`, `runtimeOutputSchema`, `permission`, `resultBudget`, `timeout`, `cancellation`, `trace`.
4. All file, subprocess, network, skill and storage I/O inside a handler must go through an adapter/port and keep passing `traceId`.
5. A tool with side effects must declare `needsApproval: true` or give a clear read-only proof; write tools default to `sideEffectScope: "workspace"`, and subprocesses default to at least `"system"`.
6. A large result must not be stuffed unconditionally back into model context; `resultBudget` must state the inline limit, preview strategy and artifact strategy.
7. After adding or modifying a tool, add tests covering at least contract declaration completeness, registry `toContracts()` projection, key success paths and key failure paths.

## Tool matrix

| Tool            | Model-visible name              | Model-visible scope                                                    | Main side effects                                                                                              | Read-only by default                                     | Concurrency-safe                                              | Result budget                     |
| --------------- | ------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------- |
| Read            | `Read`                          | main agent, Explore                                                    | file read, read cache update, may attach image/PDF meta messages                                               | yes                                                      | yes                                                           | not persisted, self-limited       |
| Write           | `Write`                         | main agent                                                             | create or fully overwrite files, update read cache, file history, LSP/IDE notification                         | no                                                       | no                                                            | 100000 chars                      |
| Edit            | `Edit`                          | main agent                                                             | exact string replacement, update read cache, file history, LSP/IDE notification                                | no                                                       | no                                                            | 100000 chars                      |
| Bash            | `Bash`                          | main agent                                                             | subprocess, sandbox, cwd, background tasks, may read/write network and system                                  | decided dynamically by command                           | only read-only commands are safe                              | 30000 chars                       |
| Glob            | `Glob`                          | main agent, Explore (temporary)                                        | file name and path pattern matching                                                                            | yes                                                      | yes                                                           | 100000 chars                      |
| Grep            | `Grep`                          | main agent, Explore (temporary)                                        | file content regex search                                                                                      | yes                                                      | yes                                                           | 100000 chars                      |
| WebFetch        | `WebFetch`                      | main agent                                                             | network GET, secondary model processing, binary persistence                                                    | yes                                                      | yes                                                           | 100000 chars                      |
| WebSearch       | `WebSearch` / internal `web_search` | main agent, Explore                                                | internal model request triggers provider-side server-side web search                                           | yes                                                      | yes                                                           | 100000 chars                      |
| AskUserQuestion | `AskUserQuestion`               | main agent                                                             | user interaction, the permission UI collects answers                                                           | yes                                                      | yes                                                           | 100000 chars                      |
| Subagent        | `Agent` / `Task`                | main agent                                                             | agent runtime, background tasks, worktree, transcript, side effects of delegated tools                         | orchestration layer yes; read-only-ness computed dynamically per child tool | orchestration layer yes; write conflicts managed by child tools and the task runtime | 100000 chars |
| Workflow        | `Workflow`                      | main agent (only after explicit user opt-in)                           | workflow run, child session, background runner, session-scoped script copy, workspace side effects of orchestrated agents | no                                                       | no                                                            | small results, status in workflow tables |
| EnterPlanMode   | `EnterPlanMode`                 | main agent                                                             | request user consent and switch session mode to plan                                                           | no                                                       | no                                                            | 100000 chars                      |
| ExitPlanMode    | `ExitPlanMode`                  | main agent                                                             | submit plan, request user consent and exit plan mode                                                           | no                                                       | no                                                            | 100000 chars                      |
| TodoRead        | `TodoRead`                      | main agent                                                             | read session todo state                                                                                        | yes                                                      | yes                                                           | 100000 chars                      |
| TodoWrite       | `TodoWrite`                     | main agent                                                             | replace session todo state                                                                                     | yes, session-only                                        | no                                                            | 100000 chars                      |
| LSP             | `LSP`                           | main agent, Explore (registered only when a usable language server exists) | queries a language server started through an enabled plugin; modifies no file                              | yes                                                      | yes                                                           | 200 results, overflow to artifact |

## ZCode implementation orientation

These documents only define tool-layer semantics and do not require implementing all capabilities at once. When landing, implement stable contracts and tests first:

- File tools first implement the `Read -> Edit/Write` read-before-write constraint and mtime/content protection against concurrent modification.
- Search tools keep both direct `Glob/Grep` implementations. The current default is the embedded search branch: the tool pools of the main agent and the `Explore` subagent hide direct `Glob/Grep`, and repository search is taken over by the Bash `find` / `grep` functions. Only when Windows CMD or a legacy shell fallback cannot inject Bash functions does it return to the non-embedded/direct branch and expose `Glob/Grep`.
- Bash first implements the argument array, cross-platform shell adapter, permission declaration, timeout, cancellation, output truncation and sandbox interface, then gradually adds complex parsing.
- WebFetch first implements an explicit network adapter, domain permission, redirect safety policy, cache and large-content budget.
- WebSearch currently uses the client tool wrapper: the main request exposes only the ordinary `WebSearch` client tool, the handler internally issues a model request containing only the provider-native `web_search`; the adapter only maps the internal native helper and does not restore HTML scraping.
- AskUserQuestion first implements non-blocking session state, recoverable pending prompts and unified SDK/TUI output.
- Subagent first implements the agent definition registry, tool pool resolver, isolated execution context, background tasks, transcript/resume and trace propagation, then considers fork, worktree, remote and teammate.
- Todo has implemented session store persistence, tool contracts, TUI/ZCode app-server plan projection, resume context injection and compact summary carrying todo state; later changes must keep these projections consuming only runtime/session events and not read storage directly.
