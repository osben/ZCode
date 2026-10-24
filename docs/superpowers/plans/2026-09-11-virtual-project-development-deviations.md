# Virtual project refactor: development deviation ledger

Related: [virtual project design](../specs/2026-09-09-virtual-project-design.md) and
[implementation record](2026-09-10-virtual-project-implementation.md).

This ledger records deviations from the design, prior understanding, or first-implementation
expectations. "Handled" means a targeted fix exists and was verified — never that the whole refactor
is done. GUI, real-remote and cross-platform checks that did not run do not count as passed.

Full history: git show 7db9b1e9:docs/superpowers/plans/2026-09-11-virtual-project-development-deviations.md

## Confirmed and handled deviations

### D01: first-membership rule was inconsistent within the design

The old body text said "multi-match → primary directory first" and "unmatched → timeline only"; the
§3 ruling record requires: only a unique match is adopted, everything else goes to the task area.
The membership-judged bit distinguishes a legal NULL from not-yet-judged so later startups never
move sessions again. session-management I17's old "timeline-only" wording is superseded.

### D02: task index had no versioned migration ledger, and the CLI number was taken

Shared migration runner extracted for both DBs; app gets `schema_migration` + `0001_projects`
(originally `v3_projects`, renamed per D98); CLI uses `0020_session_soft_delete_outcome`. Historical
SQL/checksums are never modified.

### D03: restoring table-level backups hit foreign keys on non-backed-up body tables

CLI `message`/`part` cascading FKs make a bare `session` delete able to wipe bodies, and disabling
foreign_keys inside the transaction does not protect it. Restore closes FKs first, then restores
backup columns in-transaction with row-count/hash/FK checks; only the migration record for that
restore is rolled back, new schema is kept.

### D04: declared touchedTables can be incomplete

`0019_dwf_journal` also writes `dwf_actor`, missed by the first declaration. Fix pattern: never
change historical migration SQL; build per-migration before-fixtures and compare full content hashes
of every table.

### D05: `node:sqlite` became `sqlite` in real bundles

tsup strips the `node:` prefix by default, producing a non-bundled third-party module name. Node
build configs must set `removeNodeProtocol: false`. Static type checks alone did not catch this.

### D06: workspace identity in the remote DB is not a stable physical host identity

Source Server may keep historical SSH/WSL canonical routes; multiple old addresses of one server
would look like different hosts. A trusted Source Server startup entry injects a stable `host_id`;
historical canonical workspace keys, real cwd and config hashes are kept, identities are not
bulk-rewritten.

### D07: Server Core startup order bypassed the migration barrier

Server Core created business services before resolving Source identity. Now: resolve the stable
Source identity first, create services and open RPC only after the app DB migration succeeds;
failure stays closed.

### D08: new-session membership cannot wait for the first facts

Facts may arrive before CLI creation confirms, triggering default first-membership, and retries
could overwrite a user move. The Host reserves a stable session ID by command identity and writes
membership atomically before sending to the CLI; reserved rows without `cli_created_at` are
invisible; repeat reservations never change existing membership. Other creation entries were wired
later (U03).

### D09: first-facts initialization was too broad and reset display config

Only rows that do not exist, or explicit empty reserved rows (no CLI time and old created_at = 0),
are initialized from first facts; pin/archive/unread/title intents recorded meanwhile are kept.

### D10: pinning with a full roots payload overwrote concurrent edits

`saveProject.roots` became optional; pin submits only id + pinned; the transaction keeps current
roots and name ownership.

### D11: the CLI last outcome cannot be rebuilt from trimmed turn headers

Trimming or cold resume can leave a draft/short projection. The CLI store's `last_outcome` is the
sole source; cold resume reads the persisted value; terminal events update projection metadata only
after core persists.

### D12: a generic whole-row writer survived as a second facts entry

`syncTaskMeta` (called by resume/import/create/automation marking) allowed facts and organization
state to mix again, and a JSON-only Claude import could create index rows. Both deleted; writes are
split into CLI facts / organization state / display cache; Claude import must first create a real
CLI session. Old auto-archive / workspace batch-archive APIs without production callers deleted.
Test fixtures set CLI facts and organization state explicitly — no test-only production writers.

### D13: metadata reads moved to new columns but list SQL still sorted/searched old ones

Lists, search and automation ordering now use the CLI mirrors; legacy fact columns serve only
migration and downgrade double-write; the Host title override stays a legal display rule; reserved
rows without persisted facts never appear in query results.

### D14: old tests asserted deleted behavior as premises

Keep the valid coverage (dedup, sorting, unread CAS, remote queue, model restore); fixtures provide
CLI facts explicitly; tests for deleted Group features retire with them. Never satisfy assertions by
restoring old code.

### D15: request-based reconcile can arrive after newer streaming facts

Facts entry keeps only in-flight request generations; new frames, deletes, or newer requests revoke
an older response's right to land; generations are cleaned when the request ends; no extra session
state cache. (Referenced by the residual-cleanup pending ruling about the SQL merge in
`applyCliFacts`.)

### D16: the CLI alias list missed new migration subpaths

Hand-maintained shared subpath aliases broke the CLI bundle build. Aliases are now derived from the
shared package exports (generic entry last), with a build contract test covering all exports.

### D17: the cold project tree still labeled unknown outcomes as completed

Migration maps only explicit historical terminal states, everything else NULL; new facts accept only
the CLI's `lastOutcome`; cold projections keep "unknown". Old JSON identity never overwrites a row's
primary-key identity.

### D18: old E2E readiness depended on deleted workspace sidebar nodes

Readiness is judged via the real tab store's target cwd and a visible pane; creation cases wait for
the action button instead of a cwd the previous case switched away from.

### D19: the project repo could be pointed at another Host by the caller

Repo reads/writes are restricted to the owning DB; cross-Host requests route through explicit hostId
via the existing connection manager and fail offline; remote tree reads reuse the workspace identity
resolver; no source-settings mobile attachment or extra runtime is created.

### D20: old native creation entry and ID protection blocked membership reservation

Host native/V4 creates all go through reservation (default explicit NULL); every CLI create shares
an ID-occupation check rejecting persisted, in-memory and in-flight duplicate IDs (occupied before
async materialize, released on completion); explicit imports allocate a new CLI identity, the old
hash is only for historical backup repair.

### D21: scheduled/off-peak definitions carried only cwd, and creation re-read current roots

The Host resolves and stores project, owner, cwd and a directory snapshot at definition creation
(failure precedes number allocation); dispatch/retry/resume pass the stored values, an explicit
empty array never falls back; reservations with a snapshot keep validating the existing same-Host
project but not current roots; the project concept never enters the CLI.

### D22: the new sidebar passed a React click event as the navigation automationId

`TypeError: e?.trim is not a function` in real Electron. Event boundaries must call business
callbacks with no arguments; no type-guessing fallbacks in navigation.

### D23: manual cold resume of auto-dispatched sessions still read the current project

The first membership reservation of a generated session writes an immutable
`tasks.execution_directories` in the same transaction; all three cold-resume entries read it; plain
sessions stay NULL with dynamic resolution; retry and definition deletion never touch the snapshot;
old definitions migrate to explicit `[]` (never widen old permissions from new project roots).

### D24: historical shadow hosts occupied connection slots; identical caches re-broadcast

Old task shadow migrations produced `target_json=NULL` identity placeholders that looked like ghost
connections against the 20-slot cap, and identical cache values re-broadcast on refresh (read-back
loop once auto-refresh attached). Only records with a connection target count as saved connections;
turning a placeholder into a connection re-checks capacity; consumers use CAS versions to reject
late responses without re-broadcasting.

### D25: startup reconnect evicted saved connections unseen for 7 days

The old candidate API filtered by recency; long-unused devices never reconnected. The age filter and
dead parameters were removed (still sorted by recent activity); "saved but never handshaked"
candidates join the same enumeration.

### D26: address-identity merging lacked member generations; old settings re-initiated removed connections

First-connection identity is address-based (SSH/WSL/Docker), stable Source identity exists only after
handshake; remove/re-add during connect let old responses land on the new member. Fix: the first
migration imports saved Profiles/Sources and merges address aliases; `membership_id` persisted; the
ConnectionManager acquires the member before probing and commits conditionally before publishing
online; startup/auto-recovery keep members only; Host candidates intersect the SQLite member table;
identity changes create a new independent Source after confirmation, old project entries keep their
owner.

### D27: remote global new tasks still got the shared default directory

Source management called `fileService.ensureConversationWorkspace`. Now the current online Source
connection calls the remote `projectService.prepareSession`: independent cwd per call,
`projectId=NULL`, original return protocol and Source path records kept, no extra runtime. Bound
projects and conversations both establish independent logical sessions.

### D28: multiple old directory entries resolving to one multi-root project hit the unique constraint

With entry-ID/version CAS, the same transaction keeps the resolved entry and deletes the duplicate
old entry; a cwd matching several projects stays "pending choice" (never guess); the sidebar
aggregates, selects and sorts by Host + project id.

### D29: the sidebar first read only the local tree; the remote cache had no offline boundaries

The local entry table controls the remote visible set; the online owner provides its projects/tasks;
offline means basic cache plus local entry removal only (never touching remote data); reads re-check
the membership generation before committing; node operations carry hostId; connection-state changes
reuse the existing broadcast for re-reads.

### D30: parallel typecheck overwrote the E2E host bundle

`tsconfig.host.json` emits into the same `out/host` as tsup; typecheck replaced the bundled
`index.js` and Electron's Host fork exited in ~126ms. Verification order is serial: typecheck →
full build → E2E; nothing that rewrites `out/` may run during an E2E run; UI waits were not
stretched to mask Host failure.

### D31: directory resolution validated row/project consistency but not the owning Host

Old remote shadow rows stayed in the local DB. Directory resolution compares `row.host_id` with the
repo owner in the same read transaction before returning init directories; creation retries reuse
the path.

### D32: owner-only clients have no Controller entry table, and aggregate reads failed wholesale

Owner-only `readDirectory` returns an empty directory without DB access; the service factory forbids
Controller writes via trusted assembly parameters; `projectService` keeps reading the current
owner's authoritative tree; no Controller data copies.

### D33: workspace double-forwarding missed the new project channel; a proxy object proves no support

The server handshake declares an optional `virtualProjects` capability; new Hosts forward
project/remote-projects based on it; the v1 required channel set is unchanged. The legacy
single-root server adapter is still unimplemented — being connectable is not "G1 done".

