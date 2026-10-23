# Desktop QA issue ledger

Single source of truth for issues found by `desktop-qa-orchestrator-prompt.md` and re-checked by `desktop-qa-verifier-prompt.md`. Scenario IDs refer to `scenarios.md`. History before this ledger: `docs/plans/2026-10-21-qa-findings.md` (ISSUE-001 … ISSUE-024); numbering continues from **ISSUE-025**.

## Rules

- One block per issue, appended as soon as the issue is seen (never batch at the end). Next free ID = highest ID in this file + 1.
- Before filing, search this file and the old ledger for the same symptom; if it exists, append evidence to the existing block instead.
- Severity: **S1** freeze > 1 s, crash, data loss, cross-session leak; **S2** wrong data, broken control, silent failure; **S3** polish, perf smell, log noise.
- Status flow: `open` → `fixing` → `fixed-unverified` (fix committed, gates green) → `fixed-verified` (orchestrator re-ran Verify on a restarted app built from the QA branch) → `verified` (independent verifier agent). Side exits: `decision-needed` (product/design question or spec-vs-code mismatch; never fixed without the user), `wontfix`, `cannot-reproduce`, `env` (environment/harness, not product).
- `Root cause` says **confirmed** only with code + runtime evidence; otherwise **hypothesis**.
- `Verify` must be executable by an agent that has never seen this run: start state, exact steps, selectors, what must and must not appear (UI and log lines).
- Quote the essential log/console lines inline in the entry. Scratch paths (screenshots, logs) are for the current run only — a later verifier cannot open them.
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

## Run 2026-10-22 20:01 · branch claude/qa-run-20261022-2 · base 5e8df047

PRs included in base: #283, #284, #285, #286, #287, #288, #289, #290, #291, #292, #293, #294, #295, #296 (all merged)
Baseline gates: typecheck pass (exit 0), lint 0 errors / 98 warnings; `pnpm install --frozen-lockfile` exit 0, `pnpm build:cua` pass, CLI `turbo run build` pass, `check-workspace-freshness` fresh
Environment: macOS 27.2, Node 26.12.0 (mise.toml pins 26.11.1), dev desktop, ZCODE_DATA_BASE_DIR=~/.zcode-dev-home, model `deepseek/deepseek-v4.1-flash-1017` (OpenRouter, cheapest configured), `ZCODE_QA_NO_OCCLUSION=1` local switch active. Shared `~/.zcode/v2/setting.json` snapshot at 53 keys (backup `~/qa-sandbox/run-20261022/setting.json.bak`).
Scenario results (final, 2026-10-22 23:10): R1 all live-verifiable fixes verified (see per-issue History; ISSUE-026 live re-check env-blocked, ISSUE-027 external-agent trigger verified with the ACP cases). R2: #295, #283, #286, #287, #296 all exercised live (details in scenarios.md TV/AC/QP sections; strip drag/zoom and MCP/memory chips E2E-only; Codex findings on #287 not reproducible). R3: CH-11 ✓ (load-older sub-case env: 199-row session still fits one window), CH-17 perf ✓ ("show next" is per-input-card, catalog corrected), CP-06 → ISSUE-051. R4: 38 cases pass (many as covered-by-round-1 plus this run's spot checks), 3 blocked/env (tool-dependent chat cluster — OpenRouter tool-format drift; drag re-runs harness), new issues ISSUE-052, ISSUE-053.
Fix packs: osben/ZCode#298 (ISSUE-049, open); ISSUE-051 fix in review (lane C2); no other product defects fixed this round.

## Run 2026-10-22 12:08 · branch claude/qa-run-20261022 · base 520a1bf1

PRs included in base: #275, #276, #280, #277 (merged); #282 (open; merged locally into the QA branch to get this kit)
Baseline gates: typecheck pass, lint 0 errors / 98 warnings; `pnpm install --frozen-lockfile` exits 1 on the lefthook `prepare` step (custom hooks path, known), `pnpm build:cua` run separately (pass), CLI `turbo run build` pass
Environment: macOS 27.2, Node 26.11.1, dev desktop, ZCODE_DATA_BASE_DIR=~/.zcode-dev-home, model `deepseek/deepseek-v4.1-flash-1017` (OpenRouter; effort lowered per case where possible). From 12:55 the app runs with a local, uncommitted QA switch `ZCODE_QA_NO_OCCLUSION=1` (`disable-backgrounding-occluded-windows`, `disable-renderer-backgrounding` in `packages/desktop/src/main/index.ts`) because the occluded window stopped rAF (ISSUE-034). Project `qa-sandbox` was added through the native picker by the user.
Scenario results (final, 2026-10-22 14:58): 64 cases — 58 pass, 6 fail, 0 blocked (some sub-steps blocked, noted per case).

- P0-A Sidebar 14: 13 pass, 1 fail (SB-11 → ISSUE-033, fixed-verified).
- P0-B Composer 17: 14 pass, 3 fail (CP-03 → ISSUE-035 fixed-verified; CP-06 → ISSUE-037 fixed-verified; CP-14 → ISSUE-040 fixed-verified).
- P0-C Chat 17: 17 pass.
- P1 Side panes / settings / tables 9: 7 pass, 2 fail (SP-02 → ISSUE-042 fixed-verified; ST-01 → ISSUE-045 S1 fixed-verified + ISSUE-046 fixed-verified).
- P2 Misc 7: 7 pass (MI-01 follow-up ISSUE-048).
  Cases SB-01, SB-03..SB-10 ran 12:10–12:52 with the window occluded (ISSUE-034); their rendering-dependent parts (drag reorder SB-03, hover card SB-08, drag SB-09) should be re-checked by the verifier.
  Blocked sub-steps: CP-06 worktree-failure modal (no cheap way to force); CP-14 outcome-unknown/held-unlock and host-unavailable (cannot force over CDP); ST-02 Coding Plan quota (Z.ai not connected, would change credentials); MI-01 create-limit message (needs 20 automations); CH-11 load-older (21-query session fits one window); CH-17 "show next" after 40 rows (31 calls).
  Fix packs, open items and decisions: see "Final status" below (supersedes the 14:58 pack and decision lines).
  Manual-only (needs a human or the packaged app): native folder picker; deep links (`zcode://`); native-menu ⌘ shortcuts (ISSUE-030); Open in Finder / Choose app; behaviour without the occlusion switch; Z.ai sign-in and Coding Plan quota.
  Incident: ST-01 locale uk-UA made the installed upstream app reset `~/.zcode/v2/setting.json` to defaults (ISSUE-045); restored by key at 14:27 to the pre-ST-01 snapshot.
  Cleanup: 16 sessions created this run archived in the dev app (reversible; the CH-02 test session was already deleted; not renamed to `qa-` — archive needs no rename). The archive flag lives in the dev tasks index only: the shared CLI db keeps them unarchived, and the installed app's own index lists one of them, `qa-in-group` (`session_cdcadbe3…`), as active — archive it there by hand if wanted. qa-group ungrouped, run-changed `setting.json` keys (`desktopWindowSize`, `lastActiveWorkspace`) reverted to the run-start backup, `/tmp/aiagents-pptx-venv` removed, QA-local `ZCODE_QA_NO_OCCLUSION` edit reverted, app and watchers stopped. Kept: project `qa-sandbox` and `~/qa-sandbox` (incl. worktree `zcode-intergalactic-capybara`) for the verifier; an empty draft placeholder `session_8ce432d1…` in qa-sandbox; session `session_43e5ca4a…` ("привет…", 12:45) untouched — not on the run's created list; it is in the installed app's index, so it was most likely created there.

Final status (2026-10-22 wrap-up). Nothing was merged by this run; "merged" means the user merged it.

- osben/ZCode#284 — ISSUE-025/032/033/037/040 — merged.
- osben/ZCode#285 — ISSUE-042/043/044 — merged.
- osben/ZCode#288 — ISSUE-045 (S1, fork locale overrides in `fork-settings.json`) — merged.
- osben/ZCode#289 — ISSUE-028/029/031/041 — merged.
- osben/ZCode#290 — ISSUE-039 (Steer never holds the queue; a user Stop always holds) — open.
- osben/ZCode#291 — ISSUE-026 + ISSUE-035 — merged. Decision to confirm: an unresolvable stored pick is never dropped (ISSUE-026's stored-intent rule wins over ISSUE-035's stale-pick clearing).
- osben/ZCode#292 — ISSUE-036/048/047/027 — open; integration merged in twice to resolve conflicts: `i18nCatalogParity` EN_ONLY_KEYS (union, against #285) and uk-UA `archives.count` (the ISSUE-047 plural family kept over #293's single key, worded "сеанс" like #293).
- osben/ZCode#293 — ISSUE-046 (uk-UA values translated, coverage guard test) — merged.
- osben/ZCode#294 — docs: this ledger, scenario corrections, verifier shared-settings guard, CodeRabbit fixes from #282 — open.

  Left open, and why:

- ISSUE-027/036/047/048 are fixed-unverified: unit-tested only, not re-checked live in this run.
- ISSUE-026/035: the E2E scenarios added in #291 do not pass in the local fixture; behaviour was verified live instead.
- ISSUE-039: the QA trigger was never reproduced; the fix closes gaps found in review (live check: Stop holds, Steer drains).
- The CLI's own uk-UA catalog (apps/zcode-cli) is not translated; #293 covers the UI catalog only.
- `qa-in-group` is still active in the installed app's index (archive it there by hand if wanted).
- ISSUE-038 cannot-reproduce; ISSUE-030/034 env.

  Incidents this round:

- A message meant for a new QA task was sent into the user's existing session "что ты мне раскажешь про проект ?" (a new-task click did not navigate); the session gained one QA exchange and its model switched to the QA model. Not reversible from QA; the header is now checked before typing.
- QA pack worktrees and local pack branches were deleted outside this run mid-round; the packs were recovered from the fixers' branches and the pushed remotes. No pushed work was lost.
- osascript has no assistive access from the agent shell, so the ISSUE-028 native-confirm path was verified through Cancel only.

  Final cleanup: hover-test session archived, `~/qa-sandbox/qa-delete-me` removed, app and watchers stopped. `setting.json`: `localePreference`, `lastActiveWorkspace`, `desktopWindowSize` reverted by key to the run-start backup — 53 keys, `en-US`/`system`, no fork locale overrides left in `fork-settings.json`. Remaining diffs against the backup are the user's own recent-workspace entries, left as they are.

### ISSUE-054 · S2 · composer · open

Scenario: CP-06 · Found: 2026-10-22 23:05 · Build: 9ab8f7cf (QA branch with the ISSUE-051 fix)
Repro (from a fresh app start):

1. `chmod 555 <repo>-worktrees`; draft in the project → Worktree on → type a prompt → Send. The failed card renders (ISSUE-051 fix).
2. `chmod 755` the directory; press Retry on the timeline card.
   Expected (`specs/composer-worktree-setup-steps.md`): "After Git reports a ready path, activate the same session with the frozen submission … admits that submission exactly once."
   Actual: the worktree is created and the card flips to "Worktree·ready · <name>", but the frozen submission is never admitted — the timeline keeps only the user row, the session's model config is EMPTY ("Choose model"), and Send stays disabled until the user manually picks a model; only then does the session accept input (a manually typed message runs fine). The original frozen prompt never runs at all.
   Evidence: after Retry (12–45 s): `rows:1`, last row "Reply with exactly: wt-retry", `running:false`, model `""`, sendDisabled true with empty composer; picking a model enabled input; a new manual send produced "wt-retry-2". `git worktree list` shows the created worktree.
   Root cause: hypothesis — the retry-activation path loses or fails to resolve the frozen submission's model (the frozen pick here was an ACP agent from Recent; resolution may fail in the new worktree session and the activation silently stops), or the ready→activate hand-off does not re-fire after a retry.
   Fix: — (admit the frozen submission on ready after a retry; if the model cannot resolve, surface the blocked reason instead of a silent idle row)
   Verify:
3. Repro steps 1–2 above with a non-ACP frozen model, then repeat with an ACP one.
   Must see: after the card flips ready, the frozen prompt runs exactly once in the created worktree without a manual model pick. Must not see: an idle session with "Choose model" and a permanently unadmitted frozen row.
   History: 2026-10-22 open (found while live-verifying the ISSUE-051 fix).

### ISSUE-053 · S2 · chat · open

Scenario: CH-12 · Found: 2026-10-22 22:4x · Build: 288d26e8
Repro (from a fresh app start):

1. Open a session with several turns (here qa-r2-smoke: rows contain "Reply with exactly the word pong.", "Count from 1 to 300, one number per line…", "qa queue item A"…"H", markdown/table turn).
2. ⌘F → type "pong" (setter input or keystrokes). Repeat with "Count", "queue item", "qa".
   Expected (`docs/ui/task-find-dialog.md`, `docs/v4-session-find-highlight.md`): the counter "{current} / {total} results" reflects existing matches; hits highlight and Enter/Shift+Enter navigate.
   Actual: "pong" → 0/0, "Count" → 0/0, "queue item" → 0/0 although those strings are plainly present in timeline rows; "qa" → 1/9. No highlights for the 0/0 terms.
   Evidence: bar text captured per term (parent of the "Search messages…" input shows "0/0" / "1/9"); session rows enumerated in the same probe.
   Root cause: hypothesis — the find index covers only a subset of row kinds (e.g. only rendered/virtualized rows, or assistant rows without tool/markdown projections); "qa" matching 9 suggests partial coverage, not a dead feature.
   Fix: —
   Verify: in any multi-turn session, ⌘F for a word visible in a user row AND an assistant row → the counter is ≥1/≥1 for both; hits highlight; Enter moves between them.
   History: 2026-10-22 open.

### ISSUE-052 · S3 · side pane · open

Scenario: SP-05 · Found: 2026-10-22 22:2x · Build: 288d26e8
Repro: open the Files side-pane tab in a session whose project tree changed on disk (here: `src/math.js` existed all along; the tree showed `src` containing only `.DS_Store`).
Expected: Refresh (`workspace-file-tree-refresh-button`) re-reads directory children.
Actual: Refresh ×2 left `src` showing only `.DS_Store`; collapsing/re-expanding the `src` node re-read it and `math.js` appeared.
Evidence: tree text before `…src.DS_Store notes.md…`, after node toggle `…srcmath.js.DS_Store…`; file present on disk and tracked (`git ls-files`).
Root cause: hypothesis — the refresh action re-reads only the root level (or the changed-file set) and does not invalidate expanded-directory caches.
Fix: —
Verify: change a nested directory's contents on disk, open Files, press Refresh → the new file appears without toggling the node.
History: 2026-10-22 open.

### ISSUE-051 · S2 · composer · fixed-verified

Scenario: CP-06 · Found: 2026-10-22 21:55 · Build: 288d26e8
Repro (from a fresh app start):

