# UI component testid audit

> Status: historical audit snapshot from 2026-03-31. The audited components `ChatView`, `ChatMessage`, `ChatInputToolbar` and others have since been replaced by the V4 conversation UI; this file no longer lists current gaps. Current E2E locators must follow `packages/shared/src/test-ids.ts`, the V4 components and the current E2E specs.

Scope at audit time: `packages/ui/src/**/*.tsx`, excluding `components/ui/`. Single source of testids: `packages/shared/src/test-ids.ts`.

## Conventions

- Every React component that maps to a user-visible feature area has one root-container testid.
- Dynamic list items use `testId(BASE, suffix)`, for example `testId(TID_TASK_ITEM, taskId)`.
- testid constants are declared in `test-ids.ts`; components do not hard-code strings.
- E2E tests and DOM lookups use the `data-testid` attribute only.

## Findings at audit time

Components missing a testid:

| Component file           | Missing testid                | Note                                                                                 |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------ |
| `SettingsPage.tsx`       | `TID_SETTINGS_BACK_BUTTON`    | Defined in `test-ids.ts` but not applied to the back button                          |
| `PermissionDialog.tsx`   | container testid              | The permission confirmation dialog has none, so E2E cannot locate it                 |
| `ChatPlan.tsx`           | container testid              | Plan panel                                                                           |
| `ChatErrorBanner.tsx`    | container testid              | Error banner                                                                         |
| `ChatInputToolbar.tsx`   | container testid              | Bottom config toolbar (model/mode/thought selectors)                                 |
| `DebugInfoBar.tsx`       | container testid              | Debug info bar                                                                       |
| `NewTaskButtonGroup.tsx` | dropdown trigger button       | The provider-switch arrow has none; only the main button has `TID_TASK_NEW_BUTTON`   |
| `WorkspaceSidebar.tsx`   | empty-state testid            | Empty-state hint div                                                                 |

Defined but unused testids:

| Constant                  | Problem                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `TID_PREVIEW_PREV_BUTTON` | `PreviewPane` loads by auto-scroll and has no "previous segment" button                |
| `TID_PREVIEW_NEXT_BUTTON` | Same                                                                                   |
| `TID_WORKSPACE_PATH`      | Not used by any component                                                              |
| `TID_LOCALE_TOGGLE`       | `LocaleSwitcher.tsx` does not use it                                                   |

Well covered at audit time: `WelcomeScreen.tsx`, `Terminal.tsx`, `SSHDialog.tsx`, `FileTree.tsx`, `EmbeddedBrowserPane.tsx`, `TaskList.tsx`, `ChatView.tsx`, `App.tsx` (complete); `PreviewPane.tsx`, `NewTaskButtonGroup.tsx`, `ChatMessage.tsx`, `WorkspaceSidebar.tsx`, `SettingsPage.tsx` (partial).

## Suggested fix priority

- P0 (E2E flows depend on it): `PermissionDialog` container (the permission flow cannot be automated); `ChatErrorBanner` container (error scenarios cannot be asserted, nor can the rule "a positive conversation case must not show `ChatViewErrorBanner` by default" be checked mechanically).
- P1 (feature area location): `ChatInputToolbar`, `ChatPlan`, `DebugInfoBar`, `NewTaskButtonGroup` dropdown trigger.
- P2 (cleanup): delete `TID_PREVIEW_PREV_BUTTON` / `TID_PREVIEW_NEXT_BUTTON` (or implement paging buttons) and `TID_WORKSPACE_PATH` (no UI); add `TID_LOCALE_TOGGLE` to `LocaleSwitcher.tsx` or delete it from `test-ids.ts`.

## Fix template

1. Add the constant in `test-ids.ts` with a doc comment:
   ```ts
   /** PermissionDialog permission confirmation container */
   export const TID_PERMISSION_DIALOG = "permission-dialog";
   ```

2. Add `data-testid` on the component root:
   ```tsx
   import { TID_PERMISSION_DIALOG } from "@zcode/shared/test-ids";

   <Confirmation data-testid={TID_PERMISSION_DIALOG} ...>
   ```

3. If the component does not accept a `data-testid` prop (for example ai-elements components), wrap it in a `<div>`:
   ```tsx
   <div data-testid={TID_CHAT_PLAN}>
     <Plan ...>
   ```