### D34: remote prepareSession returned a directory but lost the stable identity for navigation

The Host identity assembler registers and returns `workspaceIdentity`; Root routes explicitly by
hostId; the remote binds a logical attachment via the existing connector before writing drafts under
that identity; path-only local fallback is forbidden; mobile uses only the shared-host switcher,
never native connect.

### D35: workspace activation pre-warmed a project-less draft

The open-project intent carries an optional `draftProjectId` set in the same activation callback, so
an instance with wrong roots is never started first and then overwritten; the CLI create still
consumes only Host-resolved directories, never a project id.

### D36: clicks during dialog exit were intercepted by the root element

Real cause: global pointer-lock residue — the dialog closed, the menu exit animation ended, `body`
pointer-events stayed `none`. Product fix: the project menu is non-modal, the edit dialog holds the
modal exclusively; tests wait for dialog exit before the next interaction (no fixed sleeps, no
bypassing DOM clicks).

### D37: remote tasks without an open tab cannot use workspace-scoped list operations

Reuse the Window Controller `mutateTask`: first query the unique Source owner row to validate the
address, then call the original task service; rename is a new intent handed to the CLI; the physical
Source list scope may exist without a logical attachment but needs Source id + workspaceIdentity;
never fabricate a remoteSessionId or switch tabs; opening the task still goes through the existing
connect/bind chain. The Group-only `getGroupedTaskFacts` was deleted.

### D38: old list aggregations and components remained whole after the sidebar swap

Deleted with knip + dep:refs evidence: old Timeline/Pinned/Archived, Sortable/WorkspaceSidebarItem,
workspace task aggregation hooks, old group sort/collapse helpers and their tests. Kept: workbench,
search, common task rows, Controller, and global query capability still having consumers. Stabilized
task-row references (taskListItemStabilization, stable event-function identity) so tree refreshes
don't repaint every row.

### D39: async member commit vs socket publish lacked a unified ownership check

After every admission await, re-check cancellation and physical owner; all unpublished connections
release in `finally`, only successful publishing hands over to the map; close callbacks affect only
actually-owned online objects; errors after Profile removal never recreate failed rows.

### D40: draftSessionId had no production writer but kept remote service and close branches

Field, setter, legacy close logic and the scoped session service deleted; invalidation stays keyed
by workspaceIdentity and owned by the V4 pane prewarm lifecycle; side panels use the official
activeTaskId / empty-draft-membership semantics.

### D41: the settings file lock protected only the final write, so Hosts overwrote each other

Read-and-merge happened outside the lock; each Host assembled full JSON from stale values and the
later writer erased the earlier patch. The file lock now covers the full read-modify-write (the
duplicate rename queue is gone); the project set derives from one SQLite snapshot; the renderer
writes only the active directory. F5's entry derivation must stay inside this boundary too.

### D42: old startup restore treated all conversation directories as one canonical cwd

The new restore follows only `lastActiveWorkspace` and keeps assigned cwds; the old canonical
cleanup applies only to unmigrated settings; main no longer picks three extra Agent warm-up targets
from recentProjects.

### D43: old server directory history could not restore Controller-kept entries

The legacy server adapter accepts the roots/old cwd of entries still kept locally via a read-only
port (as addressing info for old task APIs); after upgrade, entries resolve real project ids by
original entry id/version CAS; multiple same-root projects stay unresolved; project edit/drag is
disabled in that UI; task commands still route to the remote owner. Real old-server binaries remain
unverified.

### D44: URL servers bypassed SourceManager; address and stable identities mixed

URL connections lived only in WindowRemoteConnectionRegistry. The Registry gained connect/read
entries that create no workspace, reusing member CAS and CredentialService; the first handshake
fixes the serverId, then upgrades to the stable-identity constraint; no second connection map or
fake logical session.

### D45: the schema gate missed auto UNIQUE, CHECK and literal case

Auto-index SQL is NULL in sqlite_schema and PRAGMA hides CHECK; whole-SQL lowercasing also swallowed
case changes inside WHERE strings. The gate compares old-table CHECK and auto-unique column
order/collation/direction and compares SQL tokens preserving string case; additive constraints on
old tables are rejected so downgrades cannot write restricted data.

### D46: GUI assertions mistook the tab instance id for the post-reload directory identity

Assert on the stable directory identity (`workspaceIdentity`/`workspacePath`), not tab ids.

### D47: the project tree's live subscription covered only the local scope

Remote projects showed persisted rows without running/waiting states. Fix: reuse the shared
WindowControllerTaskListRegistry snapshots, reading only online activity; kept-task cwd/roots
register via the original listTaskList observation path and never enter the project tree; direct
owners without a Controller keep their own sessions-index scope. Same path with different identity
must not cross; unknown tasks add no rows; no loop refreshes.

### D48: the plain HTTP dev entry did not match ServerCore's project owner identity

Unified `createServerHostServices` assembly, storage owner, handshake capability and workspace
identity mapping for `entry-http.ts`.

### D49: remote project change events were not wired into the local entry read path

Another client's changes never notified this client (workspace collection uses local broadcast).
SourceManager and the URL Registry's physical connections each hold a remote project broadcast
subscription that forwards only re-read notices; late events are dropped by connection owner;
subscriptions released on disconnect/update; no extra project state stored.

## Open or unverified items

### U01: local legacy remote shadow data vs the "remote-authoritative DB" boundary

