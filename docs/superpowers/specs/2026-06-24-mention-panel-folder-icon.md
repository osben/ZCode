# Mention Panel Folder Entries

`@` file candidates can return folders. When the candidate data has `kind: "directory"`, both the candidate preview and the inserted mention token show a folder icon.

Rules:

- Regular files keep the existing file icon resolution.
- File search, filtering, insertion, and serialization format are unchanged; this is presentation only — no protocol or file-scan changes.
- Folder semantics come from the structured `kind` field, never from path-suffix guessing.
- Desktop and Web mention interaction is unaffected.
