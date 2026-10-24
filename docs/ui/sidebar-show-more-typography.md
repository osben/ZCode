# Sidebar "Show More" Typography

2026-09-15: the project sidebar's pagination entry uses the same `text-ui-base` size as task titles and the
empty-state "暂无任务" (No tasks), so it scales with the UI font-size setting. Default color matches the
empty state, `text-foreground-subtlest`; on hover and keyboard focus-visible it uses `text-foreground`,
with a transparent background.

Rendered by the existing `ProjectTaskRows` entry, keeping text indent and the pagination click behavior:
the ordinary list adds 5 rows each time, the pinned list keeps its original expand/collapse. Only display
tokens change: no new state, IO, protocol or migration. Desktop and mobile Web share the component and
theme tokens; the continuous/replayable transport boundary is unchanged.

## Acceptance

`VP-MORE-01` (accepted/pending): an isolated-HOME real Electron renderer prepares 6 tasks plus an empty
project, compares the computed font-size of the entry, the task title and "暂无任务", and the default color
of the entry vs the empty state; both themes, 1200/390px and 14/18px UI font sizes stay consistent. Real
mouse hover and keyboard focus-visible brighten the entry, and clicking expands from 5 to 6 rows and hides
the entry. Screenshots and style samples are saved; no provider request. A narrow-screen emulation does not
stand for mobile shared-host or Windows/Linux real-machine verification.

## Verification Outcome

Before the fix, Electron measured the entry at 12px vs title and empty state 14px, with mismatched default
colors, and the case failed the font-size assertion. After the fix,
`desktop-e2e-20260915123224650-p53861-1395a2f25af8019d` passed 1/1 (8 computed-style groups, hover/focus,
5->6 pagination), with screenshots and `show-more-styles.json` kept in that run directory; the case stays
pending. `typecheck`, `typecheck:e2e` and the format check passed; lint had existing warnings only; HEAD
incremental architecture check 0 violations (the existing `root/resolveConversationWorkspaceTarget.ts`
unmanaged-new-file on the default-branch check is not introduced here).
