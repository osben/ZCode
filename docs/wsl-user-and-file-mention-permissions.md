# WSL user and file mention permissions

## Background

A WSL remote workspace starts the remote host and agent through `wsl.exe`. WSL needs no SSH password
authentication, but every command still runs as some Linux user; by default ZCode uses the distro's
default user.

The `@` file-mention menu builds its candidate list recursively from the workspace root. Listing a
Linux directory needs read/execute permission; when a subdirectory was created by root or another
user and is unreadable by the current user, `readdir` returns `EACCES` / `EPERM`.

## Design

- A WSL connection supports an optional `user` field. Empty keeps the distro default user; `root` starts the WSL host / agent / terminal chain as root.
- Empty `user` is the backward-compatible default-user semantics: it must not produce a new workspace identity, and existing WSL connections must not take a fresh deployment path just because user selection was added.
- WSL `user` is part of the remote workspace identity so a default-user and a root connection to the same path do not share session, cache, queue or persistence keys.
- A non-empty WSL `user` must be a displayable plain string: control characters, colon, slash and backslash are rejected and the length is limited, so an invalid user name fails early rather than at connect time and does not pollute identity or log labels.
- The dev-mode remote assets `mock-cdn` is only an offline cache; if the current-version cache is missing it must fall back to CDN/cache, so reconnecting WSL to an old address is not misjudged as a connection failure because of a local missing package.
- The connection UI shows a warning for the root user that files created later may belong to root. The warning does not block connecting.
- The file-mention index skips a single unreadable or vanished directory and keeps listing the other accessible files; an unreadable directory must not fail the whole `@` menu.
- Remote workspace prompt attachments are first uploaded from the host side to the remote user's private directory `~/.zcode/tmp/prompt-attachments/<trace>/<random>/...`, and host paths in the prompt are rewritten to remote paths. The directory is chmod `700` before upload and files `600` after, so long pasted text, images or local-cache attachments are not left readable by other users in a public `/tmp`.
- The current version does not delete the remote prompt-attachment directory when a task ends: the files sit under the remote user's `~/.zcode/tmp` so retry/recovery within the same session can still read them. Any later automatic cleanup must bind to the task/session lifecycle, delete only this trace's random private directory, and log failures at warn only.

## Non-goals

- No automatic sudo or silent privilege escalation in the `@` menu.
- No password field for WSL user; `wsl.exe --user` requires the target Linux user to exist and consumes no password.
- No change to the realtime boundary between desktop `desktop-continuous` and mobile `/remote` `web-remote-replayable`.
- No automatic cleanup of attachment directories already written to `/tmp/zcode-prompt-attachments`; old directories need manual handling by the user or a later migration script.

## Verification points

- A WSL default-user connection still has no `--user`.
- A WSL custom-user connection carries `--user <user>`.
- A WSL root connection gets its own workspace identity.
- Invalid WSL user names (containing `/`, `:`, control characters, or too long) are rejected at the UI and schema layers.
- The `@` file index does not abort on `EACCES` / `EPERM` / `ENOENT` subdirectories.
- Remote prompt attachment upload creates the remote private directory tightened to `700`, tightens files to `600` afterwards, and the remote path contains an unpredictable random segment.