Migration creates only the current owner's authoritative projects; old remote shadows and Group
members stay in their original tables as evidence. Wired: entry removal/re-add/CAS refresh,
connection members, F5 settings derivation; URL metadata and local mobile shared-host GUI passed.
Still lacking acceptance evidence: real old server binaries, SSH/WSL, real remote mobile execution —
the remote migration is not declared complete. Acceptance: read the remote authoritative projects
after connecting; removing the local entry never deletes remote data; late refresh and restart
never rebuild entries.

### U02: where the migration barrier sits between desktop main and CLI startup

Main runs a one-shot storage-migrate (via the existing executable resolver) before services/windows;
the CLI upgrades its own DB at startup with the same runner and closes it before serving; strict
JSON and exit code 0 gate the pass; failures reuse the retry/backup/exit interaction. CLI paths keep
resolving via `storage.sessionDbPath` / `ZCODE_SESSION_DB_PATH`; `ZCODE_DATA_BASE_DIR` is not a
substitute CLI history-DB path and old files are not migrated.

### U03: product-entry implementation and acceptance status

Wired: global/native/V4 creation, scheduled/off-peak local project binding, bot project binding and
Host routing, settings roots directory, composer project references and multi-root file candidates,
desktop and mobile project navigation. Deleted: old Groups, draft session id, bot main bridge, two
reader-less remote list caches. Scheduled/off-peak creation stays local-only and mobile has no
settings page — existing product limits (D72/D76), not "remote cannot create projects". URL real
remote agent create/attach/reopen, local multi-dir full process recovery, independent old-source
four-phase upgrade and URL remote agent cold recovery all passed; final unit/typecheck/lint/
architecture/format gates passed. The latest mobile regression is limited by D91's environment.

### U04: evidence boundary of GUI and real-remote verification

Passed (all still manual-review/pending): desktop project combos (URL metadata, settings unopened
root, bot authorization), dual-root composer, 390px mobile draft reload/submit/switch/reopen over a
real relay, URL real remote agent execution, local multi-dir full process recovery, old-source
four-phase verification. Unverified: real remote bots, old server binaries, SSH/WSL, mobile remote
execution — unit tests do not substitute for these.

### U05: environment evidence boundaries

CodeGraph had no workspace index — targeted retrieval and dep:refs only. Some CLI bootstrap tests
consume built adapter artifacts: rebuild the package after source changes or the old dist lies.
The pre-existing untracked `packages/remote-desktop/` is out of scope.

## Entry format

New entries keep the `Dxx` (confirmed) / `Uxx` (open or unverified) scheme recording expectation,
reality, cause, handling, verification and status changes. New design rulings update the spec first
and link from here; "not implemented yet" is never written as an accepted design change.

### D50: the settings service read HOME dynamically during async operations; test cleanup wrote the real settings

A Server Host integration test restored HOME on exit while a background settings projection kept
writing; the real user `setting.json` received test data (recentProjects/lastWorkspaceSession
replaced). Recovery: fields restored from the last app settings log entry (not a full pre-test
snapshot — byte-identical history is not claimed), current lastActiveWorkspace kept, activity index
recomputed. Standing rules: instances pin their settings path; subprocess isolation instead of
timing guesses for background completion. This incident must not be erased from the completion
record.

### D51: a fresh URL server workspace had no acceptable initial canonical identity

`resolveWorkspace` required a legacy route hint that URL servers cannot provide. Server assembly
supplies its own stable identity when the hint is absent; new aliases accept legal server routes;
existing alias/history-key priorities unchanged.

### D52: config scope was decided by open tabs; tab-less remote configs lacked identity admission

Plugins/Hooks/Subagents enumerated candidates from connected tabs (Plugins even fabricated an active
workspace tab), so a project root without an open tab never appeared. The managed
workspace-config-catalog uses `readProjects` + locally kept entries, deduplicates by real
directory/full identity, and closing a tab never removes a root; config targets are address-typed
(no fabricated tab/session); remote config reuses Source settings attachments bound to the canonical
key via the workspace alias contract before writing; membership/entry validated around reads; mobile
without Source settings rights keeps the shared-host workspace boundary.

### D53: scheduling definitions added during a downgrade missed the first migration

The first-run-only v3 migration could not see definitions added later by an old version. Every
startup now hands over `host_id IS NULL` scheduling definitions in one transaction; the single-root
match is decided exactly once; extra directories stay legacy `[]`; NULL projects, saved snapshots
and cwd/canonical keys are preserved.

### D54: menu animation made getElementText return empty; the GUI assertion read too early

Wait for the target root's text to be visible before counting matches; no fixed sleeps, no product
changes.

### D55: bot candidates relied on old tab history and readContext rewrote cwd

Candidates reuse the project directory contract; the bot Repo is the sole store of the execution
snapshot; old context is handed over exactly once, cwd kept, ambiguous membership stays NULL; the
old candidate cache and the constant cwd rewriting were deleted (spec 6.0.1).

### D56: whole-write bot state lost concurrent bindings

A controlled run confirmed the lost update (two webhooks, second write erases first). The Repo holds
a per-context file lock over the read-modify-write; initialization CAS, command updates and the
provider cursor share that entry; commands never overwrite the independent cursor field; deletion
no longer writes back whole old state. Shared-object test stubs had masked the race.

