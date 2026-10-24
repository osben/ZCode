# Desktop Input Context Menu i18n Spec

## Background

The desktop input right-click menu is popped up dynamically by the Electron main process on the `context-menu` event. Menu items set only the Electron `role` and no `label`, so the text depends on the Electron/OS default language and may not match the current ZCode app language.

## Goals

- The right-click menu of desktop editable text inputs (Undo, Redo, Cut, Copy, Paste, Delete, Select all) uses the text of the current app locale.
- Keep the Electron `role` and `editFlags`; native edit behavior and disabled states are unchanged.
- After the app language is switched, the next opening of the right-click menu uses the new language immediately, with no window restart.

## Non-goals and boundaries

- The browser's native right-click menu on mobile Web/remote Web is not changed; the browser controls it and the app cannot inject app copy.
- The input right-click menu is not rebuilt as a React/DOM custom menu.
- Other right-click menus (selected text, embedded browser, terminal) are unchanged.

## Implementation constraints

- Menu labels reuse the desktop menu locale table in `packages/shared/src/desktopMenu.ts`.
- The right-click menu reads the latest app language through a locale getter when it is created, rather than freezing the language at window creation.
- `Delete` gets its own desktop menu message id so every action in the right-click menu has Chinese and English text.

## Acceptance

1. Under `zh-CN` the editable input right-click menu shows: 撤销, 重做, 剪切, 复制, 粘贴, 删除, 全选.
2. Under `en-US` it shows: Undo, Redo, Cut, Copy, Paste, Delete, Select all.
3. The `role` and `enabled` state of each item keep the existing `ContextMenuParams.editFlags` result.
4. The locale getter is read when the menu pops up, so switching language needs no BrowserWindow rebuild.
