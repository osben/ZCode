# Grouped task workspace bootstrap

> Historical document: the 2026-09 virtual-project refactor replaced this running model. Current behavior is defined by the [virtual project design](superpowers/specs/2026-09-09-virtual-project-design.md). The old Group tables survive only as migration/downgrade evidence; the runtime API, views, and workspace bootstrap were removed. The CLI owns session facts; the Host owns project and organization state. Kept for downgrade understanding only (referenced from `.agents/skills/session-management/SKILL.md`).

The grouped task view bootstrapped existing visible tasks by workspace:

- The first grouped-view query running workspace bootstrap moved visible tasks in the current scopes into generated workspace groups; completed tasks older than seven days in scope were archived first.
- The generated group title used the workspace path leaf (e.g. `z-code`); the group id was deterministic from `workspaceIdentity || workspacePath`, so remote identity stayed isolated from local path display; the group color was deterministically distributed across the non-gray palette from the same workspace key.
- Generated groups received top-level grouped ordering; their tasks received group-member ordering by recent activity; generated workspace groups were shown only while their workspace was in the current grouped-view scope.
- Workspaces with `workspacePurpose=conversation` joined grouped task queries but were excluded from workspace-group bootstrap; their tasks started as top-level ungrouped tasks and could move into ordinary user groups.
- Bootstrap ignored existing group membership and rebuilt visible task membership by workspace; auto-archive during bootstrap was independent of settings, with a fixed seven-day retention window.
- Bootstrap wrote a global marker after initialization, so deleting or ungrouping generated groups did not recreate them on refresh; workspaces appearing later never received generated groups; the managed conversation backing directory never created a generated group named from its internal `default` path leaf.
- In grouped mode, the global New task created a UI-only draft row at the top level; a group-level New task created it at the top of that group. Repeated clicks on the same entry reused the draft row; a different entry repositioned it. The draft row was not persisted, not renameable, not draggable, and disappeared when left. When the first prompt created a real task, it inherited the draft row placement before grouped order was persisted.