### D57: a bot GUI regression hardcoded the Chinese remote-control entry

The test environment's locale is `system`; match existing zh/en texts, never assume a language or
add fixed waits.

### D58: the bot main bridge used logical workspaces and old history as connection sources

Replaced: the window Host injects the existing Source connection with explicit `connectHost` and
membership/physical-generation admission; the old bridge, runtime port adapter, dedicated IPC and
UI backfill were deleted; task owner/lease, CommandInbox and the mobile shared-host attachment were
untouched.

### D59: bot legacy canonical was not mapped to a stable Host; binding compared only project ids

The first handover resolves the stable hostId via the entry (keeping the original canonical/cwd);
later passes carry the fixed hostId; a stable server identity conflicting with the hostId is
rejected; membership id and entry id are validated before and after binding.

### D60: the sidebar swap dropped the current workspaceIdentity

Shell → ProjectSidebar → Footer pass the current identity explicitly; the remote-control entry
reuses the existing scope; identity is never re-derived from cwd.

### D61: the mobile project's new directory was not in the old bridge list; drafts died on Root replace

Spec 6.0.3 defines the unified Host prepare + online-connection admission; main only forwards the
descriptor; mobile stays replayable. The managed project-workspace-navigation covers: online Source
without a tab, offline connector rejection, scope rollback preserving the desktop owner, and
entry/physical-generation changes.

### D62: navigation requests left pending too early after the directory returned

A request stays pending until full admission and the first config sync complete; window close,
cancel, Host exit and shutdown end it; late results deliver only to a caller still holding the same
request and scope; no second task-state copy.

### D63: the old mobile bridge had no project intent or navigation dedup

The strict project intent carries only projectId/hostId; the same bridge transport identity reuses
the whole admission promise; a new navigation invalidates old requests; cancellation hits only its
own requestId; the new Root initializes project/provider/input before releasing bootstrap; old
mobile peers without admission are explicitly rejected (never a second runtime).

### D64: the real mobile home still mounted the old workspace task home

Narrow screens share the same sidebar entry as desktop; the mobile shell owns only home/chat
navigation and overlays; the old home, its grouping/sorting/model logic and model-specific tests
were deleted.

### D65: dep:refs under-reported alias consumers

`pnpm dep:refs` returned 0 references while a live `@/…` import existed. `References (0)` is never
proof of deletability; cross-check with a full-repo import/symbol scan first.

### D66: mobile directory-scope join and invalidation boundaries were missed

Join shares the same config barrier and pending-owner checks; the desktop commits along the original
renderer-ready path; deduplication never overrides an existing bridge invalidation; a stale bridge
retry after Source replacement never returns an invalidated descriptor.

### D67: opening an existing mobile task still required the old workspace list

The same Host directory admission reads and validates an existing task's address; binding
directories are restored via `resolveSessionDirectories`; `prepareSession` never allocates a
directory for it; main only passes the task intent and Host descriptor through.

### D68: the VP13 extension regression timed out at relay pairing

Two early failures at mobile relay admission had an undetermined root cause; diagnostics were added
(origin/open/close markers, CDP) and a later round passed. One pass does not claim the intermittent
network/dev-server issue is gone.

### D69: the composer still used the old workspace/sessions-index candidate chain

Providers reuse the current Host's ProjectService contract; files are read by the same Host's
fileService with absolute-path dedup and display root names separated; the old tab enumeration and
sessions-index row-set path were deleted; multi-root same-name files no longer overwrite each other
(spec 6.0.4).

### D70: VP14 used a native clear without confirming the Lexical state had emptied

Reuse the existing Lexical E2E bridge to write and confirm editor state; product mapping untouched.

### D71: mobile Root rebuild did not restore the draft's project membership

Optional project membership is persisted with the existing workspaceKey draft scope and restored by
mobile before prewarm; the original promotion/cleanup is reused; promotion never copies organization
state into Session drafts; no business state in main/relay.

### D72: remote scheduled/off-peak creation was wrongly listed as a must-do

Existing product docs (off-peak spec, scheduled-tasks view) restrict scheduled/idle-time creation to
local projects; old remote tasks stay manageable; mobile hides the entry. The virtual-project H1
ruling only bound virtual projects and froze directories — it did not lift the remote restriction.
The limit is not new, and "no remote scheduling" is not a feature gap. Remote projects and plain
remote conversations are unaffected.

### D73: the cleanup audit still found a consumer-less scratch creation chain

The old dialog, its helper tests and the empty callback chain (Root → App → Shell) were deleted;
the standalone fileService public IO method stays.

### D74: two remote renderer list caches were write-only

remotePinnedTaskStore / remoteTimelineTaskStore had no readers; connection-completion waited on
them and the Header kept optimistic/rollback copies. Caches, the refresh port, the write calls and
the Header copies were deleted; the task query projection consumed by Header/global search stayed;
H4 global-search semantics untouched.

### D75: scheduled/off-peak project selection read the whole task tree

`readProjects` (read-only catalog) instead of `readTree`, which also pulled tasks into the
auto-archive path.

### D76: the H2 mobile settings directory was wrongly listed as pending

Mobile `/remote` has no settings page (settings-sidebar-layout doc); Source settings attachments
are desktop-only. H2 keeps desktop/web; mobile verifies only existing task/draft and replayable
boundaries.

