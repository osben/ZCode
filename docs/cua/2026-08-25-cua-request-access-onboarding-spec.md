# CUA `request_access` Live Permission Guidance Spec

- Date: 2026-08-25
- Status: in implementation
- Related: producer `zcode-cua` !576, consumer `z-code` !2315

## Product contract

`request_access` is a read-only permission snapshot and does not trigger a native prompt. On macOS the producer provides versioned status in the namespaced `_meta` of a successful result. The consumer generates one permission observation only when official-CUA authority, the exact tool name, a strict schema and a local `desktop-continuous` live event all hold.

```text
live official request_access
  -> typed metadata
  -> authority-gated CLI projection
  -> desktop-only live observation
  -> fresh Host status
  -> ZCode confirmation
  -> fresh Host status
  -> existing onboarding
  -> Helper restart + refresh

history / recovery / mobile / remote / ordinary error -> no side effect
```

## State and side effects

- Accessibility `denied`, `stale` and Screen Recording `denied` are definite missing permissions; `unknown` does not trigger guidance for that permission.
- Every local live task managed by a desktop window can trigger, whether or not the task is visible or the workspace is currently active.
- The same `workspaceKey + sessionId + turnId + missingPermissions` is confirmed once; concurrent observations during confirmation or onboarding merge. A new `request_access` in a future turn may remind again.
- Before and after confirmation call `getStatus(..., {includeFunctionalProbes:false})`; only the fresh status decides the permission list.
- When both are missing the order is fixed: Accessibility, then Screen Recording.
- User cancellation does not open system settings; after authorization returns, the corresponding Helper is restarted per the existing owner contract and status refreshed.
- No conversation command, no automatic continuation, no replay of `request_access` or earlier actions.

## Delivery and identity boundaries

- The wire observation is generated only from a live `ToolCallResult` and does not enter snapshot, transcript or recovery.
- A trusted `desktop-continuous` renderer may subscribe; `web-remote-replayable` returns an empty event.
- `workspaceKey = workspaceIdentity?.trim() || workspacePath` isolates; execution and Helper queries keep using `workspacePath`. A workspace carrying `remoteSessionId` or a remote identity is pruned directly.
- Same-named third-party MCP, malformed metadata, ordinary `permission_denied`, historical `CUA_PERMISSION_REQUIRED` text and the Tool Card JSON parser can never trigger.

## UI

Reuse the global ConfirmDialog and the existing onboarding; no new modal system. The copy says the running computer-use task needs macOS permissions, with actions "前往授权 / 暂不授权" (go authorize / not now). A background window only queues the confirmation dialog and does not steal focus.

## Verification

- Producer: metadata schema, text unchanged, read-only / cross-platform fail closed.
- Core/Protocol: authority, tool name, strict schema, live-only and clientMode boundaries.
- UI: double fresh-status check, concurrent merge, same-turn dedupe, cancel/confirm, Helper recovery and zero task replay.
- E2E: representative cases for background task, cold restore, mobile replayable and ordinary error.
