# Settings: Archive Management

Settings -> Data and statistics -> Archive management ("归档管理"). Layout follows the "archived chats" reference
screenshot: title / delete-all, search, sort and project filters, project group header with count and more menu,
and cards with task title / time / delete / unarchive. Project candidates and groups use virtual projects, never
cwd.

Full history: `git show 37b98ff8:docs/superpowers/specs/2026-09-11-archive-management.md` (per-round verification
logs and the Select-expansion performance measurements).

## Behavior and boundaries

- Both the page name and the page title are "归档管理"; it sits before the auto-archive settings; the list title is
  "已归档的会话". Only `archived` rows of the Host `readTree` are shown. The CLI delete mirror excludes deleted
  tasks, and rows cannot be added back from sessions-index.
- The auto-archive settings live at the top of archive management, before the archived list: "自动归档旧会话"
  (auto-archive old sessions) and "归档保留时长" (retention) stay in one settings card and are removed from the
  general page. Existing setting keys and the 3/7/14/30 day options are kept. Since 2026-10-19 the default is off
  with 30 days (existing day values are not overwritten). While off the duration can still be chosen and saved: it
  is stored only and no archiving runs; when turned on, archiving uses the stored duration. Changing the duration
  while on reuses the settings-change re-scan; already archived sessions are not restored by a duration change.
  Since 2026-10-14 an old enabled value is reset once to off (days kept) and runs only after the user re-enables it;
  the migration contract is in `2026-09-09-virtual-project-design.md`, "Auto-archive re-enable after the fix
  (2026-10-14)". Chinese/English, light/dark and narrow layouts reuse the shared settings row.
- Fixed page copy uses "会话" (English: session) everywhere: auto-archive label/description, list title, search,
  counts, loading/empty/failure messages and delete confirmation. User-defined session titles and project names are
  shown as they are. The title reuses the shared SettingsPage header and `archives.nav`, the list still uses
  `archives.title`; display only, no change to state owner, commands, persistence or failure semantics, no
  migration.
- Default sort is updated time / all projects, searching titles case-insensitively. The middle dropdown is "sort by"
  and offers only updated time and created time, both descending. Search and project filter intersect.
- The filter row reuses the shared Select: the trigger shows only the current option and a dropdown arrow; the
  "sort by" label sits outside, left of the sort box, and neither sort nor project box has a decorative icon. The
  external label is associated with the Select, keeping keyboard operation and accessible name; narrow screens
  wrap; Chinese/English and light/dark stay usable. Filter state is still held by ArchiveManagementContent; no new
  component or sync path.
- Groups and selection are keyed by Host + projectId; same-directory projects and same-name projects on different
  Hosts are not merged. The project name is shown, remote with the Host name. No projectId shows "未归类"
  (unclassified); a deleted container keeps its name plus the "已移除" (removed) mark without restoring the project
  or changing session cwd. Candidates come from the same tree and include deleted containers that still have
  archived sessions, and unclassified.
- The time shown is the CLI updatedAt/createdAt selected by the current sort, descending and stable; the title is a
  single line with ellipsis and the full title readable; 50 items per group on first screen, show more adds 50.
  Counts and batch operations use all matches, not the rendered page.
- All archive groups (including unclassified and removed projects) are collapsed by default, with a collapse arrow
  right of the name; the name and arrow share one keyboard-operable expand button while count and more menu stay
  separate. It reuses the shared Collapsible; chat cards, row buttons and "show more" are built/mounted only when
  expanded and unmount at once on collapse. Each Host+projectId ArchiveGroupCard owns its `open` for this page;
  groups still in the result keep state across sort/filter, new or re-entered groups are collapsed, and search never
  expands automatically. Loaded counts use the page's per-group limit; counts, search results and batch operations
  never depend on collapse or DOM mounting; no persisted preference.
