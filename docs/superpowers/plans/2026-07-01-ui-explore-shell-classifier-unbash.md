# UI Explore Shell Classification unbash Alignment

> Plan from 2026-07-01, NOT yet implemented. The UI still classifies shell commands with the
> regex scan in `packages/ui/src/lib/exploreToolCall.ts` (`EXECUTE_READ_COMMAND_RE` /
> `EXECUTE_WRITE_COMMAND_RE` + segment `some(...)`), and `unbash` still lives only in
> `apps/zcode-cli/packages/core`. Kept as the open plan for the misclassification bug below.

## Problem

Explore aggregation splits a Bash command string on `&&` / `||` / `;` and aggregates into
Explore if any segment matches the read regex. A real executing command such as

```text
eval "$(fnm env --shell bash 2>/dev/null)"; cd /d/aai-projects/www-aicodezen && pnpm install --ignore-workspace 2>&1 | tail -5
```

is misclassified as Explore because the trailing `tail -5` segment matches. CLI semantics
(`isRuntimeReadOnlyBashCommand`) correctly rejects the same command; only the UI display
classification diverges.

## Target Design

- Move the browser-safe Bash parser and readonly policy to a `@zcode/shared/shell` subpath
  (shared owns `unbash`; `@zcode/core` consumes it via the workspace dependency). Nothing
  Node-only (e.g. `.git` runtime guards) may be exported from shared browser-facing paths.
- Add `classifyBashCommandForExplore(command, options?)` returning
  `{ isExplore, isList, isRead, isSearch, reason }` with reasons: `empty`, `unsafe-syntax`,
  `write-command`, `non-readonly-command`, `non-explore-command`, `read-only-explore`.
- Classification is all-command semantics: a command is Explore only if every parsed simple
  command is readonly-safe and at least one is a search/read/list command (search: `rg`, `grep`
  etc.; read: `cat`, `head`, `tail`, `sed`, `jq` etc.; list: `ls`, `find`, `tree`, `du`; git
  `grep` → search, git `diff|log|show|status` → read, git `ls-files|branch` → list). Mutating
  commands piped through `tail`/`head` (`pnpm install | tail -5`, `npm install 2>&1 | tail -20`,
  `rm -rf dist | cat`) must stay non-Explore; dynamic expansion (`grep foo $(touch out.txt)`)
  is `unsafe-syntax`.
- UI: stop splitting Bash by string; hand the full command to the shared classifier
  (`normalizeCommandCandidate` returns the unwrapped command only). PowerShell keeps its own
  read/write command-table classification. UI must not import `@zcode/core`.
- This is display-only: no changes to Bash runtime execution, permissions, sandbox, session
  stream, desktop-continuous, or web-remote-replayable semantics.

## Acceptance Essence

- Install-with-tail commands render as an independent shell tool, not under the Explore group;
  read-only pipelines (`grep -R -n foo src | head -20`) still aggregate into Explore.
- PowerShell read/write behavior unchanged; regression tests in
  `packages/ui/test/toolCallBlocks.test.ts`, `toolCallAggregation.test.ts`,
  `chatMessage.test.ts`, and core `bash-permission.test.ts` (plan-mode denial list gains the
  install-with-tail samples).
- Web bundle must not pull `node:fs` / `node:path` from the shared classifier.
