# Todo 103: Fixed Staging Merge, Bidirectional Behavior Audit and Delivery

> Status: In progress (2026-09-09). Integration branch `staging-integration-20260909`; target branch
> `provider-refactor-e2e-recovery`. Not merged back without final acceptance; no automatic push. This document holds the
> user-approved Goal; progress updates do not replace the completion conditions.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-103-staging-safe-integration.md`

## Push Authorization and Manual Acceptance Handoff (2026-09-10)

- The user authorized pushing the current candidate to `provider-refactor-m2` and `provider-refactor-e2e-recovery`;
  Windows real-installer acceptance and isolated real-SSH acceptance are done by the user. This authorization overrides
  the historical "no merge back, no push" delivery limit until those two acceptances finish. It does not mean they
  passed or that all Todo103 completion conditions are met; Todo104's other packaging-verification limits remain.
- Before pushing, staging was still `790884b1ce`, an ancestor of candidate `0ff7445a1a` (merge returned
  `Already up to date`); both push targets were ancestors of the candidate, so a normal fast-forward push was used.
- Push of `982835a57b` (atomic, both branches) was rejected by pre-push; neither remote updated. Lint 43 warnings /
  0 errors, architecture check 0 violations; the affected check fell back to the full unit run because of source
  deletions: 1637 files passed / 10 failed / 2 skipped, 14372 tests passed / 22 failed / 26 skipped (Provider name
  display, Bot, Wiki account delivery, old config fixtures), not attributed one by one. Hooks were not bypassed.
- After user-authorized gate repair: `8cfb2f82ce` fixed old test contracts and, via real Facade red tests, found and
  fixed Registry freezing losing names and template metadata. Pro I13 passed; normal pre-push full run 14395 passed /
  26 skipped / 0 failed, lint and architecture check passed. Both remote branches were atomically fast-forwarded to that
  commit without bypassing hooks (attribution in the Todo104 ledger section on the push-gate follow-up batch).
  Windows / isolated SSH acceptance stay with the user; Todo103 is not marked complete.
- Queued request (2026-09-10): independent re-review and test of both sides' expected behavior and the Provider
  refactor core, on the existing real merge candidate (not yet merged into recovery). A few unresolved items stay
  unresolved; new evidence is in ledger §47.

## Goal: Merge Staging Safely, Keep Correct Behavior, Maintain the Refactor Contract

Merge the fixed staging into recovery. Identify and handle explicit conflicts, implicit conflicts from automatic merges,
and new code depending on old interfaces. Two results must both hold: staging's correct behavior is not discarded
without grounds, and our decided architecture, product semantics and persistence boundaries are not broken.

Baselines: recovery `f0174b57f5`, staging `790884b1ce`. Confirm before executing; do not chase later staging commits.

## Boundaries and Precedence

When an architecture/product-semantics conflict has an explicit decision of ours, ours prevails without asking again.

- Non-conflicting staging behavior is kept.
- Behavior that can stay but depends on the old architecture is rewired to the current abstraction.
- Staging behavior that itself violates our decisions: the conflicting part is not restored and the reason recorded;
  other correct behavior in the same commit is handled separately.
- An equivalent implementation already exists: verify coverage, do not stack code.
- Documentation conflicts follow the latest explicit decision, not historical plans or stale comments.
- Deferred drafts such as Todo101 are not implemented; no extension of independent CLI account architecture, no
  rebuild of the sync system; others' changes, real user data and publishing are not touched.

### Supplement (2026-09-09): Fix Scope and Execution Granularity

1. Safe merge, not a repair of both sides' existing bugs: merge-introduced regressions, missed interfaces in new code and
   problems blocking approved behavior are fixed; unrelated existing problems are recorded with reason, evidence, impact.
2. Per-feature decisions, batch implementation and shared acceptance: every source stays traceable to an outcome, but
   small items need not each pass a full acceptance; low-risk changes without architecture intersection are batched;
   build, typecheck, lint and regression runs are shared.
3. Verification effort follows risk: high-risk intersections are verified closely; independent test/environment problems
   suspend only the affected items; checks are repeated only when code, dependencies, environment or claims change.
4. Test failures are attributed first (merge regression / existing product problem / stale test / environment
   prerequisite) with evidence and whether they block retained behavior. A failure is neither auto-expanded into a fix
   task nor written up as existing/passing before it is understood.
5. Delivery standard is unchanged: architecture decisions, per-feature traceable records, bidirectional review and final
   key acceptance stay; key acceptance may not be handed to Todo102 to avoid it.

### Re-decision (2026-09-09): Form a Real Merge Candidate Early

This supersedes the earlier "port every source before merging" order; review scope and final standard are unchanged.

1. Keep existing commits, decisions, implementation and evidence; safely close the in-flight G17 / G06 batch first.
2. Independent changes with no architecture intersection or implicit dependency risk are kept by a normal merge in bulk,
   not re-made as commits or re-developed/re-accepted one by one.
3. Run the real merge of fixed staging on the separate integration branch early; porting/accepting every source is no
   longer a precondition. A conflicted merge worktree is only a candidate, not a completed merge commit.
4. Explicit conflicts, automatic-merge intersections and old-interface dependencies are still checked per feature. Our
   explicit decisions prevail; retained behavior is rewired to the current interface; no whole-file ours/theirs and no
   `merge -s ours`.
5. High-risk intersections are verified closely, low-risk items in batches with shared build and regression; then a
   bidirectional review and cross-group regression of the full candidate. Local passes do not replace overall acceptance.
6. Only merge regressions, missed interfaces and blockers of retained behavior are fixed.
7. The source list records decided, implemented and verified separately; normal-merge retention is a valid implementation
   destination.

The merge candidate is not merged back into recovery without final acceptance and is not pushed automatically. Known
risk: earlier partial ports plus the staging merge may double-apply or auto-merge while changing a shared interface;
handled with fixed baselines, a candidate diff list and per-feature intersection checks, not by re-porting all sources.

## Execution Approach

```text
fix both baselines, create separate integration branch
  -> complete commit/file/feature inventory
  -> close the current modified batch, keep results and evidence
  -> normal merge of fixed staging early to form a full candidate
  -> bulk-keep low-risk independent changes; per-feature check of intersections
       (keep directly / rewire to current abstraction / equivalent exists / exclude per decision / user decision pending)
  -> verify by risk group, review per feature, record, resolve conflicts, commit the real merge
  -> bidirectional review and cross-feature regression of the full candidate
  -> merge back into recovery when acceptance conditions hold
