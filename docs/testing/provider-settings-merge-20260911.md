# Provider Stabilization Branch Merge Record (2026-09-11)

Full history: `git show b8876e8b:docs/testing/provider-settings-merge-20260911.md`

## Outcome

- The current branch was renamed `codex/provider-stabilization-20260911` (from `codex/provider-schema-refinement-20260910`, baseline `cd81a0fc08`), tracking of the old remote branch was removed, and it was not pushed.
- Merged the local target branch `codex/provider-settings-todos` at the fixed commit `9469388004` as a normal two-parent merge (14 / 77 unique commits), with no explicit conflicts, no whole-file ours/theirs, and no redo of independent upstream features. The target included staging up to `7a01923f58`.

## Intersection decisions

- Overlap files: `model-execution.ts` and the zh/en locale files.
- Request security validation: keep the manual-Key validation admission of the two official plan URLs and also wire in the target's validation observation, feature-gate logging and attempt observation chain. Official URL rules still go through the original security validation and are not intercepted by the unvalidated observation branch of access-mode.
- API Key entry: keep a single `apiKeyManagementUrl`; the team-only field and the two-button copy are not restored (the old field remains only in test assertions that reject it).
- Settings layout: keep the target's whole-page scroll and feedback positioning, do not restore the deleted ScrollEdgeShadowViewport; this branch's card and API Key entry changes are kept.
- All Todos from both sides are kept as whole files, never overwritten by number nor treated as implemented.

## Verification (at merge time)

Root `pnpm typecheck` passed; adapter `pnpm typecheck` passed after rebuilding the current Contracts (stale dist lacked the new validation-observation types); `pnpm lint` 0 errors / 41 warnings; `pnpm architecture:check --changed` passed with 0 new violations; targeted root tests (7 files, 87 tests), the Agent standalone manual-coding-plan-signing tests (18; not covered by the root config) and the model-row edit / template picker / API Key link component tests (3 files, 55) passed. No Pro/Air real-machine, mobile remote or full-product E2E was run, so the merge check is not the full acceptance of the related Todos. `git diff --cached --check` flagged trailing blank lines in two Document Skills files and trailing spaces in a decision template, all from the fixed target and not changed here.

## Todo renumbering

Both sides had duplicate Todo115-Todo122. By user request the original branch's numbers stay and the merged branch's eight items moved to Todo125-Todo132 (file names, titles, directories and cross references updated):

| Merged branch original | Current | Topic |
| --- | --- | --- |
| Todo115 | Todo125 | Model settings page question-mark help and final copy |
| Todo116 | Todo126 | GLM-5.3-Flash PDF and Coding Plan API Turbo default config |
| Todo117 | Todo127 | Built-in config online publish and update chain fix |
| Todo118 | Todo128 | Provider startup contract and off-peak entitlement refresh fix |
| Todo119 | Todo129 | Provider telemetry adaptation and Team plan recognition fix |
| Todo120 | Todo130 | Smart config switch and manual config field boundary correction |
| Todo121 | Todo131 | Smart config position in the model settings page and the "Restore" button |
| Todo122 | Todo132 | Model option background feedback and provider name edit fix |

Original-branch Todo115-Todo124 are unchanged. Only document identities were tidied; requirements and implementation status are unchanged, and existing case-tracking IDs such as M120 / R121 / T119 stay stable. This record does not promise to fix the recorded Provider, migration, Subagent, capacity or connection-test problems, nor to implement the todos newly added by the target branch.
