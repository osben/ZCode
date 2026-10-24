# Bugfix 02: Provider Drag Reorder Snaps Back Before Jumping to the Target

> Status: Completed (automated verification passed; manual macOS Electron recheck pending a dev build)
>
> Date: 2026-08-27
>
> Source: manual macOS ZCode Provider Settings experience and call-chain audit
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/bugfix-02-provider-reorder-drop-flicker.md`

## 1. Problem and Root Cause

After dragging a custom Provider in Provider Settings, the list first returned to the old position on drop and
then jumped to the target position. The final config saved correctly; the visible window was a stale state between
the temporary drag state and asynchronous persistence.

`dnd-kit` moves the sortable element with a temporary `transform` and clears it on drop, while the page still
renders from the parent's old `navigationGroups` / `modelIds`. `onDragEnd` only computed the new order and called
the async save (Personal Config file lock and atomic write, then Registry refresh, then Settings View
`onDidChange`), so the old order showed until the View arrived.

Not the cause: `arrayMove` index, whole-row drag area, CSS transition, sync-vs-async IO, or a missing second Config.

Model reordering is not affected: `InlineEditableProviderCard` already calls `setModels(next)` synchronously before
the async save, so it already has the optimistic projection. No second Pending layer is added for Models.

## 2. Rules

1. Persistence authority is unchanged: Personal Provider Config (`providerOrder`) -> Provider Registry / Settings
   View -> confirmed order.
2. The UI adds one optimistic projection, **Pending Reorder**, held between drop and View confirmation. It is not
   persisted, not cross-page, not in the Registry, not part of Model Selection or execution, and not in the global
   Zustand settings state (no cross-window sync, no effect on Desktop continuous, Mobile replayable, Remote
   Workspace, Session Selection, queue or recovery semantics).
3. `onDragEnd` computes the full target order from the currently rendered order, updates Pending Reorder
   synchronously in the same handler (so React renders the target order when `dnd-kit` clears the transform), then
   saves through the existing `ProviderSettingsService`. No disabled transitions, delayed drag end, fake transform,
   or manual DOM sorting.
4. Confirmation and rollback: when the Settings View arrives and matches the target, clear the Pending Reorder. On
   save failure, roll back only the Pending Reorder still belonging to that operation and log with the UI logger. A
   late old request must not overwrite a newer reorder. Page unmount or Environment switch discards Pending
   Reorder and uses the target Environment's View.
5. Consecutive drags before the first save completes: the new order is computed from the optimistic order (never
   from the old View); writes are serialized in interaction order or coalesced to "save the latest target"; an
   earlier success, failure or View push never clears a newer Pending Reorder; with nothing in flight, UI order,
   Personal Config and Settings View agree.
6. Model reordering keeps its existing form-owner optimistic update and rollback; Pending Reorder is not
   generalized into a domain reorder DTO.

State ownership:

| State                    | Owner                     | Lifetime                               | Purpose                              |
| ------------------------ | ------------------------- | -------------------------------------- | ------------------------------------ |
| `providerOrder`          | Personal Config           | Persisted                              | User order authority                 |
| Order in Settings View   | Provider Settings Service | Registry revision                      | Formal read fact for the UI          |
| Pending Provider Reorder | Provider Settings UI      | One page, one Environment, one or more drags | Immediate visual projection    |
| `dnd-kit transform`      | Sortable component        | One pointer/keyboard drag              | In-drag displacement                 |

## 3. Acceptance Cases

| Case    | Setup                                | Action             | Assertions                                                  |
| ------- | ------------------------------------ | ------------------ | ----------------------------------------------------------- |
| BF02-01 | Provider save Promise delayed        | Drag and drop      | Target order rendered before the Promise resolves           |
| BF02-02 | Provider save fails                  | Drag and drop      | Optimistic first; on failure roll back to formal order, log |
| BF02-03 | First Provider save unfinished       | Drag twice         | Second based on optimistic order; late result cannot override final target |
| BF02-04 | New Settings View matches target     | Save completes     | Pending cleared; later formal refresh does not jump again   |
| BF02-05 | Model save Promise delayed           | Drag Model, drop   | Existing form optimistic order stable; no second Pending    |
| BF02-06 | Keyboard sortable operation          | Reorder Provider   | Same optimistic update and confirmation as pointer drag     |
| BF02-07 | Environment switch / page unmount    | Pending exists     | Old Environment's order not carried to the new page         |

Interaction tests must control the save Promise and assert the DOM order before save completion; keep the existing
pure sort-function tests.

## 4. Completion Gate

- Provider drop stays on the target position; no old-order flash under slow file IO or slow Registry refresh;
  failure rolls back; consecutive drags honor latest intent; Model behavior has no regression.
- No synchronous file IO, manual DOM sorting, fixed delays or second Config.
- Provider Settings targeted tests, UI typecheck, root `typecheck`, `lint`, format check pass.
- Open: macOS Electron manual recheck with a deliberately slowed save chain or consecutive drags.
