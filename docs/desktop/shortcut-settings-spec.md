# Shortcut Settings spec

Shortcut settings provide user-level app command bindings. The first phase covers new task, open workspace,
close current context, sidebar/panel/terminal toggles, task find, previous/next session navigation, history
back/forward, the command center and page zoom. Enter, Escape, Tab and Space stay fixed component interactions.
Configuration is stored by command ID; missing or invalid values fall back to defaults; one key combination can
bind only one command.

This spec is the only implementation basis of the feature; the architecture principle is: **across the repo only
the shortcut module knows key bindings; all other code knows only command IDs.**

## 1. Goals and non-goals

Goals:

- Users can record and save any valid key combination in the settings page, taking effect immediately after
  saving (instantly in this window, via sync in other windows, with the desktop menu rebuilt).
- The command table, default bindings and matching/recording/conflict logic converge in a standalone module;
  adding a configurable shortcut changes only the shared command table plus the consumer's handler registration.
- Combination recognition covers: multiple modifiers (any combination of CmdOrCtrl/Ctrl/Alt/Shift), Shift+letter,
  macOS Option layout rewriting (`event.code` fallback), Chinese IME composition (isComposing/Process/Dead/229 do
  not trigger), and long-press repeat not retriggering.
- Key semantics are consistent on the three operating systems (macOS/Windows/Linux), with both themes, i18n and
  desktop/Web/mobile compatibility.

Non-goals:

- System-level global shortcuts (responding when the app is unfocused, Electron `globalShortcut`): not introduced,
  reserved for later extension.
- Component-level interaction keys of the in-session input (Enter to send, Escape to cancel, Tab to indent,
  TaskSearchDialog's G/number navigation, GitActionMenu's Enter) are not configurable.
- Shortcuts are not isolated by workspace: a user-level global configuration.

## 2. Architecture and dependency direction

```
┌────────────────────────────────────────────────────────────┐
│ packages/shared (single data source, pure data + pure functions, no DOM/Electron) │
│  shortcutCommands.ts:                                       │
│   · ShortcutCommandId / ShortcutChannel types               │
│   · SHORTCUT_COMMANDS command table (id/channel/default binding/configurable) │
│   · serialization format parse/serialize/isValid (Electron-compatible syntax) │
│  protocol.ts + validationAppSettings.ts:                     │
│   · AppSettings.shortcutBindings field (3 places in sync: interface + │
│     object schema + patch schema)                           │
└──────────────────────┬─────────────────────────────────────┘
                       │ all code imports only from here, no separate key knowledge
        ┌──────────────┼──────────────────┐
        ▼              ▼                  ▼
┌──────────────┐ ┌─────────────┐ ┌────────────────────┐
│ ui/src/      │ │ ui/src/     │ │ desktop main process │
│ shortcuts/   │ │ settings/   │ │ desktopApplication │
│ (exec kernel)  │ │ Shortcut    │ │ Menu.ts:           │
│ · generic matcher │ │ Settings    │ │ accelerator read from the │
│ · recorder   │ │ Section.tsx │ │ effective table, rebuilt on rebuild │
│ · effective-table resolve │ │ (editor UI, │ │ (reuses the existing │
│ · conflict detection │ │  reads/writes data only) │ │  SyncAppSettings → syncImmediate │
│ · label hook │ └──────┬──────┘ │  AppSettings chain)  │
└──────┬───────┘        │        └────────────────────┘
       │                │
       ▼                ▼
  useAppKeyboard   useSettings (useSettingService.ts)
  (thin shell: event→  built in: update() = settingService.update
  command→handler)   + platform.syncAppSettings + refresh()
```

Hard dependency rules:

- `ui/src/shortcuts/` is the only owner of shortcut knowledge; `useAppKeyboard`, `ShortcutSettingsSection` and
  label consumers only call its API and do not parse key strings.
- The settings service only passes shortcut data through (`Record<commandID, string[]>`) without semantic
  validation; semantic validation (format/conflict/reserved keys) lives entirely in the shortcut module.
- No new IPC, no change to the main Zustand store, no extension of BROADCAST_FIELDS. Cross-window sync and menu
  rebuild reuse the settings chain (see §6).

## 3. Serialization format (core convention of combination recognition)

A subset of Electron accelerator-compatible syntax, with the same string used for setting.json persistence,
renderer matching, menu accelerator passthrough and cross-process transport.

```
binding   := modifier+ key
modifier  := "CmdOrCtrl" | "Ctrl" | "Alt" | "Shift" | "AltGr"
key       := [a-z] | [0-9] | "[" | "]" | "=" | "-" | "," | "." | "/" | "\\"
            | ";" | "'" | "`" | [A-Z] (lowercased when recording, uppercase is invalid)
            | "Plus" | "Minus" | "Equal" (menu-compatible aliases, normalized by the kernel)
            | "F1".."F12" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
            | "Home" | "End" | "PageUp" | "PageDown" | "Delete" | "Insert"
