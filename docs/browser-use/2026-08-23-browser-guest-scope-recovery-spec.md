# Browser Use Guest Scope Freeze and Binding Self-Healing Spec

> Status: implemented
> Applies to: the Browser / Browser Use `<webview>` guest of Desktop `desktop-continuous`.
> Does not apply to: the independent recovery semantics of mobile `web-remote-replayable`, and session/stream business state in relay/main.

## 1. Problem definition

The ownership of a Browser Use tab is frozen when `BrowserViewReady` creates it as:

```text
(windowId, workspaceKey, remoteSessionId?, sessionId, browserId, browserGeneration)
```

where:

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
```

`workspaceKey` is for identity and isolation only; `workspacePath` is for execution and display only. An
already-created tab must not re-read the ambient scope because the user switches the current workspace,
task or remote connection.

In production the renderer once reported a guest with an old/current workspace scope, main rejected it by
owner scope without returning a structured result, and the caller kept waiting until the attach timeout
and finally displayed the scope error as `browser guest not attached`. This spec folds scope rejection,
guest recovery and stale-command protection into one state machine.

## 2. State and event chain

```text
main owner scope W1/S1
        |
        | BrowserViewReady(W1/S1/tabId/generation)
        v
renderer side-pane tab freezes W1/S1
        |
        | did-attach + attachGuest(W1/S1/generation)
        v
main validates and binds the guest
        |
        +--> accepted -> resolve recovery flight -> execute command
        |
        +--> scope-mismatch / stale / destroyed
                |
                v
          mark the current generation invalid
                |
                v
          request rebind (keeping the tab owner scope)
                |
                v
          renderer detach ACK -> replace the webview generation
                |
                v
          new guest did-attach -> attach again
                |
                v
          one bounded retry; on failure return a typed error
```

Concurrent commands on one tab share one recovery flight. While guest A is replaced by B, an old command
that captured A must return `stale_guest` before the actual CDP dispatch and must never send the action to
B.

## 3. Implementation contract

### 3.1 Scope passing

- `BrowserUseSidePaneTab` stores and uses the `workspaceKey`, `sessionId` and `remoteSessionId` of
  creation time.
- `AnimatedSidePanePanel`, `BrowserUseSidePaneContent` and `UnifiedBrowserView` do not back-fill the
  identity scope of an existing tab from the current active workspace.
- The attach de-duplication fingerprint must include guest id, active, workspaceKey, remoteSessionId,
  sessionId and the residency generation; a scope change must re-attach even if the guest id is
  unchanged.
- A remote workspace always keeps the workspaceKey of its `workspaceIdentity` and the `remoteSessionId`;
  never compare by path alone.

### 3.2 Attach result

`browserViewAttachGuest` returns a structured result. Main still fails closed, but scope/session/
generation rejection must not be swallowed silently or wait for a generic timeout; a rejected incoming
guest that is not the current guest must be cleaned up to prevent orphan WebContents.

### 3.3 Self-healing boundary

- Main keeps a single-flight attaching/recovering per tab; after a successful recovery all waiters are
  woken at once.
- A scope mismatch triggers only one controlled rebind/attach retry; no unbounded loop.
- Renderer rebuild still waits for main's CDP detach ACK before replacing the webview.
- A normal task/workspace switch does not unload a living guest; only guest crash, eviction or attach
  timeout enters recovery.
- A complete app restart does not restore Browser Tabs; 32-tab residency and the existing close semantics
  are unchanged.

## 4. Acceptance cases

| Case    | Scenario                                       | Assertion                                                                               |
| ------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| BGR-001 | Tab belongs to W1/S1, UI switches to W2/S2     | attach still carries W1/S1, no scope drift                                              |
| BGR-002 | same webContentsId, only the scope changes     | attach fingerprint changes, re-report and main validates                                |
| BGR-003 | main returns workspace-mismatch                | renderer receives a typed rejection and does not wait for the generic 10-second timeout |
| BGR-004 | several commands hit a missing guest at once   | only one recovery flight is created, and all waiters converge after success             |
| BGR-005 | Guest A is replaced by B while a command waits | the old command returns `backend_unavailable` and does not dispatch to B                |
| BGR-006 | one rebind still fails                         | after a bounded retry returns `backend_unavailable`, no tab shell leak                  |
| BGR-007 | local/remote with the same path                | workspaceIdentity/remoteSessionId do not mix, commands and tabs are mutually invisible  |

## 5. Verification

The implementation must pass the affected UI/main/IPC unit tests, `pnpm typecheck` and `pnpm lint`. The
real Windows Electron regression must cover activation after guest idle, new tab, workspace/task switching
and `render-process-gone`, and confirm that the desktop continuous chain has not picked up mobile
replayable snapshot/queue semantics.
