# CUA Composer Persistent Entry Button (Phase 1: Button + State Machine)

- Date: 2026-08-18
- Status: design confirmed, pending implementation
- Upstream PRD: "ZCode CUA Composer Persistent Button & Free Trial PRD v0.2" (Feishu wiki
  EEE7wZ06Ti7Gx5kGWU8cthX9nOg)
- Branch: `feat/cua-composer-entry`
- Later change: see "2026-09-11 change: Computer Use off by default" at the end. It removed the "not enabled"
  (`plugin-disabled`) UI state described in several places below; read the state tables and ASCII diagrams
  together with it.

## Background

CUA currently has one user-initiated entry: the `zcode-cua` plugin master switch in `Settings -> Computer Use`
(`packages/ui/src/settings/ComputerUseSection.tsx`). Weak user awareness and high discovery cost are the core
problem identified in PRD section 2.1.

The full PRD plan includes a free-trial onboarding layer and a free quota system. **This phase implements only
the entry and status presentation**, because the quota chain (`cua-trial` entitlement, token reserve/settle,
official trial Provider + multimodal trial model, trial task freeze, upgrade prompt dialog) has zero basis in
the current repo and depends on z.ai billing server-side delivery; the PRD itself is marked "draft, pending
billing final review". Implementing a client quota UI before the server contract is settled would only cause
rework.

## Scope

### Implemented in this phase

1. A persistent "Computer Use" button to the right of the permission-mode selector in `V4ComposerToolbar`.
2. 5 external UI states + a low-intensity status dot (not enabled grey / enabling grey spin / enabled green /
   permission missing yellow / error red). (2026-09-11: the "not enabled" state is deleted, now 4 states; not
   enabled means not rendered.)
3. 6 tooltip texts (5 states + the session-running disabled state), bilingual. (2026-09-11: `...tooltip.disabled`
   was deleted with the "not enabled" state, now 5.)