### D77: combined pending replay omitted the explicit fixture parameter

Replay mode requires an explicit fixture; the runner rejects an implicit default capture.

### D78: task rows allowed only copy; the browser refused the project-move drop

Task rows allow `copyMove`; project move and workbench copy keep their separate semantics; a
missing-root cancel changes neither membership nor roots; a confirmed move is atomic and the session
cwd is preserved.

### D79: cold-restart helpers waited for a default directory that must not open

Restart helpers wait only for the workspacePath they explicitly request, reusing the process-exit
and profile-flush barriers; product startup behavior was never changed for tests.

### D80: the independent old checkout's test launcher had no tsx entry

Load scripts with the currently installed tsx loader while resolving all business modules from the
target checkout; compile old CLI contracts in the old checkout; never symlink new workspace packages
into old code; fix all three data-path env vars to one isolated HOME before each process.

### D81: the cold-recovery follow-up was rejected by the replay service

Root cause: manual-review fixtures default to a 240-token contextWindow, triggering auto-compact;
the unmatched request was the maintenance summary (`CRITICAL: Respond with TEXT ONLY`), not the
plain COLD reply. The case uses a normal 128k window instead of widening matchers or changing
recovery logic.

### D82: two existing web transport wait timeouts under parallel full tests + GUI

Isolated reruns pass on both the current and pre-refactor checkouts; load correlation is a
hypothesis only. Timeouts were not loosened and no root cause is claimed.

### D83: the URL metadata test server did not open the provider initial-sync channel

The fixture must match production ServerCore (`providerProvisioningTargetEnabled: true`) instead of
copying provider config files by hand; not a project-directory or agent failure.

### D84: the remote project's authoritative cwd was re-realpathed by the plain directory pick

Project drafts and history tasks carry the original identity through open-project/Host binding,
skipping the renderer's second path resolution; plain folder selection keeps the canonical resolver.
Existing task cwd, Host admission, exact identity checks and continuous/replayable are unchanged.

### D85: URL execution succeeded but the project membership and extra directories were missing

Located by observation (renderer draft had the right projectId; Source `createSession` did not):
`ReplaceableConversationTransport.sendCommand` still had the old single-argument signature and
dropped the new context. Fix: forward the original parameters across proxy generations; no inferred
or server-side compensation writes. Library evidence must be saved inside the case `finally` before
cleanup.

### D86: the old branch unconditionally cancelled a passed-in attachment when reusing a remote tab

`selectRemoteWorkspaceProjectFromDialog` cancelled `sessionId` after tab reuse without checking
ownership. Only cancel when it is a temporary attachment, not the tab's current owner.

### D87: remote E2E selected an unpublished prewarm reserved row from the raw tasks table

Raw `WHERE project_id=?` hit the earlier reserved row (`cli_last_outcome=NULL`); the UI contract
never shows unpublished reserved rows. Wait and read by the executed task's condition
(`cli_last_outcome=completed`); never show reserved rows to please a test.

### D88: the cold-recovery test clicked a not-yet-enabled send button after seeing cached bodies

Wait for the real send-state barrier; never change product timing or add fixed sleeps.

### D89: a late cross-runtime ACK was correctly rejected, but recovery classification missed the error

Transport rightly discards the cross-generation ACK; ProjectionStore's known-runtime-recycling
classification lacked `fault.subscription.runtimeRestarted`, so the UI stuck on the error page. Only
that exact error joins the existing bounded resubscribe flow; old-ACK discard, single-subscription
owner and the retry budget are unchanged; no new timers/queues, no command replay.

### D90: the hooks catalog E2E waited only for the last option's text

Concurrent getText calls returned empty during animation; wait until all roots' texts are visible,
then assert exactly one item per root.

### D91: the mobile regression was rejected by the external relay's TLS certificate check

CDP saw `net::ERR_CERT_AUTHORITY_INVALID` on `wss://zcode.z.ai`; the issuer is the local Proxyman
CA. TLS validation is kept; no proxy/trust changes were made; the anomaly is not claimed resolved —
the latest mobile rounds still fail at the same handshake and the earlier passing mobile rounds
remain the standing evidence (HTTPS success ≠ the WSS anomaly gone). Distinct from D68.

Final gates at freeze: affected unit tests 1724 files / 14942 tests (2 files / 14 skipped);
typecheck 87 passed; lint 48 warnings / 0 errors; architecture violations/baseline/new all 0;
changed-file format and `git diff --check` passed.

### D92: user acceptance found the UI and creation flow deviating from the old version

Missing local/remote selection, section collapse/drag and hover actions, a permanent ellipsis on
project rows, and a bottom connection entry. Restored per the user's screenshots and the old app's
behavior; the timeline only hides entries; the Host data-ownership abstractions were kept.

### D93: empty Groups were reverse-migrated into empty projects

`migrateGroups` created an empty project when `hosts.length === 0`, contradicting "no session, no
migration". The first migration now handles only undeleted members; locally, 11 wrongly generated
empty containers were removed after verification against the original backup
(`~/.zcode/backup/empty-group-repair-20260911-gq2grh`); hand-created empty projects are never
deleted by Group name.

### D94: correction-regression test issues and connection lifecycle

Lessons: selectors must be valid and bilingual; offline fixtures must wait for workspace readiness
after reload; remote selection must target the intended Host, not the first list item; the creation
wizard needs a connection-complete callback and temp-attachment release when reusing an existing
connection dialog.

