# Workspace Header Help Menu

The workspace header action area offers a light help menu left of the terminal button, a fixed entry for
support, feedback and documentation inside the main workspace.

## Layout

- In the full Workspace Header of an existing task, the help button sits left of the Terminal toggle, in the
  same header action group as editor switching, Terminal and Side pane.
- The new-task draft state has no full Workspace Header, but the top right still offers the same help button.
- The button uses the icon-button style, keeping `icon-md` size and `ghost` look so it does not squeeze the
  workspace title.
- Narrow remote phone screens reuse `simplifyForNarrowRemote`, hiding the help and Terminal buttons to keep
  the remote title bar uncrowded.
- On Windows / Linux desktop the draft state's top right has custom-drawn window control buttons; the help
  button must clear the minimize, maximize and close area through the right safe spacing.

## Menu Items

The menu has two groups with no group titles; only desktop puts a divider between them.

Group one, top to bottom:

1. Product docs: open `https://zcode.z.ai/docs`.
2. User community: via `IPlatformService.openCommunity()`.
3. Report a problem: open the built-in feedback form, keeping `type=bug`, `module=其它` (Other),
   `includeLogs=true` and the screenshot behavior.
4. Request a feature: open a standalone request dialog, keeping `type=feature`, `includeLogs=false`.

Group two, desktop only, top to bottom: Export logs, Resource manager, Check for updates, About ZCode. Check
for updates shows only in production, keeping the existing dynamic copy and disabled state; hidden in
Preview. About is always the last item.

"Export logs" reuses the `titleBar.menu.help.exportLogs` copy and
`createHelpMenuActionHandlers().exportLogs`, calling the same main-process export function as the system
menu through `IPlatformService.exportLogs()`. It keeps the exporting toast, failure hint and revealing the
log bundle in the system file browser on completion, and adds no export implementation. Web (including
mobile remote) has no local export capability, keeps only group one and renders no export entry or extra
divider.

```text
question-mark menu -> shared export action / toast -> IPlatformService.exportLogs() -> IPC ─┐
system menu -> DesktopCommandIds.ExportLogs ────────────────────────────────────────────┤
                                                                                        ↓
                                                              main exportLogs -> log bundle / system reveal
```

Update status chain: main updater (sole owner) -> platform snapshot / state event -> menu display; click ->
existing desktop command -> main updater. A live event takes priority over an earlier-sent snapshot, and a
response after unmount is not applied.

Acceptance: the shared question-mark menu on the desktop task page, draft state and settings page can all
open the About window, showing "关于 ZCode" / "About ZCode" in zh/en; Web shows no dead entry.

Export acceptance: component unit tests cover the desktop entry, the shared action and Web hiding; the
English draft-state and Chinese settings-page scenarios of `help-menu-about.test.ts` really click Export logs,
verifying the main process generates a ZIP and requests system reveal, the export hint closes on completion,
and menu order and the About entry stay verified. The system reveal call is intercepted in isolated E2E while
the real archive still runs.

2026-10-09 verification: macOS arm64 Preview E2E 4/4 passed, English Zai Light and Chinese Zai Dark
screenshots checked; help config uses local fixtures and asserts order after dynamic items finish loading;
related unit tests 34/34, typecheck, E2E typecheck, lint, architecture and format checks passed (68 lint
warnings not from this change). Not run: Windows/Linux real machines, mobile browsers, production-identity
E2E. Run record:
`packages/desktop/.e2e-artifacts/desktop-e2e-20261009043852849-p29715-f22a05c87493b116/summary.json`.

All visible copy must go through i18n; menu items use lucide icons and no Chinese is hard-coded in
components.

## Request a Feature Dialog

- Does not reuse the general problem-report form, so screenshot, log and problem-description bug semantics
  do not interfere.
- The dialog has guide text, required "需求描述" (Requirement description) and "期望的解决方案" (Expected
  solution), and an optional contact.
- The red `*` of required titles reuses the same marker component as problem report, with `aria-hidden`, so
  screen readers do not read the decoration into the title. The two required inputs express field semantics
  through `required`, `aria-required` and a localized accessible name, not relying on reading the asterisk.
- FB-REQ-A11Y-01: the real help-menu case in `feedback-upload-privacy.test.ts` covers zh/en, wide/narrow
  windows and dark/light themes, checks both asterisks are visible yet hidden from assistive technology and
  that an empty form cannot be submitted; no real request ticket is submitted.
- "重置内容" (Reset) is at the bottom left; "取消" (Cancel) and "提交需求" (Submit request) at the bottom
  right. Submission is allowed only when both required fields have content.
- On submit the two fields are organized into a structured Markdown description and a `feature`-type ticket
  is created through the feedback service.
