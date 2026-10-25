# quick-prompts-ui

UI half of composer quick prompts (spec: `specs/composer-quick-prompts.md`). Host storage and the service live in
`packages/services/src/quick-prompts`.

Invariants:

- The composer makes one `useQuickPrompts` read. The row and the "/" section both derive from that snapshot.
- Insertion goes through the editor handle (`insertSerializedBody`) and stores Lexical body nodes, so mention chips
  survive. Markdown is never re-parsed into mentions.
- ⌘/Ctrl-click sends only through the composer's own submit callback, and only when the composer has no content
  (`draftHasContent` includes attachments and contexts). Otherwise it only inserts.
- Scope and limit rules (`model.ts`) are the only place these decisions are made. A global body never contains a
  project-bound mention; the service re-checks this on write.
- Project identity is the (hostId, projectId) pair from the session's task or the draft. It is never derived from a
  path.
- Mobile shells never create, edit, hide or delete; they only insert and send.
- Color labels (spec rules 22-24) render only as the decorative `QuickPromptColorDot`; token names come from the
  static map in `model.ts`, never from data. The editor sends `color` only when the picker changed it, so a stored
  value this build cannot read is not overwritten by an unrelated edit.
