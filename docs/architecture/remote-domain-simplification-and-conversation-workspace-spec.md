# Remote workspace projection and persistence compatibility

Current spec. The remote no-project chat UI is disabled; project entry, directory selection, disconnect and navigation recovery are defined by the [project navigation spec](../remote/project-first-remote-navigation-spec.md). This document keeps the compatibility-read and persistence constraints and no longer contains connect-and-chat design or finished implementation phases. The original plan, RCONV scenarios and review basis: `git show a17a875588b8d66c2bee49236292e174df651363:docs/architecture/remote-domain-simplification-and-conversation-workspace-spec.md`.

## Domain and state ownership

- Source identity, Profile, canonical key and migration follow §3 and §9 of the [R3 main spec](r3-source-server-remote-architecture.md).
- The physical device connection belongs to the Manager of the Window Host; the workspace attachment belongs to the Registry. Device online does not mean project ready.
- The UI's read-only join is provided by `RemoteWorkspaceProjection`; the five displayed states are in the [UX spec](remote-device-connection-ux-spec.md).
- `openWorkspaces` contains only remote workspaces; `executionContexts` may contain local and remote. Source fields must not be injected into local tabs.
- The workspace key is `workspaceIdentity?.trim() || workspacePath`; the path is for I/O, and name and connection method take no part in identity equality.
- Settings, Dialog and Sidebar reuse the same join and only filter by surface; none computes Source/attachment readiness on its own.
- Commands/controllers reuse existing Service/Manager/Registry; the current project connection intent is in the navigation spec, and the old `open-conversation` UI is not restored.
- Main/relay hold no task/session/stream truth; desktop continuous and phone replayable keep their own recovery boundaries.

```text
Source Directory + Host Manager/Registry + TabStore
  -> RemoteWorkspaceProjection -> settings / wizard / project navigation
explicit user action -> existing Controller -> Host authoritative service
```

## Navigation selection and compatibility projection

- The new version restores and writes back only `lastActiveWorkspace`, cleared with null; project/connection membership belongs to Host SQLite.
- `lastWorkspaceSession`, `recentProjects` and `lastActiveTabIndex` are degraded compatibility projections derived by the Host from committed membership; they must not serve as the new version's cold-start open set.
- Only an old-settings import lacking `lastActiveWorkspace` reads the old lists; the old active-first deferred back-fill must still prevent revival after close and failed restores overwriting persistence.
- The current Renderer live/disconnected tabs are a runtime navigation cache. A Source coming online only re-attaches the existing tabs; it does not recreate attachments for all directories from old compatibility fields.
- Explicit close releases only that window's attachment; it deletes no device, Profile, project membership, backing directory or remote task, and implicitly disconnects no whole device.
- Credential references in historical snapshots do not transfer ownership. History updates, capacity trimming and removal may only produce cleanup intents for `remote-workspace:` self-owned credentials; `connection-profile:` credentials are managed by the Source Directory and must never be deleted even if a re-projection removed the reference.
- Legacy fallback credentials are kept on rekey/restore; explicit close may only clean old credentials that are exclusively owned and not referenced by another owner.
- The current persistence fact source is [virtual project F5](../superpowers/specs/2026-09-09-virtual-project-design.md); device and window recovery: [Renderer re-attach](../remote/desktop-remote-session-renderer-reattach.md).

## 5. Persistence design

### 5.1 Near-term compatibility scheme

Keep `lastWorkspaceSession` as a degraded compatibility projection derived by the Host:

- a remote entry adds `workspacePurpose?: WorkspacePurpose`, defaulting to `project`;
- the new version restores by reading only `lastActiveWorkspace`; old fields do not overwrite Host project entries in reverse, and the Renderer and Web/Mobile do not write this membership projection;
- `sourceServerWorkspaceHistory` means only known **project** history;
- historical conversation backing workspace data is kept, but remote conversation entries no longer enter UI navigation or auto restore;
- target/credential keep the old fields for old-version compatibility, and new controllers resolve through the Profile first.

The entry schema of `lastWorkspaceSession` is a non-strict object, so old versions strip the unknown optional purpose and the field can evolve safely; an old version reading a remote entry without purpose still treats it as `project`.

### 5.2 Source history rules

`SourceServerWorkspaceHistoryEntry` **does not gain** `workspacePurpose`. The existing schema is `.strict()`; if a new version wrote a new field, then on rollback a single history entry's validation failure would degrade the whole AppSettings to defaults, and any later settings update of the old version could overwrite the original settings.

- project: keeps being written to `sourceServerWorkspaceHistory` and may appear in recent projects, project counts and the project picker;
- conversation: must not call ordinary `recordWorkspaceOpen` to write project history.

An AppSettings top-level field stores each device's resolved canonical conversation path as retained compatibility data:

```ts
interface RemoteConversationWorkspaceRecord {
  workspacePath: string;
  lastResolvedAt: number;
}

interface AppSettings {
  remoteConversationWorkspaceBySourceServerId?: Record<
    string, // sourceServerId
    RemoteConversationWorkspaceRecord
  >;
}
```

The field must sit at the non-strict AppSettings top level; old versions safely ignore the whole unknown field, and it must not be embedded in strict schemas such as `SourceServerRecord`, `ConnectionProfile` or `SourceServerWorkspaceHistoryEntry`. When the record is used, `workspacePath` is for remote I/O/display only; `workspaceIdentity` must keep being derived via the shared `buildServerRemoteWorkspaceIdentity({ sourceServerId, workspacePath })`, and the map key or a path suffix must not be taken as identity. Once an old version writes settings back it may drop the new field; after the new version connects to the Source again it must rebuild it idempotently and must not treat it as remote authority or an unrecoverable record. Explicitly deleting a device cleans the matching map entry; a plain disconnect does not.

Purpose must not be guessed from path prefixes such as `.zcode/workspace/default`.

### 5.3 Long-term R4 simplification

After the old-version rollback window ends, converge the open set to a reference-style structure:

```text
openWorkspaceSet:
  ordered workspaceKey[]
  activeWorkspaceKey
  per-key purpose
```

Device, route, known workspace and runtime target are no longer embedded repeatedly in the open set; they are resolved from the Source Directory + Profile. The current implementation does no destructive replacement and only builds a compatibility adapter first.

## Historical conversation compatibility and remaining migration

- A missing purpose defaults to `project`; historical purpose may be corrected only when a Source canonical record matches the path exactly, never by directory prefix.
- Disabling the UI does not delete the underlying capability, the canonical path map, remote sessions or task data; the UI no longer auto-restores from historical conversation open entries.
- The R4 reference-oriented open set and the cleanup of duplicated target/credential fields wait for the rollback window to end; keep old readers, and do not implement them as part of doc cleanup.
- The idle TTL of idle Sources is still an undecided product item, see R3-ISSUE-026.

## Acceptance boundary

Keep RCONV-08/12/13/14/15 protections for active-first, explicit close, rekey, partial-load write-back and non-owner/failed-restore; scenarios of the old connect-and-chat UI such as RCONV-01-05 are historical contracts and are no longer used for new product acceptance. Identity and multi-window isolation remain covered by R3 regression; stable IDs and evidence are in the [case catalog](../conversation-session-case-catalog.md) and the [coverage matrix](../testing/conversation-session-e2e-coverage-matrix.md). The doc cleanup did not re-run or promote any test status.
