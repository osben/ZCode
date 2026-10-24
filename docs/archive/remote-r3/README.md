# R3 remote main chain process document archive

Archived 2026-09-13; process text compressed 2026-10-10. These documents record the drafts, reviews, implementation plans and live-test process of the R3 Source Server remote main chain. Their content has been replaced by or merged into the current fact documents; keep them as historical background only, never as an implementation basis. Current reading entry: [`docs/remote/README.md`](../../remote/README.md).

| File | Archive reason |
| --- | --- |
| `r3-remote-ui-prototype-gap-audit.md` | §8 implementation contract merged into main spec §8.4; the rest is a per-screen prototype gap audit and twelve review rounds |
| `r3-remote-ui-prototype-gap-audit-review.md` | Review record of the audit above |
| `r3-remote-ui-implementation.md` | Implementation record; its "default download mode for new routes" entry contradicts the code (that preference was revoked on 2026-08-28); main spec §8.4.4 and the ux-spec prevail |
| `r3-provider-refactor-merge.md` | Provider refactor merge process; its §7 leftovers merged into main spec §15 |
| `r3-controller-remote-row-migration-inventory.md` | Per-table inventory merged into main spec §9.1 |
| `r3-source-server-remote-impact-brief.md` | Pre-implementation impact brief |
| `r3-source-server-remote-implementation-review.md` | Implementation review record |
| `r3-source-server-remote-completion-plan.md` | Completion plan; product-surface gaps were closed by implementation or moved to the issue ledger |
| `r3-source-server-remote-completion-review.md` | Review record of the completion plan |
| `remote-domain-simplification-and-conversation-workspace-spec-review.md` | Review record of the domain simplification spec |
| `r3-source-server-release-test-plan.md` | Old release test plan; the R3-REMOTE-xx IDs live in `conversation-session-case-catalog.md` and the execution plan is `testing/r3-remote-automation-plan.md` |
| `r3-remote-automation-readiness-2026-09-07.md` | Automation readiness record |
| `r3-remote-environment-readiness-2026-09-08.md` | Environment readiness record |
| `r3-remote-automation-live-run-2026-09-08.md` | First live-run ledger; later full results are in `testing/r3-remote-full-rerun-2026-09-10.md` |
| `r3-remote-full-validation-2026-09-08.md` | Early full validation record, replaced by the 2026-09-10 re-run |
| `r3-source-server-ssh-live-test-record-2026-08-20.md` | Live record whose baseline commit is not an ancestor of the current HEAD (ledger R3-ISSUE-020) |
| `r3-source-server-expanded-live-test-record-2026-08-21.md` | Same as above |
| `ssh-project-entry-helper.md` | Merged into "SSH project entry orchestration" of `testing/ssh-remote-p0-e2e-plan.md` |

## Original evidence and how to read it

Each original file keeps a historical entry. The full text is frozen in commit `a17a875588b8d66c2bee49236292e174df651363`; read it with `git show <commit>:<path>` from the entry, and take all historical sections and line numbers from that snapshot. The commit is a documentation snapshot, not the common product baseline of these live runs. Reading it needs the original repository history; with a shallow clone or an exported copy missing the objects, report the evidence as unavailable and never infer a pass from the entry. Open items in old reviews are checked one by one against the current issue ledger and are not closed by the compressed text.

| Evidence | Interpretation boundary to keep |
| --- | --- |
| 2026-08-20/21 SSH live runs | The baseline is not an ancestor of the current branch and cannot prove the current HEAD; R3-ISSUE-020 stays To verify. Original environment, artifact paths, passes and blockers are in the snapshots. |
| 2026-09-08 first validation | Product baseline `2af3a51991`; the original three SSH E2E ran 0/3, and later representative passes do not mean the whole suite passes. Original artifact root: `packages/desktop/.e2e-artifacts/r3-20260907-155200/`. |
| Environment readiness / early full run | Connection, login and pairing probes prove only preconditions; historical FAIL, BLOCKED and cleanup records stay in the original snapshots and are not turned into a current PASS. |
| Provider merge decision | Local editing with automatic Provisioning; the current contract is [Provider Provisioning](../../remote/provider-provisioning.md), leftovers in main spec §15. |
| Old release plan and reviews | Stable case IDs moved to the case catalog; execution requirements are in the current test plan. Historical comments are not new implementation authorization. |

Current verification entries: the [test plan](../../testing/r3-remote-automation-plan.md), the [historical 2026-09-10 re-run](../../testing/r3-remote-full-rerun-2026-09-10.md) and the [October desktop SSH guide regression](../../testing/desktop-ssh-guide-regression.md). Each report keeps its own baseline, scope and unverified items; PASSes on different baselines do not add up to a current full pass. Raw logs and recordings were not moved or deleted in this cleanup.
