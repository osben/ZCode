# Git refresh resilience

## Contract

`gitService.refresh` owns aggregation of the current Git status snapshot. `useGitRepository`
owns its renderer projection; no additional cache or persisted state is introduced.
The target is the pair `(workspaceIdentity?.trim() || workspacePath, workspacePath)`.

- Summary, staged and unstaged changes come from the same successful status snapshot.
  Identity remains part of the requested refresh. Status and identity failures reject
  the request; they must not be converted to a successful empty response.
- Branch comparison is auxiliary. If it fails (including a missing tracking ref),
  return the successful summary, changes and identity with `branchComparison: null`
  and an explicit `branchComparisonError` message. The optional nullable field keeps
  older host responses compatible. Do not retain an older branch comparison as current.
  A successful or unrequested comparison clears the error. Unexpected comparison
  errors are also disclosed, never silently treated as a clean branch.
- A complete refresh rejection, including `git status` timeout, preserves the last
  confirmed Git repository snapshot only for the exact same target. Set `loading: false`
  and expose the failure through the existing error UI. During retries keep the
  snapshot visible with the existing refresh indicator. The snapshot is stale, not a
  new status result; do not advance its revision on failure.
- An unknown target has no confirmed repository state to preserve. Show its error;
  never borrow another target's summary, changes, identity or comparison, including
  when only the identity or only the concrete path changes. Late responses for a
  superseded target cannot update the active projection or retry budget.
- A successful response explicitly reporting Git unavailable or a non-repository is
  authoritative and replaces any old repository snapshot. These remain distinct from
  failures. Subsequent successful refreshes replace stale data and clear errors.
- Rejected refreshes have at most two consecutive automatic retries per exact target,
  including failures after an earlier success. After exhaustion an external refresh
  trigger can try again. Partial comparison failures do not trigger an automatic loop;
  an ordinary later refresh retries comparison. Successful refreshes reset the budget.
- Git Review displays the existing error copy even when retained file rows are present.
  No new Git action or platform-specific interaction is introduced; Desktop and Web
  use the same projection and service result over their existing RPC routes.

## Ownership and event order

```mermaid
sequenceDiagram
  participant Trigger as Watcher / manual refresh
  participant Hook as useGitRepository (projection owner)
  participant Service as gitService.refresh (aggregation)
  participant Repo as GitCliRepo
  Trigger->>Hook: Target + refresh token
  Hook->>Hook: Increment request version; keep same-target snapshot while loading
  Hook->>Service: refresh(target, requested extras)
  Service->>Repo: Status + identity + optional comparison in parallel
  alt Status and identity succeed; comparison fails
    Service-->>Hook: Snapshot + null comparison + explicit comparison error
    Hook->>Hook: Apply only if version current; no automatic error loop
  else Required refresh fails
    Service-->>Hook: Reject
    Hook->>Hook: Version check; retain confirmed same-target snapshot + error
    Hook->>Hook: At most two retries for this target
  else Refresh succeeds
    Service-->>Hook: Current snapshot (including actual non-Git state)
    Hook->>Hook: Version check; replace snapshot; clear error; reset retries
  end
```

## Regression scenarios

1. Missing upstream: a real tracking ref is removed while the branch still tracks it.
   Refresh returns the current dirty summary, staged/unstaged changes and identity;
   comparison is null with its original error. Recreating the ref restores comparison.
2. An unexpected comparison failure is disclosed as an error; required status or
   identity failures still reject instead of producing an empty successful snapshot.
3. After a successful refresh with changes and identity, status timeout preserves all
   same-target data and the destination control, exposes the error, stops after two
   retries, then replaces the snapshot and clears the error on a later success.
4. Change identity at the same path, or change path under the same identity; a failing
   request for the new target never exposes the old snapshot. Ignore old in-flight
   success/failure results, including an A → B → A switch.
5. Successful Git-unavailable and non-repository responses replace a confirmed
   repository and remain distinguishable; both recover on a later repository response.
6. Comparison-only error is visible without a refresh loop, leaves file rows intact,
   and clears after a successful comparison.

## Verification

- Service regression: `packages/services/test/gitRefresh.test.ts` (real missing ref + recovery).
- Hook regression: `packages/ui/test/gitRepositoryResilience.test.ts` (RPC fault boundary).
- Existing hook retry and refresh-decision suites remain required.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, `pnpm fmt:check`.
