# BUG-GWT-011: a conflicted (UU) file row in the Review pane has no "Conflicted" badge; i18n keys `git.section.conflicted` / `git.kind.conflicted` are unused

- Status: FIXED (fix wave 2, 2026-10-18: unit + live confirmed in RT2; marker removed)
- Severity: S4 (cosmetic/informational: the only hint in the collapsed row is an uninformative `+0−0`; the diff with conflict markers and the functional branch-mutation guards work)
- Cases: A8 (PASS with defect observation)
- Environment: macOS 27.2 (darwin, arm64), commit `bd6a05b3` (branch `qa/git-worktree-20261017`), isolated QA instance (production build, sandbox HOME)

## Repro

1. Fixture R10 `merge-conflict` (`make-fixtures.sh R10`): `main` and `feature/a` change one line of `src/lib.txt`; `git merge feature/a` leaves the conflict unresolved. Ground truth: `u UU src/lib.txt` in `git status --porcelain=v2`.
2. Open `$QA_ROOT/repos/merge-conflict` as a project in the QA app, Review pane (source "Not staged").
3. The row `src / lib.txt +0 −0` shows no status: icon+path, `+0 −0`, chevron; no "Conflicted" text as a badge or section header.
4. Expanding the row shows a correct `diff --cc` with `<<<<<<< HEAD` / `=======` / `>>>>>>>` markers: the conflict data reaches the UI, only the row marking is lost.

## Expected

- `docs/git/requirements.md` §4.1 (File List): "Non `Not staged` items can display status badge, e.g. `Untracked`, `Conflicted`, `Staged`".
- `docs/git/requirements-review.md` (Requirement List): "Non `Not staged` items can display status badge", Completed / Accepted, includes `Staged` / `Untracked` / `Conflicted` / `Branch comparison`.
- Translations already exist: `git.section.conflicted` / `git.kind.conflicted` = "Conflicted" (en-US), «Конфлікти»/«Конфлікт» (uk-UA), "冲突" (zh-CN).

## Actual

- The Review pane (Unstaged) renders the conflicted file as a plain row (icon, path, `+0 −0`, chevron): no badge, no Conflicted section header.
- `rg "git.section.conflicted|git.kind.conflicted"` over `packages/ apps/ scripts/` outside locale files found 0 product references: the keys were dead.
- Functionally conflicts are handled: branch switch/create is blocked by the service guard `conflicts-present` (`gitCliRepo.ts:1643`, toast "Repository still has unresolved conflicts."), and the diff shows markers.

## Cause (confirmed; data chain intact, badge lost in presentation)

- `gitCliHelpers.ts:468-477`: porcelain v2 `u ` records (XY=UU) parse with `isConflicted: true`.
- `gitService.ts:82-84`: unmerged entries become `GitFileChange` with `section: "conflicted"` and `isConflicted: true` (`gitService.ts:46`).
- `useGitRepository.ts:85`: `SECTION_ORDER_BY_SOURCE.unstaged = ["unstaged", "untracked", "conflicted"]`; `buildSectionsForSource` (240-268) groups changes into a `conflicted` section.
- Loss point 1, `GitPane.tsx:117-120`: `currentChanges = currentDataset.sections.flatMap((section) => section.changes)` drops the section id; rows are `{ kind: "file", change }` or directory rows (`GitPaneDirectoryHeader.tsx` renders the folder name, not the section). The pane has no section headers.
- Loss point 2 (the buggy row component), `GitPaneChangeCard.tsx:91-128`: the row header renders only `FileDisplayInline` (icon+path), `+{change.added}/−{change.removed}` and a chevron. `change.section` / `change.isConflicted` (and `isStaged`/`isUntracked`) are never read, so no status badge renders for any kind.
- The keys are defined in all three locales (`en-US.ts:1420,1427`, `uk-UA.ts:1238,1245`, `zh-CN.ts:1323,1330`) but wired nowhere; the only live consumer of `git.kind.*`/`git.section.*` is the workspace file tree (`WorkspaceFileTree.tsx:235-241`), whose status map has no conflicted status.

## Fix direction

Renderer: in `GitPaneChangeCard.tsx` render a status badge from `change.section`/`change.isConflicted` using `intl.formatMessage({ id: "git.kind.conflicted" })` (or `git.section.conflicted`); this also covers Staged/Untracked/Branch comparison from the same spec line. Section headers would additionally need the section id carried through the `GitPane.tsx:117-125` flatten (not required for the row badge). After the fix remove the `it.fails` marker and delete a duplicated dead key if one remains.

## Test

`packages/ui/test/reviewConflictedBadge.test.ts`: unit test of the Review pane row `GitPaneChangeCard` (jsdom + @testing-library/react; a `GitPaneFileChange` object as the service returns it for porcelain `UU`; no sleeps, independent of `$QA_ROOT`). Name: `BUG-GWT-011: renders the Conflicted badge on a UU (unmerged) file row`; asserts `screen.getByText("Conflicted")` after confirming the row (`lib.txt`, `+0`, `-0`) renders. Was `it.fails`; marker removed after the fix.
