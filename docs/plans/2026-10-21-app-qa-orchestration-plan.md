# 2026-10-21 App QA + stabilization orchestration plan (round 1)

Full history: `git show b8876e8b:docs/plans/2026-10-21-app-qa-orchestration-plan.md`

Owner: orchestrator session on branch `claude/app-testing-optimization-c63859` (base `integration`).
Window: ~8 hours. This plan is round 1; round 2 replaced it (`2026-10-22-app-qa-round-2-plan.md`).

## Goals

1. The desktop app runs without freezes, every visible control works and shows correct data.
2. No regressions: every fix pack passes `pnpm typecheck`, `pnpm lint`, affected unit tests, and a manual smoke pass.
3. Fix packs ship as PRs against `integration`, each reviewed by an independent reviewer agent before being marked ready.
4. `integration` is merged into the working branch periodically (every ~2 h, and before each PR).
5. Unimplemented specs in `specs/` are implemented when they are self-contained and low-regression-risk.

## Ground rules

- Spec first: behavior changes update or add the matching `specs/*.md` before code.
- One writer per file set: parallel sub-agents never share files.
- Every delegated fix comes back as a diff that the orchestrator verifies (typecheck, lint, tests, manual check in the running app).
- Fork constraints: no upstream migration edits, `fork_` prefixes, no new `setting.json` keys, `pnpm fmt:check` scope only.
- The dev app runs isolated from the installed ZCode.app: `ZCODE_DATA_BASE_DIR=$HOME/.zcode-dev-home` (separate tasks index + CLI db, shared `~/.zcode/v2/setting.json` for provider config).

## Phase 0 - Baseline (parallel)

| Step | What                                                                                                                                      | Done when                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 0.1  | `pnpm typecheck`, `pnpm lint` on the clean branch                                                                                         | Real pass/fail recorded as the baseline (pre-existing failures listed, not hidden) |
| 0.2  | `pnpm test:unit` baseline                                                                                                                 | Failing files listed                                                               |
| 0.3  | Build CLI + start dev desktop (`pnpm dev:desktop`) with isolated data dir                                                                 | Window up, CDP on :9229 reachable via `agent-browser connect 9229`                 |
| 0.4  | Explore agent: audit `specs/` for specs whose acceptance scenarios are not implemented                                                    | Ranked list: spec, gap, risk, size                                                 |
| 0.5  | Explore agent: freeze-risk audit (sync IO in main/host/renderer hot paths, unbounded loops, missing `await`, heavy work on render thread) | Ranked list with file:line                                                         |

## Phase 1 - Manual smoke (running dev app, via CDP)

Scenario matrix (each scenario: perform, screenshot, check console + main log, note freezes > 1 s):

1. Cold open: onboarding -> "Use API key" / skip -> workspace shell renders; sidebar, composer, settings reachable.
2. Session start variants:
   - a. New task inside a project (default cwd).
   - b. New task outside any project ("+" in task area).
   - c. New task with worktree destination (composer destination control, worktree setup steps).
   - d. New task with branch switch (composer branch switcher).
   - e. Resume an existing session; resume after app restart.
   - f. Fork / child conversation; subagent inline usage display.
   - g. Incognito session (spec `incognito-session.md`).
   - h. Deep link `zcode://` new task (spec `deeplink-new-task.md`).
3. In-session: send message, stop mid-stream, resume after error (`chat-error-resume.md`), queue input while busy, draft persistence across navigation (`ui-draft-send-path.md`).
4. Sidebar: rename, pin, archive, unread, delete (cascade), filters, grouped view, PR status badge, child counts, hover card, merged highlight.
5. Review tab: diff listing, directory grouping, change summary tree view, commit from detached HEAD warning.
6. Terminal tab: cwd follows worktree (`terminal-worktree-working-directory.md`).
7. Settings: every page renders, theme + font family switch, locale switch (uk-UA parity), system prompt settings, resource telemetry toggle, memory viewer v2.
8. Manage sessions table, archive bulk actions, worktree delete-anyway ack.
9. Window actions: multiple windows, quit confirmation with running sessions, update flow dialogs.

Output: `docs/plans/2026-10-21-qa-findings.md` with ISSUE-NNN entries (repro, evidence, severity, owner agent).

## Phase 2 - Triage + delegate

- Severity: S1 freeze/crash/data loss -> fix immediately; S2 wrong data / broken control; S3 UX / polish.
- Each issue goes to one sub-agent (`Agent` tool, or `glm5-task` for mechanical work) with a self-contained brief: spec update, failing test first, fix, run checks. Disjoint file sets.
- The orchestrator verifies each result in the running app before accepting.

## Phase 3 - Fix pack PRs

- A pack is 3-8 related commits on a branch off the current working branch. Open the PR against `integration` (stacked on the previous unmerged pack if any).
- Reviewer agent (fresh context, no hypothesis given) reads the diff and reports findings; the orchestrator fixes or rejects each with a reason; re-review until clean.
- Pre-PR gate: `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm architecture:check --changed`, affected unit tests, smoke re-check of touched flows.
- Merge is the user's call unless they say otherwise; PRs are left ready with a review summary.

## Phase 4 - Progressive improvements

Candidates (3.16.1 sync audit + spec audit 0.4), executed only after Phase 1 S1/S2 are clear:

- uk-UA `project.createTask` untranslated string.
- knip: 8 dead `node.ts` re-exports.
- `IUserInstructionsService` missing on the server remote path.
- `archivedTaskDeletion.ts` + `archives.delete*` i18n keys orphaned.
- Spec gaps ranked by 0.4.
- Perf: cold-open timing, session list render cost with 500+ tasks, stream throughput (`session-token-throughput.md`).

## Phase 5 - Upstream sync cadence

- Every ~2 h and before each PR: `git fetch origin && git merge origin/integration` into the working branch; rerun typecheck + lint + affected tests; re-smoke.
- The memory note is updated with what landed and what is pending.

## Re-plan trigger

When the Phase 1 matrix is fully exercised and every S1/S2 is fixed or delegated, write the round-2 plan:
remaining S3s, next spec batch, perf work.