- Each row has unarchive/delete; the group more menu offers unarchive/delete for the group; the top-right delete-all
  acts on the current search/filter result. Deletes need confirmation stating the count and that the UI cannot
  undo; the CLI soft-delete semantics are unchanged. The candidate identities are fixed during confirmation and
  later new matches are not added.
- Only one operation batch runs at a time on a page (buttons disabled). Existing commands are sent per item, UI
  state is cleaned only on success, then a final refresh; partial failure reports success/failure counts, failed
  items stay in the authoritative tree, errors are never swallowed, successes are not rolled back and full success
  is never faked. Cancelling confirmation sends no command. Targets that expired, were unarchived or deleted are no
  longer executed.
- Local and online remote share the page; offline fakes no session cache and starts no Agent for reads; an offline
  project is recognizable but has no actionable offline index. Loading / empty / no-search-result / read-failure are
  shown separately with retry on failure. Async refresh reuses the original request sequence number with no new
  sync timer.
- DESIGN.md semantic colors, text-ui sizes and component reuse apply; light/dark, keyboard, Chinese/English and
  narrow screens are usable. Mobile reuses the existing Host attachment and must not create a runtime for the
  archive page.

## Architecture decisions

The archive UI belongs to the managed project-sidebar/ui module and exposes ArchiveManagement through its index;
settings navigation only registers the entry. ProjectDirectoryProvider is lifted to RootWorkspaceContent so sidebar,
composer and settings share one source; a nested Provider reuses the existing owner, a standalone shell can still
use it, and `useProjectTree` must not run several times. The Host owns projects/roots/archived; the CLI owns
existence/title/time. The UI owns only search, filter, collapse, pagination, the confirmation snapshot and the
in-flight batch.

```text
Host readTree -> single ProjectDirectoryProvider -> sidebar / composer / archive settings
user filter -> pure derived groups (Host+projectId; task address still workspaceKey+taskId)
confirm fixes candidates -> existing Controller.mutateTask / TaskService
             -> Host archive=false or CLI delete -> index event -> same tree refresh
desktop: continuous chain unchanged; mobile: shared-host + replayable chain unchanged
```

Task operation address/routing reuses one module-internal mutation adapter shared by sidebar and archive page;
remoteSessionId resolves from the existing registry and sourceServerId from the unified identity parser, never by
guessing remote from paths. No new protocol, schema, migration, persisted cache or accepted queue.

The auto-archive card is composed by SettingsPage in the archives section; setting values and callbacks stay owned by
SettingsPage and SettingsService stays the persistence authority; project-sidebar query/list components do not take
over settings state. The page updates only after a successful save; failure uses the original settings feedback. Host
scan scheduling, remote config scope and the desktop/mobile boundaries are unchanged; mobile gets no new settings
entry.

```text
archive settings card -> SettingsPage original callback -> SettingService.update
                                      ├-> original Host scan scheduling: off exits, on scans with the stored days
                                      └-> save succeeded -> SettingsPage updates displayed value
```

## Impact analysis and test decisions

| Item               | Conclusion                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layer/pattern      | presentation, option-source, validation, commit-effect                                                                                                                                             |
| Entries to check   | SettingsPage/navigation/config; RootWorkspaceContent/WorkspaceShellLayout; ProjectDirectoryProvider; task archive/delete commands                                                                  |
| Shared / different | three places share the directory source; the archive page takes only archived and includes deleted containers; the sidebar shows no archive; the composer shows no deleted containers              |
| UI surface matrix  | settings filter: page draft -> pure tree projection; row/group/all actions: confirmation and in-flight -> existing command -> Host/CLI; sidebar: refreshed by the same event, navigation unchanged |
| Owner / landing    | query and preferences by Provider; archive by Host tasks-index; delete by CLI mutateSessionFacts -> mirror; no new landing                                                                         |
| Invariants         | workspaceIdentity isolation, Host+projectId grouping, old cwd unchanged, no change to time/title, no write to the other database, continuous/replayable separated                                  |
| Codegraph          | unavailable (`no such table: unresolved_refs`); impact traced from source with rg, no graph analysis claimed                                                                                       |
| Graph drift        | old surface.project-task-list still points at deleted grouped/workspace nodes (historical drift); only the new archive entry and existing authoritative ports were registered                      |
| Not expanded       | provider/tools/message stream/queues do not affect archive management; no full cartesian product, no new runtime request                                                                           |
| Clarification      | user confirmed the middle dropdown is sort-by with only updated/created time; delete-all uses the current filtered result and the dialog shows the count                                           |

