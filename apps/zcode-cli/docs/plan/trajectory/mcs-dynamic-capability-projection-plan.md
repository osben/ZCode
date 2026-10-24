# Dynamic Mid-conversation System Projection Plan

> **Execution constraint:** Implement phase by phase. After each phase, run unit tests, do a code review and produce prompt-trajectory/provider-visible evidence, then wait for user confirmation before the next phase. Do not auto-commit unless the user asks.

**Status:** Implemented (Phase 5 recorded 2026-06-24, `--force-mcs` follow-up 2026-07-09). The Phase 0 and Phase 4 checklists below were never ticked in the source; Phase 5 records the e2e evidence.

**Goal:** Decide dynamically from the current model/provider capability whether a runtime system-reminder attachment is finally projected as a mid-conversation `role: "system"` message or as a legacy `role: "user"` message with a `<system-reminder>` wrapper.

**Core architecture:** All reminder producers keep emitting source-aware runtime attachment entries; no producer forks. A generic capability resolver builds the full decision context from the current `ModelRef` and the resolved `ModelConnectionInfo` and returns a `useMidConversationSystem` boolean. The final provider request builder consumes only that boolean. With MCS off, the legacy user system-reminder shape and the legacy attachment-like reminder bubble-up order are restored.

**Tech stack:** TypeScript, Vitest, `@zcode/contracts`, `@zcode/core`, prompt-trajectory, model-io trajectory converter.

## Global constraints

- No static/user config switch by default: without an explicit CLI override, MCS enablement is computed dynamically from the runtime provider/model environment.
- The CLI can set a runtime override with the single-run flag `--force-mcs` on the `--prompt`, `--target` or `tui` runtime paths; other commands must error so users do not think non-runtime-prompt commands such as `app-server` / `doctor` / `plugins` inherit it. The override skips only the fast-supported model / baseURL host gate; it does not skip `providerKind === "anthropic"`, connection resolution or source/position projection constraints. Non-Anthropic providers must still disable MCS so incompatible providers never receive a mid-history `role: "system"`.
- The capability function receives the full context, not just `baseURL` and `providerKind`, so one function can read model name, provider id, provider kind, provider URL, role, source, variant, request source, etc.
- Enable condition: the resolved connection's `providerKind` must be `anthropic`. Given that, if the current model name matches the fast-supported model lookup (currently only the Opus 4.8 boundary-complete fragment `claude-opus-4-8`), MCS is enabled directly; other Anthropic models, including case variants such as `glm-5.2` / `GLM-5.2`, still require the `baseURL` to hit the MCS allowlist. The fast-supported check uses only the model-name string, not the baseURL.
- No provider header / Anthropic beta header is added or changed.
- Producers do not fork: `skills_listing`, `todo_reminder`, `output_style`, `prompt_attachment` etc. only emit source-aware attachment entries.
- The capability helper may receive the full `ModelConnectionInfo`, which can contain sensitive `apiKey` / `headers`: never log, snapshot or persist them, and the decision context returned to callers must drop `apiKey` / `headers`.
- With MCS off, MCS-capable attachments render as legacy `role: "user"` + `<system-reminder>` and take part in legacy attachment-like bubble-up ordering.
- Request-level `context_prefix`, real user input, tool-result warnings and the goal verification auxiliary prompt never enter MCS.
- Acceptance looks only at the final provider-visible request body.

## Code facts (baseline)

- The provider-visible projection boundary is `buildProviderRequestMessages(...)` in `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts`; it unconditionally called `projectMidConversationSystemEntries(...)` with no provider capability input.
- Static source classification is in `packages/core/src/system-reminder/source.ts` (`isMidConversationSystemSource(...)`).
- Legacy rendering already exists: runtime attachment entries not consumed by the MCS projector become `role: "user"` + `wrapSystemReminderForSource(...)` via `renderProjectedEntryToModelMessage(...)`.
- Attachment reorder excluded MCS-capable sources because `isAttachmentLikeUserEntry(...)` returns false for `isMidConversationSystemSource(source)`.
- WebSearch already has a dynamic provider/baseURL capability pattern to follow: `packages/core/src/tool/handlers/websearch-support.ts`, `packages/contracts/src/tools/websearch.ts`, and runtime resolution through `modelConnectionPort.resolveConnection(this.defaultModelRef)`.

## Target behavior

Given runtime entries:

```text
user "Summarize this"
attachment prompt_attachment "Called the Read tool..."
assistant ...
attachment todo_reminder "The TodoWrite tool hasn't..."
```

