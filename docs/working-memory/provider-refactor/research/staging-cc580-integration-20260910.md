# staging cc580ba72a Merge Record

> Full history: `git show 45f808f7:docs/working-memory/provider-refactor/research/staging-cc580-integration-20260910.md`

## Baseline and Scope

- Pre-merge local: `cf6777b82d`, branch `provider-schema-refinement-20260910`, workspace clean.
- This fetch pinned staging at `cc580ba72a`: 17 upstream commits (9 non-merge), incrementally touching 49 files.
- Normal `merge --no-ff` preserving both-side commits; no file-level ours/theirs; no automatic pushes; pending Todo105–113 not executed.

## Feature Rulings and Conflicts

| Upstream Source                          | Behavior and Handling                                                                                                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `758fc8568c`, `da708b7d4a`, `8108d4e4db` | Retain Account unavailability reason classification, shared strict schemas, retry when two personal plans lack Keys. Reasons are runtime; Host is owner; UIs use common results, do not re-query entitlements, do not treat missing Keys as OAuth failures. |
| `2e26360bc9`                             | Retain BigModel embedded website's existing zcode JWT injection supplements, without changing login/authentication systems.                                                                                                                                 |
| `0fedd3c4a2`                             | Retain Adapter's same-service Coding Plan historical identity replay compatibility; only affects request-local thinking projections, does not map current selections or change historical identities.                                                       |
| `0aa4cc61ae`                             | Retain Runtime's PDF port passthrough; does not restore old model connection interfaces.                                                                                                                                                                    |
| `f5a802f929`                             | Retain share component defaults and callback reference stabilization, Session ownership unchanged.                                                                                                                                                          |
| `7ef23cfad3`, `12cddd0f87`               | Retain pre-push not forcing mise and Feishu notification service modifications; verification still goes through original gates; do not send real notifications, do not adjust external CI credentials.                                                      |

Explicit conflict only in `steps/steps.md`: retained both-side records. Upstream Todo105 and this branch's model-simplified Todo105 share a number; upstream account status records were renumbered to Todo114 with references updated; historical T105 test cases and evidence paths unchanged.

Implicit intersection: upstream `runtime-reasoning-provider-replay.test.ts` called Todo109's deleted `migrateLegacyModelSelection`, all 16 initial cases erroring. Tests fixed per this branch's formal migration rulings: seed an old-format temporary empty database, cold restart executes 0020; assert migrations retain all old members and reasoning parts and that two subsequent request rounds do not rewrite migrated historical rows. No old runtime interfaces restored; no thinking content assertions relaxed.

## Verification and Re-review

- App/Shared configs/Accounts/Notifications/Databases: 11 files, 361 tests passing. Share components: 4 files, 48 tests. CLI Adapters/Runtimes/PDFs/Session migrations/rollback reads: 6 files, 101 tests after the fix above. Total 21 files, 510 tests passing; root `pnpm typecheck` and Agent adapters/core individual `tsc --noEmit` passing.
- `pnpm lint`: 0 errors / 41 warnings; architecture check 0 violations / 0 baselines / 0 new; modified test format checks and diff whitespace checks passing.
- Upstream new behaviors each have retention destinations; this branch's migrations, historical value protections, normal reads no longer supplementing migrations, request-local compatibilities, and Account fact synchronizations did not restore old implementations. Auto-merged design documents preserve both-side clauses.
- Reviewed with architecture-governance and React best-practices; modules currently unmanaged, no new owners or cross-layer IO added.
- This round did not re-run Pro, complete Electron, real phones/SSH, or official model network verification; upstream-recorded component browser evidence is used and not counted toward the 510 cases. Do not claim full-end full-regression passing.

## Delivery

Dual-parent merge commits; all staging commits entered the current branch; only merge test wiring and document numbers/records additionally fixed. No remotes pushed, no real user data changed.
