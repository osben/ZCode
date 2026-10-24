# Opening upgraded-project history: test interaction corrected

Status: done

## Outcome

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`; legacy fixture `7a6e2eb3f1946aba9155155178e86cd947cee655`.
The initial failures (test patch 07, batch `r3-server-20261011125749338-152f05`: `history-single` 258.3 s,
`history-merge` 281.5 s) were not a confirmed business defect. With the real pointer on the in-project
visible row (patch 08, batch `r3-server-20261011143037600-31012b`), `history-single` and `history-merge`
opened and continued 1 and 2 original taskIds respectively; the navigation snapshot's canonical identity,
active pane and original taskId matched, and the multi-line case also passed the completed ledger and backup
assertions. After correcting the legacy-rollback test entry, patch 09, batch
`r3-server-20261011150809016-2aeaba`, passed both cases (single 275.9 s, merge 310.0 s): original history
resume, real legacy-program rollback, and (merge) both legacy lines still reading their data after the merge.
The overall history case counts as PASS. Business code was never changed.

## Initial suspicion

A legacy program naturally generated tasks, the current build upgraded and joined the migrated original
projectId (task project_id, project and root were verified on the remote DB; no duplicate "(2)" project was
created). The task row appeared, but clicking it showed no session pane within 30 s: single-line video stopped
at "connecting / device not connected", multi-line stayed on an empty draft; the new Main logged one
workspace-context-bound ready but no new subscription for the original task. The first result could not tell
identity re-keying, attachment publishing and task navigation apart. The test then added real-pointer
interaction and recorded project identity, connection state, navigation cache and visible panes before and
after the click.

```text
legacy program creates history → current program connects and migrates → original project added
  → legacy task row visible → click → (initially) pane did not appear; later passes with real pointer
```

Evidence: `history-single` / `history-merge` case folders (`upgrade-history.json`, videos, Desktop logs). The
business failure of [Renderer reload task navigation](14-renderer-reload-task-navigation.md) is tracked
separately.
