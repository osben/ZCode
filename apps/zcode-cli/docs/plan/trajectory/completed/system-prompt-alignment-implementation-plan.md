# System Prompt Assembly Historical Plan

Date: 2026-06-02

Status: main body implemented. This is a historical completion record, not an executable plan.

Related commits: `5f073d6a feat(zcode-cli): align system prompt assembly`, `37de3682 fix(zcode-cli): align provider-visible prompt identity`, `523f1332 fix(zcode-cli): align git system context prompt`.

## Goal

Within the active system prompt slice, fix the content, structure and order of the system prompt zcode-cli sends to the model provider:

- P-01: stable ZCode CLI/product identity prefix.
- P-02: default stable system body.
- P-03: custom prompt semantics of `systemPrompt` (replaces the default body; keeps the CLI prefix and request-level context).
- P-04: first active dynamic system sections: `session_guidance`, `language`, `output_style`, `frc`, `summarize_tool_results`.
- P-05: provider-visible git/env_info/project_context context policy.

Not in this slice: request-level `userContext`, follow-up attachments, P-12 tool schema text, P-13 ToolSearch, postponed MCP instructions, auxiliary/side request prompt chrome.

## Completion state

| Slice | State | Result |
| --- | --- | --- |
| SP-S1 CLI prefix + stable body | Done | The provider request carries the ZCode CLI prefix in its own first system message; the stable body starts at `# Agent Identity` and does not repeat the prefix sentence. |
| SP-S2 custom prompt semantics | Done | `systemPrompt` takes the custom path: keeps the ZCode CLI prefix and request-level/meta-user context; skips the default stable body, dynamic system sections, `env_info`, git snapshot and `project_context`. The separate `overrideSystemPrompt` input was removed to avoid a second override semantics. |
| SP-S3 active dynamic sections | Done | `session_guidance`, current-prompt-language guidance, `output_style`, FRC and `summarize_tool_results` are emitted in the order below. |
| SP-S3 postponed dynamic sections | Done as absence | `scratchpad`, `token_budget`, MCP instructions and dynamic sections ZCode has no feature for emit no empty placeholder. |
| SP-S4 git/env_info/systemContext | Partial | `env_info` is reduced to env_info_simple; git branch/status/commits are an independent gitStatus systemContext message inserted after dynamic system. The full decision background and provider-visible position of `project_context` and `systemContext` are a follow-up. |
| SP-S5 prompt-trajectory evidence | Manual evidence | The `system-prompt-basic` testcase and the `git-system-context-check` out request body confirm the provider-visible order by hand; `expect.json` auto-compare is not extended. |

## Final provider-visible shape

Default main session:

```text
messages:
  [0] system: ZCode CLI prefix
  [1] system: stable body beginning with # Agent Identity
  [2] system: selected dynamic system sections
  [3] system: optional gitStatus systemContext snapshot when cwd is a git repository
  [4...] user meta context / conversation messages
```

Custom body:

```text
messages:
  [0] system: ZCode CLI prefix
  [1] system: custom system body from systemPrompt
  [2...] user meta context / conversation messages
```

Active dynamic system section order:

```text
session_guidance
memory
env_info_simple
language
output_style
frc
summarize_tool_results
```

## Implementation evidence

| Area | Evidence |
| --- | --- |
| ContextBuilder boundaries | `apps/zcode-cli/packages/core/tests/context-builder.test.ts`: separate prefix/stable/dynamic/git systemContext messages, custom body, default semantic anchors, current-prompt-language guidance, output style framing, FRC and summarize conditions. |
| Runtime request shape | `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`: `systemPrompt`, no request-time context prefix mutation after MCP initialization, multi-turn request shape with dynamic sections plus MCP tools. |
| Bootstrap locale boundary | `apps/zcode-cli/packages/bootstrap/tests/session-persistence.test.ts`: UI locale detection/persistence while provider-visible language guidance stays independent of locale; model refresh and resume-time git systemContext snapshot stability. |
| Prompt trajectory | `apps/zcode-cli/tools/prompt-trajectory/testcases/system-prompt-basic/` and `apps/zcode-cli/tools/prompt-trajectory/out/git-system-context-check/trajectories/0001.openai_request_body.json`. |

Focused validation:

```bash
pnpm --filter @zcode/core exec vitest tests/context-builder.test.ts tests/runtime-trace.test.ts tests/runtime-hooks.test.ts tests/runtime-memory.test.ts tests/mcp-runtime.test.ts --run
pnpm --filter @zcode/bootstrap exec vitest tests/session-persistence.test.ts --run
pnpm --filter @zcode/prompt-trajectory typecheck
```

Repo-wide `pnpm typecheck` / `pnpm lint` results are not recorded here and are not proof of completion.

## Residual follow-ups

| Item | Status | Note |
| --- | --- | --- |
| SP-S4 project_context / systemContext background | Follow-up | Separately expand the decision background, `systemContext` semantics, the ZCode `project_context` provider-visible surface, and whether to keep converging. |
| Auxiliary / side request prompt chrome | Out of scope | Not an acceptance criterion of this slice; handle in the auxiliary request / P-36 / P-37 documents. |
| Prompt-trajectory `expect.json` automation | Skipped | Only manual request-body evidence is kept. |

Further work on SP-S4 or auxiliary requests belongs in a new or updated plan, not this document.