```

Rules:

- **Fixed modifier order:** `CmdOrCtrl → Ctrl → Alt → Shift → AltGr → key`. After parse, re-serialize to
  normalize (canonical form); parsing an invalid string returns null.
- **CmdOrCtrl is a semantic modifier:** on macOS it matches `metaKey && !ctrlKey`, on Windows/Linux
  `ctrlKey && !metaKey` (keeping the platform isolation of keyboardShortcuts.ts:165-173); for menus it is
  passed straight to Electron.
- **Ctrl is explicit Ctrl:** on macOS, recording Ctrl+X yields `Ctrl+X` (mac Ctrl is left to system Emacs-style
  editing and bound only on the user's explicit choice); on Windows/Linux the primary modifier always records as
  `CmdOrCtrl+X`, and `Ctrl+X` on those platforms matches as `CmdOrCtrl`.
- **Shift+key uses a lowercase base key:** recording `Shift+P` yields `CmdOrCtrl+Shift+p` (not `P`), and
  `Shift+7` yields `CmdOrCtrl+Shift+7` (not `&`). Implementation: when recording prefer `event.code` to look up
  the physical base key (`KeyP`→`p`, `Digit7`→`7`, `Equal`→`=`), with `event.key` only as fallback; this is the
  only reliable source under keyboard layout differences (AZERTY, macOS Option rewriting).
- **Matching is exact on modifiers:** the event's four modifier states are compared one by one with the binding,
  and extra modifiers do not match (so Cmd+Ctrl+K does not trigger CmdOrCtrl+K).
- **Key match:** `event.key` lowercase comparison hits, or `event.code` falls back through a mapping table (an
  extension of the existing getExpectedShortcutCode, adding Equal/Minus/comma/period/slash/semicolon/quote/
  backtick/backslash).
- **IME and noise filtering:** `event.isComposing === true`, `key === "Process"`, `key === "Dead"`,
  `keyCode === 229` and `event.repeat === true` never match and are never recorded. A keydown during Chinese IME
  composition must not trigger any global command.
- A single-key (no modifier) binding is valid in format and supported in matching (all four modifiers false),
  but the first-phase command table has no single-key command; the recording UI requires at least one modifier
  (except F1-F12 and arrow keys).

## 4. Command table (single source of truth)

| Command ID | Channel | Default binding |
| --- | --- | --- |
| openCommandCenter | window | `CmdOrCtrl+K`, `CmdOrCtrl+Shift+P` (two defaults, overridden as a group) |
| openSettings | window | `CmdOrCtrl+,` (mac ⌘, / win·linux Ctrl+, system convention) |
| findInTask | window | `CmdOrCtrl+F` |
| toggleSidebar | window | `CmdOrCtrl+B` |
| toggleTerminal | window | `CmdOrCtrl+J` |
| toggleSidePane | window | `CmdOrCtrl+Alt+B` |
| previousConversation | window | `CmdOrCtrl+Shift+[` |
| nextConversation | window | `CmdOrCtrl+Shift+]` |
| navigateBack | window | `CmdOrCtrl+[` |
| navigateForward | window | `CmdOrCtrl+]` |
| newTask | menu | `CmdOrCtrl+N` |
| openWorkspace | menu | `CmdOrCtrl+O` |
| closeActiveContext | menu | `CmdOrCtrl+W` |
| zoomIn | menu | `CmdOrCtrl+=` (the menu keeps the dual-entry mode of a visible Plus item + a hidden `=` item) |
| zoomOut | menu | `CmdOrCtrl+-` |
| resetZoom | menu | `CmdOrCtrl+0` |

- The `window` channel is dispatched by `useAppKeyboard` inside the renderer and works the same on all three
  ends.
- The `menu` channel is the desktop app menu accelerator (main process); menu-channel commands are greyed out in
  the Web/mobile settings page with the note 「仅桌面端生效」 (effective on desktop only), while window-channel
  commands are configurable on all three ends.
- Command table entry fields: `id`, `channel`, `defaultBindings: string[]`, `configurable` (all true in the
  first phase, field kept). Command display names go through the i18n key `settings.shortcuts.command.<id>`.
- Historical note: a static prototype on the branch listed 12 entries and missed findInTask/
  previousConversation/nextConversation, and navigateBack/Forward were once mislabeled "previous/next task";
  this table is authoritative.

## 5. Settings model and persistence

- `AppSettings.shortcutBindings?: Record<string, string[]>` **stores only user overrides**; commands without
  overrides are not written to disk and are merged with command-table defaults on read. Override semantics: whole
  group replacement (when openCommandCenter is overridden both default bindings become invalid and the user's
  recorded group takes over).
- The schema is synced in three places: the `AppSettings` interface in `protocol.ts`, `appSettingsObjectSchema`
  in `validationAppSettings.ts` (`z.record(z.string(), z.array(z.string())).optional()`) and
  `appSettingsPatchSchema` (same shape, optional). zod strips unknown fields by default, so missing the patch
  schema makes updates silently lost.
- The schema validates only the shape; semantic validation (whether the command ID exists, whether the binding
  is valid) is tolerantly done at effective-table resolve time: unknown command IDs or invalid binding entries
  are ignored with a warn log and the rest take effect normally, so hand-editing setting.json with invalid
  entries cannot break shortcuts as a whole.
- **Compatibility constraint of release state and default keys of new commands:** the shortcut customization
  feature has not been released and there is no existing user configuration, so new commands just get default
  keys (for example `CmdOrCtrl+,` of openSettings). **After first release**, when adding a command whose default
  key may conflict with a user's saved explicit binding (same scope, physically equivalent, e.g. win `Ctrl+,` ≡
  `CmdOrCtrl+,`), an upgrade compatibility of "the new default key yields to the explicit override" is required,
  so a user's existing binding is not silently preempted and the settings page display matches actual execution.

## 6. Effective chain (sequence)

```
user clicks a binding in the settings page → recording keydown
  │ Escape cancels / invalid combination hint
  ▼