1. Make the worktree parent read-only: `chmod 555 ~/qa-sandbox/zcode-qa-repo-worktrees` (the default `<repo>-worktrees` location).
2. New draft in the project → destination control → Worktree on → type a prompt → Send.
3. The preparing session opens (title "Worktree zcode/<name>"); creation fails. Navigate to another task and back to the failed session; also open a new draft in the project.
   Expected (`specs/composer-worktree-setup-steps.md` §"Submission and editor behavior"): "Progress, failure, Retry, and Cancel render inside its timeline"; "A failed session retains its setup error and Retry action"; "Navigation away … Returning to the session ID resumes the same progress state"; frozen text retained in a recovery record and restored into an empty editor.
   Actual: the failed session's timeline shows only the user row — no setup error, no Retry. At failure time a `composer-worktree-recovery` entry (Retry/Discard) exists in the destination popover, but after navigating away it is unreachable (the destination control is draft-only; the failed session's composer has no destination trigger, no error banner, empty composer, disabled Send). The catalog's old expectation (`worktree-failure-modal` with Retry/Change/Close) belongs to the worktree-RETURN failure flow (`worktreeFailureReturnStore`), not to creation failures.
   Evidence: session "Worktree zcode/orbital-yeti" (qa-sandbox): `rows:1`, `err:[]`, `markers:[]`, composerText empty, sendDisabled true; `git worktree list` has no orbital-yeti; popover at failure time: testid `composer-worktree-recovery` with Retry/Discard and "Failed to send"; after navigation the same query finds no entry.
   Root cause: hypothesis — the preparation recovery state lives renderer-local on the composer/destination control and is not rebound to the failed session's timeline on return; the spec's session-bound failure rendering is not implemented (or was lost in a refactor).
   Fix: — (render setup error + Retry/Discard inside the failed session's timeline per spec; restore the frozen text into the empty editor on return)
   Verify:
4. Start the dev app; `chmod 555` on the project's `-worktrees` directory; draft → Worktree on → send.
5. Must see: the preparing session opens, then shows the setup error with Retry/Cancel/Discard inside its timeline; navigating away and back keeps the same failed state; Discard (or Retry after `chmod 755`) completes the spec'd flow; the frozen text is restorable into an empty editor. Must not see: a silent stranded user row with no error and no recovery action.
   History: 2026-10-22 open (CP-06, forced via read-only parent) → fixing (fixer lane C2, worktree .claude/worktrees/qa-fix-051-worktree-recovery) → fixed-unverified 4636c845 (branch claude/qa-fix-051-worktree-recovery; renderer-only: the failure card and Retry were gated on the Host snapshot marker only (SessionPane.tsx:6910, Retry threw at :2607); the card now also mounts from the renderer's live pipeline entry, Retry params resolve from the frozen entry; spec sharpened same-commit; Host path verified to already persist failed+message+attemptId; tests red-first, full UI suite 11558 green) → reviewer (Lane D): SHIP, no must-fix; two test-hardening should-fixes applied in a follow-up commit → fixed-verified 2026-10-22 23:0x on the restarted dev app (QA branch cherry-pick 9ab8f7cf): chmod 555 → Send → the failed session's timeline shows "Worktree·failed / Worktree setup failed: … Permission denied" with Retry + Discard; navigation away/back keeps the state; chmod 755 → Retry → card flips "Worktree·ready · zcode/tiny-phoenix", git worktree created → FOLLOW-UP DEFECT found in the same verify: the frozen submission is not admitted after a ready retry and the session needs a manual model re-pick → ISSUE-054 → PR opened by the orchestrator.

Final status (2026-10-22 round-2 wrap-up). Nothing was merged by this run; "merged" means the user merged it.

- osben/ZCode#298 — ISSUE-049 (S2, flat-list hover card dead since #292) — open, CI green (typecheck/lint/arch + unit), fresh-context reviewer verdict SHIP (nits fixed in-branch), live-verified on the restarted dev app.
- claude/qa-fix-051-worktree-recovery — ISSUE-051 (S2, worktree preparation failure strands the first prompt) — fix 4636c845, reviewer pass + live verification recorded in the issue History; PR opened by the orchestrator.
- New S3s filed, no fix requested this round: ISSUE-050 (stale renderer instance warn), ISSUE-052 (file tree refresh misses nested dirs).
- New S2 filed: ISSUE-053 (find-in-conversation returns 0/0 for existing terms).

  Round-1 fixes re-verified live this round: ISSUE-025, 027 (all four trigger kinds incl. the ACP external-agent control), 029, 031, 032, 033, 035, 036, 037, 039 (Steer drains; user Stop always holds, incl. right after a Steer; Continue resumes), 040, 041, 042, 043, 044, 045 (both directions, shared file intact at 53 keys, upstream log clean), 046, 047 (1 сеанс singular + 2 files plural; branch-dialog variant unit-covered), 048. ISSUE-026: live re-check env-blocked (no touchable unavailable-provider session); round-1 evidence stands; the "unresolvable stored pick is kept" decision confirmed by code (typed selectionIssue values; pick kept as intent).

  New since round 1, exercised live: #295 (spawn preflight resolves this checkout's CLI), #283 (v1 tool-call inputs pair with results), #286 trajectory v2 (summary/strip/ledger/inspector 5 tabs/context chart/time-by-tool/skills chips; opens 86-207 ms; strip drag/zoom + MCP/memory chips E2E-only; old-records "—" unit-covered), #287 ACP on macOS (group + 4 detected agents with brand marks; codex/claude hidden — adapters not installed, spec behavior; Test roundtrips OK for opencode/Cursor, auth surfaced for Qwen/Gemini; pre-turn options catalog; draft-choice isolation and mode/model interplay — the two #287 review findings NOT reproducible; one live opencode free-model turn), #296 quick prompts (settings CRUD, scope, pinned/shown switches, composer row insert, "/" section with token replace).

  Blocked/manual-only this round: tool-dependent chat flows (CH-06/07/09 full paths, CH-05 cards, CH-14 background bash) — OpenRouter tool-format drift made cheap models emit raw `<tool_call>` text from ~22:00 (worked at 20:12); no merge this round touches those areas. Drag re-runs (SB-03/SB-09/SB-12): synthetic drag did not engage dnd-kit; round-1 passes + rAF healthy all session. CH-11 load-older sub-case: even 199 rows fit one window (needs a bigger fixture). CH-17 "show next": collapse is per-input-card (catalog corrected). CP-14 held-unlock: code path documented, not forced live. SB-03 real "Delete project" confirm on a throwaway: needs one native-picker step (user).

### ISSUE-050 · S3 · main · open

Scenario: MI-07 (idle hygiene) · Found: 2026-10-22 21:29 · Build: 288d26e8
Repro: reload the renderer (Vite hot update of a context provider, or a dev restart) and let telemetry batches report from the old renderer instance.
Expected: an expected post-reload race is not a warning (the renderer already drops the batch).
Actual: `[warn] … [renderer-action-trace] stale renderer instance for sender {"senderId":1}` — 5 occurrences today (20:39, 20:49, 21:29, …), one per reload; each carries no stack and the batch is dropped.
Evidence: `~/.zcode-dev-home/.zcode/v2/logs/2026-10-22.log`; code `packages/desktop/src/main/rendererActionTraceIpc.ts:88` — the `stale` set exists exactly to catch retired instance ids, so the warn fires on the designed path (same family as ISSUE-025/036/048).
Root cause: confirmed (code) — expected condition mapped to warn.
Fix: — (log at info/debug in `rendererActionTraceIpc.ts`, or fold into the rpcLogLevel-style exemptions)
Verify: reload the renderer, send a turn → no `stale renderer instance` line at warn (it may appear at info).
History: 2026-10-22 open.

### ISSUE-049 · S2 · sidebar · fixed-verified

Scenario: SB-08 · Found: 2026-10-22 20:47 · Build: 5e8df047
Repro (from a fresh app start):

1. By project view. Hover any task row for ≥ 300 ms (here `qa-r2-smoke`, then the fresh `done` row; tried 0.8–2 s hovers, centred and title-area, after moving away first).
   Expected (`specs/task-hover-card-layout.md`): `[data-task-hover-card]` appears with title, time, branch + change stats, provider/model/effort, PR section; `data-task-hover-status` matches the run state.
   Actual: the card never renders in the flat/project list (grouped view renders it). Regression: round 1 SB-08 passed at build 7754958f (2026-10-22 12:xx); #292 (pack 7, merged 2026-10-23) changed the row wrapper.
   Evidence: repeated runtime hovers with no `[data-task-hover-card]` in the DOM (project view); code — `packages/ui/src/TaskListItem.tsx:627` wraps the row in `<Tooltip open={false}>` ("This Tooltip has no TooltipContent… constant boolean", the ISSUE-027 fix) but `TaskSidebarHoverCard` (a bare `TooltipContent`, `packages/ui/src/components/TaskSidebarHoverCard.tsx:56`) is rendered inside that same Tooltip at `TaskListItem.tsx:928`, so Radix never opens it. The grouped row keeps an uncontrolled `<Tooltip>` with the same card inside (`packages/ui/src/project-sidebar/grouped/task-row.tsx:704-712`), so only the flat list is affected.
   Root cause: confirmed (code + runtime) — #292's constant-closed Tooltip swallows the hover card's TooltipContent.
   Fix: — (the fixer must (a) render the card again in the flat list, (b) keep the ISSUE-027 guarantee: no "changing from uncontrolled to controlled" warnings, (c) not re-render the memoized row on every hover — the comment at TaskListItem.tsx:625 is why `open={false}` was chosen; e.g. own Tooltip/trigger around the card, or hover state lifted into a non-memoized wrapper)
   Verify:
1. Start the dev app from the fix branch; By project view.
1. Hover a task row for 500 ms.
   Must see: `[data-task-hover-card]` with `data-task-hover-status`, title, relative time; branch/model lines when applicable. Must not see: "changing from uncontrolled to controlled" warnings in the console; the row re-rendering per mousemove (React DevTools not required — the pack-7 tests `taskListItemHoverActions.test.ts` must still pass).
   History: 2026-10-22 open (SB-08, round-2 re-run with rAF probe passing) → fixing (fixer lane C1, worktree .claude/worktrees/qa-fix-049-hover-card) → fixed-unverified cbbd4476 + b14369c6 (branch claude/qa-fix-049-hover-card; spec-first specs/task-hover-card-layout.md #10-#11; tests taskListItemHoverCard.test.ts failing-first, 26/26; root cause pinned to 15d3d06f which replaced 78ca8e4c's lifted state with constant open={false} under a false "no TooltipContent" comment) → reviewer (Lane D, fresh context): SHIP, no must/should-fix; nits (rerenderRow twin, hover-disabled + focus cases) fixed in b14369c6 → fixed-verified 2026-10-22 22:0x on the restarted dev app built from the QA branch (cherry-picks 9bb0e6e9+288d26e8): By project view hover ≥300 ms renders [data-task-hover-card] with data-task-hover-status="completed", title, time, provider/effort; 0 controlled/uncontrolled warnings; grouped view unaffected; post-restart smoke CP-02 (reply ~12 s) and CH-04 (fork + first send, no host-mismatch) pass → PR osben/ZCode#298 (open)

### ISSUE-028 · S3 · sidebar · fixed-verified

Scenario: SB-03 · Found: 2026-10-22 12:25 · Build: 7754958f
Repro: hover a project row → `virtual-project-menu` → `virtual-project-delete` ("Delete project"); or open `virtual-project-edit` → `virtual-project-editor-delete`.
Expected: per the pre-loaded product question, a destructive action asks for confirmation (or offers undo).
Actual: both entries call `service.deleteProject(project.id, project.hostId)` immediately, with no confirmation dialog and no undo toast. The delete is a soft delete on the owning Host (tasks and files are not touched).
Evidence: code, not run live (a throwaway project needs the native folder picker, which CDP cannot drive): `packages/ui/src/project-sidebar/ProjectSidebarNode.tsx:193-198` (menu `onDelete` → `deleteProject` + `refresh`), `packages/ui/src/project-sidebar/ProjectEditor.tsx:382-396` (`remove()`), `:697-708` (editor button). `CONTRACT.md:31` describes the editor delete entry without a confirmation rule; no spec requires one.
Root cause: confirmed (by code) — no confirmation step exists in either path; whether one is wanted is a product decision.
Fix: — (options: a) confirm dialog "Delete project {name}? Tasks stay in Unclassified." on both entries; b) undo toast; c) keep as is because it is a soft delete)
Verify:

1. Create a throwaway project `qa-delete-me` (folder picker), open its menu → Delete project.
   Must see: the behavior the user chose (confirm dialog or undo toast). Must not see: the project vanish with no way back if a) or b) is chosen.

History: 2026-10-22 decision-needed (confirmed by code during SB-03). → 2026-10-22 user decision (a) → fix bed72e27 (QA 63f6a8df) → fixed-verified 16:12: menu `virtual-project-delete` and editor `virtual-project-editor-delete` both open "Delete project qa-sandbox? / Its tasks stay in Tasks." with Cancel/Delete; Cancel keeps the project (DB row intact). Confirm path covered by unit tests only (throwaway project needs the native picker; osascript lacks Accessibility for the claude-code helper) → PR osben/ZCode#289 (open, not merged) → 2026-10-22 merged in #289

### ISSUE-029 · S3 · sidebar · fixed-verified

Scenario: SB-05 · Found: 2026-10-22 12:27 · Build: 7754958f
Repro (from a fresh app start):

1. In `qa-sandbox` send "Write the numbers from 1 to 300 in English words, one per line.", then click another task so the run finishes in the background.
2. When the row shows `[data-unread-indicator]`, hover the row.

Expected (`specs/task-hover-card-layout.md` lines 33-34 and acceptance #8): run-state indicators (spinner, error/unread marker) stay visible beside the hover actions.
Actual: on hover the leading slot keeps `[data-unread-indicator]` in the DOM but it renders with width 0; the row shows the Pin and `task-archive-<id>` buttons instead. Same as the pre-loaded "hover hides run indicators" item.
Evidence: probe on hover: unread marker `getBoundingClientRect().width = 0`, buttons `Pin task`, `Archive task` at opacity 1; `<scratch>/qa/shots/sb05-hover.png`.
Root cause: confirmed (runtime) — the row hides the status slot while actions show; whether the spec or the code wins is a product decision (pre-loaded item).
Fix: — (options: a) keep the marker beside the actions per spec; b) amend the spec to "actions replace the marker on hover")
Verify:

1. Make a task unread (finish a run in the background) and hover its row; repeat with a running task.
   Must see: the outcome the user chose. If a): marker width > 0 next to the Pin/Archive buttons.

