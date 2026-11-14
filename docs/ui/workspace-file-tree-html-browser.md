# File Tree: Open HTML in the Built-in Browser

## Goal

文件树右键菜单对本地 `.html` / `.htm` 文件提供“用内置浏览器打开”动作。动作使用文件的绝对路径生成 `file://` URL，并交给现有右侧 Browser side pane；浏览器在 main 将其转换为[受控 HTML 预览地址](../browser-use/local-html-preview.md)后加载。

## Boundary

- Shown only in the local desktop file tree; not shown for remote workspaces, so a remote path is not
  mistaken for a local `file://` file.
- Shown only when the entry type is `file` and the extension is `.html` / `.htm`; not for directories or Git
  deleted virtual files.
- URL generation reuses the UI-layer path utility `toFileUrl()`, so macOS/Linux `file:///...` and Windows
  `file:///C:/...` are both accepted by the built-in browser.
- Opening still goes through `handleOpenBrowserUrl()`; the existing Browser side pane creates the tab,
  validates the URL and navigates, and the file tree never operates the webview directly.

## Verification

- 浏览器安全与资源加载由 `packages/desktop/test/e2e/browser/files/browser-local-html-preview.test.ts` 验证；文件树入口保持现有 HTML 类型判断。
- 该变更不修改 ZCode session/task realtime、snapshot、queue、replayable/continuous 语义。
