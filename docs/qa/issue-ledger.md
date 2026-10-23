# Desktop QA issue ledger

Single source of truth for issues found by `desktop-qa-orchestrator-prompt.md` and re-checked by `desktop-qa-verifier-prompt.md`. Scenario IDs refer to `scenarios.md`. History before this ledger: `docs/plans/2026-10-21-qa-findings.md` (ISSUE-001 … ISSUE-024); numbering continues from **ISSUE-025**.

## Rules

- One block per issue, appended as soon as the issue is seen (never batch at the end). Next free ID = highest ID in this file + 1.
- Before filing, search this file and the old ledger for the same symptom; if it exists, append evidence to the existing block instead.
- Severity: **S1** freeze > 1 s, crash, data loss, cross-session leak; **S2** wrong data, broken control, silent failure; **S3** polish, perf smell, log noise.
- Status flow: `open` → `fixing` → `fixed-unverified` (fix committed, gates green) → `fixed-verified` (orchestrator re-ran Verify on a restarted app built from the QA branch) → `verified` (independent verifier agent). Side exits: `decision-needed` (product/design question or spec-vs-code mismatch; never fixed without the user), `wontfix`, `cannot-reproduce`, `env` (environment/harness, not product).
- `Root cause` says **confirmed** only with code + runtime evidence; otherwise **hypothesis**.
- `Verify` must be executable by an agent that has never seen this run: start state, exact steps, selectors, what must and must not appear (UI and log lines).
- Evidence paths point at the run's scratch directory; quote the essential log lines inline (they are not committed elsewhere).
- Never write credentials, tokens, real user content or internal service addresses here.

## Run header (one per run, newest first)

```
## Run <YYYY-MM-DD HH:MM> · branch <qa-branch> · base <sha>
PRs included in base: #… (merged), #… (not merged)
Baseline gates: typecheck <pass | N errors: …>, lint <0 errors / N warnings>, unit <…>
Environment: macOS <ver>, Node <ver>, dev desktop, ZCODE_DATA_BASE_DIR=~/.zcode-dev-home, model <cheap model id>
Scenario results: P0 <pass>/<total>, P1 …, P2 …; blocked: <IDs + reason>; manual-only: <list>
Fix packs: <PR links>
```

## Issue template

```
### ISSUE-0NN · S2 · composer · open
Scenario: CP-12 · Found: 2026-10-23 14:05:12 · Build: <short sha>
Repro (from a fresh app start):
1. …
2. …
Expected: …
Actual: …
Evidence: <scratch>/qa/CP-12/01.png, console.txt; log:
  [2026-10-23 14:05:12.301] [warn] [pid:…] [main] [host-log] … FAIL (…)
Root cause: hypothesis | confirmed — <file:line, one paragraph>
Fix: branch <name>, commits <sha…>, spec <path>, tests <paths>, PR <link>
Verify:
1. Start the dev app from <branch or PR head>.
2. …
Must see: … · Must not see: … (UI and log patterns)
History: 2026-10-23 open → fixing (fixer lane C1) → fixed-unverified <sha> → …
```

## Pre-loaded items (re-observe, do not re-file)

| Item                                                                                     | State after #280                                         | What the run does                                          |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| ISSUE-010 Stop vs queue                                                                  | fixed in #280 (`specs/stop-queue-hold.md`)               | regression check in CP-13                                  |
| ISSUE-012b orphan placeholder sweep                                                      | fixed in #280                                            | count placeholder rows after restart (should not grow)     |
| ISSUE-020 search scope                                                                   | fixed in #280 (all local workspaces)                     | regression check in SB-13                                  |
| Trajectory input deltas                                                                  | fixed in #280 (`specs/model-trajectory-input-deltas.md`) | regression check in CH-17                                  |
| `writeRecord` → `cli_updated_at` mirror                                                  | removed in #280                                          | regression check in SB-07 (rename does not reorder)        |
| ISSUE-019 restored draft with a deleted project                                          | partially fixed (158cc676)                               | CP-12                                                      |
| ISSUE-021 Windows-only E2E root hook on macOS                                            | `env`                                                    | ignore                                                     |
| Hover hides run indicators vs `specs/task-hover-card-layout.md` #8                       | spec-vs-code mismatch                                    | confirm in SB-05, file as `decision-needed`                |
| "Delete task" missing from sidebar + header menus vs `specs/session-deletion-cascade.md` | spec-vs-code mismatch                                    | confirm in SB-07, file as `decision-needed`                |
| "Delete project" runs without confirmation                                               | product question                                         | confirm in SB-03 on a throwaway project, `decision-needed` |
| Unimplemented specs `self-hosted-conversation-share`, `rtk-output-compression`           | blocked on user decisions                                | out of scope                                               |