MCS on keeps the MCS shape:

```json
[
  { "role": "user", "content": "Summarize this" },
  { "role": "system", "content": "Called the Read tool..." },
  { "role": "assistant", "content": "..." },
  { "role": "system", "content": "The TodoWrite tool hasn't..." }
]
```

MCS off degrades to legacy user system-reminder messages; an attachment-like reminder that came after the real user query bubbles before it:

```json
[
  {
    "role": "user",
    "content": "<system-reminder>\nCalled the Read tool...\n</system-reminder>"
  },
  { "role": "user", "content": "Summarize this" },
  { "role": "assistant", "content": "..." },
  {
    "role": "user",
    "content": "<system-reminder>\nThe TodoWrite tool hasn't...\n</system-reminder>"
  }
]
```

Positions after assistant/tool-result boundaries keep following the existing bubble-stop rules of `reorderAttachmentLikeEntries(...)`.

## File responsibilities

| File | Responsibility |
| --- | --- |
| `packages/contracts/src/model/mid-conversation-system.ts` | Pure functions: MCS baseURL allowlist and fast-supported model lookup. |
| `packages/contracts/src/model/index.ts` | Exports the MCS baseURL / fast-supported model helpers. |
| `packages/contracts/tests/mid-conversation-system.test.ts` | Allowed / denied baseURL parsing and fast-supported model checks. |
| `packages/core/src/runtime/helpers/mid-conversation-system.ts` | Builds the full MCS capability context and returns the capability decision. |
| `packages/core/src/runtime/helpers/provider-request-messages.ts` | Consumes `useMidConversationSystem`; switches MCS projection vs legacy reorder. |
| `packages/core/src/runtime/helpers/runtime-provider-request-messages.ts` | Runtime wrapper: resolves capability, then calls the provider request builder. |
| `packages/cli/src/run.ts` | Parses and validates `--force-mcs`, allowed only on `--prompt` / `--target` / `tui` runtime paths. |
| `packages/cli/src/prompt-command.ts` | Headless prompt runtimeConfig writes the MCS force override. |
| `packages/cli/src/tui-command.ts` / `tui-prompt-handler.ts` | TUI runtimeConfig writes the MCS force override. |
| `packages/core/src/runtime/methods/turn-loop.ts` | Main turn requests use the runtime wrapper. |
| `packages/core/src/runtime/methods/compact.ts` | Compact sizing uses the runtime wrapper. |
| `packages/core/src/runtime/methods/compact-active.ts` | Compact summary/token accounting uses the same capability decision. |
| `packages/core/src/runtime/methods/compact-active-helpers.ts` | The compact summary request builder takes `useMidConversationSystem`. |
| `packages/core/src/runtime/helpers/compact.ts` | Runtime-entry token estimation / microcompact take `useMidConversationSystem`. |
| `packages/core/src/runtime/methods/target-completion-verification.ts` | Target verification requests use the runtime wrapper. |
| `packages/core/tests/provider-request-messages.test.ts` | MCS on/off projection shape. |
| `packages/core/tests/runtime-mcs-capability.test.ts` | Capability decision for the full model/provider context. |
| `tools/prompt-trajectory/testcases/` | E2E fixture for the provider-visible shape. |

## Phase 0: Baseline

Before implementing, confirm the code path and test baseline. Pause for user confirmation after the phase.

- Confirm branch and worktree state (`git status --short --branch`: on the MCS work branch, no unrelated dirty files).
- Confirm `provider-request-messages.ts` enables MCS unconditionally and that no first-class disabled MCS path exists.
- Focused baseline (must pass before implementing): `pnpm --filter @zcode/core exec vitest run tests/provider-request-messages.test.ts tests/prompt-attachments.test.ts tests/runtime-reminders.test.ts`.

## Phase 1: Generic MCS capability utility

Add dynamic capability judgment modeled on WebSearch's provider/baseURL pattern, but taking the full model/provider context so later model-specific gates do not force a change of the projection layer. Pause after tests and review.

### Task 1.1: contracts-layer baseURL / fast-supported model helpers

Interface:

```ts
export function isMidConversationSystemCapableBaseURL(
  baseURL: string | undefined,
): boolean;

export function isFastSupportedModel(modelId: string | undefined): boolean;
```

Behavior:

