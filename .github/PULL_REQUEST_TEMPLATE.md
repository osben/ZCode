<!--
Title: <type>(<scope>): <summary> — type is feat / fix / refactor / perf / test / docs / chore / ci / build.
Delete any section that does not apply, but keep "Verification".
-->

## What

<!-- What changed and why, in plain words. One goal per PR. -->

Spec: `specs/…` <!-- required for behavior changes (AGENTS.md); "none: <reason>" otherwise -->

## Not changed

<!-- What was deliberately left out or deferred, and why. -->

## Risk checks

- [ ] Shared databases: no upstream migration ids, order, DDL or SQL touched; new tables/columns use `fork_`; no new `setting.json` keys.
- [ ] Upstream-owned files: edits kept minimal; fork logic in fork-owned files where possible.
- [ ] Remote control: desktop `desktop-continuous` and mobile `web-remote-replayable` both considered, or not affected.
- [ ] Workspace identity: keys use `workspaceIdentity?.trim() || workspacePath`, never the path alone.
- [ ] UI: follows `DESIGN.md`, desktop and mobile Web, both themes, i18n; screenshots below. Or no UI change.

## Verification

<!-- Real commands and results, not "tested". Say what was not run and why. -->

- `pnpm typecheck`:
- `pnpm lint`:
- `pnpm fmt:check`:
- `pnpm architecture:check --changed`:
- Tests (package, files, pass/fail; do new tests fail without the fix?):
- Not run:
