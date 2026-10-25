# Issue Report Auto Screenshot Design

The help menu's "问题上报" (issue report) opens the generic feedback dialog but did not carry the task scene the user was looking at, unlike task right-click feedback, header-more task feedback, and remote-connection-failure feedback, which already capture the current Electron window via `IPlatformService.captureWindowScreenshot()` and pass it as `FeedbackSubmitDraft.screenshots`. Now the help-menu entry captures the current window before opening the dialog.

Rules:

- Clicking "问题上报" captures the current window first, then opens the "提交反馈" dialog, so the screenshot contains the task scene without the feedback dialog itself.
- The screenshot lands in the existing "截图" area; count display and deletion reuse `FeedbackScreenshotPicker`.
- Desktop uses the existing Electron capture; Web, mobile Web, or capture failure opens the dialog normally with no screenshot (silent degradation — a failed screenshot is not a feedback-flow error).
- Other help menu items ("给产品提需求", "用户社群", "产品文档", "导出日志") are unchanged.

Design:

- `WorkspaceHelpMenuButton`'s `handleOpenIssueReport` becomes async: capture via helper, then `openFeedbackSubmit({ type: "bug", module: "其它", severity: "P2-中", includeLogs: true, screenshots })`.
- Helper `captureFeedbackScreenshotDraft(platform)` (e.g. `packages/ui/src/feedback/feedbackScreenshotDraft.ts`) builds UI drafts only — no logs, toasts, or retries. It calls `platform.captureWindowScreenshot?.().catch(() => null)` and returns one `FeedbackAttachmentDraft[]` entry on success, `[]` on no-capability/null/throw. Draft init from `initialDraft.screenshots` already exists in `FeedbackSubmitForm.tsx`.

Platform plumbing (existing): `captureWindowScreenshot?(): Promise<WindowScreenshotResult | null>` in `packages/shared/src/platform.ts` (Web may return `null`); `desktopMainIpcPlatform.ts` captures via `BrowserWindow.fromWebContents(event.sender).webContents.capturePage()`; preload and renderer main expose it to the UI platform service.

Non-goals: no screenshot editing/cropping/annotation; feedback upload protocol, ticket fields, and log upload unchanged; remote relay, main process business state, session/task stream, snapshot, queue, and replayable semantics untouched; no screenshot capability sinks into services or remote-control state.

Tests: helper unit tests (success → one draft; `null` → `[]`; throw → `[]`) and `WorkspaceHelpMenuButton` component tests (capture awaited before `openSubmit` with the screenshot in the draft; failure still opens with `screenshots: []`).

Risks: a slow capture delays the dialog (local window capture is expected to be fast; the alternative — open first with a loading state — would widen the feedback form's surface); a failed Electron capture still allows text + logs. Upload format, size limits, and the 6-image cap are unchanged.
