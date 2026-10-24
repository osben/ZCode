# P-12 Tool Descriptions / Schema Alignment Plan

Date: 2026-06-08. Status: complete (all phases accepted 2026-06-08).

## Goal

Align the provider-visible surface of the tools ZCode currently supports, as sent to the model provider:

- `tools[].name`
- `tools[].description`
- `tools[].inputSchema`
- whether a tool appears in the final `tools[]` of the main and Explore child requests
- the provider-visible description of the `Agent(Explore)` tool that ZCode already supports
- the provider-visible system prompt of the Explore Agent / Explore child

Internal shapes (registry, Zod, adapter, schema transform) are not acceptance targets. Only differences in the
final provider body (tool presence, name, description, JSON schema, child prompt) belong to P-12.

## Frozen decisions

| ID | Decision |
| --- | --- |
| TD-D1 | The model-facing schema/description of `Read/Write/Edit.file_path` uses absolute-path semantics. Whether the runtime still accepts relative paths is not written into provider-visible wording. |
| TD-D2 | `TodoWrite.priority` / `activeForm` keep their shape. Keep `priority`; only add `content/status`, the status enum and guidance to maintain todos proactively. |
| TD-D3 | The `Skill` provider-visible schema uses the field `skill`. The runtime may still accept the old `name` input, but the final tool schema no longer exposes `name`. |
| TD-D4 | `Glob/Grep` are removed from the main provider `tools[]` and kept only on the Explore child tool surface. `toolAllowlist` can only narrow the current tool pool; it cannot promote Explore-only tools to main. |
| TD-D5 | `GoalRead` is an obsolete provider tool and is removed from provider-visible `tools[]`. Goal continuation / verification keeps using the runtime prompt, tool results or the existing goal flow. |
| TD-D6 | `Agent` covers only the Explore subset ZCode supports today, and the Explore Agent's child system prompt is aligned explicitly. `model`, custom/team/fork/worktree/isolation/cwd and other unsupported capabilities are postponed. |
| TD-D7 | `WebSearch` provider-visible schema/description/native-search branch was postponed in the P-12 baseline; it was later landed separately by the [WebSearch client tool plan](./websearch-client-tool-implementation-plan.md). |
| TD-D8 | Read PDF / notebook / SVG / `pages` capabilities that ZCode is not provider-ready for are postponed; P-12 covers only the supported text/image Read. |
| TD-D9 | `ExitPlanMode` V2 / plan-file approval flow is postponed; the current ZCode contract stays. |
| TD-D10 | `ApplyPatch`, `TodoRead`, `ReadSessionContext`, `Workflow` stay as ZCode-specific tools; their description/schema must be truthful and must not claim non-existent capabilities. |
| TD-D11 | Whether `Skill` enters the child tool surface of future agents / custom agents is postponed. Only the main `Skill` schema changes now; the Explore child does not expose `Skill`. |

## Non-goals

- No WebSearch changes.
- No Read PDF / notebook / SVG / `pages` implementation.
- No migration of the Todo runtime/session model to `activeForm`.
- No subagent `model` override or custom agent.
- No decision on `Skill` in future agents' child tool surface; the Explore child explicitly omits `Skill`.
- No rewrite of plan mode / the `ExitPlanMode` V2 flow.
- No change to session store, UI transcript, permission broker or tool-execution side effects, except where a provider schema change requires runtime-compatible parsing.

## Phase gate

After each phase, stop and hand the following to the user; continue to the next phase only after confirmation:

1. Change summary and affected surface of the phase.
2. Focused unit test results.
3. The prompt-trajectory e2e output directory for the phase, and which `*.openai_request_body.json` to inspect.
4. Whether the provider-visible diff matches expectations, with postponed items and residual risk.

## Phases

### Phase 0: Baseline and red/green tests

Lock the provider-visible tool surface with focused tests (TDD red first) instead of manual inspection:

- Main runtime provider `tools[]` contains no `Glob` / `Grep` / `GoalRead`.
- A main `toolAllowlist` that names `Glob` / `Grep` still cannot promote Explore-only tools.
- The Explore child provider `tools[]` contains `Glob` / `Grep` and no edit/write/agent tools.
- Provider-native `web_search` behavior is unchanged; assertions only guard against accidental removal of the existing native projection.
- Prompt-trajectory testcases cover the main basic request, the Agent-enabled parent request and the Explore child request tool lists.

Baseline facts at plan start: `AgentRuntime` always passed `includeExploreOnlyTools: true`, so main exposed `Glob/Grep`; `GoalRead` entered `builtInTools` through `targetReadToolEntry`; `Skill` schema was `{ name, args? }`; `Read/Write/Edit.file_path` said "absolute or relative"; old tests locked main to include `Glob/Grep`.

Files: `apps/zcode-cli/packages/core/tests/{main-tool-pool,subagent-explore,tool-contracts}.test.ts`, `apps/zcode-cli/tools/prompt-trajectory/testcases/p12-tool-surface/*`.

```bash
cd apps/zcode-cli
pnpm --filter @zcode/core exec vitest run tests/main-tool-pool.test.ts tests/subagent-explore.test.ts tests/tool-contracts.test.ts
pnpm --filter @zcode/bootstrap^... build
pnpm --filter @zcode/bootstrap build
pnpm prompt-trajectory:testcases -- --cases testcases/p12-tool-surface --out-root out/p12-tool-surface
```

### Phase 1: Tool exposure

Change only the final provider-visible tool list, not handler behavior.

- `includeExploreOnlyTools` is on only when `config.toolset === "explore"`.
- Keep the order in `resolveBuiltInToolAllowlist(...)` and the register filter: filter by toolset scope first, then apply the allowlist, so the allowlist cannot promote `Glob/Grep` to main.
- Remove `GoalRead` from the provider-visible built-in tool list. Delete only the provider tool registration; keep the goal continuation / verification capabilities that internal code still uses (`target.ts`, goal runtime).
- The Explore child still has `Glob/Grep`. `ApplyPatch/TodoRead/ReadSessionContext/Workflow` are not removed.

Files: `packages/core/src/runtime/agent-runtime.ts`, `packages/core/src/tool/handlers/index.ts`, `main-tool-pool` / `subagent-explore` / `tool-contracts` / `target-tool` tests.

Acceptance:

- Main provider request `tools[].name` has no `Glob/Grep/GoalRead`.
- Explore child provider request `tools[].name` has `Glob/Grep`.
- `toolAllowlist: ["Glob", "Grep"]` in main does not produce these provider tools.

### Phase 2: Hard provider schema differences

- `Skill` provider schema is `{ skill: string, args?: string }`. The runtime parser accepts both old `{ name }` and new `{ skill }`, but `inputSchema` projects only the new field. The handler normalizes to `skillName` internally.
- `Read/Write/Edit.file_path` description uses absolute-path semantics.
- `Read.pages` is not exposed in the provider schema (no provider-ready capability); the runtime schema keeps the legacy `pages` for compatibility. Restoring it provider-visibly is a postponed P-12/Read media-docs item, reopened only when real PDF/pages support exists.
- `TodoWrite` keeps `priority`, adds no `activeForm`; description covers `content/status`, the status enum, at most one `in_progress`, and proactive todo maintenance guidance (including "do not mark complete" rules).

Files: `packages/contracts/src/tools/{skill,read,write,edit,todo}.ts`, `packages/core/src/tool/handlers/{skill,read,todo}.ts`, `skill-tool` / `tool-contracts` / `tool-input-normalization` tests.

Acceptance:

- Provider-visible `Skill.inputSchema.properties` has `skill`, not `name`.
- The runtime executes `Skill` with both old and new inputs.
- Provider-visible `Read/Write/Edit.file_path` no longer teaches relative paths.
- No `activeForm`, `Agent.model`, WebSearch or Read media capability is introduced.

### Phase 3: Common tool description / guidance

Descriptions cover the semantics; they need not match word for word.