### D95: cross-platform boundary of project directory selection

The first version reused Source settings attachments (desktop-only). Now routed through
`projectService.readDirectory(hostId)`; the Host assembly reuses fileService/systemService; the UI
DirectoryBrowser never guesses owner from the current tab or platform; no project-DB reads, no
workspace/agent creation. Adding one public query intent exposed 4 internal ports of the old
read-only adapter in the public contract — moved back to the private implementation (dep:refs
evidence), keeping 9 public methods without raising the gate threshold.

### D96: post-correction mobile acceptance still limited by relay TLS

Desktop 9/9 and the full 6-file rebuild run 14/15 (only mobile VP13 blocked at
`net::ERR_CERT_AUTHORITY_INVALID`). Desktop passing or desktop-narrow screenshots never substitute
for mobile shared-host acceptance; TLS stays on.

### D97: responsive screenshots must restore the real theme and sidebar state

Viewport overrides auto-collapse the sidebar and clearing the override does not re-expand; toggling
the dark class alone does not switch Zai theme variables. Tests use the existing setTheme entry,
wait for `theme-zai-light/dark`, re-expand via the real sidebar button, and check real panel widths.
Also found: "add connection" stayed clickable on a saved Host connection, starting a second flow —
the entry is disabled via the existing connecting state (no new state or queue).

Final UI-correction verification: desktop E2E 9/9 including real remote create + directory
selection, task execution/reopen/CLI cold recovery; 1200/390px and Zai light/dark layout
assertions; unit tests, typecheck, lint (48 pre-existing warnings / 0 errors), architecture
(baseline/new/violations 0), format and diff checks passed. Ownership: project-sidebar owns
form/collapse UI state; the project service routes Host intents; project-storage does the legacy
conversion; directory IO reuses the Host-assembled file services; connections stay with the
existing connection manager; saving then adding an entry never falls back to local; no task copies
or queues added; desktop continuous / mobile replayable unchanged.

### D98: migration IDs follow the CLI numbering rule

`v3_projects` mixed a schema codename into the migration id; the correct id is `0001_projects`,
each DB incrementing its own sequence. Only declarations and startup/upgrade test expectations were
renamed; the SQL text (including the v3 comment inside the checksum input) is untouched, with a
pinned checksum assertion; no alias or second migration path for the temporary name. The rename was
executed on the real DB in-transaction after a backup and a dry-run on a copy
(`~/.zcode/backup/migration-id-20260911-cppLK7/`); checksum/app_version/applied_at and all 15
business tables unchanged.

### D99: the project row replication missed icon states and quick actions

The old WorkspaceSidebarItem used Folder/FolderOpen icons (no standalone arrow); hover must keep the
Ellipsis/ListTree/MessageCirclePlus quick buttons; the context menu only supplements them; the file
tree reuses existing components and Host binding (single root opens directly, multiple roots open a
chooser, zero roots disabled). Tests wrap the rows in the same TooltipProvider the real app
provides.

### D100: returning from the file tree lost the project collapse state

The file tree replaces the list and unmounts ProjectNode, whose internal useState resets. Collapse
values moved to the persistent sidebar keyed by Host + project id; rows render the controlled value
and emit toggle commands — a single UI owner.

### D101: the editor lacked the directory-list form and a delete entry

Added a compact directory list, set-primary action, and a bottom soft-delete, reusing the existing
services and ownership (getPathLeaf, saveProject/deleteProject/prepareSession); no new
directory/task deletion logic.

### 2026-09-11 product-experience retention regression

The refactor had dropped: sorting priority/preference, pagination, collapse memory, selection
highlight, archive exit, pin feedback, file tree and mobile marks, remote menu/diagnostics, top
selection state, and the collapsed unread dot. Ruling: old Groups are not restored and expanding a
project does not enter a directory draft; every other old behavior is kept, plus the unread dot next
to the collapsed project name. Additional finds and rules: pinned rows must be passed to TaskList
too (not just pinnedTasks, or the pinned area drops rows); remote diagnostics project the current
error from the connection owner instead of status-only; mobile task file trees must wait for the
existing shared-host attachment switch and drop late results after close; connectProfile must carry
`TransportContext.onLog` so project reconnection shows real probe/upload progress (the connection
manager stays the sole owner). In-flight pin releases when the command and the current refresh
complete — never on "ACK + value equals expectation" (a concurrent unpin would be shadowed forever
by the intent). Copy must be bilingual; screenshots must read the real panel width. The mobile VP13
round of this pass paired over a real relay but the page showed `AUTH_FAILED / 手机连接已失效`
(distinct from D91's TLS error): real mobile create/file-tree/access marks remain unaccepted, and
desktop narrow-screen or component tests never count as the mobile chain passing.

### D103: the first migration lost the old settings' project order

The old UI restored order from lastWorkspaceSession; the migration's unordered DISTINCT-into-Map
then append of settings let history directories jump ahead. Fix in project-storage's first
conversion only: take settings order first, then history directories and valid Groups; the DB is
never re-migrated or user drag order overwritten; `projects.position` remains the single Host-owned
order; recentProjects is not the sidebar order source.

### D104: local machine restored to the old input for a user-driven first-migration retest

Read-only audit showed the local position data was already the wrong migration result and the
current setting.json was reverse-derived from it — unusable as pre-upgrade input. On the user's
explicit instruction (accepting partial recent-data loss), both DBs and settings were restored from
the complete snapshot `~/.zcode/backup/session-projects-20260909-141705/` (later re-restorations
under `~/.zcode/backup/project-migration-retest-20260911-*` and
`cli-migration-retest-20260911-*` with manifests): files replaced offline with SHA-256-verified
copies, quick_check/foreign_key checks passed, no hand-edited positions, ids or ledgers; the old
snapshot's CLI ledger (`0019_dwf_journal` checksum difference, foreign `0020_dwf_run_result`) was
preserved as real old input rather than dodged. The app was not started and no migration was run —
restore success is not upgrade-acceptance success; the user retests manually.

### Project collapse animation and task-row file-tree correction (VP29)

The new rows conditionally mounted content and bypassed the shared Collapsible animation. Fix:
reuse the original component and collapse preference; scope the group selector by the current
content's data-state (the same-name group selector also matched the outer partition's open state
and overrode exit). The session row's file-tree button was removed; the project row's file view
stays.