kernel conflicts check (see §7)
  │ rejected → UI red + shows the owner, not persisted, chain ends
  ▼ passed
useSettings.update({ shortcutBindings: {...} })
  ├─ settingService.update(patch)     → zod validation + merge with latest settings + atomic write of setting.json
  ├─ platform.syncAppSettings(patch)  → IPC → main syncImmediateAppSettings:
  │      ├─ patch.shortcutBindings present → rebuildMenu() (accelerator rebuilt from the
  │      │    effective table read from mainSettingService)
  │      └─ webContents.send(SettingsChanged) to all windows
  │           → other windows' useSettings onSettingsChanged → refresh()
  │             → sharedSnapshot updated → effective table recomputed → useAppKeyboard uses the new keys on the next event
  └─ refresh() → this window's sharedSnapshot updated (immediate effect)
```

- Desktop multi-window: window A changes a key → window B refreshes via SettingsChanged (precedent: the
  all-window broadcast of setAutoUpdatePreferences in main/index.ts).
- Web/mobile: `platform.syncAppSettings` is a no-op fallback, a single window has no cross-window problem; menu
  channel commands do not apply.
- At startup: each window's useSettings gets the effective table on first fetch; the main process reads
  shortcutBindings from `mainSettingService.get()` in rebuildMenu.

## 7. Conflict policy (system-reserved keys rejected; in-app occupancy needs a second confirmation to take over)

When recording combination B to bind command C, validate in order:

1. B hits the reserved-key blacklist (RESERVED_BINDINGS, below) → **reject directly**, marked red with the hint
   「系统保留键位」 (system-reserved key), no confirmation entry. Taking over system/browser shortcuts would
   break native input and browser behavior, so there is no second confirmation.
2. B is already occupied by another command in the effective table (including any of its default bindings) →
   **marked red with the owner + a 「仍要绑定」 (bind anyway) second-confirmation button**. After confirmation,
   take over: C's override is written as [B], and the taken-over command's override is written as its effective
   bindings minus B (possibly an explicit empty array = unset, not falling back to default); without confirmation
   the user can keep recording other combinations or exit with Escape.
3. B equals C's current binding → no-op (idempotent).

**Recording-state suppression (so recorded keys do not trigger the original command):** the recording listener
and useAppKeyboard are both window capture listeners, with the recording one registered later (same phase: first
registered runs first). So during recording: the renderer channel is short-circuited by the kernel's
`setShortcutRecordingActive(true)` for useAppKeyboard dispatch; the menu channel notifies main via
`platform.setShortcutRecordingActive(true)` (IPC `SetShortcutRecordingActive`) to rebuild the menu with all
configurable accelerators removed (the macOS system menu eats keys before the renderer, so preventDefault cannot
stop it); the **Web root-level fallback listener** (useRootPlatformEffects fixed to respond to Cmd/Ctrl+N, O)
and the **toolbar fixed hotkeys** (Ctrl+M / Ctrl+Shift+M / Ctrl+T) are likewise short-circuited in the recording
state, since they register earlier than the recording listener and would otherwise eat keys first. Leaving the
recording state restores them.

**Cross-process closure of the recording state (preventing leaks on window destruction):** the IPC carries the
initiating webContents id; when a recording window closes or the renderer crashes it cannot send a reset IPC, so
main resets the recording state by initiating webContents in the existing window-destroy cleanup and
rebuildMenus, preventing menu accelerators from being removed permanently (all later rebuildMenu calls would
build a menu without accelerators, affecting all windows).

**Recording keyboard semantics (recording = explicit intent, the recorder monopolizes the keyboard):**

- **Recording start grabs focus:** the recording row's preview kbd element is `focus()`ed, pulling focus out of
  editable elements (such as a search box). Otherwise a Chinese IME swallows Shift+letter into composition input
  and the recorder only receives isComposing/229 noise events, which is the root cause shape of "cannot
  recognize pure Shift combinations".
- **IME noise events are still recorded by looking up the physical key from `event.code` in the recording state**
  (for events with isComposing / Process / Dead / keyCode 229, `key` is unreliable but `code` is a physical key).
  The matching side keeps filtering fully as before (isShortcutEventNoise unchanged): recording lenient,
  matching strict.
- **Combinations whose platform normalization loses the primary modifier are refused for recording:** on mac
  Cmd+Ctrl+combos, on win/linux pure Meta (Win key) combos both have cmdOrCtrl/ctrl false after normalization;
  serializing as usual would produce a bare single key (like "k") that is not on the blacklist and does not
  trigger conflict detection, and after persisting, pressing that bare key anywhere in the app would hit the
  command and swallow input. Before serialization, `(metaKey || ctrlKey) && !cmdOrCtrl && !ctrl` is refused.
- **Conflict/invalid hints do not exit the recording state:** simply press the new combination again to override
  (the listener stays attached); a modifier pressed alone (pending) immediately clears any remaining
  preview/error/take-over hint, giving visual feedback that the recorder is "still alive".

**Editable-target exemption (pure Shift+printable key and typing a capital letter are the same physical event):**
when useAppKeyboard dispatches, if the event target is input/textarea/contenteditable, bindings of the type "no
primary modifier + Shift + printable single character" (`isShiftOnlyPrintableBinding`) are skipped: no match, no
preventDefault, so the user can type capital letters in the chat input/search box/terminal; with focus in a
non-editable area these bindings work as usual. Named keys (Shift+F1, Shift+arrows) are not affected by the
exemption.

Matching data semantics: an **explicit empty array = "unset"** for a command in `shortcutBindings` (the
effective table is empty and does not fall back to default); the settings page "clear" button and the
taken-over command after a take-over both produce this state; only when all entries are invalid does it fall
back to default (guarding hand-edited setting.json). **This semantics extends to main-side menu resolution**
(`resolveMenuAccelerator`): explicit empty array → the menu item has no accelerator (after a take-over the
taken-over command's default key must really be removed, and must not fall back to a hard-coded default,
otherwise one key triggers two actions); only all-invalid entries fall back to default, consistent with the
renderer effective table.

Reserved-key blacklist (cannot be bound by any configurable command):

- Component fixed-interaction single keys: `Enter`, `Escape`, `Tab`, `Space`, `Backspace`,
  `ArrowUp/Down/Left/Right`.
- Component fixed-interaction combinations (consumed fixedly by the toolbar): `CmdOrCtrl+M` (model menu),
  `CmdOrCtrl+Shift+M` (session mode), `CmdOrCtrl+T` (thinking depth); they do not read the effective table and
  binding them would cause one key triggering two actions. (Superseded by §12.6: these became configurable
  commands.)
- Browser/editing native behavior (primary-modifier combinations): `CmdOrCtrl+C/V/X/Z/A/Y/S/P/L`,
  `CmdOrCtrl+Shift+Z`.
- Refresh and developer tools: `F5`, `CmdOrCtrl+R`, `CmdOrCtrl+Shift+R`, `F12`, `CmdOrCtrl+Shift+I/J/C`.
- Function key area: the whole `F1`-`F12` range is reserved (browser help/developer tools semantics).
- **Web dynamic reservation:** menu-channel commands on Web/mobile are not configurable, but their default keys
  (Cmd/Ctrl+N, O, W and so on) are still consumed fixedly by the root-level fallback listener, so conflict
  detection rejects them as reserved keys (no take-over entry), not opened to take-over like on desktop.

The blacklist is declared in the kernel module in binding-normalized form, and comparison happens after
normalization. Command-table default bindings must not intersect the blacklist (a unit-test assertion, limited
to global-scope commands, see §12). Users may move a command to any combination outside the blacklist,
including keys that belonged to other commands (rule 2 prompts and takes over after second confirmation rather
than the blacklist blocking).

## 8. Settings page UI spec

- Keep the registered shortcuts section (settingsPageConfig / settingsNavigation / SettingsPage mounting done)
  and rewrite `ShortcutSettingsSection`:
  - **One row, several bindings:** one command per row, with the command name in the left column vertically
    centered across all bindings, the key column listing each binding vertically, and the action column a
    "clear all" trash button. A command with no binding shows a 「未分配」 (unassigned) keycap (click to record
    the first one).
  - **Per-key keycaps:** a binding string is split by `formatShortcutBindingLabelParts` into per-key tokens
    (macOS `["⇧","⌘","P"]`, Win/Linux `["Ctrl","Shift","P"]`, the same token sequence as the display label),
    each token rendered as an independent `Kbd` component (`components/ui/kbd.tsx`: reuses
    `ControlShortcutBadge`'s `h-4`, `rounded-md`, `bg-tooltip-tag` / `text-tooltip-tag-foreground` and the
    platform font, adds `min-w-4` and centers, so symbol and letter keys have equal size), with one combination
    laid out in a `KbdGroup` (gap-1). Keycaps of customized commands use the brand color.
  - Row actions (current phase: replace only, no add/delete of a binding yet): clicking a keycap or the pencil =
    **replace that one** (the recording state is embedded at that entry's position, written back as a whole
    group by effective-list index through `buildShortcutOverridesWithBindingAt` on success; an unassigned
    command records the first one through `buildShortcutOverridesAfterAppend`); the trash can = **clear all
    bindings** (override written as explicit `[]` = unassigned, no fallback to default). In the recording state
    `Escape` cancels; `Backspace` restores default (deletes the overrides entry, keeping the SG-03 default-key
    conflict pre-check). `buildShortcutOverridesWithoutBindingAt` (delete a single entry) is ready in the kernel
    with unit tests; the UI entry is left for later.
  - **Same-command duplicates are rejected:** if the recorded combination is physically equivalent
    (`isSamePhysicalBinding`) to another effective entry of this command, it is rejected in red (add compares all
    entries, replace skips the target being replaced); mounting the same key twice on a command is meaningless.
    Cross-command conflict/reserved-key policy is unchanged (§7).
  - Conflict red: `text-destructive` + owner copy (semantic color only for real validation problems per
    DESIGN.md); the hint copy states that after a conflict one just presses the new combination again.
  - The search box filter (matching by command name/ID, hitting all binding rows of the command) and "restore
    all defaults" (clearing shortcutBindings) are kept.
  - **Search by key combination (same as VSCode keyboard shortcuts):** a keyboard icon button at the right end of
    the search box; clicking enters an armed state (placeholder becomes 「按下要搜索的组合键…」 (press the
    combination to search), the input is readOnly). The armed state reuses the in-row recording's keyboard
    exclusivity (`setShortcutRecordingActive`, renderer/menu dual channel), with a window keydown capture:
    `Escape` exits; `Backspace` clears the captured combination; other events are captured by the recorder
    (`recordShortcutBinding`, with platform normalization; keys that cannot appear in the command table such as
    bare letters are silently ignored). A successful capture exits the armed state and the combination becomes an
    independent filter condition (AND with text search): it hits commands in the effective table with a
    **physically equivalent** binding (`isSamePhysicalBinding`, the same canonical measure as conflict detection,
    win Ctrl+m ≡ CmdOrCtrl+m). The captured combination shows from the left as input text (same as VSCode: brand
    color + monospace font, readOnly; the text filter stays in effect internally), and the × at the right clears
    it to pure text search. It is mutually exclusive with in-row recording: clicking a record button while armed
    first disarms, and vice versa. With no hits the table tail shows an empty-state copy (key search carries the
    combination label, pure text search does not).
  - Menu-channel commands on Web/mobile are greyed out (weakened text color, not hidden), with the i18n note
    「仅桌面端生效」 at the row end.
  - The interface-mode switch shortcut keeps being registered and responding but is not shown in the shortcut
    list; the light/dark switch shortcut stays in the list. The sidebar theme and interface-mode submenus show
    only options, without repeating shortcut hints at the bottom.
  - All copy goes through i18n (zh-CN/en-US keys added in sync), replacing the hard-coded Chinese in the
    prototype.
- Display label: `useShortcutCommandLabel(commandId)` takes the first binding of the effective table and
  formats it as a platform label (macOS `⌘K` style, Win/Linux `Ctrl+K` style, keeping existing
  keyboardShortcuts.ts formatting habits); when the command is unassigned (empty effective bindings) it returns
  an empty string, the tooltip shows no key segment and **does not fall back to the default display**: the hint
  must match what actually takes effect. It replaces these call sites: App.tsx:143-149 (7 places),
  NewTaskButtonGroup.tsx:16, WindowsCaptionMenuButton.tsx:238/243/260, WorkspaceSidebar.tsx:414,
  WorkspaceSidebarFooter.tsx:294/302. GitActionMenu's ⏎ and TaskSearchDialog's G/numbers are dialog-internal keys
  outside the command table and stay unchanged.
- Dual-key display: openCommandCenter shows the first binding of the effective table.

### Settings page controls, narrow screen and save feedback

- The search box reuses `SettingsSearchInput`; ordinary text uses the UI font and captured key combinations keep
  a monospace font. The key button and clear button reuse the shared Button.
- The toolbar keeps the settings page's wrapping layout; on narrow screens search takes a row alone, and restore
  defaults uses a compact outline button.
- Wide screens keep four columns (command, keys, scope, actions); narrow screens switch to command/scope on top
  and keys/actions below. Long commands, combinations and conflict hints may wrap and are not clipped.
- Save state is held by ShortcutSettingsSection; binding facts still come from useSettings. All modification
  entries are disabled once submission starts and restored after the settings update and snapshot refresh
  complete. Search is unaffected.
- A save failure shows an accessible error hint, keeps the current settings and restores editing; the user can
  operate again, with no automatic retry. Returning from the reset confirmation must still go through the same
  save entry.
- Original search semantics are kept: text and key conditions are ANDed, readOnly after capture, and clearing the
  key restores the original text condition.
- SC-13: check the search control, the opaque background of keycaps, shared height/radius, long key combinations,
  action buttons and layout in light/dark themes and wide/narrow screens; SC-14: not editable during a
  controlled save, and can be saved again after the failure hint (component tests control the Promise, E2E
  verifies the real save).

## 9. useAppKeyboard parameterization

- Changed to receive `handlers: Partial<Record<ShortcutCommandId, (() => void) | null>>` and read the effective
  table internally; in `useEffect` keydown → filter (repeat/IME) → generic matching over each command's bindings
  by the effective table → on a hit `preventDefault()` and call the handler.
- When a handler is null/missing, **do not preventDefault** (keeping the existing semantics of
  previousConversation/navBack: when the function is unavailable the browser default behavior is let through).
- The handlers mapping at the App.tsx mount point maps to command IDs, one-to-one with current behavior,
  without changing business logic.
- The existing matchesPrimaryShortcut family stays for fixed interactions not in the table (matchesShiftTab and
  so on) and is not deleted in this change.

## 10. Test plan

Unit tests (tests first, then implementation):

- shared serialization: parse/serialize round-trip, normalization (order/case/alias), invalid strings rejected,
  Electron compatibility (CmdOrCtrl passthrough valid).
- kernel matcher: platform isolation (mac meta vs win/linux ctrl), exact modifier match (extra modifiers do not
  hit), Shift+letter (uppercase key/code fallback), macOS Option rewriting (key is a layout character, code
  hits), IME (isComposing/Process/Dead/229 do not hit), repeat does not hit, single-key binding.
- recorder: Cmd/Ctrl→CmdOrCtrl platform normalization, mac Ctrl→Ctrl, Shift+7→7 (code lookup), a modifier alone
  produces nothing, Escape/Backspace semantics, **pure Shift combination (Shift+F) recording**, **IME noise
  events recorded by code lookup (stay pending without a lookup-able code, repeat is not recorded, the matching
  side keeps filtering as before)**.
- effective-table resolve: default merge, whole-group override, invalid entries ignored, unknown commands
  ignored.
- conflict detection: blacklist, cross-command occupancy, idempotence; an assertion that command-table default
  bindings do not intersect the blacklist.
- key-search equivalence (`isSamePhysicalBinding`): win/linux CmdOrCtrl ≡ Ctrl with AltGr overlay; mac primary
  modifier and Ctrl independent (the same string pair's equivalence flips by platform); bare named keys;
  strings that fail to parse are never equal.
- split multi-binding builders: `buildShortcutOverridesAfterAppend` (default keys + overrides all kept,
  appending to unassigned = the first), `buildShortcutOverridesWithoutBindingAt` (delete the given entry, delete
  to empty falls to explicit `[]`, other commands unaffected), `buildShortcutOverridesWithBindingAt` (replace at
  the given position, other default keys kept).
- schema: shortcutBindings patch update round-trip, unknown-field stripping behavior.

E2E (packages/desktop/test/e2e/; app interaction requires E2E by repo rule):

- Record a new binding in the settings page → still effective after restart (setting.json persistence).
- The new binding actually triggers the command in the main UI (for example after rebinding toggleSidebar, the
  new key opens/closes the sidebar).
- Conflict scenarios: record a combination occupied by another command → red hint with the owner + 「仍要绑定」
  confirmation takes over and persists, the taken-over command becomes 「未设置」 (unset); record a system
  reserved key (such as Ctrl+C) → rejected directly with no confirm button; keys during recording do not trigger
  the original command (suppression effective).
- Keys during Chinese IME composition do not trigger commands (can simulate isComposing events).
- Real key pipeline (`browser.keys()`, as distinct from synthetic KeyboardEvent): pure Shift combination
  recording → persist → effective in the main UI (SC-04); after a conflict, pressing a second combination
  directly without Escape (SC-05); IME noise events in the recording state recorded by code (SC-06, synthetic
  isComposing event); pure Shift+printable key does not trigger the command or swallow the character inside an
  editable target (SC-07); after taking over a menu-channel default key the original accelerator is removed and
  the key triggers only the new owner (SC-08, including main-side empty-array semantics).
- "Clear to unassigned" (SC-10): click the trash can → kbd shows 「未分配」 and the clear button is disabled →
  the original default key no longer triggers the command in the main UI → re-entering the settings page is
  still unassigned (covers `[]` override persistence, no fallback to default); the recording-state `Backspace`
  restore-default path is unaffected.
- Search by key combination (SC-11/SC-12, `settings/shortcut-settings-key-search.test.ts`): after arming, the
  platform primary modifier + K filters to the command with that default binding (openCommandCenter) and other
  command rows disappear → clearing restores the full list; a combination with no hit (CmdOrCtrl+Shift+9) shows
  the empty state → clear, re-arm, Escape exit (aria-pressed resets, list unchanged).

## 11. Implementation steps

1. shared: `shortcutCommands.ts` (format + command table) + 3 field places in protocol.ts/schema + unit tests.
2. `ui/src/shortcuts/`: matcher/recorder/resolve/conflicts/label + unit tests.
3. `useAppKeyboard` parameterization + App.tsx handlers mapping + 11 label replacements.
4. Rewrite `ShortcutSettingsSection` + i18n keys (zh-CN/en-US).
5. desktop main: menu accelerator parameterization + the shortcut branch of `syncImmediateAppSettings`
   (rebuildMenu + SettingsChanged broadcast).
6. E2E cases.
7. `pnpm typecheck`, `pnpm lint`, related unit tests and E2E all green before committing.

## 12. Scopes and sources (scoped shortcuts)

Modeled on the When / Source columns of VSCode Keyboard Shortcuts: a binding can take effect only within a
specific **scope**, and the settings page indicates the binding's **source**. With scopes, "dialog confirm keys"
like the Enter family can safely enter the table, because their blast radius is limited to the context.

### 12.1 Scope definition

The command table `ShortcutCommandEntry` gains `scope?: "global" | "composer"` (default `global`):

- `global`: all existing commands. Dispatched by useAppKeyboard (window channel) / the menu accelerator (menu
  channel).
- `composer`: behavior meaningful only while the chat input is focused. Dispatched by the composer's Lexical
  keyboard behavior plugin (`LexicalChatInput` KeyboardPlugin), the **sole consumer**; useAppKeyboard, the menu
  and the Web fallback listener have zero awareness of composer commands (`useAppKeyboard` explicitly skips
  `scope !== "global"`).

The scope implementation does not depend on a global focus registry: the composer plugin's keydown only arrives
while its own editor is focused, the event target is the scope, naturally with no shared state and no timing
problems (the only data source = the DOM event path).

First composer-scope commands (result of auditing component-internal fixed keys, see table):

| Command | Default binding | Description |
| --- | --- | --- |
| `composerSend` | `Enter` | send message |
| `composerInsertNewline` | `Shift+Enter` | insert newline |

Scope candidates from the audit that are **not** in the table (noted for the record): TaskFindDialog's
G/number/⏎ and GitActionMenu's ⏎ (dialog-internal navigation keys, a `taskFindDialog` scope could be added
later); the toolbar's Ctrl+M / Ctrl+Shift+M / Ctrl+T (consumed across scopes, kept global + blacklist per §7;
superseded by §12.6).

### 12.2 Kernel changes

- Key-name whitelist: `NAMED_KEYS` adds `Enter` (so `Shift+Enter` and `CmdOrCtrl+Enter` become expressible); the
  recording-side `CODE_TO_KEY` adds it too (main keyboard `Enter` code; `NumpadEnter` is not mapped).
- The reserved-key blacklist tightens accordingly: `Enter` joins `RESERVED_BINDINGS`, **effective for the global
  scope only**; the assertion "command-table default bindings must not intersect the blacklist" narrows to
  checking global commands only.
- Conflict detection is isolated by scope: when rebinding a command it is compared only with commands of the
  **same scope** (`CmdOrCtrl+Enter` coexisting as the composer send key and a global command is not a conflict);
  the blacklist blocks rebinding only in the global scope.

### 12.3 Composer plugin dispatch order (priority of the rebind layer and runtime features)

```
keydown (composer Lexical KEY_ENTER_COMMAND, COMMAND_PRIORITY_HIGH)
  ① disabled / isComposing ──▶ as before (block entirely / let IME candidate confirmation through)
  ② rebind layer resolveComposerKeyAction (shortcuts/composerShortcuts.ts, reads composer commands of the effective table)
       ├─ hits composerInsertNewline ──▶ let Lexical insert a paragraph (newline)
       └─ hits composerSend ──▶ send branch (reusing the existing semantic functions):
             combination with no modifier ──▶ gated by submitDisabled / enterSubmits (mobile viewport), equivalent to today's bare Enter
             with Ctrl/Meta modifier and reversed delivery enabled (onModifiedSubmit injected) ──▶ yield: let the main chain through,
             Ctrl+Enter still expresses the "reverse delivery" runtime feature (delivery semantics are more specific than the key binding)
  ③ no hit (including all modified combinations in the default state) ──▶ the existing main chain runs unchanged
