# Markdown Preview Selection References

## Product behavior

The preview body of Markdown Preview (a `.md` / `.markdown` file or directly passed Markdown text) supports mouse, keyboard and touch selection. A non-empty valid selection shows "添加到当前任务" (add to current task); clicking adds the selected text to the current main task's pending references, keeps the draft and does not auto-send. "在辅助对话中提问" (ask in side conversation) is also offered. Source view keeps the existing code interactions.

- If the main task has no session yet, the reference goes into that workspace's draft scope.
- References reuse the conversation reference chip, removal, atomic limits and send serialization: at most 8,000 characters per reference, 8 references, 16,000 characters total; a duplicate source and text is not added twice.
- The Markdown source explicitly records the file path or text-preview identity and fakes no message row/session. Sending reuses the userselect block: a file selection carries path/text; text without a path and conversation selections carry only text.
- Both selection endpoints must be inside the same preview body; blank selections, button/input controls and cross-preview selections are rejected. Selections across paragraphs and tables are valid.
- The popover closes on scroll, Escape, collapsed selection, file switch, body update, task/workspace switch or preview hidden. It must not overflow narrow screens and uses theme tokens and zh/en copy.

## Data flow and boundaries

```text
AnimatedSidePanePanel (activeTaskId + workspaceKey)
  -> PreviewPane -> MarkdownPreviewContent
                     -> Selection action
                        -> reference scope[workspaceKey, taskId | draft]
                           -> Composer draft + reference chips
                              -> user sends -> existing userselect serialization
```

`workspaceKey` is strictly `workspaceIdentity?.trim() || workspacePath`; no entry is offered when the preview source and target workspace do not match. "添加到当前任务" targets the current main task, not a guess from the most recently focused side input. All changes live in the UI pending-reference layer; desktop `desktop-continuous` and mobile `web-remote-replayable` keep their own transport and recovery boundaries, with no new runtime/host state or queue.

## Acceptance scenarios (accepted)

- MPS01: selecting body text in a file/text preview and adding keeps the draft, shows the right chip, is removable and does not auto-send.
- MPS02: sources are distinguished, same-source same-text is deduped, limits reject atomically, file sends path/text, path-less text sends text only.
- MPS03: cross-region/control/blank selections are rejected; scroll, Escape and source or target change clear the popover.
- MPS04: mobile touch selectionchange, narrow-screen layout, light/dark themes and i18n.
- MPS05: same path with different remote identity is isolated; draft/task are isolated.
- MPS06: a Markdown selection routes via workspaceKey + current main task sessionId to the registered main SessionPane, passing the Markdown reference. It follows the message selection's rules: reuse an active child, create one if none, replace an invalid child, dedupe pending creation. Main/side drafts are preserved and nothing is auto-sent. With the Markdown tab active there is usually no active child; the most recently used side tab is not guessed.
- MPS07: with no main session yet, in a read-only/mobile viewport, or with the main controller not ready, the side action is disabled with a localized explanation. When the main task or the target side conversation has a blocking interaction, the reference action is disabled. The original "添加到当前任务" stays available. The existing reference-less launcher still forces a new child and is unaffected by the blocking state. A Workspace Hook soft review does not count as a blocking interaction. Verification must exercise the callback actually registered by the real SessionPane, not only the Runtime helper.
- MPS08: Markdown and the conversation stream share one selection menu: horizontal layout, content-fit width, vertical divider, unified font, spacing, theme, radius and hover/disabled styles. Viewport bounds are constrained by the actual menu size; on narrow screens it stays horizontal and button text may wrap. Only menu display and positioning are shared; reference source, routing and side-action disable conditions are unchanged.
- MPS09: a file Markdown reference explicitly carries an optional real `path` (not workspaceIdentity or sourceKey). One reference shows "file name · 引用"; several including files show the generic reference count; details list each path and selection. A path-less text preview stays text-only. Sending reuses the userselect text block: file items are `{path,text}`, conversation items `{text}`. The history parser keeps a valid non-empty string `path`, stays compatible with old text-only and legacy formats, and invalid structures do not swallow the body. zh/en, narrow-screen truncation and Windows path separators must all work. The E2E extracts the userselect JSON from the real provider request's user text and asserts the single reference equals `{path: filePath, text: marker}`, rejecting missing/wrong path, changed selection and extra internal fields.

```text
Markdown reference -> scoped registered main opener
  -> reference present: existing selection creation/reuse route
  -> no reference (existing launcher): force new child
  -> child composer references; never auto-send

preview source.path -> reference.path -> userselect JSON -> history parser -> shared chip
```

The side entry only extends the optional reference parameter of the existing renderer controller entry; no protocol, Host/CLI state is added and the mobile side-conversation boundary is not widened. English button copy, shared with the conversation stream, is `Add to chat` and `Add in side chat` (same i18n keys; Chinese copy and behavior unchanged).

## Verification status

- Formal desktop E2E: `packages/desktop/test/e2e/conversation-session/conversation-session-markdown-preview-selection.test.ts` (promoted at user request; not added to the Docker verification set, no Docker admission run).
- Covered by unit tests and macOS Desktop E2E: add/dedupe/remove, draft preservation, source/serialization/limits, touch selectionchange, narrow-screen positioning, draft and remote-identity isolation, side-conversation reference routing and blocking, menu layout, file path round trip.
- Open (not verified): real mobile device native long-press, real remote attachment chain, Windows/Linux, and visual check of the light theme. Mobile events/narrow layout and identity isolation have unit tests; both themes use existing semantic tokens.
