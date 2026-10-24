# Auto-reconnect runs three times but the project page shows no retry progress

Status: ready-for-human

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, test patch 07, batch
`r3-server-20261011125749338-152f05`; `retry-budget` failed after 122.7 s. A real TCP gate dropped the
connection and refused later ones; `retry-budget.json` records 3 refusals, but a DOM MutationObserver over the
whole retry period never saw `1/3`, `2/3` or `3/3`. The project ended offline with the connection error
entry.

```text
real disconnect → three TCP reconnects refused → offline + error entry
  └─ page observation: progress counter always empty
```

The [connection display acceptance](../remote-connection-ux/12-sidebar-header-and-menus.md) requires progress
such as "自动恢复 2/3" (auto-recovery 2/3). At the time, `ProjectConnectionStatus` took only
connecting/error/logs and showed a spinner while connecting, and `RemoteConversationBanner` fetched the
presentation but did not render its recovery count. Only the project/conversation pages were confirmed
lacking progress; Settings was not claimed, and the background retries were not claimed missing.

The test moved this non-prerequisite display assertion to the end of the scenario and keeps the failing
requirement, while still verifying silent recovery after the network reopens and manual takeover. Patch 08,
batch `r3-server-20261011143037600-31012b`, completed both (distinct new sessions, Host count unchanged) and
failed only on displayedAttempts=[] (276.8 s): the remaining defect is the visible progress; background
recovery has independent pass evidence.

2026-10-15 progress: the project-row remote identity details now have a connection-progress section at the
top that reads `recoveryAttempt/Limit` from the status registry and shows "自动恢复 n/3". `retry-budget` now
opens the details while connecting and keeps them open until the terminal state; `hovercard-retry-20261015-r3`
observed `displayedAttempts=[1,2,3]` and PASSED. By confirmed design the project row itself shows only
"连接中" (connecting) with no persistent counter. Whether the conversation banner should also render the
recovery count is awaiting human confirmation.

Evidence: `retry-budget.json`, run log and failure video of the batch above.
