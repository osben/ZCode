# Windows unit test compatibility spec

## Background

On Windows dev machines `pnpm test` once failed widely (56 files / 161 cases) and intermittently crashed
with `0xC0000005` (ACCESS_VIOLATION). Classifying case by case, about 97% were Windows environment
compatibility problems in 8 root-cause classes; this spec records the fix for each class and the rules tests
must follow from now on. Branch: `fix/windows-unit-test-compat`.

## State after rebase (2026-08-24, baseline origin/staging c8c15b8d02)

After rebasing onto the latest staging, the full unit test run was **9 failed / 12444 passed**, with no crash.
Remaining composition:

| Category                                           | Count | Note                                                                                                                                                                                     |
| -------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows process-tree reclaim residue               | 3     | `zcodeAgentProcessManager`; the lifecycle fixtures work took this from 8 to 3                                                                                                            |
| staging pre-existing drift (fails on any platform) | 3     | settings MCP/skill/subagent scope badge `formatCanonicalPluginName` assertions; `a9263f3d03` removed the call from the list component without syncing the tests, needs a business ruling |
| cross-platform drift                               | 2     | `feedbackHttpClient`, `stdioDesktopPresentationSurface` (see below)                                                                                                                      |
| flaky (load timeout)                               | 1     | `appUsagePanel`, passes when run alone                                                                                                                                                   |

Handled along with the rebase: staging's CUA single-package merge (the 51 broker files folded into
`@zcode/zcode-cua`) removed `launchSocketPath` / `reservedTransport` (the rendezvous `.pending` handover
mechanism); the local windowsCuaDevHelperHost / node.ts and related tests were aligned to the new API
(a Windows named pipe has no fs handover semantics, socketPath is the single source of truth; caller_timeout
always fails closed as warming up).

## Environment facts (read this section first)

| Fact                                                                                                                             | Impact                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| The repo has `core.autocrlf=true` and workspace text is CRLF                                                                     | Every test that "reads source and asserts a snippet" must normalize newlines                                                                       |
| Git Bash injects `/usr/bin` (GNU tar 1.35) at the front of PATH                                                                  | GNU tar treats the `C:` in an archive argument as a remote host; macOS/Linux commands such as `zip`/`ditto` are missing                            |
| The real Windows user PATH has System32 in front (bsdtar)                                                                        | The product uses bsdtar on user machines; the test environment must restore the same order in vitest.setup.ts                                      |
| NTFS does not keep POSIX exec bits (0o111 is always 0)                                                                           | exec-bit assertions apply only on POSIX hosts                                                                                                      |
| Windows cannot delete the directory that is any process's cwd; renaming the same target while an open handle is held gives EPERM | Child-process lifecycle tests have a hard constraint on teardown order                                                                             |
| `node:fs` globSync returns backslash paths on Windows                                                                            | glob results must be normalized before prefix filtering                                                                                            |
| The product control endpoint on Windows uses a `\\\\.\\pipe\\...` named pipe                                                     | IPC tests must construct the endpoint per platform; the product chain must not be skipped because a POSIX socket fixture reports EACCES on Windows |

## The 8 fixed root-cause classes and rules

1. **CRLF (16 cases / 12 files)**: added `packages/{ui,desktop}/test/readSourceText.ts` (`\r\n → \n` after
   reading). Rule: contract tests read source through `readSourceText` / `readSourceTextAsync`; a bare
   `readFileSync + toContain(multi-line snippet)` is forbidden.
2. **Fixtures injecting Windows paths produce invalid JSON (7 cases)**: placeholder replacement must replace
   the quotes too with the product of `JSON.stringify(path)`; a bare path must not be `replaceAll`-ed into a JSON string.
3. **GNU tar / zip / ditto (21 cases)**:
   - vitest.setup.ts puts System32 first in PATH (on Windows when System32 has tar.exe);
   - the product `stageRelease` writes zip with `tar -a` on Windows (**a real product bug fix**, since a
     Windows machine has no `zip` command); POSIX hosts keep `zip`;
   - tests building zip fixtures use `tar -acf` on Windows; cases depending on `ditto` are skipped on win32.
4. **Unix socket / macOS-only chain (about 50 cases)**: the CUA permission proxy is macOS/Linux only (.app /
   LaunchServices / codesign / ps+SIGTERM); the related describe/it use
   `describe.skipIf(process.platform === "win32")` with the reason noted; platform-independent pure-logic
   groups keep running. The ZCode Server control channel does not belong to this class: the Windows product
   implementation uses a named pipe, and tests must cover it with `resolveServerLayout(...).controlEndpoint`
   or an equivalent platform endpoint helper. Rule: a skip must state "why the product does not support
   Windows"; an uncommented skip is forbidden.
