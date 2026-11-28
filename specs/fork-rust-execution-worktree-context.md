# Rust agent: execution worktree notice in the model context

Status: implemented in zcode-rs (`packages/rust-cli`). Node oracle: `specs/execution-worktree-model-context.md` and core `context/sections/env-info.ts` (`formatExecutionWorktreeSentence`, `buildExecutionWorktreeSection`), `subagent/system-prompt.ts` (`buildSubagentExecutionWorktreeContext`). Parity row: `specs/fork-rust-agent-parity.md`, "Execution worktree".

## Background

A worktree session runs in a linked git worktree while its row is listed under the parent workspace. Node tells the model so with one line in its system prompt. zcode-rs ran such sessions correctly but never said it, so the model could take the worktree for the main checkout.

## Fact

The session actor holds the fact, not a flag. `ExecutionWorktreeFact` (`kernel-api` `session_ops.rs`) is `{path, workspace, branch, missing}`:

- `path`: where the session runs (the worktree);
- `workspace`: the parent workspace, the row's `directory` (Node `workspacePath`);
- `branch`: the stored `execution_branch`, if any;
- `missing`: the worktree directory was gone when the actor opened (Node sets it at resume only).

It replaces the earlier `execution_worktree: bool` in `LoadedSession`, `SessionState`, `RunView` and `LiveAgent` (one owner, no second copy). Sources:

- create in a worktree: `path` and `branch` from the request, `workspace` is the root before the move, `missing` false;
- cold load: the stored row (`directory`, `execution_directory`, `execution_branch`), `missing` is one `metadata` call when the row is loaded;
- activation of a prepared session (`Command::SetExecutionRoot {root, branch}`): `workspace` is the root before the move, `missing` false. An activation at the root the session already has keeps the fact it loaded;
- a subagent: its spawning session's fact, through `RunView`.

The fact travels to the assembler as `ContextRequest::execution_worktree`, set by the query loop from `RunView`. It is never read from the store at render time and costs no I/O per request.

## Text

One sentence, as Node `formatExecutionWorktreeSentence`. Nothing is rendered when `workspace` is empty.

Healthy:

`Execution worktree: this session runs in a linked git worktree of <workspace> (branch <branch>); file changes stay in the worktree until they are merged.`

The ` (branch <branch>)` part is left out without a branch. Missing:

`Execution worktree: the requested worktree <path> is missing; filesystem and terminal actions are blocked until it is restored. The parent workspace is <workspace>.`

Paths are written as they are (no escaping), like Node.

### Main session

- Section "Execution Worktree": `# Environment` and a line `- <sentence>` (a dash with no leading space).
- Position: in the session block, after Memory and before Context management (Node: dynamic system sections, after memory, before "Context Management"). `/context` lists it under that name, from the session's fact.
- It is isolation context, not environment text: the incognito `environment` and `harness` toggles do not drop it.
- With `--system-prompt` the default sections are gone. Node still sends the section, as its own dynamic system message after the custom prompt. zcode-rs sends it as a separate trailing system block after the custom (and appended) text, with the same cache control.
- A session without a worktree has no section: its system prompt is byte for byte what it was.

### Subagent

Node's child context builder appends `<env>`, the sentence and `</env>` (one block, lines joined with a newline) as the last part of the subagent's system text, after the token budget line, for every subagent whose parent runs in a worktree. Incognito toggles do not drop it. zcode-rs appends the same block as the last `\n\n`-joined part of the subagent system block.

A workflow actor is not covered: its system text is Node's workflow identity, and zcode-rs does not add the notice there.

### Fork children

A fork child takes the main session's context and the parent's fact, so it gets the main-session section.

## Known differences from Node

- Node freezes the system prompt in a snapshot until compaction, so the notice there changes only after a compaction. zcode-rs builds the system blocks on each request; the fact is fixed for the actor's life, so the text does not change between requests. The `missing` flag is read once, when the actor opens, as in Node; it does not follow a directory that returns or vanishes later.
- The spec of the Node side says task-tool children do not spread the parent's fact. Node's code does (`runtime/methods/subagent.ts`, `executionWorktree: this.config.executionWorktree`), and so does zcode-rs.

## Acceptance

Tests (`context` `worktree_tests.rs`, `system_tests.rs`; `agents` `report_tests.rs`; `session` and `runtime` for the fact):

1. healthy with a branch, healthy without a branch, missing: the three sentences above, byte for byte;
2. an empty `workspace` renders nothing;
3. the main section sits between Memory and Context management, is named "Execution Worktree" in `/context`, and survives an incognito profile without `environment` and without `harness`;
4. a request without the fact has no section (system blocks equal to the blocks of a session that never had one);
5. `--system-prompt`: a trailing block holds the section;
6. a subagent's system ends with the `<env>` block, also under an incognito profile; none without the fact;
7. the fact: a create in a worktree, a cold load of a stored row (with and without a branch, a missing directory), an activation and a repeated activation.
