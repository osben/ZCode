# definition-preview-service

The executing Host for a workspace answers `resolve` and `readFile` for a `DefinitionPreviewRef`.
It never accepts a root from the client. Each call re-reads the skill, subagent and command
catalogs through `DefinitionCatalogPort`, selects one candidate (path hint, then enabled, then
workspace > user > plugin, then path), and derives the root from that candidate: the skill
directory, or the single agent/command file. Built-in agents and, until slice 4, plugins resolve
to `not_found`. The service holds no state, so calls are idempotent and a stale ref cannot reach
a root the Host did not just discover.

Confinement follows `readGenUiDocument`: the relative path is validated as a string (no empty,
`.`/`..`, NUL, absolute, drive-letter, UNC or colon segments), the root is realpath'd once, every
segment below it is `lstat`ed and any symlink is rejected, the file is opened `O_NOFOLLOW` and its
`dev`/`ino` (BigInt) must match the walk's `lstat`. Node has no `openat()`, so the check repeats
after open: the file's current realpath must be inside the root and the identity there must equal
the opened handle's, which defeats a directory swapped for a symlink mid-read. Symlinks are listed in the tree as `link` entries and
never followed. Text is capped at 256 KiB; binary content (fatal UTF-8 decode) and oversized files
return a notice instead of content. Rejections are logged at `warn` without paths.

The composition root (`createLocalServices`) wires the catalog port from the existing skills,
subagents and commands services; this module imports no concrete service. Remote workspaces reach
the same service on their own Host. See `specs/definition-preview-pane.md`.