- baseURL: parse the hostname (retry with an `https://` prefix when the input has no scheme); allowed when the host equals an allowlisted host or is a subdomain of it. Allowlisted hosts: `bigmodel.cn`, `z.ai`, `deepseek.com` (the source list also repeats `z.ai`).
- Allowed examples: `https://bigmodel.cn/api/anthropic`, `https://open.bigmodel.cn/api/anthropic`, `https://z.ai/api/anthropic`, `https://api.z.ai/api/anthropic`, `https://deepseek.com/anthropic`, `https://api.deepseek.com/anthropic`, `https://zcode.z.ai/api/anthropic`, `api.z.ai/api/anthropic`.
- Rejected examples: `undefined`, empty string, `https://provider.example/anthropic`, `https://bigmodel.cn.example/anthropic`, `https://z.ai.example/anthropic`, `https://deepseek.com.example/anthropic`, `https://example.com/anthropic?redirect=https://api.z.ai`.
- Fast-supported model: lowercase and trim the name; match the marker `claude-opus-4-8` only at boundaries. The character before the marker must be absent or one of `.`, `/`, `:`; the character after must be absent or one of `-`, `[`, `.`, `/`, `:`, `@`, `_`. Scan all occurrences.
- Matches: `claude-opus-4-8`, ` claude-opus-4-8 `, `CLAUDE-OPUS-4-8`, `anthropic.claude-opus-4-8`, `us.anthropic.claude-opus-4-8`, `bedrock/us.anthropic.claude-opus-4-8`, `claude-opus-4-8-cc[1m]`, ` claude-opus-4-8-cc[1m] `, `claude-opus-4-8-cc`, `claude-opus-4-8[1m]`, `claude-opus-4-8-preview`, `claude-opus-4-8-latest`.
- Rejects: `undefined`, empty string, `claude-opus-4-7`, `claude-opus-4-80`, `claude-sonnet-4-8`, `not-claude-opus-4-8`, `my_claude-opus-4-8`, `glm-5.2`, ` GLM-5.2 `, `zai/glm-5.2`, `z.ai/glm-5.2`, `bigmodel/glm-5.2-latest`, `glm-5.1`, `glm-5.20`, `not-glm-5.2`, `my_glm-5.2`.
- Export both from `packages/contracts/src/model/index.ts`.
- Tests: `pnpm --filter @zcode/contracts exec vitest run tests/mid-conversation-system.test.ts` (written red first).

### Task 1.2: core-layer full capability context

Files: `packages/core/src/runtime/helpers/mid-conversation-system.ts`, `helpers/index.ts`, `tests/runtime-mcs-capability.test.ts`.

Interface:

```ts
export interface MidConversationSystemCapabilityContext {
  modelRef: ModelRef;
  connection: ModelConnectionInfo;
}

type SanitizedModelConnectionInfo = Omit<ModelConnectionInfo, "apiKey" | "headers">;

export interface ResolvedMidConversationSystemCapabilityContext {
  baseURL?: string;
  connection: SanitizedModelConnectionInfo;
  modelId: string;
  modelRef: ModelRef;
  providerId: string;
  providerKind: ModelConnectionInfo["providerKind"];
}

export type MidConversationSystemCapabilityReason =
  | "supported"
  | "missing_model_connection_port"
  | "resolve_connection_failed"
  | "unsupported_provider_kind"
  | "unsupported_base_url";

export interface MidConversationSystemCapabilityDecision {
  useMidConversationSystem: boolean;
  reason: MidConversationSystemCapabilityReason;
  context?: ResolvedMidConversationSystemCapabilityContext;
}

export function evaluateMidConversationSystemCapability(
  context: MidConversationSystemCapabilityContext,
): MidConversationSystemCapabilityDecision;

export function resolveMidConversationSystemCapability(input: {
  modelConnectionPort?: ModelConnectionPort;
  modelRef: ModelRef;
}): MidConversationSystemCapabilityDecision;
```

Design:

- `evaluateMidConversationSystemCapability(...)` receives the full `ModelConnectionInfo`, so it can see `connection.model.modelId`, `providerId`, `providerKind`, `baseURL`, `providerOptions`, and `modelRef.role` / `source` / `variant`.
- The initial version judges only by `providerKind` + `baseURL` (the fast-supported model rule above is also listed in the global constraints).
- `apiKey` / `headers` may exist on the input connection but must never reach logs or trajectories; the returned decision context contains only the sanitized connection.

