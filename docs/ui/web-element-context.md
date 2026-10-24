# Web Element Context

ZCode's built-in browser supports adding a web element to the chat context on desktop.

## Flow

1. The element-pick button in the Browser toolbar enters picking mode.
2. `EmbeddedBrowserPane` temporarily injects a picker through Electron `webview.executeJavaScript`.
3. On hover the page shows a highlight and a basic-info popover; click captures the current element and exits;
   Esc cancels the picking state.
4. The Renderer dispatches the `zcode:web-element-context-add-to-chat` event.
5. The chat composer shows a web-element chip, and on send the context is assembled into a Markdown text block.

## V4 Composer Wiring

V4 adds no protocol field: web element context is still prompt text context, and the chip is only the visual
shell of composer and transcript.

```
EmbeddedBrowserPane
  -> zcode:web-element-context-add-to-chat
  -> ConversationComposer/useWebElementContexts
       workspaceKey = workspaceIdentity?.trim() || workspacePath
       transient in-memory contexts[]
  -> WebElementContextAttachmentChip
  -> submit:
       visible text + buildPromptWithWebElementContexts(...)
       contextAttachmentCount > 0
  -> SessionPane:
       parseV4VisibleSlashCommand(..., { contextAttachmentCount })
       contextAttachmentCount > 0 => do not consume /goal or /compact locally
  -> createSession/sendText
  -> ConversationRowView:
       parsePromptWebElementContexts(row.text)
       visible content + read-only WebElementContextAttachmentChip
```

## V4 State Boundaries

- The Composer chip lives only in the current React composer's memory; switching session, switching workspace
  or refreshing the page clears it.
- Draft persistence saves only text/editorState, not web element context.
- A successful send clears the context; a failed send keeps the chip and input for retry.
- `contextAttachmentCount` is used only for app-side slash-command protection and does not enter the v4
  protocol payload.
- Transcript copy/edit/retry use the raw `row.text`, so the Markdown context block is not lost.

## Boundaries

- Capture logic runs only inside the desktop `webview`, not through the host process or a service.
- Web / mobile do not read cross-site DOM directly; the first version does not support this capability.
- Context belongs to the current workspace by `workspaceIdentity?.trim() || workspacePath`; a V4 remote
  workspace must keep passing `workspaceIdentity`, and filtering contexts only by `workspacePath` is forbidden.
- Cookies, localStorage and sessionStorage are not read, nor the current value of inputs; a password input is
  masked.
- What is sent to the ZCode Agent is plain-text Markdown, compatible with the current provider.

## Captured Fields

- page URL and title
- tag name, role, accessible name
- selector and XPath
- visible text and nearby text
- safe attribute whitelist
- visible bounding rect
- computed style summary: color, background color, font family, font size, font weight, display
- sanitized HTML excerpt

All large text fields are truncated before entering the prompt.
