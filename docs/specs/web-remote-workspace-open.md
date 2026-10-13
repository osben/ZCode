# Web Remote Control: Opening a New Worktree Workspace on the Desktop

## Goal and Scope

The phone/browser web remote client can complete the full Command Center "New task in worktree" flow:

1. Create the worktree over the existing RPC channel (`gitService.createWorktree`, the relay's generic RPC accessor);
2. Ask the **desktop** to open the new worktree as a workspace via the **new window-control request** `workspace-open-request` (reusing the desktop deep-link open chain; a parallel implementation is forbidden);
3. After a successful open, refresh the workspace list and attach to the new workspace through the **existing** `workspace-bridge` switch (`webRemoteControlWorkspaceSwitcher`).

Out of scope: the web client must not create its own Host (local workspaces are owned by desktop window Hosts — a hard architecture rule); the relay only forwards and schedules attachments and stores no business state; `allowOpenWorkspace={false}` stays as-is — arbitrary-path "open workspace" entries remain disabled, and the worktree flow (a directory the user explicitly created) is the single sanctioned path.

## Owners and Event Order

```text
┌──────────────┐   ┌──────────────┐   ┌────────────────────┐   ┌──────────────────────┐   ┌────────────────────────┐
│ Web client   │   │ External     │   │ Desktop Main       │   │ Desktop Renderer     │   │ Window Host (utility)  │
│ main.tsx     │   │ relay        │   │ webRemoteControl   │   │ (Root / tab store)   │   │ desktop window local   │
│              │   │              │   │ Manager +          │   │                      │   │ Host                   │
│              │   │              │   │ handleOpenWorkspace│   │                      │   │                        │
└──────┬───────┘   └──────┬───────┘   └─────────┬──────────┘   └──────────┬───────────┘   └───────────┬────────────┘
       │                   │                     │                         │                           │
  [1] gitService.createWorktree ──(existing RPC over bridge/relay)──────────────────────────────────────>│ local git
       │<── created ───────────────────────────────────────────────────────────────────────────────────┘
       │                   │                     │                         │                           │
  [2] POST /api/remote-control/windows/{token}/workspace-open               │                           │
       │ {workspacePath, workspaceIdentity?} ─>│ convert to window-control │                           │
       │                   │── workspace-open-request (zcode_type) ───────>│                           │
       │                   │                     │ validate runtime/window │                           │
       │                   │                     │ handleOpenWorkspacePath │                           │
       │                   │                     │── OpenWorkspacePath IPC >│ handleSelectProject:      │
       │                   │                     │                         │ activateOrSetWorkspace /   │
       │                   │                     │                         │ addTab + startDraft        │
       │                   │                     │                         │── syncWebRemoteControl ──> │
       │                   │<─ workspace-open-response {success} ──────────│   Workspaces (snapshot)   │
       │<── 200 {success} ─│                     │                         │                           │
       │                   │                     │                         │                           │
  [3] GET /api/remote-control/windows/bootstrap/{token} (bounded poll, limited retries)                  │
       │                   │── bootstrap-request ─> getAvailableWorkspaces │                           │
       │<── workspaces contains the new key ─────│                         │                           │
       │                   │                     │                         │                           │
  [4] POST .../workspace-bridge {workspaceKey} (existing switch chain, unchanged)                        │
       │                   │── workspace-bridge-open ──────────────────────>│ attachWorkspaceHost ─────>│ reuse/new attachment
       │<── bridge ────────│<─ workspace-bridge-ready ──────────────────────│                           │
       │ connectViaWebSocket(bridge.wsUrl)  -> renderBridgeRoot(new Root, initialWorkspaceAbsPath=worktree,
       │ no initialTaskId -> starts a draft)       [flow ends: new workspace + new task draft]
```

Ownership:

- **Worktree creation**: orchestrated by the web client; execution stays with the desktop Host's gitService (existing fact, unchanged).
- **Workspace open (desktop side)**: Desktop Main `handleOpenWorkspacePath` (the existing deep-link entry) routes to the target window renderer's `handleSelectProject` (the same activate/addTab + startDraft contract as the desktop Command Center). Main keeps no task/session business state.
- **Workspace open (web side)**: the new window-control request only declares intent; a success response means "dispatched to the target window", not "renderer finished" (see Idempotency Boundaries).
- **Attachment**: the existing `workspace-bridge` channel, single active bridge; cross-Host routing and stale-run protections are all preserved.

## Protocol Changes (packages/shared)

- `packages/shared/src/web-remote-control.ts`:
  - `WebRemoteControlWorkspaceOpenRequest` / `WebRemoteControlWorkspaceOpenSuccessResponse` / `WebRemoteControlWorkspaceOpenErrorResponse` (`type: "workspace-open-request"` / `"workspace-open-response"`, carrying `requestId`, `windowControlSessionId`, `workspacePath`, optional `workspaceIdentity`, fields consistent with the `workspace-bridge-*` sibling messages), added to the `WebRemoteControlWindowControlRequest` / `Response` unions.
  - Relay↔desktop transport: `WebRemoteControlWorkspaceOpenRequestPayload` (`zcode_type: "workspace-open-request"`) and `ResponsePayload` (success / success:false + error), added to the `WebRemoteControlAppPayload` union.
- `packages/shared/src/validation.ts`: zod schemas for the app payloads above are added to `webRemoteControlAppPayloadSchemas` (`workspacePath` required non-empty, `workspaceIdentity` optional non-empty); payloads that fail validation keep being rejected at the transport boundary as before.
- UI-side API: `WebRemoteControlWorkspaceSwitcherApi.openWorkspace?(target: { workspacePath; workspaceIdentity? })` (implemented only by the web remote-control switcher).

Identity rule: the key is uniformly `workspaceIdentity?.trim() || workspacePath`. A worktree is a freshly created local directory with no identity, so its key is the path; the protocol still carries the optional `workspaceIdentity` for consistency with the sibling messages, bridge matching keeps using `resolveWebRemoteControlWorkspaceKey`, and matching a target that has an identity "by path alone" is not allowed.

## Acceptance Scenarios

1. **Happy path**: the web remote Command Center picks a project → enters a branch → Start; after the worktree is created, the open is dispatched to the desktop automatically, the refreshed list shows the new workspace, the bridge switch completes, and the new Root lands in the new workspace with a draft.
2. **Duplicate open (already open)**: the target path is already an open tab in a desktop window: the renderer's `activateOrSetWorkspace`/`activateTabByPath` activates the existing tab without creating a duplicate; the open response is still success; the web side switches to that workspace.
3. **Concurrent open races**: the same client's Start has a busy gate (`worktreeStartBusy` + attempt ref), so two opens are never dispatched concurrently; different clients opening the same path concurrently: the renderer's addTab deduplicates by identity key, both converge to the same tab, each with its own bridge attachment (the desktop's single active bridge is isolated per runtime).
4. **Desktop window closing**: `BrowserWindow.fromId(windowId)` is null or destroyed → the open dependency throws → `workspace-open-response {success:false}`; the web side shows the existing failure toast and keeps no leftover local tab.
5. **Invalid path**: non-absolute path / network path (UNC) / missing directory: `handleOpenWorkspacePath`'s `isValidLocalWorkspaceDirectory` rejects it and returns `success:false`. A paired web client already holds local-Host RPC (it can create worktrees), so open introduces no new capability surface; validation is identical to the deep-link path.
6. **Relay not upgraded**: when the relay lacks the endpoint, the web-side fetch fails → the Command Center's existing `openFailed` toast (with retry) is shown; no local fallback open.
7. **Existing messages unaffected**: `window-bootstrap-request` / `workspace-bridge-request` / `mobile-view-state-update` handling paths and zod validation are unchanged (test regression).

## Idempotency Boundaries

- An open request is one request/one response keyed by `requestId`; the desktop neither caches nor queues duplicate opens (the renderer's addTab/activate is itself idempotent, so replays are safe).
- `workspace-open-response` success means "Main accepted and dispatched the open to the target window renderer" (same semantics as a deep link). After the renderer finishes addTab, the existing `syncWebRemoteControlWorkspaces` pushes the snapshot; therefore the web side **polls** the workspace list after success (bounded attempts) and only sends the bridge request once the key appears — a failed bridge match ("target workspace is not in the current desktop window") is treated as "open not finished", and exhausting the retries reports an error.
- The bridge switch keeps the existing single-active-bridge semantics (release the old attachment before attaching the new one); on failure the old bridge stays, no half-open state is produced.

## Verification

- `pnpm typecheck` / `pnpm lint` / `npx oxfmt --check <changed>` / `pnpm architecture:check --changed`.
- Unit tests (vitest): the new zod schemas (valid / invalid / missing identity); desktop manager dispatch (success, dependency-throw propagation, existing window-control messages unaffected); the web-side open→refresh→bridge-switch orchestration (including the bounded retries when the list is delayed).
- The relay is an external deployment with no forwarding implementation in this repository: end-to-end verification (real device + upgraded relay) is out of scope here and is recorded in the PR "Not verified" section.
