# Create Project Dialog Layout

Status: implemented (2026-10-15). The layout was confirmed via a prototype (variant B; kept on the `prototype/project-editor-dialog` branch, not merged).

## 1. Scope

| Item           | Content                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Components     | `ProjectEditor` (create / edit project form), the embedded `RemoteProjectList` page (add existing project)                                    |
| Change layer   | Presentation only; connection flow, save chain, state machine, props contract, folder trust confirmation and folder browser are unchanged     |
| Entries        | Sidebar project plus, chat "create project on this device"; Desktop, Web and mobile share one component, no separate mobile layout            |
| State source   | The device status dot comes only from `resolveRemoteConnectionPresentation`; the component never picks colors itself                          |
| Related specs  | [Confirm trusting folders before creating a project](project-creation-folder-confirmation.md), [remote device status display](../architecture/remote-device-connection-ux-spec.md) |

## 2. Form Layout

Fields top to bottom: **project name → device → source folders**. The device selector and the existing-project entry below it form one group placed after the name and before the source folders; keyboard focus order matches field order.

```
┌ Create project ───────────────────────┐
│ Project name                            │
│ [ New project                        ]  │
│ Device                                  │
│ [🖥/🗄 name                 ● status ▾]  │
│ Projects already on this device? Add to sidebar > │  ← only when a remote device is selected
│ Source folders                          │
│ ┌┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐  │
│ ┆   (📁+)  Choose folder / subtext   ┆  │  ← dashed empty state with zero folders
│ └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘  │
│                      [Cancel] [Create]  │
└─────────────────────────────────────────┘
```

- The three field labels use `text-ui-sm font-medium`. The name is a standard Input with no prefix icon; its placeholder is the default name saved ("新项目", New project).
- When chat already confirmed a folder (`fixedFolder`), the device selector is hidden; the device name stays as read-only text under the name, and the folder row still shows the full path.

## 3. Device Selection

- Still a Select dropdown. Trigger and every option are "icon + name + status": `Monitor` for this computer, `Server` for remote devices; SSH / WSL / Docker are not distinguished.
- Status sits at the right and draws the dot from `resolveRemoteConnectionPresentation({ state }).dot`; connecting shows a spinner instead of a dot.
- Online shows the dot only (text for screen readers only); the other 4 states show dot plus short text (`project.deviceStatus.*`).
- Long names truncate; status and the selected checkmark stay visible.
- "添加远程设备…" (Add remote device…) is last, prefixed with a `Plus` icon and separated from the device list by a divider.

## 4. Add Existing Project Entry

- Position: directly under the device selector; shown only when a remote device is selected and `onBrowseExisting` is provided.
- Form: one `text-ui-sm` line "这台设备上已有项目？" (Projects already on this device?) followed by an underlined `text-brand` link button "添加到侧栏 >" (Add to sidebar >). The question states the purpose; the link is the only clickable area.
- Behavior unchanged: click calls `onBrowseExisting`; if the device is offline it connects first and then opens the list; device status does not disable the entry.
- Focus returns to this link on return.

## 5. Source Folders

- Zero folders: dashed-border card, round `FolderPlus` icon, main text "选择文件夹" (Choose folder), subtext "ZCode 可读取和编辑这些文件夹" (ZCode can read and edit these folders).
- Remote device offline: main text becomes "连接并选择文件夹" (Connect and choose folder), subtext "设备当前{状态}，点击后先连接" (Device is currently {status}; click to connect first).
- With folders: one bordered list; for local projects the last row is "添加文件夹" (Add folder). "设为主要" (Set as primary) on non-primary folders is a small ghost button, always visible on mobile (not hover-only).

## 6. Existing Projects List Page (embedded)

- The back button sits left of the title: an `ArrowLeft` icon button with aria-label "返回新建项目" (Back to create project); `data-testid="remote-project-back"` is unchanged.
- The old "返回新建项目" button at the bottom of the list is removed.
- The standalone dialog form (non-embedded) is unchanged.

## 7. Verification

- UI unit test `packages/ui/test/projectEditorLayout.test.ts`: field order, dots and text for the 5 states, existing-project hint row, empty-state copy, back button position and focus.
- E2E: affected selectors updated in `project-device-selection`, `existing-remote-project`, `virtual-project-mobile`, `background-connection`. The 3 desktop cases passed against a local SSH container (2026-10-15); the mobile case was not run.
- Visual: light/dark, Chinese/English, 1440 / 480 window widths, from desktop E2E screenshots.
- Name/device field reorder (2026-10-16): layout unit tests 6/6 passed; the real `ProjectEditor` browser mount passed 8 combinations (390 / 1200px × Zai Light / Dark × Chinese/English), checking local and remote layout, the existing-project entry moving with the device, Tab order and name retention. Screenshots and geometry are in `packages/desktop/.e2e-artifacts/project-editor-order/`; the desktop SSH and mobile remote E2E assertions were updated but the full chain was not rerun.
