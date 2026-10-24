# TMPDIR write convergence spec

## Background

The system temp directory may have restricted permissions from the host environment, a sandbox or an
enterprise security policy. If ZCode's main product paths depend on writing to `TMPDIR` /
`os.tmpdir()`, log export, feedback upload, clipboard image reads, checkpoint builds or command-output
persistence fail in some environments.

## Goals

- Apart from the Bash output exception below, controllable ZCode temporary/persisted files live under
  the data root, `~/.zcode` by default.
- Bash output prefers the system temp directory and, when that directory is unavailable, reuses the
  existing output implementation under the data root.
- Historical files are not migrated and old `TMPDIR` layouts are not scanned extra; existing output
  references are still read by their actual path.
- This change does not modify the remote asset fallback or the official iOS / Android emulator plugin paths.

## Path conventions

| Scenario                            | New path                                                                                                 | Lifecycle                                                                                |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| zcode-cli Bash persisted output     | `<os.tmpdir()>/zcode-bash-<random id>/<session>/<tool>-stdout.log`; fallback to `<storageRoot>/cli/exec` | named temp file, keeps the foreground/background retention rules, accepts system cleanup |
| zcode-cli clipboard image           | `~/.zcode/clipboard`                                                                                     | deleted after a single read                                                              |
| log export staging                  | `~/.zcode/export-log-stage`                                                                              | deleted after packaging; leftovers allowed on abnormal exit                              |
| log export result                   | `~/.zcode/export-log`                                                                                    | user-visible export result, kept by default                                              |
| feedback attachments and log bundle | `~/.zcode/feedback`                                                                                      | deleted after upload completes                                                           |
| Git checkpoint temporary index      | `~/.zcode/git-checkpoint-index`                                                                          | deleted after the checkpoint build completes                                             |
| Desktop editor icon conversion      | `~/.zcode/editor-icon`                                                                                   | deleted after a single conversion                                                        |

## Constraints

- The business subdirectory must be prepared before writing; do not rely on `mkdtemp` creating parent
  directories. When Bash's system tmp parent directory does not exist, fall back on `ENOENT` and do not
  create the system tmp root itself.
- A short-lived directory must use a single-use unique subdirectory and be cleaned in `finally`
  afterwards; Bash retained output is not deleted when the adapter closes.
- A cleanup failure must not affect the main flow result. Bash tmp output is not yet counted in App
  storage usage statistics or cleanup; other directories keep the existing management scope.
- Bash's custom `ZCODE_STORAGE_DIR` / `storageRoot` is only the fallback location; other files still
  prefer the resolved `storageRoot`.
- The service / desktop side uses the existing data base dir semantics: `~/.zcode` by default and
  `{dataBaseDir}/.zcode` when `ZCODE_DATA_BASE_DIR` is configured.

## Bash output exception

A recursive search of the data directory reads the output file being written, and the search result is
written back to the same file, forming a self-reference. The main app and workflow child runtimes inject
`bashOutputTempDir = os.tmpdir()` into the execution adapter. Each adapter creates a private directory
on demand with async `mkdtemp` and reuses only a successful creation result; a direct call that does not
pass this option keeps the original behavior. Shell initialization snapshots, startup scripts and
non-Bash output keep using the original `outputRootDir`.

The output file must actually be created and opened; an `access` pre-check cannot be used. Only
`EACCES`, `EPERM`, `EROFS`, `ENOENT`, `ENOTDIR`, `ENOSPC` and `EDQUOT` in the tmp preparation phase
allow fallback. Fallback calls the original `<storageRoot>/cli/exec` file preparation logic; other
errors and fallback failures end through the existing failure chain. After the command starts, the path
is not switched and nothing is rerun. A self-reference can still occur on fallback or a direct search of
tmp; that risk is not a commitment of this fix.

The actual path can be published only after file preparation completes. Foreground/background, monitor,
result and file entries share that path and the opened fd, stdout/stderr keep writing directly to the
same file, and the output encoding is parsed only once. A cancel or close during preparation must
release the handle and forbid spawn. Foreground small output and over-limit files keep best-effort
cleanup, while large output and background files keep the retention rules; no unlink, no archiving on
exit, no guarantee that the system cleans up or that the file is readable after a restart, and the
5 GiB / 5 s soft thresholds are unchanged.

## Non-goals

- No cleanup of existing `$TMPDIR/zcode-*` leftovers.
- No change to the remote asset cache fallback.
- No change to the data directories of `apps/zcode-cli/packages/ios-simulator-plugin` and
  `apps/zcode-cli/packages/android-emulator-plugin`.