5. **Path separators (about 20 cases)**: for cases mocking POSIX-style input, the expected value is
   constructed from the same source as the product (`join` / `resolve` / `path.delimiter`), verifying
   concatenation semantics rather than separator glyphs. Exception: a POSIX literal hardcoded by the product
   (such as the flatpak export path) keeps the literal in the expectation.
6. **exec-bit assertions (3 places)**: wrapped in `if (process.platform !== "win32")`.
7. **pdfjs cMapUrl (1 case, also a suspected source of 0xC0000005)**: the Node factory reads the cMapUrl
   concatenated path with fs.readFile; the only cross-platform viable form is "forward-slash fs path + /".
   A `file://` URL and a backslash path both do not work (measured).
8. **teardown EPERM**: add `maxRetries/retryDelay` to the test teardown rm (Node's official Windows file-lock
   mechanism). Note: **retry cannot save a long-held handle** (see below).

## Known unfixed (needs a dedicated effort; do not blindly paper over)

### Windows process-tree reclaim incomplete (currently the largest remaining failure source)

Symptom: `zcodeAgentProcessManager` (8 cases) reports `runtime process tree cleanup incomplete; remaining pid=...`;
its derived effect makes `zcodeAgentService(.v4)` / `localServicesRemoteAuthority` / `daemonRegistration`
(about 32 cases) hit EPERM deleting the temp directory in afterEach: **when the agent child process has not
fully exited, its cwd occupies the directory, and Windows cannot delete any process's cwd directory** (verified
with a minimal repro: process alive → EPERM always; after exit → deletion succeeds).

The design semantics of the Windows branch of `processTreeTerminator.ts` (taskkill /T /F + fail-closed identity
verification) need a full investigation before touching; papering over with "blind sleep before deleting the
directory" or "skip identity verification" is forbidden. Investigation entry: `cleanupManagedProcessForShutdown`
→ `forceTerminateWindowsProcessTree` → the residual report of `processTreeWaiter`; capture taskkill's actual
output and exit timing.

### Product design gap: Project Memory stable read vs Windows rename

The premise of `projectMemoryStableRead`, "the reader holds an O_RDONLY handle while a concurrent party
atomically renames to update", does not hold on Windows: renaming the same target while an open handle is held
always gives EPERM (verified with a minimal repro). The tests were changed to the platform-consistent order
"rename first, then open", but **the product will still meet it in real Windows concurrent scenarios**; a
Windows branch needs design (for example degrade to copy+truncate when rename fails, or a write-side retry).
After the fix, restore the original mock order as a regression.

### 3 real cross-platform failures (not Windows problems, need a business ruling)

- `stdioDesktopPresentationSurface`: expects assembly to pass `presentationSurface: "desktop"`, but
  `packages/server/src` has no such field (the services layer has it);
- `feedbackHttpClient`: with ZCODE_ENV=test expects base `zcode.z.ai`, actual `zcode.z.ai`;
- `useCodingPlanQuotaResetUi`: the mock received `builtin:personal-granted`, expected `builtin:team`.

### Intermittent 0xC0000005

During full runs a vitest worker occasionally crashes natively (reproduced once this round before the pdfjs
CMap case fix). It did not reproduce after the pdfjs fix, but is not conclusive; if it reproduces, first
investigate that case and the native module loading order.

## Security note

(Historical.) When `changelogAiClient` failed, vitest printed the full real environment variables (including
API key and JWT) into the test output; that test was deleted together with the custom changelog pipeline when
staging `b232f93ab1` removed it, but the behavior "a vitest assertion failure prints the whole mock argument
object" remains: any test asserting spawn options should avoid putting a real env into a diffable object. Clean
local debug logs promptly, and rotate credentials that have leaked.

## Regression constraints added after the rebase (2026-08-21)

- A JSON-format Windows service descriptor must be `JSON.parse`d before asserting fields; matching raw
  backslash paths directly against the serialized text is forbidden.
- Test temp paths must be built with `join`; PATH in fixtures must be built with `path.delimiter`.
- macOS CUA tests fall into two kinds: pure-logic tests that can inject a platform explicitly pass
  `platform: "darwin"`; test groups depending on the real Darwin native ABI are explicitly skipped on
  Windows, and platform-independent policy tests keep running.
- Repo Wiki JSON state must go through the shared atomic write utility, so cancel/generate concurrency
  does not read half a JSON.
- Coding Plan history/read dedupe must include provider/organization/project scope; using only `usedAt` is
  forbidden, otherwise the same timestamp makes different plans swallow each other's reports.
- When a test simulates background lifecycle writes through a timer, it must hold that Promise and await
  it before teardown; temp file names must be unique, and fire-and-forget writes to a fixed `.test.tmp` are forbidden.
- The atomic-replace scenario "rename over the target while holding a read-only handle" holds only on
  POSIX; Windows returns `EPERM` per the file sharing mode, so such POSIX-semantics tests must be isolated
  explicitly and not disguised as a cross-platform contract.
