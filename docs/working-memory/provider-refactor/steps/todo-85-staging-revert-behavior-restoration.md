# Todo85: Restore Functionality After Reverting the Staging Merge and Audit Each Item

> Verification ownership update (2026-09-09): remaining untested/failed/manual-promotion items from this document were transferred to [Todo102](todo-102-verification-debt-closeout.md), closing this document's separate verification schedule. Historical evidence remains; transfer does not mean tests passed. The old deferred clause for explicit Subagent behavior was superseded by Todo99 implementation. The Off-Peak Ticket exception and the boundary against adding pre-send synchronization remain unchanged.

> Status: restoration and item-by-item audit completed on 2026-09-07. See the restoration audit table for delivery evidence and explicit exclusions.
> Starting point: `a43049c265`, branch `provider-refactor-e2e-recovery`, including earlier restoration work and uncommitted changes from other tasks.
> Latest progress: all 65 files and related manual interventions have an owner and disposition. Claim/account, navigation, MCP, CUA, Hook, attachments, and Goal restorations were committed. D02/Todo87 is wired into the shared layer, Composer, Automation, Bot, Wiki, and off-peak read-only protection. D01 is explicitly not restored; explicit Subagent auto-correlation and cross-account/Ticket migration for off-peak are explicitly excluded. The latest four Air retest groups passed 12/12. Other checks and untested real-environment combinations are recorded honestly; this is not a full-product regression.

## Goal and Scope

Trace the reverts and manual handling from that staging merge and restore correct behavior that was discarded without a decision. Keep staging behavior by default; adapt it or propose a decision only where it conflicts with the current Provider architecture or explicitly changed product semantics. Do not make the user decide every technical adaptation.

- Staging at the time: `16d999f6a48b180b691a4d909479c063580d2ad0`.
- Merge `aaa68edbca`: first parent `88fdfc34e0` was the current branch at the time; second parent was the staging revision above. Do not reverse the parents or treat the first parent as staging.
- Merge revert `7016d1e09a`, involving 50 files.
- Mixed plugin commit `b9118cc192`, its revert `cb16b3c8fd`, and follow-up UI `2ee9b8d0c6`.
- Manual handling `0ed79bae57` (`SessionPane`) and related patches; search history for other similar conflict handling and record the source of any expanded scope.
- Do not merge staging changes introduced after the fixed baseline, execute Todo80, or use this task to rewrite the entire Provider/Session architecture.

A commit's presence in ancestry does not prove a feature was retained; a revert does not prove the feature is still missing. Trace every item through current code and follow-up patches.

## Execution and Records

```text
revert/manual-handling patches -> group by original feature -> inspect intent and call chain
  -> trace later restoration -> compare with current implementation
  -> fully retained / equivalent implementation / to restore / decision required
  -> write spec, restore tests, adapt code -> verify -> reverse-audit -> update record
```

Record detailed work only in the [restoration and decision table](../plan/staging-conflict-restoration-audit.md) to avoid conflicting duplicate conclusions. For each group, record original commit, revert location, original behavior, current result, reason for the decision, code locations, test results, and next step. Add a per-file index so every file in revert patches has a feature owner and disposition.

1. Build the complete inventory. Audit both reverts and manual changes first; do not misrepresent the full diff between two branches as the incident scope.
2. Complete direct-retention items first. Restore the complete upstream/downstream flow by feature; transplant only relevant behavior from mixed files. For files changed by other tasks, compare first and do not overwrite parallel work.
3. Adapt to current architecture. Preserve ModelSelection, target Host Registry, Account State/Overlay, sparse config, and established migration boundaries. Do not restore the old Provider Store, old Runtime Config, or account-first automatic model selection.
4. For items requiring a decision, record the exact user behavior, conflict with current rules, options, and recommendation; pause that item while continuing independent work. Latest decision on 2026-09-07: D01 does not restore pre-send remote synchronization; D02 was implemented by [Todo87](./todo-87-selection-view-unified-resolution.md), and the old switching helper is not restored. There are no unresolved product blockers.
5. Verify and review. Start with focused tests that demonstrate the original issue, then run typecheck/lint. Verify interactions in a dedicated MacBook Air E2E worktree and record build version/results. Preserve Desktop continuous / Web replayable and `workspaceIdentity` isolation. Do not report “code exists” or “typecheck passes” as real E2E success.
6. Commit by feature. Commit only verified changes in this task and preserve others' work. Do not mark complete if verification fails. Add an actual Agent-session trailer to each commit.

## Completion Criteria

- Every located file affected by a revert/manual change has a disposition. Every feature has an evidence-based conclusion rather than a generic “needs checking.”
- All identified gaps that are understood and actionable are addressed, with restoration tests and an overall review recorded.
- Unresolved items are analyzed enough for the user to choose among concrete options; do not leave technical investigation for the user.
- Record environment blocks separately from actual test failures; do not claim completion. The final report identifies items not restored, needing a decision, or still requiring verification.
- Do not count “all staging commits are in history” or “only unit tests ran” as successful restoration.
