# Original task history cannot be opened after the remote primary root becomes unavailable

Status: ready-for-human

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, test patch 07, batch
`r3-server-20261011125749338-152f05`. `directory-missing`, `directory-denied`, `directory-file` failed after
188.4 / 190.0 / 191.2 s, all at opening the original task of the unavailable directory A. Patch 08, batch
`r3-server-20261011143037600-31012b`, re-ran the three variants with a real pointer on the in-project
visible task row: each `historyNavigation` records expectedTaskId=A but only one visible primary pane, still
bound to B; A keeps its path/identity but has an empty remoteSessionId. A global-DOM-click-hit-hidden-row
explanation is excluded.

## Facts

The scenarios move the primary root away, replace it with a regular file, or revoke traverse permission on an
exclusive parent (the permission case confirmed that an unprivileged Core and the access probe were actually
denied). After Source reconnect B/C restored new attachments and B could continue. A's project entry and task
row stayed, new-task and file buttons were disabled, and the unavailable-directory notice was correct.

Clicking A's original task left the primary pane on B's first-turn and continuation messages for 30 s; the
`missing` video end frame also shows B. Desktop logs lack navigation events, so the root cause is not
established and A's data is not claimed lost.

```text
A/B/C online → Source disconnect → A's primary root becomes unavailable → reconnect
  → B/C restored, B can continue
  → A: new task / files disabled, task row kept
  → click A's original task → page still shows B
```

The [primary-root availability contract](../../project-primary-root-availability.md) says history reads must
not depend on the directory existing and the directory must not be rebuilt just to read history. The result
violates this; later directory repair and continuing the original task are not reached. Relation to the
[Renderer reload navigation issue](14-renderer-reload-task-navigation.md) is unconfirmed. Business code is
unchanged.

Evidence: the three `directory-*` case folders of the batches above (`directory-resilience.json`, failure
videos, logs).
