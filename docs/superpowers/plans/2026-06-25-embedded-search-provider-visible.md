# Embedded Search Provider-Visible Branch

> Historical implementation plan (2026-06-25), kept as the provider-visible contract. ZCode ships
> the embedded search branch by default (embedded search gate on and Bash available). The
> execution-layer backend and bundled binaries are governed by
> `docs/runtime-tools/embedded-search-native-build.md`; the prelude injection switch is
> `ENABLE_EMBEDDED_SEARCH_BASH_PRELUDE` in
> `apps/zcode-cli/packages/core/src/embedded-search/shell.ts`.

## Default Baseline

1. Provider-visible layer: direct `Glob` / `Grep` tools are not exposed to the model by default.
2. Bash prompt: the model is not told to avoid running `find` / `grep` in Bash.
3. Plan prompt: uses ``find``/Glob, ``grep``/Grep, and Read.
4. Runtime layer: `find()` / `grep()` shell functions are injected into session shells that
   support POSIX shell functions (see the switch above; the original plan recorded a temporary
   policy of not injecting, relying on the user's local commands).

## Target Behavior

- The embedded search gate is on by default; non-default local agent entry points may disable it.
- Gate on and Bash available:
  - main system broad exploration guidance uses ``find`` / ``grep`` via the Bash tool;
  - the Explore prompt uses Bash `find` / `grep` guidance;
  - the Bash prompt avoid list no longer includes `find` / `grep`;
  - Bash initialization injects `find` / `grep` functions executed by the embedded search backend
    (bundled form dispatches to `bfs` / `ugrep`);
  - `grep` runs `ugrep -G --ignore-files --hidden -I` and excludes
    `.git/.svn/.hg/.bzr/.jj/.sl` by default;
  - `grep` bypasses the wrapper back to system `grep "$@"` for `-*-filter*`, `-*-pager*`,
    `-*-view*`, `-*-format-open*`, `-*-config*`, `---*`, `-@*`, `-*-save-config*`;
  - the `find` / `grep` functions fall back to system commands when the internal binary is not
    executable.
- Windows / Git Bash:
  - POSIX shell semantics are still required; no `find()` / `grep()` functions are injected into
    CMD;
  - under Git Bash/MSYS/Cygwin the functions invoke via `ARGV0=... "<binary>"`, not Linux/macOS
    `exec -a`;
  - the shell snapshot converts Windows host paths to Git Bash paths (for example `C:\repo` ->
    `/c/repo`) and filters Git Bash auto-generated `winpty` aliases.
- Glob/Grep tool prompts have a separate simple/short description branch; it is independent of
  the embedded search gate.

## Provider-Visible Contract

The acceptance scope is everything the model can see in the final request body, not just system
prompt lines. The default embedded branch must satisfy all of:

1. `tools[]` does not expose direct `Glob` / `Grep` — neither for the main agent nor for the
   Explore subagent.
2. The Bash tool description's avoid list contains exactly ``cat``, ``head``, ``tail``, ``sed``,
   ``awk``, or ``echo`` and not `find` / `grep`.
3. The Explore prompt uses `Use \`find\` via Bash for broad file pattern matching` and
   `Use \`grep\` via Bash for searching file contents with regex`; the Explore allowlist has no
   direct `Glob` / `Grep`.
4. The Plan prompt uses ``find``, ``grep``, and Read for patterns/conventions.
5. The Agent tool description does not leak direct search tools (no
   `(Tools: Glob, Grep, Read, Bash, WebFetch, WebSearch, TodoWrite)`).
6. Main system guidance does not emit Agent/Explore session guidance lines for the embedded
   branch; the dedicated-tool list does not mention Glob/Grep; the broad exploration fallback
   reads ``find`` or ``grep`` via the Bash tool.

## Three-Layer Architecture

1. **Provider-visible branch capability** — a model-aware pure function
   (`apps/zcode-cli/packages/core/src/embedded-search/capability.ts`,
   `evaluateEmbeddedSearchBranchCapability`, shaped like the MCS capability helper) decides
   whether the embedded search branch applies. It controls direct tool exposure, Bash prompt,
   Explore prompt, Plan prompt, Agent description, and main system guidance. Branch decisions
   must not be duplicated in prompt builders or tool registration. It receives the model ref and
   a sanitized connection context (modelId, providerId, providerKind, baseURL; apiKey/headers
   stripped); the first version short-circuits on a global flag and does not gate by
   provider/source/variant.
2. **Bash prelude builder** (`apps/zcode-cli/packages/adapters/src/exec/embedded-search-prelude.ts`)
   — generates the `find()` / `grep()` shell functions from an `EmbeddedSearchBackend`; does not
   hardcode `zcode __internal-search`; does not decide branch capability.
3. **Embedded search backend** — the first version used `internal-cli` (transparent passthrough
   to the host `find` / `grep` through `zcode __internal-search`, with low-cost default grep args
   and the bypass list; argv/stdin/stdout/stderr/exit code passed through untouched). The
   `argv0-dispatch` backend kind is reserved so the backend can switch without changing the
   provider-visible branch, prompts, or tool exposure. See
   `docs/runtime-tools/embedded-search-native-build.md` for the shipped bundled-binary backend.

Naming: the architecture fact is "embedded search backend", not "internal search shim". The
internal CLI never hand-parses a subset of real `find` / `grep` arguments — the model generates
real command lines and subset parsing would regress behavior.

## Fallback Branch

Direct `Glob` / `Grep` tools remain implemented. They are exposed when the global flag is off or
Bash is unavailable; those cases keep the direct-branch prompt wording and description/schema
contract tests. The adapter must never inject POSIX functions into CMD even if it receives
`bashPrelude` (misuse guard).

## Acceptance Criteria

- Default provider-visible request exposes no direct Glob/Grep tools.
- Default Bash prompt does not discourage `find` / `grep`; Explore/Plan prompts and the Agent
  description use the Bash `find` / `grep` wording.
- Global flag off or Bash unavailable: direct Glob/Grep tools are exposed and pass existing
  description/schema tests.
- All branch decisions live in `embedded-search/capability.ts`; no scattered provider/source
  checks.
- Backend switches do not change provider-visible branch capability or prompt tests.