### Input project selector gap (VP30)

The composer selector had been missed by the refactor: it saw only opened tabs, truncated to 5
items and keyed by cwd. Now it shares the project catalog and sorting, matches by identity, name
and roots, and searches with the copy “搜索项目” (search projects); the candidate list scrolls
independently of a fixed menu height so the footer entry is never cut off.

### Same-name historical tasks: unread illusion and missing detail title (read-only investigation)

Two independent causes. (1) The detail header still consumed old workspace/query-cache metadata and
a swallowed lightweight-snapshot failure, so a same-name task showed the default title — later fixed
by reading the workspace-scoped `getTaskMeta` from the Host index, decoupled from V4 body restore,
with `remoteSessionId` added to the read eligibility (service object + workspaceKey + taskId alone
miss an attachment rebuild reusing the service). (2) Clicking an old unread task cleared the unread
bit, the sidebar refresh ran `archiveInactive`, and the 28-day-old completed task met the 7-day
archive rule — the blue dot "never disappearing" was the next same-name unread task taking its
place. Whether the currently viewed task should be protected was settled in the auto-archive
interaction contract (see the 2026-09-11 fix and the 2026-09-14 entry), not by restoring old unread
caches.

### Archive management implementation

Settings and WorkspaceShellLayout are siblings — ProjectDirectoryProvider was lifted to the shared
RootWorkspaceContent so nested providers reuse one read owner. `deleteTask` delegates to the CLI's
`mutateSessionFacts(delete)` soft delete (its old "list-hide only" comment was wrong); no local
tombstones. The archive surface: real update/creation-time sorting, virtual-project filter,
unarchive write-back, delete confirm/cancel, `time_deleted`/`cli_deleted` persisted, post-reopen
results, search-scope batch delete, group unarchive. The middle dropdown is the sort mode only —
task-type classification was removed.

### Current-task title and auto-archive fix (2026-09-11)

Kept the existing 7-day lookback rule; no "currently viewed task exempt from archive" exception.
The Host tree accepts an explicit unarchived→archived change via `removeTaskState`, so the list and
the open detail leave together; a first read of archived history remains viewable; a missing row
offline is not "archived". Unread CAS logic was correct and unchanged. Titles: `getTaskMeta` from
the Host index; the CLI stays the sole title writer and the Host a mirror; no schema/migration
changes.

### Auto-archive trigger decoupled from the project tree (2026-09-14)

User report: a session became unopenable — clicking it cleared the unread bit, the sidebar's
`readTree` refresh then archived it (completed > 7 days ago, previously protected only by being
unread) and `removeTaskState` kicked the detail back to the draft. Ruling: archiving is never
triggered by clicking a session. Implementation: new Host scheduler
`packages/services/src/project/autoArchiveScheduler.ts` — first scan after service assembly, hourly
thereafter, plus rescans when `taskAutoArchiveEnabled` / `taskAutoArchiveOlderThanDays` change;
scans are serial, concurrent triggers coalesce into one rescan, and desktop-attached-remote does
not start it. `readTree` lost its `autoArchive` side effect; the never-injected `beforeRead` entry
and the emitter-less reasons `auto_archive` / `realtime_sync` were deleted. AMT02 now reads: with
7-day archiving on, an already-read old task is archived by the settings-change scan and leaves the
list; opening an old unread task only clears unread and stays open.

### Auto-archive criterion changed to pure time-based (2026-09-15)

Old-criterion leftovers never left the list: 324 local overdue read-unarchived tasks had
`cli_last_outcome='error'`, 346 had no CLI outcome at all, only 6 were completed (read that day) —
"completed only" archived almost nothing. Ruling: archive purely by time; pinned unaffected.
`archiveInactive` dropped the `unread_at IS NULL` and `cli_last_outcome='completed'` conditions,
keeping the pinned/deleted/cli_deleted/host filters and the running-task (`activeTasks`) guard;
the scan interval went 1h → 5min; settings copy (zh/en): “最后活动时间超过保留期即归档，置顶与运行中不受影响”
(archive when last activity exceeds the retention period; pinned and running are unaffected).
AMT02 covers 28-day-old read and unread tasks archived, a pinned old task exempt, and a 6-day-old
task staying after being opened.
