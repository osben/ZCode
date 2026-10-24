# Mention Editor Selection and Markdown Contract

## Cause and Scope

`PromptMentionNode` used to insert an img/svg at the head of the TextNode DOM while `getTextContent`
returned the canonical Markdown. Lexical could not find the actual text along `firstChild`, and the
selection offset disagreed with the displayed text length, so select-all with an endpoint on a mention
made the internal selection diverge from the browser selection.

Applies to `LexicalChatInput`, shared by the main Composer and inline message editing, covering files,
skills, commands, subagents, sessions, whiteboards and plugins.

## Contract

```text
Lexical state
  +-- __text / DOM text -> display, caret, native selection
  +-- markdown         -> serialized independently -> onChange / send / draft / clipboard
  +-- icon             -> CSS decoration, adds no DOM text node
```

1. Keep the TextNode token atomic-editing semantics; the DOM text must equal `__text` exactly, and an
   async icon failure does not replace the text node.
2. `getTextContent` returns the display text; whole-document and selection Markdown serialization read
   `mention.markdown` explicitly.
3. Plain text is cut by the selection; a mention that actually intersects the selection outputs its full
   canonical form, and cut/delete uses the same atomic range. A collapsed selection or one that only
   touches a token boundary is not an intersection.
4. Whole-document output keeps the existing paragraph double newline, LineBreak single newline and
   whitespace semantics; selection output keeps the Lexical RangeSelection paragraph-separator rules.
   External `getText`/`getMarkdown` and `onChange` keep emitting canonical Markdown.
5. Copy and cut are registered at the common editor layer, independent of whether the candidate panel is
   enabled; when the clipboard write throws, the event is consumed and the selection kept, so the default
   CUT does not delete content.
6. JSON `type/version/markdown/mentionId/data` stay compatible; importing old `text` normalizes the
   display text and never rewrites the canonical.
7. No change to plain-text paste, the send protocol, draft owner/key, `workspaceIdentity` or remote
   session identifiers.
8. Desktop `desktop-continuous` and mobile `web-remote-replayable` keep their own chains; this change is
   confined to the editor layer before submit.

## Accepted Cases

| ID      | Setup/action                                                                            | Must assert                                                                             |
| ------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| MSEL-01 | Plain text; leading/middle/trailing/only/adjacent mention; real platform select-all key | DOM selection is non-collapsed and complete; replacing after select-all leaves no token |
| MSEL-02 | Delete after select-all, undo                                                           | Editor is cleared; undo restores canonical and labels                                   |
| MSEL-03 | Forward/backward partial selection, copy and cut                                        | Plain text is cut accurately, mention output is atomic, cut range equals output         |
| MSEL-04 | Old JSON, multi-paragraph, Unicode, icon failure                                        | Display length is right, canonical is not lost, icon update keeps the text node         |
| MSEL-05 | Typing after prefill and Option+ArrowRight                                              | Label is kept, body text appends normally                                               |

Extend the existing chat-input-mention-navigation E2E first. Unit tests verify serialization and
clipboard commands; a real browser verifies native selection and editing; `dispatchCommand` returning
true alone is not a pass.

Representative coverage is desktop macOS and Chromium. Windows/Linux Ctrl+A, mobile long-press
select-all, WebKit, light theme and inline message-edit E2E are not covered and must be recorded
separately; Chromium results are not cross-platform coverage. No provider, runtime-queue or network-fault
combinations are needed because the fix does not change submit or recovery boundaries.

## Verification Outcome (2026-09-04)

- Before the change, the desktop native Cmd+A E2E failed on leading/trailing/only/adjacent; plain text
  and middle passed.
- After the change, 7 focused files (53 tests) passed; Desktop macOS / Chromium 146
  chat-input-mention-navigation passed 10/10, screenshot
  `packages/desktop/.e2e-artifacts/mention-selection/native-select-all.png`; `pnpm typecheck`,
  `pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm lint` and the conversation coverage audit passed.
- Environment trap: typecheck emits to `out/host`, so it must not run in parallel with a Desktop bundle
  build (it overwrites the Host bundle and startup fails).

## E2E Lifecycle (local, no Docker)

The 8 native interaction regressions of MSEL-01/02/03 moved to the standalone
`conversation-session-mention-selection`; the top-level spec keeps the MSEL-05 adjacent-navigation case.

- Pending: `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-mention-selection.test.ts`.
- Canonical target: `packages/desktop/test/e2e/conversation-session/conversation-session-mention-selection.test.ts`.
- Provider contract: `providerRequestPolicy: none`, case-local fixture and requests are empty; after
  each case assert the provider request count did not increase.
- Order: pending explicit replay + screenshot review -> fixture check -> promotion dry run/apply ->
  formal explicit common+case replay -> default replay.
- Result: pending 8/8, formal 8/8, default replay 10/10 (8 migrated + 2 top-level navigation); fixture
  check, promotion and in-transaction coverage audit passed; E2E typecheck, root typecheck and lint
  passed. No Docker validation or admission was run; cross-platform gaps stay.
