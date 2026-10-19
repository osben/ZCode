# rtk command-output compression (DRAFT)

Status: draft, not implemented. Open questions at the end must be resolved before implementation.

## Goal

When [`rtk`](https://github.com/rtk-ai/rtk) is installed on the host that runs agent shell commands, the Bash tool transparently runs
token-compressed variants (`git status` → `rtk git status`) so less command output reaches the model context.

Prior art: craft-agents-oss `packages/shared/src/agent/core/rtk-rewrite.ts`, `rtk-detector.ts` (rewrite in PreToolUse, blocking
`spawnSync`, 200 ms budget, leading `command` bypass). ZCode moves the seam later — see "Why not PreToolUse".

## Verified rtk behavior (rtk 1.0.1)

`rtk rewrite "<cmd>"` prints the rewritten command and exits:

| exit | meaning                                                       | example                                                  |
| ---- | ------------------------------------------------------------- | -------------------------------------------------------- |
| 0    | rewrite                                                       | `git status` → `rtk git status`, `ls -la` → `rtk ls -la` |
| 3    | rewrite ("ask" under Claude Code rules; meaningless to ZCode) | `cat README.md` → `rtk read README.md`                   |
| 1    | no rewrite                                                    | `git diff \| git apply`                                  |
| 2    | deny                                                          | `sudo git status`                                        |

- ~17 ms per call. Exit codes of the wrapped command are preserved (grep 1, git 128).
- Output is lossy (e.g. `rtk git log` truncates subjects).
- `\grep` and `/usr/bin/grep` are not rewritten; `command grep` IS rewritten to `command rtk grep`, so ZCode must detect the
  `command`/`builtin` prefix itself.
- rtk records every command in its own `history.db`. Kill switches: `RTK_DISABLED`, `RTK_TELEMETRY_DISABLED`.
- Compound commands are rewritten per segment: `git status && git diff` → `rtk git status && rtk git diff`,
  `cd apps && git status` → `cd apps && rtk git status`, `FOO=1 git status` → `FOO=1 rtk git status`.
- Not every tool is covered: `pnpm typecheck` → exit 1 (no rewrite); `npm run dev` IS rewritten (long-running — see rule 4).
- `rtk recall <hash>` returns output a filter elided — the model's escape hatch besides the `command` prefix.

## Setting semantics (confirmed with the user)

- The switch can be turned on only when rtk is detected on the executing host.
- The user can always turn it off; the explicit `false` is stored and survives rtk reinstall/upgrade.
- Never-touched setting = on. Consequence: installing rtk later turns compression on for new sessions automatically.
- rtk disappears while stored `true`/unset → no rewrite, switch shown disabled with "not installed"; the stored value is kept.

## Product rules

1. Setting "Use rtk to compress command output" (`rtkCompression`). Effective default: **on** when rtk ≥ 0.44.0 is detected on the
   executing host; otherwise the switch is disabled with a hint ("not installed" / "update rtk").
2. The rewrite never changes what permissions, hooks, read-only/concurrency policy, return-code interpretation, read-file-state,
   telemetry, or the transcript see — they all keep the **original** command. The tool card may show a small "rtk" marker.
3. Rewrite only on exit 0/3 and when the output differs from the input. Exit 1/2, timeout (200 ms, async) or any error → run the
   original unchanged. rtk never blocks or auto-allows a command.
4. Skip the rewrite when any of:
   - the command starts with `command`/`builtin`, `\`, or an absolute path (explicit raw-output escape hatch);
   - `run_in_background` is set (rtk buffers output; would starve progress and TaskOutput);
   - the shell is not POSIX / git-bash (same predicate as `supportsEmbeddedSearchShellSelection`);
   - the rewrite yields `rtk read` (read-file-state would record filtered content as file contents);
   - the rewrite yields `rtk grep`/`find`/`rg` while the embedded-search prelude is active;
   - the command family has a post-execution stdout consumer in ZCode (see "Stdout consumers").
5. All rtk spawns get `RTK_TELEMETRY_DISABLED=1`. Incognito: see open question 1.
6. Bash tool description gains a short note: output may be grouped/trimmed; prefix with `command` for exact output; prefer rtk's
   recovery hint before re-running. `rtk gain` (without `--reset`) is added to the read-only policy.

## Stdout consumers (must be audited before implementation)

Code that parses Bash stdout after execution would see rtk-compressed text:

- `core/src/tool/handlers/bash-gh-rate-limit.ts` — regex on gh error text (`API rate limit exceeded`, `RATE_LIMITED`). Either verify
  `rtk gh` preserves these lines or skip `gh` rewrites.
- `core/src/tool/handlers/bash-image-output.ts` — parses stdout as an image data URL; any rtk filtering of that stdout breaks
  image results. Must be excluded (or proven untouched) before enabling.
- `core/src/tool/handlers/bash-read-file-sources.ts`, `bash-read-file-state.ts` — covered by rule 4 (`rtk read`), re-check for
  `head`/`tail`/`sed -n`.
- Grep all `tool/handlers/bash-*.ts` for further stdout consumers.

## State owners and interfaces

- **User intent** — fork setting `rtkCompression?: boolean`, stored only when set by the user. Registered in `FORK_SETTING_KEYS`
  (`packages/shared/src/forkAppSettings.ts`) — never a `setting.json` key. Delivered to the CLI via the session runtime preferences
  result (`default(true)`), resolved in `packages/services/src/node.ts` and
  `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`. Frozen at session start (it shapes the Bash description).
- **Availability** — owned by the CLI process on the executing host, probed once asynchronously through the session shell
  environment (`adapters/src/exec/shell-init-snapshot.ts`; a Finder-launched Electron app lacks `/opt/homebrew/bin` on PATH),
  cached per process. Exposed via a workspace-scoped `rtk/status` request modeled on `lsp/status`:
  `{ state: "available" | "not_installed" | "outdated" | "unsupported_shell", version?, path?, minVersion }`, `recheck?: boolean`.
- **Rewrite seam** — internal `ExecutionRequest.outputCompression?: { kind: "rtk" }` (same contract as `bashPrelude`: never accepted
  from hooks or generic runners). The Bash handler sets it when preference ∧ availability ∧ rule 4. New adapter module
  `adapters/src/exec/rtk-rewrite.ts` calls `rtk rewrite` via `execFile` (argv array) and applies the exit-code policy.
  `ExecutionResult.compressedBy?: "rtk"` feeds telemetry and the UI marker.

### Why not PreToolUse

In `core/src/tool/executor/call-runner.ts` PreToolUse hooks (`updatedInput`, ~:302) run **before** `resolveToolPermission`
(~:327). Rewriting there would make permission rules (`patternSources: ["command"]`, `bash.ts:533`) match `rtk git …` instead of
the command the user approved.

```
Settings UI ──patch──▶ SettingService ──▶ fork settings (rtkCompression)
                                     │ session create
Host (local | remote collection) ──runtimePreferences{rtkCompression}──▶ CLI on exec host
CLI startup: RtkProbe(shell env) ──cache──▶ {state, version}
UI Settings ──rtk/status(workspace)──▶ CLI ──▶ RtkProbe cache

Turn: hooks(orig) → permission(orig) → Bash handler(orig; sets outputCompression)
      → ExecAdapter: rtk rewrite (≤200 ms) → spawn(rewritten | orig) → stream
      → toBashOutput(orig semantics, rtk stdout) → transcript shows orig
```

## Acceptance scenarios

1. rtk 1.0.1 present, setting untouched: `git status` runs as `rtk git status`; transcript and approval card show `git status`;
   an allow rule `git status*` still auto-allows.
2. rtk absent or < 0.44: switch disabled with hint; commands unchanged.
3. `command git log`, `git diff | git apply` not rewritten; `sudo git status` (rtk exit 2) runs the original.
4. `cat file` / `head -5 file` not rewritten; read-file-state unchanged.
5. `run_in_background: true` + `npm run dev` not rewritten; progress tail streams.
6. Remote workspace without rtk while desktop has it: no rewrite there; Settings shows "not installed" for that workspace.
7. PowerShell/cmd: no rewrite. Windows git-bash with `rtk.exe` on PATH: rewrite works.
8. `rtk rewrite` hangs > 200 ms: original runs; debug log emitted.
9. Incognito session: per open question 1.
10. grep with no matches under rtk still exits 1 and reports "no matches", not an error.
11. gh rate-limit reminder still fires when `gh` output contains a rate-limit error.

Tests: unit matrix for exit codes and exclusions with a fake rtk binary (configurable delay); version parsing; probe through shell
env; handler test that permission and transcript see the original; protocol schema default/fallback; UI store test for
`rtk/status`; desktop E2E toggling the setting.

## Files to touch (estimate)

- Specs/docs: this file, `apps/zcode-cli/docs/design/v2/tool/04-bash.md`, `.../tool/00-tool-change-chain.md`.
- CLI: `contracts/src/interfaces/execution.port.ts`; `core/src/tool/handlers/bash.ts` + new `bash-output-compression.ts`
  (`bash.ts` is already over the size limit); `bash-prompt.ts`; `handlers/index.ts`; readonly policy for `rtk gain`;
  new `adapters/src/exec/rtk-probe.ts`, `rtk-rewrite.ts`; `node-execution-adapter-run.ts`; bootstrap `server-operations.ts`,
  `rtk/status` handler.
- Shared: `forkAppSettings.ts`, `protocol.ts`, `zcode-protocol/index.ts` (strict types + runtime validation).
- Services/Desktop: `services/src/node.ts`, `desktop/src/host/remoteWorkspaceServiceCollection.ts`.
- UI: settings row next to native search (`packages/ui/src/settingsPageHelpers.tsx`), `store/rtkStore.ts` (like `lspStore`),
  i18n en-US / zh-CN / uk-UA.

## Open questions

1. Incognito: always off (simplest), or a new incognito capability toggle (requires bumping the incognito profile version)?
2. Toggle timing: new sessions only (recommended, keeps the Bash description stable) or live via a preferences update method?
3. Remote version skew: can a remote host run an older fork CLI? The preferences result schema is strict; if skew is possible, use a
   separate method that tolerates method-not-found.
4. Standalone TUI CLI (no Host): default on or off?
5. Savings UI: show an `rtk gain -f json` meter? Lifetime totals are not meaningful without a per-project/session filter.
6. Fallback when rtk is absent: ship our own declarative per-command filters (OmniRoute
   `open-sse/services/compression/engines/rtk/`, ~55 JSON filters) as a separate feature?
