# Subagent Browser Use Session Boundary

> Since 2026-10-09 subagents may use Browser Use; the earlier rule "subagents always fail closed with
> `Browser is not available in subagent`" is removed. This file keeps its original path and describes the
> current behavior.

## Background

The host `node_repl` MCP is a generic JavaScript kernel process shared by the main agent and subagents.
Browser Use needs host control of the desktop window or the CLI managed headless runtime, so tab
ownership, workspace and clientMode must trace back to a session the client knows.

Desktop decides tab ownership and which conversation expands the browser panel by the request
`sessionId`: `sessionId === the current conversation's ownerTaskId` (see `applyBrowserUseSidePaneEvent` in
`packages/ui/src/lib/workspaceSidePane.ts`). Desktop does not know a subagent's child session id. A tab
opened with a child session id would not expand the panel and would not appear in any conversation, an
invisible orphan. So browser requests of core `Agent` subagents use the **current conversation (parent
session)** as tab owner.

## Scope

- core `Agent` subagent: `taskType: "subagent_child"`, `runtimeScope: "subagent"`; the subject of this
  document.
- dynamic workflow (dwf) subagent: `taskType: "workflow_child"`; keeps using the child session's own tabs
  and closes them with the run on dispose. See "Subagent sessions" in
  `apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md` and contract 4 of
  `docs/zcode-protocol-model-backed-control-requests.md`.

## Target semantics

- Main-agent Browser Use behavior is unchanged.
- A subagent can initialize, discover, read docs and operate Browser Use, with the same API as the main
  agent.
- A subagent shares one tab set with the current conversation:
  - `tabs.list()` and `user.openTabs()` see all browser tabs of the current conversation, including those
    opened by the main agent and by the user.
  - Tabs newly opened or selected by the subagent auto-expand in the current conversation's browser panel,
    as when the main agent opens a tab.
- workspace (`workspaceIdentity` / `workspacePath` / `remoteSessionId`) and `clientMode` come from the
  parent session, so the desktop continuous and mobile replayable boundaries match the parent.
- A subagent does not close tabs on its own:
  - at subagent turn end and run end (completed, failed or cancelled) no `turnEnded` / `closeSession` is
    sent to desktop;
  - tabs are left to the parent session's own lifecycle (on parent turnEnded control is released and tabs
    are not closed);
  - run end only revokes the child-session registration; later Browser requests with that child id are
    rejected as if never registered.
- A later `SendMessage` that resumes the same subagent registers again and sees the tabs still left in
  the conversation.

## Call chain

```text
parent runtime                  shared node_repl MCP        bootstrap broker (one state per server context)     Desktop
  | Agent tool -> spawn child         |                             |                                          |
  | forChildSession(child, parent,    |                             |                                          |
  |   tabOwner:"parent") ------------------------------------------>| childSessionParents[child]=parent        |
  |                                   |                             | parentTabOwnerChildren += child          |
child runtime                         |                             |                                          |
  | js(session_id=child,              |                             |                                          |
  |    runtime_scope=subagent) ------>| bridge only validates the   |                                          |
  |                                   | binding is unexpired        |                                          |
  |                                   | list/execute(child) ------->| requireSession(parent) -> workspace/mode |
  |                                   |                             | send sessionId=parent (tab owner) ------>| conversation tab; panel expands by
  |                                   |                             | connection recorded under parent         | ownerTaskId=parent
child turn / run end                  |                             |                                          |
  | child port turnEnded / closeSession ------------------------------>| no lifecycle sent; closeSession only    |
  |                                   |                             | revokes the registration                 |
parent turn ends                      |                             |                                          |
  | turnEnded(parent) --------------------------------------------->| sent to every browser the parent used    |
  |                                   |                             | (including child-used) -------------->   | control released, tabs kept
```

## Implementation constraints

- The `node_repl` browser bridge and the bootstrap node_repl broker no longer reject requests by
  `runtime_scope`. The broker still validates the private socket token first; authoritative sessionId
  validation is `requireSession` of `BrowserControlPort`.
- The ownership mode is declared in `tabOwner` of `BrowserControlPort.forChildSession({ childSessionId,
  parentSessionId, tabOwner })`: `"parent"` for core Agent subagents, `"child"` (default) for dwf
  subagents. Whether a child session resolves depends only on whether the parent runtime called
  `forChildSession`; never guess the parent from the session id's shape.
- In `tabOwner: "parent"` mode the broker records the connection under the parent session, so a browser
  used by a subagent also receives the parent's turnEnded / closeSession.
- When the port lacks `forChildSession` (CLI headless CDP) the subagent uses the parent port directly,
  tabs land in the child session's own scope and the child session is closed when the subagent ends.
  Headless has no UI panel.
- Cleanup failures only log `warn` and never block the subagent result from returning to the parent agent.
- A background subagent and the parent session may operate the same tabs concurrently, consistent with
  "shared conversation tabs"; no extra lock.
- The Computer Use subagent restriction is unchanged
  (`docs/cua/2026-08-18-subagent-computer-use-unavailable-spec.md`).

## Acceptance

- Calling the Browser bridge in subagent scope no longer throws and the init entry works.
- After `forChildSession` registers with `tabOwner: "parent"`, the child session's list/execute send the
  parent session id, workspace and clientMode come from the parent; child port turnEnded / closeSession
  send no desktop request; after revocation child requests are rejected; the parent's turnEnded reaches
  browsers the subagent used.
- The parent runtime calls `forChildSession({ childSessionId, parentSessionId, tabOwner: "parent" })` for
  the subagent, and after the subagent ends calls closeSession on the child port (revocation only).
- Desktop E2E (BAB01 / BU-E2E-012):
  - the child can list the main agent's tabs and newly opened tabs are visible in the current
    conversation's panel;
  - back in the main agent, the original tab state is still `parent-before` and the child-opened tab is
    still in `tabs.list()`.
