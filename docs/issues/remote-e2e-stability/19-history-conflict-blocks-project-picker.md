# One workspace's history conflict blocks the whole remote project picker

Status: ready-for-human

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, test patch 07, batch
`r3-server-20261011125749338-152f05`, case `history-conflict`: a legacy program generated two lines of
history, the test injected a canonical/source task-identity contradiction only in directory A, then switched
back to the current program. The case ended after 880.0 s with the helper error "SSH deploy/connection did
not complete". `history-conflict-sources` (identity contradiction between two sources) ended the same way
after 865.2 s. Both stopped at project selection for the healthy directory B.

A read-only WebDriver probe after 21:46 confirmed: the wizard was closed and "Add remote project" showed
`SourceServerWorkspaceIdentityConflictError: Source Server workspace task identity conflict` pointing at A;
the "New project" button was disabled and no project was selectable. The case never reached A's conflict
handling page, retry or abandon-merge assertions, and B's independent usability was not proven.

```text
only A's history carries a conflict → Source connects → whole project tree is read
  → A's conflict fails the tree request → empty list, new-project disabled
  → healthy directory B cannot be opened first
```

The [R3 migration contract](../../architecture/r3-source-server-remote-architecture.md) says failures block
opening per workspace, not the connection; the project model must still give a path into conflict-free
projects. `RemoteProjectPicker` shows only an error and disables creation when `service.readTree` fails as a
whole; the boundary between remote project-tree reads and lazy history migration must be reviewed. The
conflict must not be ignored and legacy history must not be deleted to restore usability.

Business code is unchanged. The test helper now reports the raw cause as soon as the project page shows an
explicit error instead of waiting 10 minutes. Patch 08, batch `r3-server-20261011143037600-31012b`, verified
this: `history-conflict` ended in 328.2 s (was 880.0 s) and `history-conflict-sources` in 304.8 s (was 865.2 s),
both reporting the identity conflict; the business failure still counts as FAIL, and the total-time delta is
not a performance comparison of the fixed install stage.

Evidence: run log, `upgrade-history.json` and failure video of `history-conflict`; probe returned
picker=true, disabled=true.
