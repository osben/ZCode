# definition-preview-protocol

Pure wire contracts for previewing a definition (skill, command, subagent, plugin) from a mention.
A `DefinitionPreviewRef` names what to look up: kind, name, optional plugin id, an optional path
hint carried by the mention, and the workspace identity. It never names a root and grants no file
access. The executing Host resolves the ref against its own discovery results, derives the root,
and confines every read to it. Schemas are strict, so a client-chosen root is rejected at the wire.

Limits shared by Host and UI: text reads stop at 256 KiB (Code Viewer's limit) and a tree returns
at most 2,000 entries with `truncated: true` beyond that. See `specs/definition-preview-pane.md`.
