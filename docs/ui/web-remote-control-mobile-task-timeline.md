# Web Remote Control Mobile Task Timeline

> **Status: deprecated (confirmed on the 2026-10 staging merge).** After the virtual project refactor the
> mobile home shares `ProjectSidebar` with desktop (see
> `docs/superpowers/specs/2026-09-09-virtual-project-design.md` section 6.0.3 and deviation record D64);
> the mobile-specific task home, the desktop-to-mobile task snapshot and the related code are deleted. The
> text below is historical background only, not an implementation basis.

The ordinary list of the mobile remote task home had two organizations, switched by a segmented control
"Recent | Workspace" right of the "All tasks" row (preference stored locally):

- Recent (default): cross-workspace flat tasks grouped by the desktop timeline (today / yesterday / this
  week / earlier), with date groups as sibling sections.
- Workspace: workspace grouping, expand/collapse, reconnect entry for disconnected remote workspaces.

Both views affected only the ordinary list; only the "Pinned" section stayed above (pinned tasks not
repeated in the ordinary list); running and pending states stayed in the task row, with no separate
section and no status filter (rules: [mobile task home](../web-remote-control/mobile-task-home-design.md#首页)).
Timeline rows kept the workspace label; rows of disconnected remote workspaces were not directly openable.
Sort (updated / created time) sat in the header "More" menu with logic in
`packages/ui/src/lib/webRemoteControlMobileTaskHome.ts`, default `updatedAt` descending, with the other
time field and `taskId` as stable tie-breakers. During a stay, existing task order and date buckets stayed
stable while status and time text took new snapshots; new tasks were inserted first in their group and new
groups appended at the end, with regrouping on successful refresh, returning home, or changing
organization/sort.
