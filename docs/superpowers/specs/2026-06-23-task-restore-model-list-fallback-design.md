# Task Restore Model List Fallback Design

A persisted task model may no longer be available. Picking the first provider snapshot entry in `useTaskRestore` was wrong: the provider snapshot is a registry view, not the user's model dropdown, and the host runtime may reject it (observed: UI chose `builtin:bigmodel/GLM-5.2` as fallback while the host rejected the session model and the toolbar still echoed the historical `builtin:bigmodel/GLM-5.1`).

Rules:

- When a historical task model is confirmed unavailable, the automatic switch reuses the first selectable model in the model list — the first item the user can see and choose in the toolbar dropdown (`modelSelectGroups[0].items[0].value` when the current model is absent from `modelSelectGroups`, whether native or custom provider).
- The task restore resolution layer only decides whether the task-local model is available; it does not pick a fallback from provider snapshots, and when the historical model is unavailable with no explicit visible-model fallback it no longer passes the old model as a resume hint to the runtime.
- Automatic switching goes through the existing `handleModelValueChange` chain, keeping UI selection, provider sync, task config, and runtime hint consistent.
- If the model list has no selectable model, do not auto-fallback; keep the existing unavailable indication.

Non-goals: no new host RPC for the runtime's first available model; no toolbar-component dependency in the task restore lib; manual model switching unchanged.

Verification: unit tests cover fallback to the first list item when the active task model is unavailable, and that task restore no longer uses the first provider snapshot entry.