Test focus: allowlisted anthropic provider is supported; non-anthropic is unsupported; unknown baseURL is unsupported; missing `modelConnectionPort` returns a disabled decision; a throwing resolve returns a disabled decision; the decision context exposes the full current model/provider info (`modelRef`, sanitized connection equal to the input minus `apiKey`/`headers`, `modelId`, `providerId`, `providerKind`, `baseURL`). Verify: `pnpm --filter @zcode/core exec vitest run tests/runtime-mcs-capability.test.ts`.

## Phase 2: Make provider projection capability-aware

`buildProviderRequestMessages(...)` gains a `useMidConversationSystem` parameter. MCS on keeps the current role-system projection; MCS off uses legacy user system-reminder and restores legacy bubble-up ordering. Pause after tests and review.

### Task 2.1: builder parameter and legacy reorder

Files: `packages/core/src/runtime/helpers/provider-request-messages.ts`, `packages/core/tests/provider-request-messages.test.ts`.

```ts
export function buildProviderRequestMessages(input: {
  entries: readonly RuntimeMessageEntry[];
  applyCacheControl?: boolean;
  useMidConversationSystem?: boolean;
}): ProviderRequestMessageProjectionResult;
```

Tests:

- MCS on: entries `real_user "Summarize notes."`, attachment `prompt_attachment` "Called the Read tool with the following input: {}", attachment `output_style` "Terse output style is active." project to `[user "Summarize notes.", system "Called the Read tool with the following input: {}\n\nTerse output style is active."]`.
- MCS off: the same without the output_style attachment projects to `[user "<system-reminder>\nCalled the Read tool with the following input: {}\n</system-reminder>", user "Summarize notes."]`.

Implementation points:

- Call `projectMidConversationSystemEntries(...)` only when `useMidConversationSystem === true`; never call the MCS projector otherwise.
- `reorderAttachmentLikeEntries(...)` takes `AttachmentReorderOptions { includeMidConversationSystemAttachments: boolean }`: MCS on -> `false`; MCS off -> `true`, so formerly MCS-capable attachments return to legacy bubble-up ordering.
- Verify: `pnpm --filter @zcode/core exec vitest run tests/provider-request-messages.test.ts tests/prompt-attachments.test.ts tests/message-history.test.ts`.

## Phase 3: Wire dynamic capability into all runtime request paths

Main turn, compact, microcompact, token estimation and target verification all use the same capability decision, so provider-visible shape never diverges between request paths. Pause after focused tests and code review.

### Task 3.1: runtime wrapper

Files: `packages/core/src/runtime/helpers/runtime-provider-request-messages.ts`, `helpers/index.ts`, `tests/runtime-mcs-capability.test.ts`.

```ts
export function resolveRuntimeMidConversationSystemCapability(
  runtime: Pick<AgentRuntimeInternal, "defaultModelRef" | "modelConnectionPort">,
): MidConversationSystemCapabilityDecision;

export function buildRuntimeProviderRequestMessages(
  runtime: Pick<AgentRuntimeInternal, "defaultModelRef" | "modelConnectionPort">,
  input: { entries: readonly RuntimeMessageEntry[]; applyCacheControl?: boolean },
): ProviderRequestMessageProjectionResult;
```

`resolveRuntimeMidConversationSystemCapability` calls `resolveMidConversationSystemCapability({ modelConnectionPort: runtime.modelConnectionPort, modelRef: runtime.defaultModelRef })`; `buildRuntimeProviderRequestMessages` resolves the decision and calls `buildProviderRequestMessages({ ...input, useMidConversationSystem: decision.useMidConversationSystem })`.

Tests: under an allowlisted anthropic connection an `output_style` attachment projects as `role: "system"`; under a non-anthropic connection it projects as a legacy user `<system-reminder>` that bubbles before the real user.

### Task 3.2: replace runtime call sites

Files: `runtime/methods/{turn-loop,compact,compact-active,compact-active-helpers,target-completion-verification}.ts`, `runtime/helpers/compact.ts`, plus any separate microcompact runtime method.

- Main turn: `buildRuntimeProviderRequestMessages(this, { entries: this.messageHistory.toRuntimeEntries(), applyCacheControl: true })`.
- Compact sizing: same with `applyCacheControl: false`, taking `.messages`.
- Compact summary: `useMidConversationSystem = resolveRuntimeMidConversationSystemCapability(this).useMidConversationSystem`, passed to `estimateRuntimeEntryTokens(activeEntries, { useMidConversationSystem })`, `buildCompactSummaryRequestMessages(entriesForSummary, compactPrompt, { useMidConversationSystem })` and `estimateRuntimeEntryTokens(postCompactEntries, { useMidConversationSystem })`.
- Microcompact: the same boolean passed to `maybeLocalMicrocompactRuntimeEntries(...)`.
- Target verification: `buildRuntimeProviderRequestMessages(this, { entries, applyCacheControl: false })`.
- Verify: `pnpm --filter @zcode/core exec vitest run tests/runtime-tool-loop.test.ts tests/runtime-compact.test.ts tests/microcompact.test.ts tests/provider-request-messages.test.ts tests/runtime-mcs-capability.test.ts`.