4. `session-busy` interactivity override: any turn running in the workspace disables the whole button.
5. Platform gate: remote / linux / plain Web / mobile remote control do not render it.
6. Click behavior: every visible state jumps to the settings `computerUse` section; only the session-busy
   override does not respond. (2026-08-20 change; originally "only not-enabled and permission-missing were
   clickable, other states had only a hover tooltip", see the "Click behavior" section.)
7. Settings switch "Show the Computer Use button in the composer" (default shown; off hides it persistently).
   (2026-08-21 changed to default hidden; since 2026-09-11 the switch is greyed out with different hint copy
   while Computer Use is off.)

### Explicitly not done in this phase

Not done (PRD sections), with reasons:

- 4.2 / 6.2 free-trial onboarding dialog: product decision, the button jumps straight to settings.
- 7 / 7.1 / 7.2 free quota, trial model, trial task, upgrade prompt: depend on the z.ai billing server; contract
  not finally reviewed.
- 4.2 step 2 / 4.3 item 4 `capability-changed` protocol event: needs extending `@zcode/protocol` +
  `apps/zcode-cli`; this phase uses plugin toggling + Helper health as an approximation.
- 4.5 multi-task floating window: coupled with quota/concurrency rules.
- 4.6 tracking funnel: mostly onboarding-layer conversion, pointless without the onboarding layer.

**Degraded readiness criterion**: PRD 4.3 requires all 5 checks; this phase judges 3: the plugin enabled write
succeeded, Helper permission passes (mac, `isCuaPermissionTccGranted`: both TCC items granted), and Helper
status is available.

**Why functional probes are not used** (corrected 2026-08-19): this item originally used
`isCuaPermissionStatusFullyReady` (both TCC items + two functional probes ok), a constant-false condition:
upstream `shouldRunCuaScreenCaptureProbe` requires an explicit `includeFunctionalProbes` (active screen capture
must be a user intent), the persistent entry only does read-only refresh, so `screenCaptureProbeOk` is always
`false` and an authorized user would stay on the "missing macOS permission" yellow dot. It now uses the same
TCC criterion as the settings permission rows; a failed tool call reaches the model as an ordinary MCP error and
the model may call the read-only `request_access`. The Renderer neither infers permission from error text nor
opens the authorization guide automatically.

**Known risk**: the tool set of a live session may not yet be refreshed, so the user sees a green dot while the
Agent does not yet have CUA tools. This is a direct consequence of the missing `capability-changed` and must be
filled in the next phase.

## Visibility and state derivation

```
                    ┌──────────────────────────────────────────────┐
  visibility gates (four layers since 2026-09-11; any failure → no DOM rendered, not rendered as disabled)
  ├ platform gate : macOS desktop || Windows desktop and a local workspace
  │                 remote / linux / web / mobile remote → unsupported
  ├ setting gate  : AppSettings.computerUseComposerEntryHidden === true
  │                 → hidden
  ├ service gate  : on mac, services.cuaPermissionService missing → not rendered
  └ plugin gate   : cuaPlugin.enabled !== true and not toggling → not rendered
                    (added 2026-09-11, see the change section at the end)
                    └──────────────────────────────────────────────┘
                                    ↓ all pass
  ┌──────────────── underlying state (three data sources merged) ────────────────┐
  │ ① pluginManagementStore : cuaPlugin.enabled / togglingPluginId
  │ ② useCuaPermissionStatus: accessibility / screenRecording + probes
  │                           (queried only on mac and when ① enabled is true)
  │ ③ session running facts : current pane snapshot.control.canStop
  │                           || workspace runtime running/activeInputId
  │                           || visible task index status=running
  └──────────────────────────────────────────────────────────┘
                                    ↓
   internal state        →  UI state        status dot     click behavior
   ────────────────────────────────────────────────────────────────
   plugin-disabled       →  (deleted 2026-09-11: not rendered, see the plugin gate)
   starting (toggling)   →  enabling        subtle spin    jump to settings computerUse
   permission-required   →  permission missing  amber      jump to settings computerUse
   ready                 →  enabled         green          jump to settings computerUse
   error                 →  error           red            jump to settings computerUse
   ────────────────────────────────────────────────────────────────
   session-busy ── interactivity override, underlying state unchanged ──→ greyed + disabled tooltip + no click response
```

### Click behavior (2026-08-20 change)

The original design made only `plugin-disabled` and `permission-required` clickable, and `starting` / `ready` /
`error` were pure status lamps (PRD section 3 item 6). The actual feel after landing was broken: after a user
followed the guide through TCC authorization and the button turned green, clicking it did nothing; a control
that looks like a button, has a hover tooltip and ignores clicks reads as a malfunction, not as "no action by
design in this state".

It is now **clickable whenever visible, always jumping to the settings `computerUse` section**, the only
exception being the session-busy override (the button is then greyed with a "session in progress" tooltip, and
allowing the jump would contradict the visual).

The justification is the destination itself: the settings `computerUse` section has something for the user in
every state: the plugin master switch, the mac permission rows and authorization button, error details, and the
"show the Computer Use button in the composer" switch. From the ready state they can turn it off; from the
error state they see the reason; from the enabling state they see the plugin row spinning in sync. No state
makes the jump pointless, so the whitelist has no value. In the implementation `CLICKABLE_STATES` was deleted
and `clickAction` is decided by `interactionDisabled` alone.

### Where each internal state is decided (implementation contract)

| Internal state        | Condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `starting`            | `togglingPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID` (highest priority, overrides all states below)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `error`               | (1) `pluginManagementStore.error` is non-empty and this operation targeted zcode-cua (ownership is recorded by the store's `lastFailedPluginId`: an operation failure with a pluginId writes that id, while failures without a plugin target such as marketplace/validate/load write null; CR-01, preventing a shared error from mapping an unrelated failure to the button error state); or (2) on mac the plugin is enabled but the Helper status is `!isCuaPermissionStatusAvailable(status)` (Helper failed to start / unhealthy) |
| ~~`plugin-disabled`~~ | ~~`cuaPlugin?.enabled !== true`~~ (deleted 2026-09-11: not enabled is no longer a UI state but is kept out of rendering by the plugin gate)                                                                                                                                                                                                                                                                                                                                                                                           |
| `permission-required` | mac + plugin enabled + Helper status available + `!isCuaPermissionTccGranted(status)`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ready`               | plugin enabled, and (Windows) or (mac and `isCuaPermissionTccGranted(status)`)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Priority short-circuits top to bottom. When the permission status has not returned for the first time
(`status === null`, cold-start window) it is treated as `starting` rather than `error`, avoiding a red dot
flash when the window just opened.

### Platform differences

- **macOS**: permissions need to be measured. Source (2) participates fully.
- **Windows**: no TCC, source (2) is skipped entirely; `plugin.enabled === true` means `ready`.
- Exactly the same source as the existing platform decisions of `ComputerUseSection`, reusing
  `supportsLocalMacCuaPermissionOnboarding` / `IS_MACOS_DESKTOP` (`lib/cuaPlatform.ts`) and
  `isRemoteWorkspaceIdentity`; no new platform criteria are written.

### Semantic boundary of session-busy

It is an "interactivity override", not a sixth UI state, and does not change the underlying state: after all
turns end the original state and dot color restore automatically. The current pane uses
`snapshot.control.canStop` as the lowest-latency authority; the workspace-level fallback also checks runtime
running, `activeInputId` and the visible task index's `running` status, so a projection briefly returning to
ready does not wrongly unlock. The decision granularity is the **workspace** (not a single task): toggling the
plugin enabled state changes the tool set of all sessions in that workspace and invalidates the prompt cache,
so the affected scope and the disabled scope must match.

The composer stop button is not affected by this disabling (it goes through the existing stop control chain);
otherwise a running task could not be aborted.

### Permission query cost constraint

> Rewritten 2026-08-19: polling (exponential backoff from 1s, per-instance timers, 10s once all granted) was
> removed entirely; the text below is the current architecture.

`useCuaPermissionStatus` has no steady-state timer. State lives in the in-process shared cache of
`lib/cuaPermissionStatusStore` (slotted per workspace), read by both the settings page and the composer entry,
so they neither query twice nor show different results. Refresh happens at three event-driven moments: mount
(a later mount rides the in-flight query through `ensure`); window regains focus (the user came back from macOS
System Settings); an explicit caller `refresh` (plugin switch, Helper restart, return-from-authorization
recovery chain).

Polling was removed for more than RPC cost: every round reset `fresh` to false, so the settings authorization
button label flipped between "Open System Settings" and "Verifying..." with width jumps. Display therefore
follows `settled` (holds once there is displayable content, only goes up), and `fresh` is used only for
decisions.

**The only timer** is transient convergence: during Helper cold start / recreate right after the plugin is
enabled, main-side `getStatus` honestly returns unavailable, and treating that as final would show a red dot
with a non-clickable error. For "unavailable or reject" it retries with bounded backoff per
`TRANSIENT_RETRY_DELAYS_MS` (1s/2s/4s), publishing nothing during retries; after the budget an unavailable
result publishes the error state, while a reject keeps lastKnown and waits for the next real event.

The gate kept: **query only when `cuaPlugin.enabled === true` and on mac**, since the not-enabled presentation
is unrelated to permissions; a unit test stops a refactor from lifting the query outside the gate.

## Components and files

| File                                                        | Responsibility                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/ui/src/lib/cuaComposerEntryState.ts` (new)        | Pure function `resolveCuaComposerEntryView(inputs)` → `{ visible: false }` or `{ visible: true, uiState, tone, spinning, tooltipMessageId, clickAction, interactionDisabled }`. Zero React / zero store dependency |
| `packages/ui/src/hooks/useCuaComposerEntry.ts` (new)        | Orchestration hook: merges the three data sources, gates the permission query by enabled, calls the pure function                                                                                                  |
| `packages/ui/src/v4/composer/V4ComposerCuaEntry.tsx` (new)  | Two-layer component: outer platform gate + inner presentation (below)                                                                                                                                              |
| `packages/ui/src/lib/cuaPlatform.ts` (changed)              | Platform detection changed from module-level constants to lazy functions, plus a new Windows gate                                                                                                                  |
| `packages/ui/src/v4/ConversationComposer.tsx` (changed)     | Inserted after `V4ComposerModeSwitch` inside `leadingActionsNode`                                                                                                                                                  |
| `packages/ui/src/settings/ComputerUseSection.tsx` (changed) | New "Show the Computer Use button in the composer" row in the master switch card                                                                                                                                   |
| `packages/shared/src/protocol.ts` (changed)                 | `AppSettings` gains `computerUseComposerEntryHidden?: boolean`                                                                                                                                                     |
| `packages/shared/src/validationAppSettings.ts` (changed)    | Matching validation                                                                                                                                                                                                |
| `packages/shared/src/test-ids.ts` (changed)                 | Adds `TID_V4_COMPOSER_CUA_ENTRY`                                                                                                                                                                                   |
| `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts` (changed)   | New copy                                                                                                                                                                                                           |

Extracting state derivation into a zero-dependency pure function is the core of the design: the combination
space is large (platform x hidden switch x plugin state x permission state x busy), and only a pure function
can test this matrix fully without a store mock per combination.

### Why the component has two layers

`V4ComposerCuaEntry` (outer) calls only `useOptionalPlatform` / `useOptionalServices` to decide the platform
gate and returns null otherwise; `V4ComposerCuaEntryMounted` (inner) calls `useCuaComposerEntry`. When the gate
fails no settings subscription, plugin store read or permission query starts. The composer also renders in
hosts without `PlatformProvider` / `ServiceProvider` (3 existing composer tests); the inner `usePlatform` /
`useServices` throw there (the first wiring broke 22 tests), so the outer layer uses the optional variants and
silently degrades to not rendering. For the same reason the hook uses `useOptionalTabStore`: without a provider
`openSettingsTab` is a noop and the button still renders and hovers.

### Platform detection becomes lazy functions

`IS_MACOS_DESKTOP` in `cuaPlatform.ts` was an import-time constant, so UA-based tests could not cover several
platforms in one process. It becomes the lazy functions `isMacOsDesktopUserAgent()` /
`isWindowsDesktopUserAgent()` (runtime-equivalent). The Windows gate's capability criterion is
`executeDesktopCommand` (desktop-only injection), not `openCuaPermissionOnboarding`, which does not exist on
Windows (no TCC).

### Visual specification

Follows `DESIGN.md`:

- The trigger uses one decision across Draft and existing sessions, desktop and mobile Web: the toolbar's
  single layout owner applies these seven compression steps cumulatively by the real available width, stopping
  at the first step with enough space and skipping controls that do not exist:
  1. Computer Use collapses to a 28px square icon button.
  2. mode collapses to a 28px square; Plan, think and provider keep text.
  3. Plan collapses to a 28px square; think and provider keep text.
  4. think hides text and dropdown arrow, keeping the icon + small green bar; provider and model stay fully
     shown.
  5. Hide provider-text; think keeps the small green bar; the model name stays fully shown.
  6. think drops the small green bar and collapses to a 28px square; the model name stays fully shown.
  7. model collapses to a 28px square icon button (no extra truncation step or sub-80px step).
- Container width breakpoints no longer hide the copy early; with enough space model and provider names show
  fully (no pre-truncation at 256px). A fixed 12px gap separates the two groups, the send button stays usable,
  wrapping is forbidden, and icon buttons keep the original action, Tooltip and accessible name.
- think's level logic is unchanged (progress by configured order, off/invalid values zero; when text collapses
  the Tooltip shows the current level, disabled reason first; single-level read-only, multi-level select).
  Only the composer uses these presentation forms.
- When space returns, re-decide from the full layout and restore in reverse: model name, think small green bar,
  provider, think text, Plan text, mode text, finally Computer Use text. A late-appearing Computer Use,
  model/language change and window resize re-measure; with system reduced-motion on or off, provider and model
  stay on one text line (no wrapping or vertical clipping from DOM hierarchy changes).
- Acceptance: narrow/widen the toolbar step by step and check the seven-step order with each step collapsing/
  restoring independently (think small green bar vs provider and think square vs model square are not merged;
  controls absent are skipped; multi-level/single-level think; long provider and model; zh/en; desktop/mobile;
  light/dark; normal/reduced motion); the small green bar is really visible, level height correct, all controls
  keep their operations.
  ```text
  size or content changes → toolbar single layout owner → measure the full buttons
    → Computer Use square
    → mode square (Plan, think and provider text kept)
    → Plan square (think and provider text kept)
    → think small green bar (provider kept)
    → hide provider-text (think small green bar kept)
    → think square (small green bar hidden, model name kept)
    → model square
    (measure each step, stop when enough; when widening recompute from the full layout and restore in reverse)
  ```
- The status indicator is a compact dot, a normal flex child on the right of the button content (not absolutely
  positioned); when text collapses it still follows the icon. It keeps the state machine's
  `subtle/green/amber/red` tones mapped to semantic backgrounds (not-enabled/enabling use the secondary
  foreground; permission missing, ready, error use warning, success, destructive); `spinning` maps to a pulse
  on the dot. The settings page's `StatusDot` is unaffected.
- Font sizes use only `text-ui-*`. **Not highlighted**: the default state has the same visual weight as the
  other toolbar controls.

## Settings switch

- Field `AppSettings.computerUseComposerEntryHidden?: boolean`.
- It uses `hidden` rather than `visible` semantics: `undefined` means shown by default, so old users need no
  data migration.
- Reads go through `useSettings()` (shared snapshot + cross-window broadcast), writes through
  `services.settingService.update()`.
- The flag is persistent; restart and version updates do not self-heal it, and it can only be turned back on in
  the settings page (PRD 4.1).
- Hiding the entry does not affect tasks in progress.

## Copy (PRD 6.1 / 6.4 original text)

| message id                                       | Chinese (UI string)                                                  | English                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `chat.toolbar.computerUse.label`                 | 电脑操作                                                             | Computer Use                                                                                             |
| ~~`…tooltip.disabled`~~                          | ~~体验电脑操作 · 让 ZCode 直接操作你的电脑~~ (deleted 2026-09-11)    | ~~Try Computer Use — let ZCode operate your computer~~                                                   |
| `…tooltip.starting`                              | 正在启用电脑操作插件…                                                | Enabling Computer Use plugin…                                                                            |
| `…tooltip.ready`                                 | 电脑操作已就绪 · 直接描述你想让 ZCode 做的事                         | Computer Use ready — just describe what you want ZCode to do                                             |
| `…tooltip.permissionRequired`                    | 缺少 macOS 权限，点击完成授权                                        | Missing macOS permissions — click to grant                                                               |
| `…tooltip.error`                                 | 电脑操作启用失败 · 重启 ZCode 应用后重试，或让 ZCode 排查日志        | Computer Use enablement failed. Please restart ZCode app and retry, or ask ZCode to investigate the logs |
| `…tooltip.sessionBusy`                           | 会话进行中，暂不能切换电脑操作；任务结束后可再试                     | A conversation is running. Computer Use can't be toggled right now — try again after it finishes.        |
| `settings.computerUse.composerEntry.label`       | 在输入框显示电脑操作按钮                                             | Show Computer Use button in the composer                                                                 |
| `settings.computerUse.composerEntry.description` | 关闭后输入框不再显示电脑操作按钮，也不会自动恢复；可随时在此重新开启 | When off, the composer button is hidden and stays hidden until you turn this back on.                    |

PRD 6.1 strikes through "enabling", but the state list in section 3 item 2 still keeps that state. This design
keeps the copy: the strikethrough is read as "not a standalone onboarding landing point", not "give the user no
hint at all"; toggling is a real intermediate state, and no hint during it would make the user think the click
had no effect. (The state was originally not clickable either; since 2026-08-20 it jumps to settings like the
other visible states.)

## Tests

Per AGENTS.md "tests before code":

1. **`cuaComposerEntryState.test.ts` (main, 23 cases)**: the state derivation matrix, platform (mac/win/other)
   x hidden switch x plugin state x permission state x busy, asserting
   `{visible, uiState, tone, spinning, tooltipMessageId, clickAction, interactionDisabled}`; one case iterates
   all 5 states to lock "clickable except for session-busy" so the clickable-state whitelist is not
   reintroduced.
2. **`useCuaComposerEntry.test.ts`**: wiring facts. Core: no permission query when the plugin is not enabled /
   the list is not loaded / hidden by settings; remote workspace and remote session not rendered; click
   navigation; locks from canStop, runtime active input and task index running, and unlock from a terminal task
   index.
3. **`v4ComposerCuaEntry.test.ts` (7 cases)**: presentation maps the view faithfully (not rendered when
   invisible, data attributes, tooltip, `clickAction` decides `onActivate`, disabled state ignores clicks but
   keeps a hoverable DOM, Computer Use's `@2xl/composer` boundary).
4. **`computerUseComposerEntrySetting.test.ts` (5 cases)**: default shown, writing true/false, rollback on write
   failure.

**No E2E added**: the button's truth depends on macOS TCC and Helper process state, so CI containers cannot
produce meaningful assertions; re-evaluate once `capability-changed` and the quota chain land.

## Multi-client impact

- **Desktop mac/win local workspace**: the new button, main path.
- **Desktop remote workspace (SSH/WSL/Docker)**: `isRemoteWorkspaceIdentity` hit → not rendered.
- **Mobile `/remote`**: remote-control protection constraint → not rendered.
- **Plain Web**: platform gate fails → not rendered.
- **linux local**: product Host not wired → not rendered.

It does not touch the session / task realtime message stream, does not involve the `clientMode` /
`deliveryKind` boundary, and does not change the owner / lease / snapshot chain. Source (2) is an existing host
RPC read-only query, and (3) is a renderer-local store read.

## 2026-09-11 change: Computer Use off by default

A product decision rolled Computer Use (CUA) back from "default on at first launch" to "default off, the user
enables it explicitly in settings". Three places in this design are affected:

1. **Plugin default state**: `official-plugin-definitions.ts` no longer declares `defaultEnabled` for
   computer-use, and the default-enabled list in `packages/shared/src/plugin-marketplaces.ts` drops that entry
   too (the bootstrap unit test mechanically compares the two lists). The decision is
   `enabledPlugins[id] ?? defaultEnabled`, so users who once turned it on manually in settings already have an
   explicit `true` persisted and are unaffected; users who never toggled it get it off.

2. **A plugin gate is added to the visibility gates**: when not enabled the button is not rendered, instead of
   rendering a grey dot as an acquisition entry. Under default-off semantics that grey dot would be a
   permanent promo slot for every new user, and the button remaining after the user turned Computer Use off in
   settings reads as not fully turned off. The exception is `pluginToggling`: during toggling `pluginEnabled`
   is still the old pre-toggle value, and blocking it too would leave the "enabling" spinner an empty gap.

3. **The `plugin-disabled` / "not enabled" UI state is deleted**: with the gate it is unreachable (the only
   not-enabled combination that passes the gate is toggling, and toggling returns `starting` first), and the
   `chat.toolbar.computerUse.tooltip.disabled` copy is removed with it, leaving no unreachable branch or
   orphaned copy. External UI states drop from 5 to 4.

Accompanying settings adjustment: while Computer Use is off, the "Show the Computer Use button in the composer"
switch is greyed out and its description becomes `settings.computerUse.composerEntry.requiresEnabled` ("Turn on
Computer Use first..." / 「需先开启电脑控制…」). Otherwise it would be a clickable, writable switch whose button
never appears, and users would conclude the switch is broken.
