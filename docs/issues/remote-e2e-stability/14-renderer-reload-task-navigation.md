# After a Renderer reload, a ready remote task cannot be switched to

Status: ready-for-human

## Real-pointer revalidation

Baseline unchanged, test patch 07; batch `r3-server-20261011125749338-152f05`, case `renderer`, failed after
143.5 s. The task row was scoped by project identity, waited until visible, then clicked with a real WebDriver
pointer. Main logged one valid reload ready ACK for each of the two original sessions (A/B); the Renderer was
operable 2026 ms later.

`beforeSelectingA`: current page is B, the navigation cache has no A. After the real click the cache still has
no A and B stays active; `afterSelectingA.panes` has a single visible pane, B's
`session_18e17db7fc3de951f1952295a7f6d8cd`. So the failure is not a click on a hidden stale row or a probe
reading a hidden pane.

The task-navigation chain calls `ensureTaskNavigationWorkspace` / `activateTabByPath` first, and there is a
reject branch when a remote tab is missing. That fits "attachment ready, navigation cache missing the entry,
click ineffective", but the logs do not pin the root cause to that branch. The fix must reconcile the actual
attachment with the navigation entry; adding a port-less fake tab is not acceptable. Product code and the
failing assertion are unchanged.

```text
Renderer reload → A/B original attachments ready
  → current B, cache lacks A
  → real click on project A's original task
  → B remains the only visible pane (fails after 30 s)
```

## First finding and ruled-out causes

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, test patch 06, batch
`r3-server-20261011123601821-eca14c`, `renderer`, failed after 184.6 s. After the reload the Renderer was
operable at 2232 ms and Main wrote valid `renderer-reload` ready ACKs for both original remoteSessionIds, so
this was not a missing attachment. Opening A from the sidebar worked; a DOM click on task B's test id left A
as the primary pane after 30 s (video end frame shows A's title and first-turn body).

B's task is `session_bcb5ecb4a2c7bc043954b54e1f376f6c`. B's conversation subscription succeeded at reload,
was released when switching to A, and was never re-subscribed. The DOM-click suspicion was ruled out by the
real-pointer run above. No new session was created as a substitute for restoring the original task.

Evidence: `packages/desktop/.e2e-artifacts/r3-server-20261011125749338-152f05-renderer/` and
`...r3-server-20261011123601821-eca14c-renderer/` (`renderer-reload.json`, failure video, Desktop log).