History: 2026-10-22 decision-needed (SB-05). → 2026-10-22 user decision: regression of specs/task-hover-card-layout.md #8 → fix 405d47d8 (QA a34208d8) → fixed-verified 16:08: By project — running row on hover keeps the spinner (22 px) beside Pin/Archive; unread row on hover keeps `[data-unread-indicator]` (7 px) beside Pin/Archive; By group — unread marker (6 px) beside the actions. Reviewer nits (touch Pin, button styling, focus) sent back to the fixer → PR osben/ZCode#289 (open, not merged) → 2026-10-22 merged in #289

### ISSUE-030 · S3 · harness · env

Scenario: SB-01/SB-05 · Found: 2026-10-22 12:24:15 · Build: 7754958f
Repro: with the main window attached over CDP, `agent-browser press Meta+n` (or any CDP-synthesized Meta+key that the native menu owns).
Expected: New task (the File menu accelerator `CmdOrCtrl+N`).
Actual: the About window opens; log `[desktop-command] execute showAbout windowId=1` (12:24:15.715 and 12:25:32.573). agent-browser then switches to the About target, so later commands silently run against it.
Root cause: hypothesis — CDP `Input.dispatchKeyEvent` events are unhandled by the page and Electron forwards them to the macOS main menu as key equivalents without proper characters; the first app-menu item (About, no accelerator) matches. Real keyboard ⌘N goes through the native accelerator. Not a product bug.
Fix: none in product. Harness rule: never send menu-owned shortcuts (⌘N, ⌘O, ⌘W, ⌘=, ⌘,) over CDP; use the button (`task-new-button`) or the menu item. If the About window appears, click `.ok-button` and `agent-browser tab 0`.
Verify: n/a (env).
History: 2026-10-22 env.

### ISSUE-031 · S3 · sidebar · fixed-verified

Scenario: SB-07 · Found: 2026-10-22 12:33 · Build: 7754958f
Repro: right-click any task row (or `workspace-more-button`) → "Copy task path"; paste.
Expected: a path that exists and identifies the task's stored session.
Actual: copies `<workspacePath>/<taskId>.zcode-session` (e.g. `~/qa-sandbox/zcode-qa-repo/session_1ef9….zcode-session`); no such file exists, and the Host hard-codes `exists: false`. Sessions live in the CLI SQLite db, not in per-task files. Copy path / Copy log path / Copy session ID are correct.
Evidence: clipboard read after the menu action; `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:3379-3384` (`getTaskSessionFilePath` returns the synthetic path with `exists: false`, unchanged since the open-source import 872ad960, i.e. upstream behavior).
Root cause: confirmed (code + clipboard) — legacy menu item kept after session storage moved to SQLite.
Fix: — (options: a) hide "Copy task path" when `exists` is false; b) copy something useful instead (session ID + db path); c) leave upstream behavior to avoid fork divergence)
Verify: right-click a task → the item is hidden/disabled (a) or copies an existing path (b).
History: 2026-10-22 decision-needed (SB-07). → 2026-10-22 user decision (a) → fix ea292238 (QA 1a0ae397) → fixed-verified 15:52: task row menu and header `workspace-more-button` menu no longer list "Copy task path" (Copy path / Copy log path / Copy session ID still present). Note: the Host always returns exists:false, so the item is now always hidden → PR osben/ZCode#289 (open, not merged) → 2026-10-22 merged in #289

### ISSUE-032 · S3 · sidebar · fixed-verified

Scenario: SB-09 · Found: 2026-10-22 12:41 · Build: 7754958f
Repro: grouped view (`sidebar-view-grouped`) → right-click any task row → `task-group-move-menu`.
Expected: system groups show their localized titles ("Scheduled tasks", "Idle-time tasks") as in the project-view menu, and (per `docs/off-peak-task/spec.md` line 298: system groups hold only run products) are not offered as manual move targets.
Actual: the grouped-view submenu lists `[data-task-group-target="zcode-default-group-cron"]` with the raw DB title `cron`; the project-view menu (`TaskGroupTaskMenu.tsx:39-47`) localizes it via `taskGroupTitleMessageId`. Both menus offer the cron/off-peak system groups as targets.
Evidence: submenu text `Remove from group|qa-group|New group|…|cron|…`; code `packages/ui/src/project-sidebar/grouped/task-context-menu-content.tsx:85-95` renders `group.title`.
Root cause: confirmed (code) for the label: the grouped menu skips `getTaskGroupDisplayTitle` / `taskGroupTitleMessageId`. Whether system groups may be manual targets is a product question (hypothesis: they should be excluded).
Fix: label part: branch claude/qa-fix-032-group-move-label, commit 2131d8a4 (grouped menu uses `getTaskGroupDisplayTitle`; test `packages/ui/test/groupedTaskContextMenuGroupTitles.test.tsx`; rule added to `docs/ui/task-grouped-view.md`); target list unchanged (decision); PR osben/ZCode#284 (open, not merged)
Verify: grouped view → task menu → Move to group: system group reads "Scheduled tasks" (en-US) and, if the user decides so, system groups are absent or disabled.
History: 2026-10-22 open (SB-09). → fixing → fixed-unverified 2131d8a4 (label only) → fixed-verified 2026-10-22 12:57 on QA branch 54254f51 (grouped menu shows "Scheduled tasks"; target list unchanged, decision pending) → 2026-10-22 merged in #284

### ISSUE-033 · S2 · sidebar · fixed-verified

Scenario: SB-11 · Found: 2026-10-22 12:55 · Build: 7754958f
Repro (dev app after some navigation; reproduced twice, once with ⌘[ / ⌘], once with the header buttons):

1. Click `plugin-store-sidebar-open` (Plugin Marketplace).
2. In the projects view click three task rows in order: A = `qa-outside`, B = `qa-count`, C = `qa-in-group` (each opens; `workspace-title` follows).
3. Press the header `button[aria-label="Go back"]` three times, then `Go forward` twice.

Expected (browser-style stack): C → back B → back A → back Plugin Marketplace; forward A → forward B.
Actual: C → back **Plugin Marketplace** → back **B (qa-count)** → back **Automations** ("Task created" page, visited ~30 min earlier) with Back disabled; forward → **Plugin Marketplace** → forward stays on Plugin Marketplace (Forward disabled). A never appears; the stack order does not match the visit order.
Evidence: probe output `<scratch>/qa/run-state.md` (SB-11 note); no navigation log lines exist. History data structure `packages/ui/src/lib/taskNavigationHistory.ts` (pure push/goBack/goForward look correct) → the defect is in which entries get pushed / how the cursor is synced (`packages/ui/src/store/zcodeSessionStoreNavigation.ts`, `zcodeSessionStoreTaskSlice.ts`, `app-shell/useWorkspaceTaskNavigation.ts`).
Root cause: confirmed (runtime + code, 13:10, window rendering) — pushes are correct: live `taskNavHistory` after PS, A, B, C is `[…, p, t:A, t:B, t:C]` (n=15, c=14). On Back, `useWorkspaceTaskNavigation.ts:281-297` calls `taskNavigationTargetExists` (`packages/ui/src/lib/taskNavigationTarget.ts:6-23`), which only consults `getVisibleTaskMetas(workspaceState)` and `taskMetaByEntityKey`; projects-view tasks (A outside any project, B in `qa-sandbox`) are in neither, so they are treated as deleted and every entry for them is purged (`removeTaskFromNavHistory`, n 15→12), landing on Plugin Marketplace. Secondary defects found by the fixer: forward skips an entry after a purge (cursor clamp), and purge + step were two store updates.
Fix: branch claude/qa-fix-033-nav-history: 9770c061 (cursor/purge in one snapshot) + 887de48d (purge only on positive deletion evidence) + 597bab68 (facts owned by `project-sidebar/deletedTaskFacts.ts` via ProjectDirectoryProvider `isTaskKnownDeleted`, retained per host while offline, dropped on membership leave; `removeTaskFromHistory`/step purge keyed by `workspaceIdentity?.trim() || workspacePath` + taskId); spec `docs/ui/workspace-sidebar-navigation.md` NAV-033-01..05; tests `useWorkspaceTaskNavigation.test.ts`, `workspaceNavigationHistory.test.ts`, `deletedTaskFacts.test.ts`; PR osben/ZCode#284 (open, not merged)
Verify:

1. Fresh app start. Open Plugin Marketplace, then click three different task rows A, B, C.
2. Go back ×3, Go forward ×2 (buttons and ⌘[ / ⌘]).
   Must see: B, A, Plugin Marketplace, then A, B; Back disabled only at the first entry. Must not see: a page that was not visited in this sequence.

History: 2026-10-22 open (SB-11). → fixed-unverified 9770c061+887de48d → fixed-verified 2026-10-22 13:52 on QA branch (f7ea79aa, 0a97edcb): PS→A→B(project task)→C, back ×3 = B, A, PS, forward = A, B; history n stays 7 (no purge) → reopened 14:10 (reviewer: remote tombstones dropped while a host is offline; taskId-only purge keys; plus 25 affected-test failures from the session-store write in useProjectTree) → fixing → follow-up 597bab68 (deletion facts owned by the project directory, per-host retention, identity-keyed purge; repo runner 4501/4501) → fixed-verified 2026-10-22 15:05 after restart on QA branch 09e46c2c (same trace C→B→A→PS, forward A→B, n stays 4) → 2026-10-22 merged in #284

### ISSUE-034 · S3 · harness · env

