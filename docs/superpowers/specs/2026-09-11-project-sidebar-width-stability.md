# Project Sidebar Width Stability

2026-09-11: users reported that the "显示更多" (show more) button flickered while idle and sat off-center to the
right. This supplements the section layout boundary of the virtual-project spec.

The single-column width of the project/task sections is decided by the sidebar's available width. A task title and
its marquee copy must not stretch the section; title overflow stays with the original TaskTitleOverflowText and the
page size stays with ProjectTaskRows. "显示更多" is centered within its task list's width and stays stable before
and after paging.

```text
sidebar available width -> section column width -> title overflow detection -> title copy
                               ^                                              |
                               +---------- reverse stretching forbidden ------+
```

The fix constrains the minimum width of the Grid single column in the project-sidebar UI module. It reuses the
original column gap, collapse, task title, paging and data owners; no new state, observer or timer is added. Desktop
and mobile share this layout; the continuous / replayable and Host / CLI data chains are unchanged.

Acceptance VP-WIDTH-01 (accepted / pending): a real Electron renderer with an isolated HOME and a synthetic task
index, 25 mixed long/short titles in each of the project and task areas, no provider requests. Observe idle for a
time window: no horizontal section overflow, no button width jumps, text centered in the task list; clicking
"显示更多" expands 20 items to 25. Check light/dark themes and normal/narrow section widths. The synthetic index
proves layout and paging only, not session resume or CLI sync.