| Case  | Setup -> Action -> Assertion                                                                                                                                                                                            | Status/evidence                                                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| ARM01 | settings data-and-statistics entry; several virtual projects sharing a cwd, long titles, unclassified, deleted project -> search / time sort / project filter -> groups / counts / candidates use virtual projects only | accepted; unit + pending E2E                                      |
| ARM02 | archived row -> unarchive -> index archived=false, page row gone, sidebar shows it again; cancelling delete changes nothing, confirmed delete sets CLI time_deleted and mirror delete, refresh does not revive          | accepted; unit + pending E2E                                      |
| ARM03 | after search/project filter -> group/all batch action -> only items matching at confirmation are processed; repeated clicks run once, failed items kept and reported, other groups untouched                            | accepted; unit + pending E2E                                      |
| ARM04 | same projectId / task ID / real path on different Hosts -> routing -> full identity/source/attachment kept; local and remote isolated                                                                                   | accepted; unit; real remote/mobile GUI pending                    |
| ARM05 | long titles, 50+ list, Chinese/English, 390px, light/dark -> search / more / buttons / scroll usable                                                                                                                    | accepted; unit + E2E on the shared renderer, not a mobile pairing |
| ARM06 | default all collapsed -> mouse/keyboard expand and collapse -> only expanded groups mounted; collapsed groups' counts and batch actions stay complete                                                                   | accepted; unit + pending E2E                                      |
| ARM07 | general page has no auto-archive item -> archive management default off / 30 days -> while off change and save the duration, restored on refresh -> on uses the stored duration; still editable after turning off       | accepted; pending E2E; layout covered by ARM05                    |
| ARM08 | page header "归档管理" above the auto-archive settings, fixed session copy and delete confirmation                                                                                                                      | accepted; layout reuses ARM05                                     |

E2E cases live under manual-review/pending with fixtures in an isolated HOME/workspace; history data needs no model
(provider policy=none). Function and batch semantics follow the user request and existing command constraints; the
stream protocol is unchanged, so formal-proof message-state combinations are pruned. Not promoted to formal/Docker;
awaiting manual review.

### 2026-10-19: default 30 days, duration presettable while off

Default settings, SettingsPage initial/fallback values and the Host scan fallback are all 30 days; existing days are
not migrated. The disabled binding between the duration dropdown and the switch is removed; saving still goes through
SettingService; scanning exits while off and reads the stored value when on; no new state or sync path.

Verified with a fresh Electron run (ARM07, ARM08, ARM01/05/06: default off/30 days, change to 7 days while off and
refresh, keep 7 on enabling, change to 14 while on, off again then 30, archived sessions not restored; Chinese/English
x light/dark x 1200/390px layouts). Cases stay pending; narrow screens are not a real-phone check. The extra
ARM02/ARM03 unarchive cases of the old build failed and were not touched by this change, so they are not counted as
passed. A first affected-unit run had 2 failures in subagentsService tests (afterEach cleanup timeout, then temp file
ENOENT); the file passed 29/29 on rerun, with no test or timeout change and no claim that the first batch was green.

## Verification summary