Scenario: SB-05/SB-11/CP-12 · Found: 2026-10-22 12:52 · Build: 7754958f
Repro: run the dev app while its window is fully covered by other windows (normal when an agent drives it over CDP). `requestAnimationFrame` callbacks never fire (`document.visibilityState === "hidden"`).
Actual (artifacts, not product bugs): typed composer text vanished once; composer text then followed the pane across sessions (A's draft shown in B and C); the sidebar minute ticker paused (by design while hidden). After restarting with `disable-backgrounding-occluded-windows`, rAF fires, drafts stay per session (and restore after restart), labels tick.
Root cause: confirmed — Chromium backgrounds occluded windows; composer draft swap and other UI work run on animation frames.
Fix (harness): start the dev app with `ZCODE_QA_NO_OCCLUSION=1` and the two `appendSwitch` lines next to the `remote-debugging-port` switch (QA-local edit, never committed), or keep the dev window visible. Check before any UI case: `agent-browser eval` a rAF probe must fire within 1.5 s.
Verify: n/a (env). Candidate for the kit: make this an env-gated switch in `main/index.ts` so QA does not need a local edit.
History: 2026-10-22 env.

## Run 2026-10-22 11:57 · dry run of the kit · base 1e6737a5

PRs included in base: #275, #276, #280 (merged); #277 (open, not included)
Baseline gates: not run (docs-only change); `pnpm fmt:check` ok
Environment: macOS, dev desktop, ZCODE_DATA_BASE_DIR=~/.zcode-dev-home, model `deepseek/deepseek-v4.1-flash-1017` (OpenRouter); Z.ai provider not signed in (footer shows Connect)
Scenario results: Phase 0–1 of the orchestrator prompt as written (launch, CDP attach in ~40 s, log watcher, long-task probe), CP-02 pass (pong in 8 s, worst block 151 ms), CH-02 archive + delete path pass; startup sweep removed 147 placeholder rows (#280 ISSUE-012b live)

### ISSUE-035 · S2 · composer · fixed-verified

Scenario: CP-03 / CH-10 · Found: 2026-10-22 13:03 · Build: 54254f51 (+QA-local occlusion switch)
Repro (from a fresh app start, window rendering — rAF probe fires):

1. Open an idle existing session S (here "Reply with the word pong", session_c60c5b32…, model `deepseek/deepseek-v4.1-flash-1017`, effort Max).
2. `chat-model-select-trigger` → `chat-model-select-item-custom:<provider>:openrouter%2Ffree` → Esc. `v4-model-config` now shows `model=openrouter/free`.
3. Click another task row, then click S again.

Expected: S keeps the newly selected model (CP-03 "a session keeps its own model"); right after step 2 a toast "Switched from {from} to {to}" (`docs/ui/model-switch-toast.md`, `docs/chat-model-change-notice.md` "the UI immediately shows a toast").
Actual: after step 3 `v4-model-config` is back to `deepseek/…`, `thought=max` (choice silently lost). No toast at any point (DOM observer for "Switched from" saw nothing). If instead a prompt is sent right after step 2, the new model answers and the `[data-marker-type=modelChange]` "Model switched … → …" marker appears, so the switch only applies when followed by a send in the same visit. Also: picking a model on an existing session does not become the "Recent" default for the next new task (new drafts still default to deepseek/Max).
Evidence: host log at the pick shows only `setting.get` / `setting.update` (shared `~/.zcode/v2/setting.json`) and `model-selection.getView`; no session config command. Probe output in `<scratch>/qa/run-state.md` (CP-03).
Root cause: confirmed (code; same in upstream pin 0a1fc56d, no regression) — the pick goes `V4ComposerToolbar.tsx:962-1005` → `SessionPane.tsx:5025-5040 handleSelectModel` → `useDraftConfigControl` `updateComposerDraft` (memory + `persistDraft`); `composerDraftStore.ts:599-609 persistV4ComposerDraft` deletes the scope record when the text is empty, so returning to the session rebuilds the config from the session snapshot (old model). This follows `docs/ui/composer-text-draft-persistence.md:8,11` (2026-10-14: "仅改模型/权限不构成可持久化草稿", config is memory-only). The toast is emitted only from `handleOnlineModelTransition` (`SessionPane.tsx:3628-3641`) on a `snapshot.modelTransition` after a send — consistent with `docs/ui/model-switch-toast.md` ("完成模型切换后") but not with `docs/chat-model-change-notice.md` ("immediately shows a toast"). "Recent" updates only on an accepted send (`docs/ui/project-task-draft-lifecycle.md:46`, by design). `docs/ui/chat-model-select-menu.md:46` (switchModelConfig on pick) is stale. The `setting.update` at pick time is not from the model-pick path (unattributed).
Fix: — decision-needed: a) keep as is, fix the two contradicting/stale docs and the CP-03 expectation; b) persist a model-only per-session selection (reverses the 2026-10-14 rule; owner `persistV4ComposerDraft`) and show the toast on pick (`showModelChangeNotice` in `handleSelectModel`, de-dupe the send-time toast)
Verify:

1. Fresh start; open an idle existing session, pick a different model, Esc.
   Must see: toast "Switched from … to …".
2. Open another task, come back.
   Must see: the picked model still in `v4-model-config`. Must not see: the old model.
3. Send "Reply with exactly the word pong." → `[data-marker-type=modelChange]` and a reply from the picked model.

History: 2026-10-22 open (CP-03) → decision-needed (spec 2026-10-14 rule; docs contradict). → 2026-10-22 user decision (b) → fix e0a7a6d5 (QA 6d2902fd) → fixed-verified 16:30 in qa-hover: pick openrouter/free with no text → navigate to Automations and back → still openrouter/free; pick deepseek → toast "Switched from OpenRouter/openrouter/free to OpenRouter/deepseek/deepseek-v4.1-flash-1017"; a following send adds no second switch toast. Recent adoption on pick not done (policy: Recent is written on accepted sends) → 2026-10-22 PR osben/ZCode#291 (open)

### ISSUE-036 · S3 · runtime · fixed-unverified

Scenario: CP-06 · Found: 2026-10-22 13:09:48 · Build: 54254f51
Repro: send the first prompt of a new task (seen with a worktree task; the log shows the same pair at 01:40, 02:11, 04:32, 13:09 today).
Expected: no warn for a session that is being created.
Actual: right after the first send, two warns:
[warn] … [zcode-host] [rpc:call] zcode-agent.conversationWorkflowRunsV4 FAIL (0.8ms) {"name":"ZCodeProtocolClientError","message":"fault.workflowRuns.sessionNotFound: sess_cdffdc7b-…"}
[warn] … [renderer] [workflow-run] 读取 run 摘要失败（journal 回退暂缺） {"error":"fault.workflowRuns.sessionNotFound: …","live":true}
The UI recovers (no visible error).
Evidence: `~/.zcode-dev-home/.zcode/v2/logs/2026-10-22.log` (8 lines, 4 pairs).
Root cause: hypothesis — the renderer reads workflow-run summaries for the new session before the CLI has created it (same race family as ISSUE-025); either the read should wait for the create ack or `sessionNotFound` on a just-created session should be expected and logged below warn.
Fix: —
Verify: create a new task and send; Must not see `workflowRuns.sessionNotFound` at warn.
History: 2026-10-22 open (CP-06) → fixing → fixed-unverified 643ed5a6 (branch claude/qa-fix-037-branch-intent). → 2026-10-22 pack 7 osben/ZCode#292: `rpcLogLevel.ts` logs `conversationWorkflowRunsV4 FAIL … fault.workflowRuns.sessionNotFound` at info; spec `specs/host-rpc-log-levels.md`; unit-tested, not re-checked live

### ISSUE-037 · S2 · composer · fixed-verified

Scenario: CP-06 · Found: 2026-10-22 13:20 · Build: 54254f51
Repro (sandbox repo on `main`, window rendering):

1. In project `qa-sandbox` have one non-worktree task running or awaiting approval (here "qa guard test").
2. New draft in `qa-sandbox` → destination control (`button[aria-label="Choose where this task runs"]`) → Worktree off → Task branch → `feature/qa-branch`. Header shows `feature/qa-branch`.
3. Type text, Enter → dialog "Switch branch? Switching to feature/qa-branch changes the working tree for 1 running task: qa guard test" → Cancel.
4. Enter again.

Expected (`specs/composer-branch-switcher-semantics.md` §1 line 17): a cancelled switch aborts the send, "no session is created, draft text and intent are preserved"; step 4 shows the guard again for `feature/qa-branch`.
Actual: step 3 keeps the text and creates no session (correct), but the destination label and the popover "Task branch" row switch back to `main`; step 4 sends with no guard and the new task runs on `main` (repo stays on main). The user's branch choice is silently dropped.
Evidence: probe after Cancel: dest label `main`, popover `Worktree|Task branch|main`, `git branch --show-current` = main; step 4 created task "qa guard test 2" on main.
Root cause: hypothesis — the cancel path resets the draft branch intent to the current branch (or the intent is re-derived from the checkout after the aborted send) instead of keeping the selected intent.
Fix: branch claude/qa-fix-037-branch-intent: 643ed5a6 + af1556d1 (`LexicalChatInput.tsx` onChange passes `{programmatic}` from PROGRAMMATIC_UPDATE_TAG, `ChatPromptEditor.tsx` forwards it, `ConversationComposer.tsx` handleEditorChange is the single user-edit writer, empty-text effect and ref removed; worktree base consumed at send acceptance); spec `specs/composer-branch-switcher-semantics.md` §1 + scenario 25; tests in `v4ConversationComposerWorktreeLateAckDispatch.test.ts` ("ISSUE-037" ×6); PR osben/ZCode#284 (open, not merged)
Verify:

1. Same setup (one active non-worktree task in the project).
2. Draft → Task branch `feature/qa-branch` → send → Cancel in "Switch branch?".
   Must see: destination still `feature/qa-branch`, text kept, no new session. 3. Send again → the guard appears again naming `feature/qa-branch`. Must not see: a send on `main` without a guard.