## Phase 4: Prompt-trajectory E2E

Prove with real provider-visible trajectories that the same session/request gets the right shape under different provider capabilities. Pause for user review of the artifacts.

- A fixture with a real user prompt, at least one text-file prompt attachment and at least one runtime reminder such as `output_style` or `todo_reminder`.
- Allowlisted anthropic provider: reminder is `role: "system"`, e.g. `[user "...", system "Called the Read tool..."]`.
- Unsupported provider: reminder is a user `<system-reminder>` and attachment-like reminders bubble before the real user, e.g. `[user "<system-reminder>\nCalled the Read tool...", user "..."]`.
- Output goes to `apps/zcode-cli/out/` for review. Build first: `pnpm --filter @zcode/contracts build`, `pnpm --filter @zcode/core build`.

## Phase 5: Docs, worklog, final verification (executed 2026-06-24)

- MCS plan docs use the dynamic capability gate wording: enabled path keeps `role: "system"`; disabled path falls back to legacy user `<system-reminder>` and restores attachment-like bubble-up.
- Capability judgment reads `ModelRef` and the resolved `ModelConnectionInfo` only in the runtime wrapper / helper; the provider request builder reads no provider/model info and consumes only the `useMidConversationSystem` boolean.
- 2026-07-09 follow-up: CLI-only `--force-mcs` runtime override that forces an Anthropic provider past the model/baseURL allowlist; allowed only on `--prompt` / `--target` / `tui`, not persisted, no effect on default auto-detection; non-Anthropic providers still disable MCS.
- Producers still emit only source-aware runtime attachment entries.
- Sensitive fields: the helper does not log, persist or output `apiKey` / `headers`, and `decision.context.connection` drops them before returning.
- Prompt-trajectory evidence: `apps/zcode-cli/out/mcs-dynamic-capability/enabled` (reminder is mid-history `role: "system"`) and `apps/zcode-cli/out/mcs-dynamic-capability/disabled` (reminder is a legacy user `<system-reminder>` before the real user prompt).
- Verification: focused Vitest and `pnpm typecheck` passed; `pnpm lint` ran but was blocked by pre-existing max-lines / unused lint items, with no lint errors in the new MCS helper files.
- The worklog `apps/zcode-cli/worklogs/trajectory-align-log.md` records a per-day brief, core idea and effective scope.

Final verification commands:

```bash
pnpm --filter @zcode/contracts exec vitest run tests/mid-conversation-system.test.ts
pnpm --filter @zcode/core exec vitest run tests/runtime-mcs-capability.test.ts tests/provider-request-messages.test.ts tests/prompt-attachments.test.ts tests/runtime-reminders.test.ts
pnpm typecheck
pnpm lint
```

If `pnpm typecheck` or `pnpm lint` fails on existing repo issues, the delivery note must separate problems introduced by this change from pre-existing ones.

## Risks and safeguards

| Risk | Safeguard |
| --- | --- |
| Capability judgment scattered over call sites | Only the runtime wrapper calls the capability resolver; the provider builder takes a boolean. |
| Later model-specific gates need a refactor | The resolver takes the full context, including `ModelRef` and `ModelConnectionInfo`. |
| MCS-off provider-visible shape differs from legacy | `includeMidConversationSystemAttachments: true` restores legacy bubble-up. |
| `apiKey` / `headers` leak to logs or trajectories | A decision may hold context, but no logging/snapshot may output the full connection. |
| Compact/microcompact and main turn shapes diverge | All request paths share `resolveRuntimeMidConversationSystemCapability(...)`. |

## Self-check

- MCS enable conditions are defined only in the capability resolver.
- `buildProviderRequestMessages(...)` reads no provider/model info.
- Producers do not change entry generation by provider.
- Enabled path outputs role system; disabled path outputs user `<system-reminder>` and restores attachment bubble-up.
- Prompt-trajectory shows the shape difference under both provider capabilities.
- No automatic commit.