- `Read`: prefer Read for known file paths, Bash `ls` for directories, default line-output semantics, do not guess about empty/unreadable results, do not use Bash `cat` instead of Read.
- `Write`: existing files must be Read first, prefer Edit for existing files, do not proactively create docs/README, no emoji by default.
- `Edit`: must Read first, `old_string` uniqueness, restore real content when Read output is line-number-prefixed, `replace_all` boundaries.
- `Bash`: destructive git / hooks / package install / polling / background / timeout / sandbox-override guidance; must not unconditionally point to `Glob/Grep`, which main does not have.
- `WebFetch`: within current fields only: source/quote safety, private/auth URLs, redirects, prefer the GitHub CLI for GitHub, MCP preference. No WebSearch/native-search.
- `AskUserQuestion`: when to clarify, not a replacement for plan approval, `Other` option is provided by the client, preview/multiSelect boundaries.
- `EnterPlanMode`: state the real main facts: main has `Read/Bash/Agent(Explore)`; `Glob/Grep` exist only inside the Explore child.
- ZCode-specific tools (`ApplyPatch/TodoRead/ReadSessionContext/Workflow`) describe only their real capability.

Files: `packages/core/src/tool/handlers/{read,write,edit,bash,webfetch,todo,ask-user-question,plan-mode}.ts`, `tool-contracts.test.ts`.

Acceptance:

- Main provider `Bash.description` no longer unconditionally points to `Glob/Grep`.
- Key behavior guidance of `Read/Write/Edit/Bash/TodoWrite` is findable in the provider-visible description.
- No description claims a postponed or unimplemented capability.

### Phase 4: Glob / Grep Explore-only schema and description

- `Glob` schema: `pattern` required, `path` optional, strict object (`additionalProperties: false`). Description: fast file pattern matching, modification-time sorting, find files by name patterns, use the Agent tool for open-ended multi-round search. Path wording is current-working-directory semantics.
- `Grep` schema: `pattern` required; `path/glob/output_mode/-A/-B/-C/context/-n/-i/type/head_limit/offset/multiline` stay truthful to what is supported. Description: ripgrep-compatible search, regex, glob/type filter, output modes, do not use Bash `grep/rg` instead of the dedicated tool, use the Agent tool for open-ended multi-round search.
- If the registry still shares the same description, confirm main never sees the `Glob/Grep` contract.

Files: `packages/contracts/src/tools/{glob,grep}.ts`, `packages/core/src/tool/handlers/{glob,grep}.ts`, `tool-contracts` / `subagent-explore` tests.

Acceptance: the Explore child request has complete `Glob/Grep` schema/description; the main request has no `Glob/Grep`.

### Phase 5: Agent tool description + Explore Agent prompt

Aligns two provider-visible surfaces: the `Agent` tool description/schema in the main request, and the Explore Agent system prompt in the Explore child request. No unsupported agent feature is introduced.

- `Agent` description uses Explore routing semantics: open-ended codebase research / locating files / references / answering where/how questions (not the old "not for open-ended analysis" wording). It states that Explore is stateless and read-only, that the final answer returns only to the parent, and that the parent must relay it. It also covers the supported usage notes: description/prompt parameters, trust-but-verify, background/foreground, fresh agent with a self-contained prompt, parallel launch and available agents.
- `Agent` schema exposes only `description/prompt/run_in_background/subagent_type: "Explore"`; no `model`, no `isolation`.
- Explore Agent prompt: read-only file-search and codebase-research specialist (keeping the ZCode identity). The read-only critical section forbids creating, modifying, deleting, moving or copying files, temp files, and Bash commands that change file/process/system state. Redirects / heredoc file writes and state-changing commands are forbidden, but read-only pipelines (`|`) are allowed (the old over-broad `|` ban is removed).
- Tool guidance matches the final child `tools[]`: `Glob` for files, `Grep` for content, `Read` for known paths, `Bash` only for read-only shell operations; no spawning agents.
- `Skill` is not mentioned in the Explore prompt and not in the Explore child `tools[]`. WebFetch/TodoWrite guidance describes only supported behavior. Agent description and Explore prompt may semantically suggest `WebSearch` for current / post-knowledge-cutoff information.
- Final answer guidance: answer directly, cite evidence file paths, quote code only when necessary, state gaps when evidence is insufficient, stay compact enough for the parent to continue.

