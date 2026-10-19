# Agent harness comparison: ZCode core vs other harnesses (2026-10)

Scope: `apps/zcode-cli/packages/core/src` (~108k lines TS) compared with harnesses in `~/Dev/Harness App debug`:
craft-agents-oss, deepseek-harness-master (+ dsh-desktop), PI-Desktop-main, OmniRoute (gateway, compression only).
copilot-frontend is a built bundle and was skipped.

Legend: **[V]** verified in source during this review; **[R]** reported by a subagent, not re-checked.

## Where each harness keeps its loop

- **craft-agents** — no own loop; wraps Claude Agent SDK (`packages/shared/src/agent/claude-agent.ts`) and the Pi SDK over a
  JSONL subprocess. Base tools come from the SDKs.
- **DSH** — everything is a Cordis plugin (loop, tools, prompt, session log, LLM seam); typed waterfalls
  (`agent/pre-step`, `llm/stream`, `tools/pre-execute|execute|post-execute`).
- **PI-Desktop** — pi-agent-core loop in a Node sidecar (`packages/agent-runtime/src/runtime.ts`), all file/shell tools in Rust
  (`crates/host-core/src/tools/`); 358 ADRs.
- **ZCode** — own monolithic runtime (`runtime/methods/turn-loop.ts`, `turn-model-step.ts`, `model.ts`).

## Where ZCode is already ahead

Memory (recall, dream, extraction), dynamic workflows, conversation-level compaction, rewind/workspace checkpoints, hook trust
model, and the argv-level read-only bash policy are stronger than in all three harnesses.

## Confirmed gaps in ZCode

- **[V]** `auto` permission mode is a stub that denies everything (`permission/service.ts:157`, `:374`, `mode.auto.unimplemented`).
- **[V]** No OS sandbox anywhere (no sandbox-exec / bwrap / Landlock references in `apps` or `packages`).
- **[V]** Microcompact replaces old results with `[Old tool result content cleared]` (`compact/microcompact.ts:18`) — no head/tail.
- **[V]** AGENTS.md is discovered only from cwd upward (`adapters/src/context/index.ts:219`), not for nested dirs touched by tools.
- **[V]** Deferred tools / ToolSearch not finished (`runtime/methods/compact-active.ts:255`).
- **[V]** Hook events: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Stop
  (`contracts/src/hooks/index.ts:7`) — no pre-LLM-request / context-rewrite / pre-compact events.
- **[V]** Subagents share the parent's execution cwd (`subagent/system-prompt.ts:45`).
- **[R]** No fork-from-parent subagent mode; `node-repl` has no tool bindings.
- **[R]** "Always Allow" stores raw command/path rules (`tool/executor/permission-suggestions.ts`).

## Ranked ideas to borrow

| #   | Idea                                                                                                                                                                                                                                                      | Source                                                                                                                                  | Fits in ZCode                                                        | Effort |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------ |
| 1   | **Auto mode as a tighten-only model reviewer** — readonly policy pre-filter; reviewer sees only the call, not assistant text / tool results (injection resistance); no answer → ask; such prompts get no "remember" key; mode change mid-check re-decides | craft `shared/src/agent/core/guarded-mode.ts`, `server-core/src/decisions/guarded-mode.ts`; DSH `experimental/auto-review/src/index.ts` | `permission/service.ts`, `tool/executor/permission-flow.ts`          | M      |
| 2   | **Command-output compression** — rtk rewrite when installed; declarative per-command filters as fallback                                                                                                                                                  | craft `rtk-rewrite.ts`; OmniRoute `open-sse/services/compression/engines/rtk/`                                                          | see `specs/rtk-output-compression.md`                                | S–M    |
| 3   | **Smarter oversized tool results** — head+tail pruning with marker (original kept in log), collapse superseded Reads, intent-aware excerpt/summary                                                                                                        | DSH `compaction/compaction-tool-result-pruner`; OmniRoute `readLifecycle`; craft `shared/src/utils/large-response.ts`                   | `compact/microcompact.ts`, `tool/result-persistence-format.ts`       | S → M  |
| 4   | **Granular "Always Allow" keys** — subcommand-level for CLIs, none for chains/wrappers/dangerous, folder for writes, host for curl                                                                                                                        | craft `shared/src/agent/core/permission-remember.ts`                                                                                    | `tool/executor/permission-suggestions.ts` + `bash-command-parser.ts` | S      |
| 5   | **Deferred tools via ToolSearch** — bounded one-line catalog, activation rebuilt from persisted markers                                                                                                                                                   | PI ADRs 0048, 0225                                                                                                                      | `tool/tool-visibility.ts`, `runtime/helpers/runtime-tools.ts`        | M      |
| 6   | **OS sandbox + one-shot widening request** with justification routed to approval                                                                                                                                                                          | DSH `sandbox/*`, `native/system`; craft `session-tools-core/src/runtime/*-isolation.ts`                                                 | new `sandbox/` wrapping bash spawn                                   | L      |
| 7   | **Nested AGENTS.md discovery** triggered by file ops, byte budget dropping broader files first                                                                                                                                                            | DSH `context/agent-instructions`                                                                                                        | `adapters/src/context/index.ts` + reminder                           | S–M    |
| 8   | **Per-path edit-failure guard + same-path mutation lock**                                                                                                                                                                                                 | PI `agent-runtime/src/mutation-recovery.ts`, `path-lock.ts`                                                                             | `tool/handlers/edit.ts`, `tool/scheduler.ts`                         | S      |
| 9   | **Keyless replay snapshot tests** of recorded sessions + scripted failing mock LLM server                                                                                                                                                                 | DSH `test-support/llm-replay`, `session-snapshot`, `llm-mock-server`                                                                    | new test support next to `apps/zcode-cli/packages/tests`             | M      |
| 10  | **Compaction degradation ladder** (reduced input → chunked summary → keep recent window) and **estimate calibration** vs provider usage                                                                                                                   | PI ADRs 0282/0302, `context-calibration.ts`                                                                                             | `runtime/helpers/compact-selection.ts`, `compact/policy.ts`          | M      |

### Smaller / later

- Cost-aware subagent model choice (never more expensive than the session) — craft `subagent-model.ts` (S).
- Turn-outcome classifier (finished / needs_input / blocked) for unattended workflow nodes — craft `decisions/turn-outcome.ts` (S–M).
- Fork subagent seeded with parent turns — DSH `subagent-fork-in-process` (S–M).
- Hardened host git (disable repo hooks/fsmonitor, strip git env) — PI `session_worktrees/git.rs` (S).
- `context` / `before_provider_request` hook events — upstream pi `docs/extensions.md` (M).
- Hashline tag-verified edits — PI `crates/host-core/src/tools/hashline/`, ADR 0087 (L; tag-only staleness proof S–M).
- Programmatic tool calling (`run_code` with generated typed SDK, sub-calls through permissions) — DSH `core/tools/src/ptc.ts` (L).
- Decision-point framework for small-model judgments with outcome logging — craft `server-core/src/decisions/decision-point.ts` (M–L).
