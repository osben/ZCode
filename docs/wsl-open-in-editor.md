# Open remote workspace files with local apps

## Background

For a WSL remote workspace, `workspacePath` is the Linux path inside WSL, e.g. `/home/user/repo`. It
must keep going to the remote host / agent / terminal and must not be rewritten to a UNC path early
for the Windows desktop app, which would pollute remote execution semantics and workspace identity.

The desktop title bar's "Open in Editor" entry runs in the Windows main process. Passing
`/home/user/repo` straight to Windows-side VS Code or Explorer makes the host treat it as a local
path, so opening fails or lands in the wrong place.

## Design

- Opening a WSL remote workspace in VS Code / VS Code Insiders: main builds a VS Code Remote-WSL URI; directories use `--folder-uri`, files use `--file-uri`.
- Opening it in Windows Explorer: main converts the Linux path to a UNC candidate only at the platform boundary, preferring `\\wsl.localhost\<distro>\...` and falling back to `\\wsl$\<distro>\...`; files are located with `/select,`, directories are opened directly.
- Passing a WSL Linux path directly to other local editors is unsupported. The UI shows only VS Code / VS Code Insiders / Explorer, so Cursor, JetBrains, Terminal, etc. never receive a Linux path.
- If the WSL target lacks a distro, main resolves the default distro with `wsl.exe -l -v --all`; only when that fails does it return an explicit error. It never falls back to passing the bare Linux path.
- SSH remote files show only VS Code / VS Code Insiders (Remote-SSH URI support). Targets without a local path mapping, such as Docker, show no local editors.
- Conversation Markdown links, Assistant Preview Cards, change summaries and Diff previews must carry `workspacePath`, `workspaceIdentity` and `workspaceRemoteSessionId`. Remote target matching uses identity/session to disambiguate same-path remotes; path display and execution still use `workspacePath`.
- A Markdown link may use only an explicit trailing `/` as a directory display hint and must not guess the filesystem type from the extension. The "open with" action must first `stat` through the current workspace-scope file service and pass the real `file/directory` as `pathKind` to main; if the type cannot be confirmed, no local editor is invoked. Directories use `--folder-uri` or open Explorer directly; files use `--file-uri` or Explorer `/select,`.
- File-manager actions in the workspace file tree, review-area changed files and project/task menus must reuse the same remote-target resolution. Windows Explorer may be invoked only when a WSL target matches exactly; the review area and project menu keep "open directory" semantics and pass `pathKind: "directory"`. SSH and Docker expose no local file-manager entry.
- An editor fallback produced by remote-capability filtering applies only to the current UI and must not overwrite the user's global editor preference; persist only when the user explicitly picks an editor.

## Impact

- Platform path conversion happens only on desktop: WSL uses Remote-WSL URI/UNC, SSH uses Remote-SSH URI; Web and mobile still do not launch local apps.
- UI capability filtering and workspace scope apply to WSL, SSH, Docker and plain local workspaces. Docker fails closed because it has no reliable host path mapping.
- Plain local workspaces keep opening by local path and do not require `workspaceIdentity`.
- Native Windows, macOS and Linux file-manager actions keep the existing platform implementation; the WSL branch applies only when the remote identity resolves exactly to WSL.
- Remote host, agent, terminal, Web remote control, task realtime and workspace identity semantics are unchanged.