History: 2026-10-22 open (CP-06). → fixed-verified 2026-10-22 13:55 on QA branch f5820c20 (Cancel keeps feature/qa-branch + text, second send shows the guard again, Confirm switches and creates the session) → reopened 14:10 (reviewer: race — a fast switch failure lets the ref reset before the clear effect; redesign to clear only from user edits) → fixing → follow-up af1556d1 (intent cleared only from user edits via the editor `programmatic` flag; accepted send consumes it in both modes; runner 912/912) → fixed-verified 2026-10-22 15:08 on QA branch 6cbd0c2b (Cancel keeps feature/qa-branch, guard repeats, user clearing the draft resets to main) → review follow-up 928f0b9c (prompt-history recall counts as programmatic) verified 2026-10-22 14:23 on QA branch ff8a0fe9 (ArrowUp ×2 / ArrowDown ×2 keep feature/qa-branch; typing then clearing resets to main) → 2026-10-22 merged in #284

### ISSUE-038 · S3 · composer · cannot-reproduce

Scenario: CP-08 / CP-10 · Found: 2026-10-22 13:27 · Build: 54254f51
Repro: new draft in `qa-sandbox` (3 files, 8 sessions). Either open `chat-attachment-button` ("Add context") on an empty draft, or type `@` in the composer.
Expected (`docs/ui/chat-composer-action-menu.md` lines 13-16): Files section = current workspace, files first, "空查询最多 10 项" (up to 10 items on an empty query); Sessions section = current workspace sessions; a section hides only when it has no candidates and no loading/error state.
Actual: with an empty query only ADD and PLUGINS (14 plugins) render; `[data-testid^=prompt-suggestion-option-file:]` and `session:` are absent, also after waiting and after a previous query warmed the cache. Any one-character query (`@q`) immediately shows 5 files and 8 sessions. `.DS_Store` is offered as a file candidate (polish).
Evidence: option counts by kind: empty → `{"plugin":14}`; `q` → `{"file":5,"session":8}`.
Root cause: confirmed — not a bug. `MentionPanel.tsx:154-165` virtualizes rows (`useVirtualizer`, overscan 8); with ADD + 14 plugins the Files/Sessions rows are below the fold and not mounted, so counting `[data-testid^=prompt-suggestion-option-]` without scrolling misses them. Scrolling the panel to the bottom shows `{"file":3,"session":11}`. Providers do run for the empty query (`ChatPromptActionMenu.tsx:91-107`, `MentionPlugin.tsx:192-219`). `.DS_Store` filtering belongs to `packages/services/src/file/workspaceFileIgnore.ts` defaults (optional follow-up).
Fix: —
Verify: empty draft in a project with files → `@` and the plus menu list up to 10 files and the workspace's sessions without typing a query.
History: 2026-10-22 open (CP-08/CP-10). → cannot-reproduce (QA probe error: virtualized list; scenario catalog updated to scroll before counting).

### ISSUE-039 · S3 · composer · fixed-verified

Scenario: CP-13 · Found: 2026-10-22 13:37 · Build: 54254f51
Repro: start a long run ("Count from 1 to 800, one number per line. Do not use tools."), queue two messages A and B, press `v4-queue-item-send-now-<A>` ("Steer").
Expected (catalog CP-13): "Steer runs the item now"; the rest of the queue is not specified.
Actual: the running turn stops, A runs, and B stays queued under `v4-queue-paused-banner` ("The queue is paused · Continue") until the user presses Continue. A following Send opens the paused-queue dialog. This follows `specs/stop-queue-hold.md` (a stop that cancels a turn holds the queue) because `sendQueuedNow` goes through the CLI stop barrier (`docs/ui/chat-message-queue.md:25`), but a user who steers one item likely expects the remaining queue to keep draining.
Evidence: probe right after Steer: running, banner present, queue `[B]`; 8 s later idle, banner present, queue `[B]`.
Root cause: confirmed (runtime) — by the current stop-hold rule; product decision whether Steer should hold.
Fix: — (options: a) keep the hold, document it in `docs/ui/chat-message-queue.md`; b) Steer's internal stop does not write a hold, so the queue keeps draining after the steered item)
Verify: per the decision.
History: 2026-10-22 decision-needed (CP-13). → 2026-10-22 user decision (b) → fixer: steer/stop code identical to the QA build; Steer already carries `preserveQueueAutoDrainOnCancel`, `holdFollowingQueue` only from user Stop; spec + regression tests + 4 E2E steer cases added (pack 5, no product change) → live re-run 15:56/15:57 on the QA build (deepseek): Steer A2 mid-run and Steer A3 right at run start — the remaining item drained by itself, no `v4-queue-paused-banner` → cannot-reproduce. Untested residual: Steer before the runtime foreground token exists (spec rule 12). Plural nit `chat.queue.sendConfirm.description` belongs with ISSUE-047 → reviewer found the runtime-idle steer path (caller abort without the preserve intent); fixed as hardening 21a33aed/11bbb768 with failing-first core + CLI tests; that path is reachable only via legacy session/send and goal-compact, not the native v4 send, so the QA trigger stays unexplained → pack 5 (spec + hardening + E2E steer cases) → 2026-10-22 PR osben/ZCode#290 (open): Steer never holds, user Stop always holds (incl. after an in-flight cancel); live: Stop holds, Steer drains
Note: the paused-queue dialog text reads "Clear the 1 previously queued messages?" (plural with 1, i18n polish).

### ISSUE-040 · S3 · composer · fixed-verified

Scenario: CP-14 · Found: 2026-10-22 13:41 · Build: 54254f51
Repro: paste a 40 MB PNG into the composer (synthetic `ClipboardEvent('paste')` with a `File`), with text in the input.
Expected: a readable reason, e.g. the existing en-US string `chat.attachments.oversizedInlineImage` "Image attachment {filename} is too large ({size}). Please compress it to {maxSize} or smaller and try again." (also in zh-CN, uk-UA).
Actual: the chip goes `queued → failed` and shows only a "!" badge; the reason is a hover `title` "Upload failed: oversized-inline-image-attachment" (raw error code via `chat.attachments.upload.failed`). No toast. Send is disabled (correct per `docs/ui/chat-file-attachments.md`), so with the tooltip unseen the user gets no explanation. `chat.attachments.oversizedInlineImage` has no caller in `packages/ui/src` (only locale files). A 120 MB file behaves the same.
Evidence: chip `title`, `data-upload-status=failed`, `v4-composer-send` disabled; `packages/ui/src/lib/chatAttachmentErrors.ts:21` defines the code.
Root cause: hypothesis — the upload failure path formats `error.code` into `chat.attachments.upload.failed` instead of mapping `OversizedInlineImageAttachmentError` (and the video variant) to their localized messages.
Fix: branch claude/qa-fix-040-oversized-attachment-message, commit 8defe0e0 (`useComposerAttachments.ts` maps OversizedInlineImageAttachmentError to `chat.attachments.oversizedInlineImage`, non-transient; test `useComposerAttachmentsUpload.test.ts`; rule in `docs/ui/chat-file-attachments.md`); PR osben/ZCode#284 (open, not merged)
Verify: paste a > 20 MiB image → the chip/toast shows the localized "too large … compress to …" text; Send stays disabled until the chip is removed.
History: 2026-10-22 open (CP-14). → fixing → fixed-unverified 8defe0e0 → fixed-verified 2026-10-22 15:09 on QA branch 02b27d6f (chip title "Upload failed: Image attachment qa-40m.png is too large (40 MB). Please compress it to 20 MB or smaller and try again.") → 2026-10-22 merged in #284

### ISSUE-041 · S3 · chat · fixed-verified

Scenario: CH-05 · Found: 2026-10-22 14:25 · Build: f5820c20
Repro: in `qa-sandbox` (Full access) ask the agent to add `square(x)` to `src/math.js`; after the turn, in the change summary "1 file changed +4 -0" press Undo → "Undo files".
Expected (`docs/rewind-button-any-message.md` lines 7 and 29; catalog CH-05): the file-change summary toggles between undo and reapply ("撤销 / 重新应用").
Actual: Undo reverts the file (git diff empty) and the panel shows the "Undone" badge with Undo disabled; there is no Reapply action. `chat.changeSummary.reapply` exists in the locales but is unused; the V4 panel (`packages/ui/src/v4/ConversationFileSummaryPanel.tsx`) has undo only, identical to upstream pin 0a1fc56d (lines 130-134, 277).
Root cause: confirmed (code) — upstream behavior; the docs describe the older MessageChangeSummaryPanel.
Fix: — (options: a) update the docs/catalog to "undo only" (no fork divergence); b) add Reapply to the V4 panel (fork feature))
Verify: per decision.
History: 2026-10-22 decision-needed (CH-05). → 2026-10-22 user decision (a) docs only → `docs/rewind-button-any-message.md` bac4555f (pack 3) + CH-05 catalog on the QA branch → PR osben/ZCode#289 (open, not merged) → 2026-10-22 merged in #289

### ISSUE-042 · S3 · review · fixed-verified

Scenario: SP-02 · Found: 2026-10-22 15:30 · Build: 02b27d6f
Repro: in the project repo create an empty untracked file (`touch qa2.txt`) and a non-empty one (`qa.txt`); open the side pane Review tab (`git-pane`, scope Unstaged), press Refresh.
Expected (catalog SP-02, `specs/review-reliability-fixes.md`): the list matches `git status` (`?? qa.txt`, `?? qa2.txt`).
Actual: only `qa.txt +1-0` is listed; the empty untracked `qa2.txt` never appears (also after Refresh).
Also SP-03: the commit dialog says "1 files" and "Commit" with "Include unstaged changes" on commits only `qa.txt`; `qa2.txt` stays `??` after the commit (fec1559).
Evidence: `git -C ~/qa-sandbox/zcode-qa-repo status --short` → `?? qa.txt`, `?? qa2.txt`; pane text "Unstaged | … | qa.txt | +1-0".
Root cause: confirmed (code) — `shouldIncludeUntrackedChange` (`packages/services/src/git/gitService.ts`) drops every untracked entry with +0/-0; upstream (pin 0a1fc56d) does this on purpose to hide empty build artifacts. The commit dialog uses the same list, so the empty file was not committed either.
Fix: branch claude/qa-fix-042-review-empty-untracked, commit 153d04bc (QA branch 9043a481): `buildUntrackedStats` marks zero-byte regular files `isEmptyFile`, `shouldIncludeUntrackedChange` keeps them; binary/oversized/unreadable stay hidden; `gitCliHelpers.ts` added to `.staged-file-size-exemptions` (23.9 KB upstream file; a new sibling file is blocked by unmanaged-new-file); spec `specs/review-reliability-fixes.md`; real-git test in `packages/services/test/gitService.test.ts`. Diverges from upstream intent — flagged in the PR. Residual: branch scope reports an empty added file as kind modified (numstat 0/0). PR osben/ZCode#285 (open, not merged)
Verify: empty untracked file appears in Review (Unstaged and All branch changes) with +0 -0 and an "added" status.
History: 2026-10-22 open (SP-02). → fixing → fixed-unverified 153d04bc → fixed-verified 2026-10-22 14:22 after checkpoint 4 (Review Unstaged lists `qa2.txt +0-0`).

