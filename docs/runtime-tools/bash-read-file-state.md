# Bash Read File State Runtime Contract

## Background

The active path does not rely on `# Using your tools` to require the model to Read first. Instead the Bash
runtime maintains a read-state producer: conservatively recognized simple read-type Bash commands write file
content into readFileState, so the later Edit/Write read-before-write guard considers the file already read.

## Scope of this round

- Supports conservative read-state backfill for Bash `cat`, `head`, `tail`, `sed -n`, `grep`/`egrep`/`fgrep`; no backfill when Bash stdout or the FileSystemPort file read result is truncated.
- Supports `staleReadFileStateHint` after a Bash write-type command modifies an already-read file.

## Non-scope

- No seed read state.
- No NotebookEdit.
- No change to the prompt or the provider-visible tool list.
- Read-state metadata produced by Bash is not persisted.

## Runtime order

1. A Bash foreground command finishes.
2. The runtime first builds the normal `BashOutput`.
3. If the command is a write-type command, scan the readFileState that existed before execution; if an mtime advanced after Bash started, append a stale hint. The hint text shows the first 5 paths relative to cwd, appends `and N more` beyond that, and uses `file/files` singular/plural.
4. If the command is a conservatively recognized read-type Bash command and Bash stdout is not truncated, the runtime re-reads the real file from the FileSystemPort and writes readFileState; if the FileSystemPort read result is truncated, the backfill is likewise skipped so a full file the model did not see is not disguised as read.
5. background, image output and interrupted produce no stale hint and no read-state backfill.
6. A provider-error that is not a semantic failure is handled as a shell error: no stale hint and no read-state backfill; `grep`/`egrep`/`fgrep` backfill only when the exit code is 0.
