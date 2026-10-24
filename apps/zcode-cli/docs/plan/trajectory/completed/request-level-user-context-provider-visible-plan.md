# Request-level UserContext Provider-visible Plan

**Goal:** Fix the final provider-visible content, order and key request surfaces of the request-level `userContext`, without refactoring the `MessageHistory` prefix lifecycle.

**Status:** Complete for the provider-visible active scope. The full request prefix projection / `MessageHistory` structural split remains a future reference, not part of this plan.

**Architecture:** Keep the `ContextBuilder -> MessageHistory` prefix model. System prompt blocks, the skills listing and the context meta-user still enter the in-memory `MessageHistory` at initialization; reset/compact keep the prefix through `countContextPrefixMessages(...)`. This plan changes only the userContext text structure, field order, custom/compact/Explore behavior and verification coverage of the final provider request.

## Scope

In scope:

- Keep the `MessageHistory` prefix as is (system / skills / userContext stay in history).
- Keep the ZCode provider-visible title `# user_instructions`; fix the leading structure and relative order of the request-level userContext.
- Keep the ZCode single-file priority `AGENTS.md -> CLAUDE.md` as a deliberate product decision.
- Append `project_context` to the end of the `# user_instructions` block as ZCode extra content; it is no longer a standalone provider-visible field.
- Order: `# user_instructions` block first, `# currentDate` after. With no instruction/project context, no empty `# user_instructions` is emitted.
- Verify custom system prompt, compact/reset and Explore subagent final provider bodies; make only small targeted fixes.
- Verify each phase with focused tests plus prompt-trajectory e2e on the final request body.

Out of scope:

- Moving system / skills / request-level userContext out of `MessageHistory`.
- Removing `countContextPrefixMessages(...)` or restructuring request assembly segments.
- Full multi-layer `CLAUDE.md` / `.claude/rules` / include / conditional discovery.
- User-message `content[]` merge, attachment bubble-up, ToolSearch, MCP instructions.
- Exact wording; the target is structure, order and semantics, keeping ZCode's own section titles.

Baseline before this plan: the context meta-user held `# currentDate`, `# user_instructions` and `project_context`, written to `MessageHistory` at initialization. A custom `systemPrompt` kept skills/currentDate/userInstructions but dropped `project_context`; this plan keeps it by default because it belongs to `# user_instructions`. `date_change` reminders are owned by the system-reminder slice and unchanged.

## Product decisions

| ID | Decision | Rule |
| --- | --- | --- |
| PVC-D1 | Internal structure | Prefix stays in the in-memory `MessageHistory`. |
| PVC-D2 | Provider-visible title | Keep `# user_instructions`; no other section name, no dynamic `# agentMd` by file name. |
| PVC-D3 | Instruction source | Keep `AGENTS.md -> CLAUDE.md` priority. |
| PVC-D4 | Project context | Appended to the end of the `# user_instructions` block as ZCode extra; no standalone `# projectContext`. |
| PVC-D5 | Custom system prompt | The custom body skips default system/systemContext but keeps userContext; `project_context` is kept because it belongs to `# user_instructions`. |
| PVC-D6 | Compact/reset | Keep the existing prefix retention mechanism; verify only the final provider body. |
| PVC-D7 | Explore subagent | Read-only omit: an Explore child request omits the instruction/project userContext block and keeps `currentDate`. |
| PVC-D8 | Full discovery | Postponed: no multi-layer `CLAUDE.md` / `.claude/rules` / local / include / conditional discovery. |

## Phases

Each phase stops after tests plus prompt-trajectory e2e for user review.

### Phase PVC0: Normalize plan state

The earlier full prefix projection plan is a future structural split reference; the active path is provider-visible formatting only. The old UC1 split runtime code was reverted, so the baseline is prefix-in-`MessageHistory`.

### Phase PVC1: Content and order formatting

Target shape:

```text
<system-reminder>
As you answer the user's questions, you can use the following context:
# user_instructions
Codebase and project instructions are shown below.

Source: /path/to/AGENTS.md
...

Project context:
...

# currentDate
Today's date is YYYY-MM-DD.

IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.
</system-reminder>
```

- Instruction and project content share one `# user_instructions` block; `project_context` is at its end. With project context but no instruction, `# user_instructions` is still emitted; with neither, it is not.
- `# user_instructions` precedes `# currentDate`.

Files: `packages/core/src/context/{builder,types}.ts`, `packages/core/src/context/sections/request-user-context.ts`, `packages/core/tests/context-builder.test.ts`, testcase `tools/prompt-trajectory/testcases/request-user-context/`.

Tests (ContextBuilder):

- No instruction/project: only `# currentDate`.
- `AGENTS.md` + `CLAUDE.md`: `# user_instructions` has the `AGENTS.md` content and not the `CLAUDE.md` content.
- Only `CLAUDE.md`: `# user_instructions` has the `CLAUDE.md` content.
- Project context only: `# user_instructions` exists with no empty instruction source.
- Instruction + project context: project context is at the end of `# user_instructions`, before `# currentDate`.

```bash
pnpm --filter @zcode/core exec vitest tests/context-builder.test.ts --run
pnpm --filter @zcode/core typecheck
pnpm --filter @zcode/core build
pnpm --filter @zcode/prompt-trajectory run:testcases -- --cases testcases/request-user-context --out-root out/request-user-context-pvc1
```

Expected: `# user_instructions` before `# currentDate`; no other instruction section title; no standalone `# projectContext` / `## 项目信息` outside `# user_instructions`.

### Phase PVC2: Custom and compact surface verification

Keep the prefix lifecycle; verify the provider body after custom/compact/reset has no loss, duplicate or reorder. Targeted fixes only.

- A custom `systemPrompt` path keeps the context meta-user, with `project_context` inside `# user_instructions`.
- After compact/reset, the userContext prefix appears exactly once in the provider body.
- If a compact auxiliary request sends a provider request, it includes userContext per the product decision; if the current path lacks that, record a targeted follow-up rather than expanding into a prefix projection refactor.

Files as needed: `context/builder.ts`, `runtime/helpers/compact.ts`, `runtime/methods/compact-active.ts`; tests `runtime-trace.test.ts`, `runtime-compact.test.ts`.

Tests:

- Runtime trace, custom system prompt + projectContext: body has CLI prefix + custom system + context meta-user with `# user_instructions` and `# currentDate`, no default dynamic system.
- Runtime trace, reset/compact-like history preservation: the context meta-user appears once.
- Prompt-trajectory `custom-system-project` and `compact-prefix` cases (multi-round/compact exports no duplicate context meta-user).

Evidence: `apps/zcode-cli/tools/prompt-trajectory/out/request-user-context-pvc2/test20260605-142700`.

### Phase PVC3: Explore subagent context trimming

Explore child requests omit the instruction/project userContext block and keep `currentDate`; main session requests are unaffected.

Files as needed: `runtime/methods/subagent.ts`, `context/builder.ts`; tests `runtime-trace.test.ts`, `subagent-explore.test.ts`.

Tests: Explore child has no `# user_instructions` and has `# currentDate`; the parent main request still has both when instruction/project context exists.

Evidence: `apps/zcode-cli/tools/prompt-trajectory/out/request-user-context-pvc3/test20260605-144412` (`explore-trim/0002-non-incremental-change.openai_request_body.json` is the Explore child request).

## Final acceptance

- Final provider body keeps the `# user_instructions` title with the order/structure above.
- `AGENTS.md -> CLAUDE.md` priority is intact and documented as a deliberate product decision.
- `project_context` is inside `# user_instructions`, not a standalone provider field.
- `# user_instructions` precedes `# currentDate`; an empty `# user_instructions` is not emitted.
- A custom system prompt keeps userContext; compact/reset does not duplicate or drop it.
- The Explore child omits instruction/project userContext but keeps currentDate.
- Full prefix projection / `MessageHistory` cleanup remains future reference.