### ISSUE-043 · S3 · renderer · fixed-verified

Scenario: SP-03 · Found: 2026-10-22 15:36 · Build: 02b27d6f
Repro: Git tools → "Commit or push" (`git-action-trigger`) → commit dialog (`git-commit-dialog`); read `agent-browser console`.
Expected: no accessibility errors.
Actual: `[error] \`DialogContent\` requires a \`DialogTitle\` for the component to be accessible for screen reader users.`The commit dialog`DialogContent`at`packages/ui/src/GitActionMenu.tsx:385`has no`DialogTitle`(the push dialog in the same file at :652-656 has one). Also "1 files" in the dialog (plural i18n nit).
Root cause: confirmed (code).
Fix: — (add a visually hidden`DialogTitle`/`DialogDescription` to the commit dialog; fix the plural) PR osben/ZCode#285 (open, not merged).
Verify: open the commit dialog → no DialogTitle error in the console; screen-reader name present.
History: 2026-10-22 open (SP-03). → fixed-unverified 7b80c3b3 → fixed-verified 2026-10-22 14:41 (dialog named "Commit changes", "1 file", no DialogTitle console error; closed without committing).

### ISSUE-044 · S3 · renderer · fixed-verified

Scenario: SP-06 · Found: 2026-10-22 14:14 · Build: 02b27d6f
Repro: in a chat, a link card for `http://127.0.0.1:9/unreachable` → Open (in-app browser).
Expected: a short, user-facing load-error message (e.g. "This port is blocked for safety").
Actual: `browser-load-error` shows "Failed to load page: Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_UNSAFE_PORT (-312) loading '…'" — raw Electron IPC wrapper text inside `browser.loadFailed` (`packages/ui/src/i18n/locales/en-US.ts:1338`, `{message}` is the raw error). Navigation, back/forward/refresh and Reload all work.
Root cause: confirmed (code) — two writers of `errorMessage` per navigation: `did-fail-load` writes the clean `errorDescription`, the `webview.loadURL` rejection catches write the raw IPC `error.message` (that one won the race here); the log already has `errorCode`/`errorDescription` (`[browser-use] 页面加载失败 {"errorCode":-312,"errorDescription":"ERR_UNSAFE_PORT"}`).
Fix: branch claude/qa-fix-043-044-ui-nits, commit b05c25ce (QA branch 747bf8b3): pure `describeBrowserLoadFailure` in `embeddedBrowserHelpers.ts` is the single owner of the text, used by all three writers in `UnifiedBrowserView.tsx`; spec `docs/browser-use/2026-10-22-browser-load-error-message-spec.md`; 6 unit cases. PR osben/ZCode#285 (open, not merged)
Verify: open an unsafe-port URL → the message has no `GUEST_VIEW_MANAGER_CALL` text.
History: 2026-10-22 open (SP-06). → fixed-unverified b05c25ce → fixed-verified 2026-10-22 14:42 ("Failed to load page: ERR_UNSAFE_PORT").

### ISSUE-045 · S1 · settings · fixed-verified

Scenario: ST-01 · Found: 2026-10-22 14:26 · Build: 7229c227
Repro: installed upstream app running (same `~/.zcode/v2/setting.json`); in the fork dev app Settings › General › Language → Українська.
Expected (AGENTS.md "setting.json is not fork-safe storage"): a fork-only choice never makes the shared file unreadable for the upstream build.
Actual: the fork writes `"locale":"uk-UA","localePreference":"uk-UA"` into the shared file (14:25:46). The installed upstream app re-reads it, logs `[settingService] read failed schema validation, returning defaults. error: locale: Invalid option: expected one of "zh-CN"|"en-US"; localePref…` and **writes its defaults back** (14:26:04): 51 → 40 keys. Lost: `shortcutBindings`, `lastActiveWorkspace`, `providerFamilyConnectionSelections`/`providerFamilyDomain`, `webRemoteControlRelayV2Device`/`…LastEnabledContext`, `desktopWindowSize`/`desktopZoomLevel`, `onboardingOccupation`, `settingsSyncFirstRunPromptHandled`, `sourceServerDirectoryMigrationVersion`; reset to defaults: `autoDownloadAndInstallUpdates`, `receivePreviewUpdates`, `modelIoFullRetentionEnabled`, `messageStreamShowTodos`, `toolGroupingChangesEnabled`, `embeddedBrowserAllowInsecureCertificates`, `computerUseComposerEntryHidden`, `proactiveSuggestionsEnabled`.
Evidence: installed app log `~/.zcode/v2/logs/2026-10-22.log` 14:26:04.858–.862 (pid 79510 settingService); dev log `[settingService] write payload` 14:25:46.304 (51 keys, uk-UA) and read 14:26:11 (40 keys, no dev write in between).
Root cause: confirmed (logs + code) — the fork extends the shared `localeSchema`/`localePreferenceSchema` with `"uk-UA"` (`packages/shared/src/validationAppSettings.ts:43-44`) and persists it in the shared `locale`/`localePreference` keys; the upstream schema rejects the whole file and its read-defaults-then-write path overwrites everything. Any fork-only enum value in a shared key has the same blast radius.
Fix: — (design: keep the shared keys within the upstream value set — e.g. persist `en-US`/`system` there and the uk-UA choice in fork storage `~/.zcode/v2/fork-settings.json`, read with precedence by the fork; needs user alignment per AGENTS.md)
Recovery done: QA restored `setting.json` at 14:27 to the pre-ST-01 snapshot (53 keys, identical; 14:25:46 payload + 2 upstream-only keys from the snapshot); the installed app may still hold defaults in memory until restarted.
Verify (only on a build that contains the fix; first `cp ~/.zcode/v2/setting.json` to a snapshot and afterwards revert by key, never wholesale): with the upstream app running, choose Українська in the fork → the fork UI is Ukrainian, `setting.json` `locale` stays in `zh-CN|en-US`, upstream log has no `failed schema validation`, key count unchanged.
History: 2026-10-22 open (ST-01) → decision-needed (AGENTS.md: align on the design before fixing; recommended option in Fix). → 2026-10-22 user decision (fork storage) → fix e7ef9bfd/971236e5/a92aa08f (QA 6ff6d30d..b5d0a40c) → verified live 15:53–16:00 with the installed upstream app running: pick Українська → UI Ukrainian, `setting.json` keeps 53 keys with locale en-US / localePreference system, `fork-settings.json` gets localePreferenceOverride/localeOverride uk-UA, upstream log has no `failed schema validation` and no write; dev restart → still Ukrainian; pick English → overrides cleared. Reviewer must-fixes (two-file write race, migration failure breaking get(), sync schema dropping uk payload) sent back to the fixer → review fixes da9eed86/d5e9bbd3 re-verified live 16:45 (uk → shared 53 keys en-US/system, fork overrides set, no upstream schema failure; English → overrides cleared) → PR osben/ZCode#288 (open, not merged) → 2026-10-22 merged in #288

### ISSUE-046 · S3 · i18n · fixed-verified

Scenario: ST-01 · Found: 2026-10-22 14:25 · Build: 7229c227
Repro: Settings in uk-UA; visit General, Appearance, Manage sessions, Archive management.
Expected: no untranslated strings on visited pages.
Actual: Archive management is entirely English ("Archive management", "Archived sessions", "Delete all", "Sort by", "Updated time", "All projects"); nav "Remote devices", "Worktrees", "Browser Use", "Computer Use"; General "Tool search". `uk-UA.ts` has 552 values identical to English phrases (remote 196, settings 138, project 56, conversationShare 39, chat 36, archives 19, …) and 6 keys missing.
Root cause: confirmed (catalog) — untranslated copies in `packages/ui/src/i18n/locales/uk-UA.ts` (e.g. `archives.*` at :8292+).
Fix: —
Verify: uk-UA on the four pages shows no English UI strings (product names excepted).
History: 2026-10-22 open (ST-01). → 2026-10-22 fix 7164ecf1 + coverage test 38de3748 (736 values translated; phrase-like identical values 630 → 0 outside an explicit allowlist of brand/technical strings) → live spot-check on the QA branch: Settings nav and Archive management in Ukrainian ("Керування архівом", "Архівні сеанси", "Видалити все", "Сортувати за", "Усі проєкти"); group counts ("14 sessions") come from `archives.count`, fixed in #292 → PR pending (rebased onto integration)

### ISSUE-047 · S3 · i18n · fixed-unverified

Scenario: MS-01 · Found: 2026-10-22 14:36 · Build: 7229c227
Repro: Settings › Archive management with one archived session in a project.
Expected: "1 session".
Actual: group header "1 sessions". Same family: `git.branchSwitcher.commitDialog.changesValue` "{count} files" in `GitBranchDialogs.tsx` (found by the ISSUE-043 fixer, not fixed there).
Root cause: confirmed (catalog) — count strings use a single `{count} …s` message instead of the repo's plural-family keys (`intl.formatPlural`, as in `GitBranchSwitcher`).
Fix: —
Verify: one archived session → "1 session"; branch-switcher commit dialog with one file → "1 file".
History: 2026-10-22 open (MS-01). → 2026-10-22 pack 7 osben/ZCode#292: plural families for `archives.count`, `git.branchSwitcher.commitDialog.changesValue`, `chat.queue.sendConfirm.description` (en/zh/uk); `git.actionMenu.commitDialog.changesValue` is in #285 (ISSUE-043)