Files: `packages/contracts/src/tools/agent.ts`, `packages/core/src/tool/handlers/agent.ts`, `packages/core/src/subagent/explore.ts`, `subagent-explore` / `tool-contracts` tests.

Acceptance:

- A parent request with `Agent` has a description that states the Explore use cases and limits.
- The Explore child system prompt is a read-only file-search/codebase-research specialist and covers the read-only boundary, tool priority and final answer guidance, without banning read-only pipes.
- The child tool list matches Phase 1.

### Phase 6: Prompt-trajectory e2e and closing

Final acceptance by provider-visible request body:

- Main request: `tools[].name`, `Skill.inputSchema`, `Read/Write/Edit.file_path` description are checked.
- Agent-enabled parent / Explore child: parent has no `Glob/Grep/GoalRead`; child has `Read/Bash/Glob/Grep` and no `Agent/Skill/Write/Edit/ApplyPatch/GoalRead`.
- Explore child system prompt shows the Phase 5 identity, read-only boundary, tool priority and final answer guidance; no `Use Skill`, no old `|` ban.
- No request top-level / message-level runtime metadata leaks into `*.openai_request_body.json`. `AskUserQuestion.metadata.source` is a provider-visible tool schema field, not runtime metadata.
- `Agent` schema has no `model/isolation`; `Skill` schema has `skill` and no `name`.

Final evidence directory: `tools/prompt-trajectory/out/p12-tool-surface-final-review-20260608-184856/test20260608-184857`. Verified with focused core/contracts tests, touched-package `tsc --noEmit`, touched-file `oxlint` and `git diff --check`.

Environment blockers recorded at acceptance (not P-12 regressions): root `pnpm typecheck` / `pnpm lint` were blocked by the pnpm deps status check without a TTY; `apps/zcode-cli` `pnpm typecheck` / `pnpm lint` were blocked by a missing local `turbo` shim; wider package `oxlint` hit pre-existing `max-lines` / unused / optional-chaining issues in files P-12 did not touch (for example `core/src/workflow/lifecycle.ts`, `core/src/subagent/runner.ts`, `contracts/src/model/index.ts`, `bootstrap/src/zcode-protocol/session-mapper.ts`).

```bash
cd apps/zcode-cli
pnpm --filter @zcode/core exec vitest run tests/main-tool-pool.test.ts tests/subagent-explore.test.ts tests/tool-contracts.test.ts tests/skill-tool.test.ts tests/tool-input-normalization.test.ts
pnpm --filter @zcode/core exec vitest run tests/target-tool.test.ts
pnpm --filter @zcode/contracts exec vitest run tests/grep.test.ts
pnpm --filter @zcode/bootstrap^... build
pnpm --filter @zcode/bootstrap build
pnpm prompt-trajectory:testcases -- --cases testcases/p12-tool-surface --out-root out/p12-tool-surface
pnpm typecheck
pnpm lint
git diff --check
```

If full `pnpm lint` is blocked by existing untouched problems, list the blocking files and the focused lint/typecheck results; never report blocked as passed.

## Risks

- `Skill.skill` is a provider schema breaking change: the runtime parser must accept the old `name`, and historical tool calls in trajectory/replay must still execute.
- Removing main `Glob/Grep` changes the model's search path: `Agent` must be exposed when subagent capability is available, and Bash/plan-mode guidance must not ask main to use `Glob/Grep` directly.
- Removing the `GoalRead` provider tool must not affect internal goal continuation / verification prompts or tool-result flow; a focused test guards goal runtime.
- `Bash` description is shared provider text for main and Explore; do not write it as a fact unique to one surface unless only that surface sees it.
- `Read.pages` may have a historical mismatch between field and real capability; verify the handler/provider before deciding between removing it from the provider schema and postponed-safe wording (resolved in Phase 2: removed from provider schema).

## Execution notes

- Stop after each phase for user review; never advance automatically.
- Do not commit automatically; commit only when the user asks.
- New code comments, if required, explain the bug/design reason and do not name other products.
- The plan is marked complete only after Phase 6 acceptance.