Related unit tests, Electron E2E (real created/updated reverse sort, virtual-project filter, unarchive write-back,
delete confirm cancel, CLI time_deleted and Host cli_deleted, persistence after reopen, search-scoped batch delete,
group unarchive, 1200/390px light/dark screenshots and overflow checks), root/E2E typecheck, fixture check, lint and
the architecture gate passed. Real mobile pairing / remote Host / Windows / Linux were not run and narrow-screen
screenshots do not substitute. The semantic graph gained the archive surface, shared directory owner and task
mutation adapter relations; codegraph scanning stayed unavailable and was not written up as graph analysis.

### 2026-09-15: simplified filter controls

The two dropdowns already reused the shared Select; only the project-sidebar/ui composition changed to move the icon
and sort label out of the trigger. Filter state, commands and the continuous/replayable chain are unchanged. The
decorative icons before the sort label and before the project selector were then removed per user request, leaving
the sort text and the shared Select arrow; the filter bar keeps only the search icon and two arrows.

### 2026-09-15: archive-page expand lag located; groups collapsed by default

Cause (profiled in a real dev window with 42 archive groups): `ArchiveGroupCard`'s 50-item limit applies per
project while `ArchiveManagementContent` rendered all groups at once (about 1,142 rows, 17k DOM nodes). Radix Select
injects a scroll lock and changes body `pointer-events` when opening, forcing large-scope style recalculation in
`UpdateLayoutTree`; menu open took about 400-490ms with all projects versus 60-110ms with a single project. Per user
ruling the fix is default-collapsed groups mounted only when expanded: archive rows mounted dropped from 1,142 to 0,
sort Select 406-416ms -> 66-74ms, project Select 461-487ms -> 90-124ms (dev-build numbers, not production
benchmarks). Open follow-up: whole-page virtual scrolling to limit off-screen mounted entries was proposed but not
done.

```text
click Select -> scroll lock / outside-click lock -> style recalculation over many archive DOM nodes -> measure menu position -> first frame
enter archive page -> all groups open=false -> only group title/count/more mounted
click name or arrow -> that group open=true -> mounts its paged chat cards; click again unmounts
batch command -> original matched data -> existing Host/CLI command (independent of mount state)
```

A default-not-mounted unit test failed against the old implementation (50 rows) before the change. E2E also covers
independent expansion, no row DOM after keyboard collapse, more menu not expanding, new groups collapsed / group state
kept after filtering, batch delete and unarchive of collapsed groups, and 16 screenshots (Chinese/English x light/dark
x 1200/390px x collapsed/expanded).

### 2026-09-15: auto-archive settings moved into archive management

The whole settings group moved out of GeneralSectionContent; SettingsPage's archives section now composes
TaskAutoArchiveSettings above the original ArchiveManagement. The card has no internal state; reading and saving use
SettingsPage's existing callbacks; the shared settings row's narrow stacking layout and existing Chinese/English copy
are reused and control accessible names added. Only the ui module's display changed; the project-sidebar contract,
Host scheduling, persistence keys and protocol are untouched. ARM07 failed on the old implementation because
"general" still showed the auto-archive copy, and passed after the change together with the existing archive list
operations; the scan case verifies old-task archive, pinned protection and recent-task retention.

### 2026-09-15: archive page title and session wording

The shared settings page header is restored with "归档管理" and the list keeps its own "已归档的会话" title. The old
implementation hid the archives header and mapped the page title to the list title, which left no page title after
the auto-archive card moved in; both special cases were removed. Archive-specific Chinese/English copy is unified to
session; user content is not replaced. ARM08 covers the title above the auto-archive settings, fixed copy and the
delete confirmation. Four ui display files changed with zero net lines; owners, event order and the
continuous/replayable boundaries are unchanged.

Across the 2026-09-15 rounds the default-branch architecture check still reported a pre-existing unmanaged-file
error for `packages/ui/src/root/resolveConversationWorkspaceTarget.ts`, unrelated to this work. Real mobile
shared-host, remote Host and Windows/Linux GUI were not run in any round; narrow-screen evidence comes only from the
shared renderer. Cases stay pending.