### ISSUE-048 · S3 · host · fixed-unverified

Scenario: MI-01 · Found: 2026-10-22 14:35:55 · Build: 747bf8b3
Repro: Automations › Workflow tab (Saved workflows) with several projects that have no `.zcode/workflows` directory.
Expected: an expected-missing directory is not a warning (the renderer already treats it as normal).
Actual: 14 `[warn] … [rpc:call] file-watcher.watch FAIL … ENOENT: no such file or directory, watch '<project>/.zcode/workflows'` lines in one burst (one per project + `~/.zcode/workflows`); each line carries a full stack. The renderer side logs the same failure at debug (`useSavedWorkflowsDirectoryWatch.ts:62` "目录可能尚不存在").
Evidence: `~/.zcode-dev-home/.zcode/v2/logs/2026-10-22.log` 14:35:55.351–.357.
Root cause: confirmed (code + log) — same mechanism as ISSUE-025: `packages/desktop/src/host/rpcLogLevel.ts` maps every `[rpc:call] … FAIL` to warn; the watcher request for a not-yet-created directory is expected.
Fix: — (either watch the nearest existing parent / skip missing dirs in the saved-workflows watch, or exempt `file-watcher.watch` ENOENT in `rpcLogLevel.ts` like ISSUE-025)
Verify: open the Workflow tab → no `file-watcher.watch FAIL` at warn.
History: 2026-10-22 open (MI-01 follow-up). → 2026-10-22 pack 7 osben/ZCode#292: `file-watcher.watch FAIL` ENOENT on any `.zcode/workflows` (project or user-global) logged at info; unit-tested, not re-checked live

### ISSUE-025 · S3 · runtime · fixed-verified

Scenario: CP-02 · Found: 2026-10-22 11:58:26 · Build: 1e6737a5
Repro (from a fresh app start):

1. Start the dev app; while the Agent runtime is still starting, press New task (⌘N).

Expected: no failed RPC, or the subscription waits for the runtime.
Actual: host logs `[rpc:call] zcode-agent.subscribeSessionsIndexV4 FAIL (0.1ms) {"message":"ZCode Agent runtime is not running." … getReadOnlyClient …}` at warn; 6 occurrences in the 2026-10-22 dev log. The UI recovered (the send worked).
Evidence: `~/.zcode-dev-home/.zcode/v2/logs/2026-10-22.log` 11:58:26.535 and 04:32:18.077.
Root cause: confirmed (code, 2026-10-22 run) — by design the renderer probes `subscribeSessionsIndexV4` with `runtimePolicy: "existing-only"` (`packages/ui/src/v4/agentSessionsIndexTransport.ts:121-126`); the Host throws `ZCODE_AGENT_RUNTIME_UNAVAILABLE` from `getReadOnlyClient` (`zcodeAgentService.ts:3588-3605`); the store treats it as "dormant" and resubscribes on the runtime-lifecycle "available" event (`sessionsIndexStore.ts:268-272, 674-698`). There is no current-state query to gate on, so the failing probe is expected. The only defect is the level: `packages/desktop/src/host/rpcLogLevel.ts:37` maps every `FAIL` to warn, with one existing exemption for `ZCODE_AGENT_PROVIDER_NOT_READY`. Also seen mid-session (2026-10-22 12:17:48, 12:42:10) when a workspace's runtime was not yet started.
Fix: branch claude/qa-fix-025-rpc-log-level, commit dd3a1146 (`packages/desktop/src/host/rpcLogLevel.ts` exempts `[rpc:call] zcode-agent.subscribeSessionsIndexV4 FAIL (` with `code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE` → info; tests `packages/desktop/test/host-rpc-log-level.test.ts` "host RPC log level: expected runtime-unavailable sessions-index probe"); no spec covers RPC log levels; PR osben/ZCode#284 (open, not merged)
Verify:

1. Restart the dev app, open a new task within 2 s of the window appearing.
   Must see: sessions index populated, send works. Must not see: `subscribeSessionsIndexV4 FAIL` in the log (or, if the retry is by design, it is logged below warn).

History: 2026-10-22 open (dry run). → fixing (fixer lane C) → fixed-unverified dd3a1146 → fixed-verified 2026-10-22 12:55 on QA branch ec9bb2b4 (restarted app logs `[info] … subscribeSessionsIndexV4 FAIL` at 12:55:49/51, no warn) → 2026-10-22 merged in #284

### ISSUE-026 · S2 · composer · fixed-verified

Scenario: CP-03 · Found: 2026-10-22 11:58 · Build: 1e6737a5
Repro (from a fresh app start):

1. Have sessions that ran on a provider that is now unavailable (here Z.ai, not signed in; footer shows Connect).
2. Open an existing session last run on that provider.

Expected: the composer shows the session's model with an "unavailable" state, or switches to an available model with a notice (per `docs/chat-model-change-notice.md`).
Actual: the follow-up composer shows "Choose model"; `[data-testid=v4-model-config]` has empty `data-provider` / `data-model`. Whether Send is blocked silently was not checked.
Evidence: screenshot not retained; `v4-model-config` dataset dump: `provider=""`, `model=""`, trigger text "Choose model".
Root cause: confirmed (code, 2026-10-22 run triage) — by design the follow-up composer keeps the stored selection as intent (`useDraftConfigControl.ts:287-291`); when the Host view cannot resolve it (`resolveEffectiveModelSelection` → `selectionIssue` provider-not-found / account-connection-unavailable / model-not-found, `packages/provider/src/effective-model-selection.ts:30-60`) the effective selection is empty and the toolbar shows "Choose model" (`V4ComposerToolbar.tsx:1239` comment: empty model is a valid awaiting-selection state for existing conversations). Send is disabled (`SessionPane.tsx:1919-1921` → `submissionReady`), and Enter shows the generic toast "The session isn't ready yet. Try again in a moment." (`composerSubmitBlockReason.ts:34-35`), which is misleading: the cause is the unavailable model, and retrying does not help. `composer-send-blocked-reason` renders only for barrier reasons. Not a regression; spec gap (`docs/chat-model-change-notice.md` does not cover this; `docs/composer-model-thinking.md:19` only defines the empty label).
Fix: — decision-needed (options: a) specific block reason "Selected model is unavailable — choose a model" via a new `ComposerSubmitBlockReason` + i18n en/zh/uk; b) a) plus showing the previous model as "unavailable" in the trigger; c) auto-fallback to the preferred model with a notice — conflicts with "intent preserved"). Same area as ISSUE-035.
Verify:

1. Open a session whose provider is not available.
   Must see: a clear model state and a working path to send (pick a model, or a readable blocked reason). Must not see: a silent no-op Send.

History: 2026-10-22 open (dry run). → decision-needed 2026-10-22 (run triage: by design + misleading block reason). → 2026-10-22 user decision (a) → fix 85e6800c (QA 45e7ca1d) FAILED live verify 15:58: the `modelUnavailable` reason is computed but never shown — Enter inserts a newline (`submitDisabled` includes `!submissionReady`, so `submit()` and its toast are never reached), no inline `composer-send-blocked-reason`, no Send tooltip. Reopened to the fixer with reviewer points (cold-start transient verdict, account-connection copy, predicate order) → amendment a50cc6c9 (QA 30da4a3b: inline reason + Enter keeps the draft, settled gate, account copy) → fixed-verified 16:25 on session "привет" (Choose model): typing shows `composer-send-blocked-reason` "Selected model is unavailable — choose a model."; Enter keeps 1 paragraph (no newline) and announces the reason; draft cleared afterwards → reviewer: Enter scoped-send branch hardening, spec drift, E2E for UMS-01/02 → follow-up with the fixer; moved out of pack 3 into a composer PR together with ISSUE-035 → 2026-10-22 PR osben/ZCode#291 (open)

### ISSUE-027 · S3 · renderer · fixed-unverified

Scenario: CP-02 · Found: 2026-10-22 11:58 · Build: 1e6737a5
Repro: open a session and hover composer toolbar controls; read `agent-browser console`.
Expected: no React warnings.
Actual: repeated `Tooltip is changing from uncontrolled to controlled` / `from controlled to uncontrolled` warnings.
Evidence: `agent-browser console` output of the dry run.
Root cause: confirmed (code) — Radix `react-use-controllable-state` warns on every `open` undefined↔boolean flip: `ControlHintTooltip` callers passed `open={x ? false : undefined}` (V4ComposerIncognitoControl, V4ComposerModeControls, V4ExternalAgentConfigControls, ModelConfigSelect) and `TaskListItem` passed `open={hoverEnabled ? undefined : false}`.
Fix: pack 7 osben/ZCode#292 (open): `ControlHintTooltip` owns the uncontrolled state and always passes a boolean; the task row Tooltip (no content) gets a constant `open={false}`; tests `controlHintTooltipOpenFlip.test.ts`, `taskListItemHoverActions.test.ts`.
Verify: open an existing session; hover and then focus (Tab) each of: `v4-composer-incognito-trigger`, `chat-mode-select-trigger`, `chat-model-select-trigger`, the external-agent config control when an ACP agent is selected; open and close the mode menu while its hint is showing; hover two sidebar task rows (`li[data-testid^=task-item-]`). `agent-browser console` shows no "changing from uncontrolled to controlled" / "controlled to uncontrolled" warning; hints still appear on hover/focus.
History: 2026-10-22 open (dry run). → 2026-10-22 fixed in pack 7 #292 (unit-tested, not re-checked live)
