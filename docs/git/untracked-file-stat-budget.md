# Untracked File Line Count Statistics Reading Budget

## Reason and Scope

Windows 3.12.1 logs showed the Host reaching an external-memory peak of about 2.67 GiB during Git refresh. `buildUntrackedStats` called `readFile` concurrently for every untracked file and identified binaries only after fully loading them. In an isolated reproduction, a 256 MiB binary file increased external heap memory by about 256 MiB while the result still reported zero lines. The 512 KiB `git status` output limit constrains only the path list, not file content size.

The fix covers untracked-file statistics in Git status refresh only. Git commands, tracked-file statistics and diff preview are unchanged.

## Behavior Contract

- Single-file statistics limit is 1 MiB. A file over the limit keeps its change entry, with `added=0, removed=0` like any non-countable file.
- Ordinary text within the budget keeps exact line counts: empty file, LF, CRLF, no trailing newline, and newlines across chunk boundaries.
- File type and size are checked first; only ordinary files are read, at most 64 KiB at a time. A NUL in any chunk returns zero lines as binary.
- Each statistics run uses at most four workers, each reusing one 64 KiB Buffer; total read buffers are at most 256 KiB regardless of file count or total size.
- If a file grows after the check, at most 1 MiB + 1 byte is read to detect the overrun; an overrun returns zero lines, never a partial count.
- Deleted, unreadable and non-ordinary files fall back to zero lines. An opened handle is closed on success, binary, overrun and exception paths.
- No persistent cache, background timer, second Git status or new RPC.

## Ownership and Sequence

```text
Existing Git refresh of desktop / mobile Web / remote workspace
  → GitCliRepo.getStatus in the services that host the workspace
  → untracked entries → four workers → size check → chunked statistics → same status snapshot
                                          └─ large file / binary / failure → zero lines, entry kept
```

The reading budget and workers belong to one repo query; existing in-flight merging and UI late-result handling are unchanged. File paths still use workspacePath/repoRoot; no identity cache is added and workspaceIdentity isolation is unchanged. The shared services implementation covers Windows/macOS/Linux and local and remote execution; it does not touch Agent runtime, CommandInbox, owner, snapshot, desktop continuous or mobile replayable paths.

## Verification Contract

- Unit tests verify real small-file line counts, that over-limit files are not content-read, early stop on binaries, the four-worker cap, growth races and handle cleanup.
- Existing Git repo/service regression tests keep entries and staged/unstaged behavior compatible.
- SP13 pending file attachment resource regression: after a real watcher auto refresh, a small file updates to `+4 -0`, over-limit text counts no lines, and the Host working-set peak is recorded; it does not depend on Git pane navigation.
- Re-run the pre-fix memory probe with the same 8 × 32 MiB binary files and compare the heap external memory increment.

## Verification Result (2026-09-14)

- Same 8 × 32 MiB binary files, real helper: heap external memory increment about 256 MiB before the fix, about 0.3 MiB after; both runs report zero lines.
- Git helper / repo / service: 35 unit tests pass; the new reading-budget test fails 4 and passes 1 on the old implementation and passes fully after the fix.
- Real macOS Electron resource regression passes: after auto refresh the status bar shows `+4 -0`, Host working-set peak increment 1,648 KiB; an independent re-run measured 464 KiB (1 case passed), without calling a model. Report: `packages/desktop/.e2e-artifacts/desktop-e2e-20260914-041207-001/summary.md`.
- `pnpm typecheck`, desktop `typecheck:e2e`, `pnpm lint` and `pnpm architecture:check --changed` pass; lint keeps its 42 pre-existing warnings, no errors.
- Known gap: the existing SP13 pending scenario that opens the Git pane through `Changes` failed in this round and never reached the large-file read; the extra resource regression runs independently and does not claim to fix that navigation problem or the whole pending file.
- Known gap: the conversation coverage audit still reports I74/I75 unknown abbreviation and stale counts/generated document; a clean temporary directory at the then-current HEAD gives the same errors, so the audit baseline was not changed.
- Not verified on real Windows, Linux, mobile remote control or remote workspaces; the shared repo implementation changes no protocol or identity isolation, and E2E triggers refresh through Git metadata changes to stay compatible with Linux non-recursive listening.

Command for the independent resource run:

```bash
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts \
  --spec ./test/e2e/conversation-session/conversation-session-git-review-entry.test.ts \
  --mochaOpts.grep 'Git 自动刷新'
```
