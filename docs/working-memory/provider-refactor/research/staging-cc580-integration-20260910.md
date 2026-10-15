# staging cc580ba72a Merge Record

## Baseline and Scope

- Pre-merge local: `cf6777b82d`, branch `provider-schema-refinement-20260910`, workspace clean.
- This fetch pins staging: `cc580ba72a`, 17 upstream commits total (9 non-merge), incrementally involving 49 files.
- Normal `merge --no-ff` preserves both-side commits, no file-level ours/theirs, no automatic pushes; does not execute pending Todo105–113.

## Feature Rulings and Conflicts

| Upstream Source                          | Behavior and Handling                                                                                                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `758fc8568c`, `da708b7d4a`, `8108d4e4db` | Retain Account unavailability reason classification, shared strict schemas, retry when two personal plans lack Keys. Reasons are runtime; Host is owner; UIs use common results, do not re-query entitlements, do not treat missing Keys as OAuth failures. |
| `2e26360bc9`                             | Retain BigModel embedded website's existing zcode JWT injection supplements, without changing login/authentication systems.                                                                                                                                 |
| `0fedd3c4a2`                             | Retain Adapter's same-service Coding Plan historical identity replay compatibility; only affects request-local thinking projections, does not map current selections or change historical identities.                                                       |
| `0aa4cc61ae`                             | Retain Runtime's PDF port passthrough; does not restore old model connection interfaces.                                                                                                                                                                    |
| `f5a802f929`                             | Retain share component defaults and callback reference stabilization, Session ownership unchanged.                                                                                                                                                          |
| `7ef23cfad3`, `12cddd0f87`               | Retain pre-push not forcing mise and Feishu notification service modifications; verification still goes through original gates; do not send real notifications, do not adjust external CI credentials.                                                      |

Explicit conflicts only in `steps/steps.md`: retain both-sides new records. Upstream Todo105 and this branch's model-simplified Todo105 share the same number; change upstream account status records to Todo114, update references; historical T105 test cases and evidence paths unchanged.

Implicit intersection: Upstream `runtime-reasoning-provider-replay.test.ts` calls Todo109's deleted `migrateLegacyModelSelection`, with all 16 initial cases reporting TypeErrors. Fix tests according to this branch's formal migration rulings: seed old-format temporary empty databases, cold restart execute 0020; assert migrations retain all old members and reasoning parts, subsequent two request rounds do not rewrite migrated historical rows. No old runtime interfaces restored, no thinking content assertions relaxed.

## Verification and Re-review

- App/Shared configs/Accounts/Notifications/Databases: 11 files, 361 tests passing.
- Share components: 4 files, 48 tests passing.
- CLI Adapters/Runtimes/PDFs/Session migrations/rollback reads: after fixing the above tests, 6 files, 101 tests passing.
- Total 21 files, 510 tests passing; root `pnpm typecheck`, Agent adapters/core individual `tsc --noEmit` passing.
- `pnpm lint`: 0 errors / 41 warnings; architecture check 0 violations / 0 baselines / 0 new; modified test format checks and diff whitespace checks passing.
- Upstream new behaviors each have retention destinations; this branch's migrations, historical value protections, normal reads no longer supplement migrations, request-local compatibilities, Account fact synchronizations, and other boundaries did not restore old implementations. Auto-merged design documents preserve both-side clauses.
- Reviewed using architecture-governance and React best-practices; modules currently all unmanaged, no new owners or cross-layer IO added.
- This round does not re-run Pro, complete Electron, real phones/SSH, or official model network verification; uses upstream-recorded component browser evidence, does not count it toward these 510 cases, and does not claim full-end full-regression passing.

## Delivery

Forms dual-parent merge commits, all staging commits entering current branches; only additionally fixes merge test wiring and document numbers/records. Does not push remotes, does not change real user data.
