# Todo85: Restore Functionality After Reverting the Staging Merge and Audit Each Item

> Verification ownership update (2026-09-09): remaining untested/failed/manual-promotion items were transferred to [Todo102](todo-102-verification-debt-closeout.md), closing this document's separate verification schedule. Historical evidence remains; transfer does not mean tests passed. The old deferred clause for explicit Subagent behavior was superseded by the Todo99 implementation. The Off-Peak Ticket exception and the boundary against adding pre-send synchronization remain unchanged.

> Status: restoration and item-by-item audit completed on 2026-09-07. See the restoration audit table for delivery evidence and explicit exclusions.
>
> Starting point: `a43049c265`, branch `provider-refactor-e2e-recovery`, including earlier restoration work and uncommitted changes from other tasks.
>
> Latest progress: all 65 files and related manual interventions have an owner and disposition. Claim/account, navigation, MCP, CUA, Hook, attachments and Goal restorations were committed. D02/Todo87 is wired into the shared layer, Composer, Automation, Bot, Wiki and off-peak read-only protection. D01 is explicitly not restored; explicit Subagent auto-correlation and cross-account/Ticket migration for off-peak are explicitly excluded. The latest four Air retest groups passed 12/12. Other checks and untested real-environment combinations are recorded honestly; this is not a full-product regression.

## Goal and scope

Trace the reverts and manual handling from that staging merge and restore correct behavior that was discarded without a decision. Keep staging behavior by default; adapt it or propose a decision only where it conflicts with the current Provider architecture or explicitly changed product semantics. The user is not asked to decide every technical adaptation.

- Staging at the time: `16d999f6a48b180b691a4d909479c063580d2ad0`.
- Merge `aaa68edbca`: first parent `88fdfc34e0` was the then-current branch; second parent was the staging revision above (do not reverse the parents).
- Merge revert `7016d1e09a` (50 files); mixed plugin commit `b9118cc192`, its revert `cb16b3c8fd`, follow-up UI `2ee9b8d0c6`; manual handling `0ed79bae57` (`SessionPane`) and related patches. Other similar conflict handling is searched for and any expanded scope is recorded with its source.
- Out of scope: staging changes after the fixed baseline, executing Todo80, rewriting the whole Provider/Session architecture.

A commit in ancestry does not prove a feature was retained and a revert does not prove it is still missing: every item is traced through current code and follow-up patches.

## Method

```text
revert/manual-handling patches -> group by original feature -> inspect intent and call chain
  -> trace later restoration -> compare with current implementation
  -> fully retained / equivalent implementation / to restore / decision required
  -> write spec, restore tests, adapt code -> verify -> reverse-audit -> update record
```

Detailed records live only in the [restoration and decision table](../plan/staging-conflict-restoration-audit.md) (original commit, revert location, original behavior, current result, reason, code locations, test results, next step, plus a per-file index so every file in the revert patches has a feature owner and disposition).

1. Build the complete inventory by auditing the reverts and manual changes first, not the full diff between two branches.
2. Complete direct-retention items first, restoring the whole upstream/downstream flow by feature and transplanting only the relevant behavior from mixed files; compare before touching files changed by other tasks.
3. Adapt to the current architecture: preserve ModelSelection, target Host Registry, Account State/Overlay, sparse config and the established migration boundaries; do not restore the old Provider Store, old Runtime Config or account-first automatic model selection.
4. For items needing a decision, record the exact user behavior, the conflict with current rules, options and a recommendation, and pause that item while continuing independent work. Latest decision (2026-09-07): D01 does not restore pre-send remote synchronization; D02 was implemented by [Todo87](./todo-87-selection-view-unified-resolution.md) and the old switching helper is not restored. No unresolved product blockers.
5. Verify and review: focused tests that show the original issue, then typecheck/lint; interactions verified in a dedicated MacBook Air E2E worktree with build version and results recorded; keep Desktop continuous / Web replayable and `workspaceIdentity` isolation; "code exists" or "typecheck passes" is not E2E success.
6. Commit by feature, only verified changes of this task, preserving others' work, with an actual Agent-session trailer; do not mark complete if verification fails.

## Completion criteria

- Every located file affected by a revert/manual change has a disposition and every feature an evidence-based conclusion.
- All understood, actionable gaps are addressed with restoration tests and an overall review recorded.
- Unresolved items are analyzed enough for the user to choose among concrete options.
- Environment blocks are recorded separately from real test failures; the final report names items not restored, needing a decision or still requiring verification.
- "All staging commits are in history" or "only unit tests ran" does not count as successful restoration.