```

Inventory must cover all explicit conflicts (including modify/delete and rename), all automatically merged regions
changed on both sides, single-side new code depending on deleted interfaces, old fields or old state sources, and
cross-file protocol, persistence, config, dependency, build and test contracts. Decisions are per feature, not per file.
Each item records source commit, intent, current implementation, conflict point, decision basis, result, test evidence,
review conclusion and open items; duplicates may be merged but every source must trace to a destination. New findings go
into the same ledger.

Implementation and review:

- Update or write the spec first, then discriminating tests, then implementation, for behavior that is rewired or
  repaired. Independent existing features kept by the normal merge reuse their spec/tests and are verified in risk-based
  batches.
- No bulk whole-file ours/theirs; no large revert followed by restoration from memory.
- After each group or low-risk batch, check all requirements of the covered features and related upstream/downstream
  entries; small items share acceptance; independent blockers do not stop other groups.
- Finally two independent checks: from staging toward the result (is correct behavior missing?) and from our refactor
  toward the result (is old architecture, a bypass or a semantic regression reintroduced?).
- Verification includes relevant unit tests, typecheck, lint, necessary builds and runnable Pro desktop/remote tests;
  the standard is behavior assertions holding, not compilation.

## When to Stop

Stop the affected items and tell the user only when: a genuinely new product decision is required (no existing
principle decides, or two valid decisions conflict); scope must grow significantly (local rewiring cannot solve it; new
architecture, new migration or a deferred scheme would be needed); new permissions or irreversible operations (real user
data, external publishing, destructive actions); parallel changes in the worktree cannot be safely isolated; key
acceptance cannot be completed and independent work is exhausted. Small test prerequisite/tool/environment problems are
recorded and the rest continues. Undecided parts stay isolated; an integration with unresolved risk is not merged back.

## Completion Conditions

All must hold: every source has a destination with no unexplained discard or restore; all intersections decided and no
open item affects delivery; all approved behavior implemented or proven equivalent; current architecture and product
decisions obeyed; per-group (or low-risk batch) feature review, overall bidirectional review and key verification done,
with shared evidence marking its coverage; critical regressions resolved and verification limits recorded honestly (no
untested written as passing); code and records committed and the result safely merged back into recovery, without
automatic push. Todo102's existing verification debt is managed separately; this merge's key verification may not be
handed to it.

## Evidence Entry Points

- [Per-group decision and execution ledger](../research/todo103-staging-integration-ledger.md)
- [Fixed source inventory](../research/todo103-staging-source-inventory.json): 193 non-merge commits, 60 merge commits,
  941 net staging-changed paths (950 investigation paths including historically cancelled and explicit-conflict paths).
  Recomputed on the fixed SHAs: 235 doubly changed paths, 107 explicit conflicts, 128 auto-merged doubly changed paths;
  the smaller intersection from the first verbal scan is not an acceptance basis.
- `pending` means decision or evidence check not finished. Groups are routing only; files can span groups and each
  feature fragment must be checked.

## Real Merge Candidate Rule

The integration branch starts from the fixed recovery baseline; completed group commits are kept. After the dirty batch
is closed, run a normal `git merge --no-commit --no-ff` of fixed staging without waiting for other sources. Do not commit
partial code in an index with unresolved conflicts. No `merge -s ours`, no conflict markers committed, no whole-file
ours/theirs. A read-only `merge-tree` candidate is not deliverable code. The final proof must show fixed staging is an
ancestor of the result and every source has a destination.

## Acceptance Status

- [x] Fixed both SHAs; separate branch and clean worktree; baseline freshness check.
- [x] Reviewable inventory of non-merge / merge / file / conflict.
- [x] Closed the current batch and started the real merge: checkpoint `c4f8619d96`, `MERGE_HEAD=790884b1ce`.
- [x] Resolved candidate conflicts into a complete runnable real merge commit `e1c611be98` (parents: checkpoint
      `c4f8619d96` and staging `790884b1ce`; ledger §24-43 and the real-merge-candidate list). 193 non-merge sources
      record decided/implemented/verified; file-level final review and key platform acceptance continue.
- [x] All feature groups verified against current code and decided; every source has a destination (ledger §43-44).
- [ ] Approved retained behavior implemented, tested, reviewed per group and committed.
- [x] Real merge of fixed staging and overall protocol / dependency / build checks (ledger §36-45; Windows real install
      is not a build pass and is the next gate).
- [x] Two independent code reviews, staging -> result and refactor -> result (ledger §43-45).
- [ ] Key verification complete; no open item affects delivery; merged back into recovery.