## Issues

<!-- Append ISSUE-025 and later below this line. -->

## Run 2026-10-22 11:57 · dry run of the kit · base 1e6737a5

PRs included in base: #275, #276, #280 (merged); #277 (open, not included)
Baseline gates: not run (docs-only change); `pnpm fmt:check` ok
Environment: macOS, dev desktop, ZCODE_DATA_BASE_DIR=~/.zcode-dev-home, model `deepseek/deepseek-v4.1-flash-1017` (OpenRouter); Z.ai provider not signed in (footer shows Connect)
Scenario results: Phase 0–1 of the orchestrator prompt as written (launch, CDP attach in ~40 s, log watcher, long-task probe), CP-02 pass (pong in 8 s, worst block 151 ms), CH-02 archive + delete path pass; startup sweep removed 147 placeholder rows (#280 ISSUE-012b live)

### ISSUE-025 · S3 · runtime · open

Scenario: CP-02 · Found: 2026-10-22 11:58:26 · Build: 1e6737a5
Repro (from a fresh app start):

1. Start the dev app; while the Agent runtime is still starting, press New task (⌘N).

Expected: no failed RPC, or the subscription waits for the runtime.
Actual: host logs `[rpc:call] zcode-agent.subscribeSessionsIndexV4 FAIL (0.1ms) {"message":"ZCode Agent runtime is not running." … getReadOnlyClient …}` at warn; 6 occurrences in the 2026-10-22 dev log. The UI recovered (the send worked).
Evidence: `~/.zcode-dev-home/.zcode/v2/logs/2026-10-22.log` 11:58:26.535 and 04:32:18.077.
Root cause: hypothesis — the renderer subscribes to the sessions index before the runtime is up and relies on a later retry; `createRuntimeUnavailableError` from `getReadOnlyClient` in the desktop host.
Fix: —
Verify:

1. Restart the dev app, open a new task within 2 s of the window appearing.
   Must see: sessions index populated, send works. Must not see: `subscribeSessionsIndexV4 FAIL` in the log (or, if the retry is by design, it is logged below warn).

History: 2026-10-22 open (dry run).

### ISSUE-026 · S2 · composer · open

Scenario: CP-03 · Found: 2026-10-22 11:58 · Build: 1e6737a5
Repro (from a fresh app start):

1. Have sessions that ran on a provider that is now unavailable (here Z.ai, not signed in; footer shows Connect).
2. Open an existing session last run on that provider.

Expected: the composer shows the session's model with an "unavailable" state, or switches to an available model with a notice (per `docs/chat-model-change-notice.md`).
Actual: the follow-up composer shows "Choose model"; `[data-testid=v4-model-config]` has empty `data-provider` / `data-model`. Whether Send is blocked silently was not checked.
Evidence: screenshot not retained; `v4-model-config` dataset dump: `provider=""`, `model=""`, trigger text "Choose model".
Root cause: hypothesis — same family as ISSUE-011 (dead stored selection) but for an existing session's model; may be by design.
Fix: — (likely `decision-needed` after root cause)
Verify:

1. Open a session whose provider is not available.
   Must see: a clear model state and a working path to send (pick a model, or a readable blocked reason). Must not see: a silent no-op Send.

History: 2026-10-22 open (dry run).

### ISSUE-027 · S3 · renderer · open

Scenario: CP-02 · Found: 2026-10-22 11:58 · Build: 1e6737a5
Repro: open a session and hover composer toolbar controls; read `agent-browser console`.
Expected: no React warnings.
Actual: repeated `Tooltip is changing from uncontrolled to controlled` / `from controlled to uncontrolled` warnings.
Evidence: `agent-browser console` output of the dry run.
Root cause: hypothesis — a Tooltip receives `open={undefined}` on some renders and a boolean on others.
Fix: —
Verify: open a session, hover each toolbar control, `agent-browser console` shows no controlled/uncontrolled Tooltip warning.
History: 2026-10-22 open (dry run).