```

In the default (no user override) state ② and ③ are equivalent branch by branch (the unit test locks the matrix:
desktop/mobile viewport × Enter/Shift+Enter/Ctrl+Enter × reversed delivery switch), guaranteeing zero
regression. Whole-group replacement semantics are unchanged: after the user rebinds `composerSend` to
`CmdOrCtrl+Enter`, bare Enter is unbound → in the ③ main chain, with shift/ctrl/meta all false and
`enterSubmits` true, it would take the default send; to make the bare Enter of "Ctrl+Enter people" fall to a
newline, the main chain's bare-Enter branch gets a scope check first: when the effective binding of
`composerSend` does not contain bare Enter (the user removed it), bare Enter lets Lexical insert a newline.
When Shift+Enter is not overridden the `composerInsertNewline` default binding hits as usual for a newline,
unaffected.

### 12.4 Settings page

- composer commands appear in the list automatically (data-driven).
- **Scope becomes its own column:** the list grows from three to four columns (command | keys | scope | actions),
  each row explicitly marked 「全局」 / `Global` or 「输入框」 / `Composer` (i18n zh/en in sync); a small badge
  reads poorly, and an independent column makes the scope obvious at a glance.
- The menu-channel greying logic does not apply (composer commands are changeable consistently on all three
  ends); the 「仅桌面端生效」 badge stays beside the command name (platform availability semantics, orthogonal to
  scope).
- "Restore all defaults" is destructive: clicking reuses the global confirm dialog
  (`useConfirmDialogStore` + `ConfirmDialogHost`, Enter confirms / Esc cancels), and `shortcutBindings` is
  cleared only after the second confirmation; the button is disabled without overrides.
- The "source" column (default/user/plugin) is temporarily carried by the existing visuals (override keys in
  brand highlight + restore default), to be materialized as an independent column once plugin keys enter the
  command table.

### 12.5 Tests

- shared: Enter-family parse/serialize round-trip; the `scope` field; composer command table entries.
- ui kernel: `RESERVED_BINDINGS` contains `Enter` and blocks only global; conflict detection scope isolation;
  `resolveComposerKeyAction` matrix (default/rebind/reversed delivery yield/unbound fallback); the default-state
  ②≡③ equivalence matrix.
- E2E (SC-09): in the settings page record composerSend as `CmdOrCtrl+Enter` → bare Enter in the composer does
  not send (input kept), `CmdOrCtrl+Enter` sends (the draft clears or the user message appears). Note that
  persisting ≠ the renderer effective table refreshing instantly (the SettingsChanged broadcast has a
  sub-second async window); after the persistence assertion the case explicitly waits for the window to pass
  before verifying main UI behavior.

### 12.6 Composer toolbar hotkeys become configurable commands

The former fixed hotkeys Ctrl+M (open model menu) / Ctrl+Shift+M (switch session mode) / Ctrl+T (switch thinking
depth) were consumed fixedly by the window capture listener of `v4/composer/toolbarShortcuts.ts` without reading
the effective table (CR-06 once blocked them via the reserved blacklist). They are now command-table commands:

| Command | Default binding | Description |
| --- | --- | --- |
| `openModelMenu` | `Ctrl+m` | open model menu |
| `cycleSessionMode` | `Ctrl+Shift+m` | switch session mode |
| `cycleThoughtLevel` | `Ctrl+t` | switch thinking depth |

- **Explicit Ctrl modifier** (not CmdOrCtrl): the semantics are Ctrl on all three ends (also Ctrl on mac),
  equivalent to the exact-modifier match of the old `matchesCtrlShortcut` family, with default behavior
  unchanged.
- Dispatch stays in the toolbar's window capture listener (the action depends on composer toolbar state: model
  menu openRequestKey, option gating and so on), but matching reads the effective table, so rebinding in the
  settings page takes effect immediately; recording-state suppression, defaultPrevented/repeat/isComposing
  filters and option ownership gating are unchanged.
- The reserved blacklist drops these three accordingly (the CR-06 blocking scheme from before §12.6 is
  withdrawn): the conflict system (occupancy detection + second-confirmation take-over) applies to configurable
  commands across the board.

Physical-equivalence conflict detection (new CR-01): the matching side treats platform-equivalent combinations as
the same physical key; if conflict detection compared only strings exactly, the recorder's platform
normalization product (recording ⌃M on win yields "CmdOrCtrl+m") would bypass the occupancy check against the
explicit-Ctrl default bindings (the three toolbar keys), causing silent shadowing with no hint (useAppKeyboard
dispatches first with preventDefault, the toolbar listener's defaultPrevented guard gives up, and the menu dies
silently). So conflict detection and take-over clearing both operate on canonical keys: on non-apple platforms
CmdOrCtrl ≡ Ctrl ≡ AltGr (primary modifier bit) and AltGr ≡ Alt (overlay bit) are folded together; on apple
platforms CmdOrCtrl(meta) and Ctrl are independent physical keys compared separately. macOS also has a minimize
guard: ⌘M is the fixed accelerator of the system menu `role:"minimize"`, so binding ⌘M in any scope (including
composer) is refused as a reserved key; the system menu eats the key before the renderer, so such a binding
would be dead on arrival.

Review conclusions (SG-03 / SG-09):

- **Restore default (clear override) is guarded like recording:** before clearBinding, a conflict pre-check runs
  with the command's first default key (after physical-equivalence normalization, including variants like
  Ctrl+m ≡ CmdOrCtrl+m); on occupancy a toast names the owner and **nothing is persisted**. By product decision
  it only hints and does not clear the occupier automatically (auto-clearing would need chained restore logic,
  which is extra design); the recording-state Backspace path reuses the same clearBinding and is naturally
  guarded the same way.
- **Division of labor between "clear" and "restore default" (post-review):** trash-can "clear" = override written
  as explicit empty array = unassigned (the original key is fully disabled); recording-state `Backspace` =
  restore default = delete the override entry (the only entry for returning a single command to default; a
  global "restore all defaults" also exists). Clearing only reduces bindings and produces no new key, so it does
  not break the "one key, one command" invariant and does not go through the conflict pre-check; restoring
  default reintroduces the default key into the effective table and must be pre-checked.
- **Unified open policy of the composer scope:** not limited to the Enter key family; `resolveComposerKeyAction`
  matches all bindings of the effective table, and users can bind send/newline to any key (such as F9),
  consistent with the open policy of other commands. A cross-scope same key (for example composerSend bound to
  CmdOrCtrl+k together with the global command center) is not reported as a conflict by the §12.2 scope
  isolation and both actions happen on the keypress; that is an explicit user choice under the open policy.
  **Dispatch-layer companion (new CR-01 closed):** KEY_ENTER_COMMAND is dispatched only for Enter, so non-Enter
  rebindings are dispatched by LexicalChatInput's root keydown capture (handleNonEnterScopedKeydown): a newline
  hit explicitly runs insertLineBreak; a send hit reuses the send chain but is not subject to the mobile
  viewport `enterSubmits` gate (accidental soft-keyboard sending concerns only the Enter physical key), and has
  no intersection with reversed delivery (which responds only to Ctrl/Meta+Enter), so it needs no yielding. The
  pure function `resolveComposerKeyAction` is shared by both dispatch paths.
