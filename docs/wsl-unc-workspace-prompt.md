# WSL UNC workspace open prompt

## Background

Windows users can open a WSL UNC path such as `\\wsl.localhost\Ubuntu\home\...` or
`\\wsl$\Ubuntu\home\...` directly from the system directory picker. Windows file APIs can access it,
but if it opens as a local workspace, Agent / Bash / terminal run in the Windows host environment
instead of WSL Linux. Consequences:

- Commands must repeatedly enter WSL indirectly through PowerShell / Git Bash / `wsl.exe`, which invites quoting and path-escape problems.
- `git`, `node`, `npm`, `live-server`, etc. resolve against the Windows PATH, not the Linux PATH inside WSL.
- PowerShell and Bash environment-variable syntax differ, so users misapply `$FOO` / `FOO=bar command` to the Windows shell.

## Design

When the local path the user selects matches a WSL UNC prefix, ZCode does not switch to a remote WSL
workspace automatically: switching changes the command execution environment, the config isolation
key and the remote session lifecycle, which needs user confirmation. Instead it prompts:

1. Recommend opening the workspace through "Remote connection -> WSL" so commands run in the WSL Linux environment.
2. On confirm, only open the remote connection dialog with WSL preselected; do not connect or convert the path automatically.
3. If the user cancels or closes the prompt, continue opening the original UNC path as a local workspace.

## Impact

- Only the desktop local-open-workspace entry is affected.
- Existing WSL remote workspace, SSH, Docker and Web remote-control paths are unchanged.
- The `\\wsl.localhost` path stays openable; the user can still continue opening by path.

## Verification points

- `\\wsl.localhost\Ubuntu\home\user\repo` and `\\wsl$\Ubuntu\home\user\repo` trigger the prompt.
- Ordinary Windows paths and ordinary UNC network-share paths do not.
- Choosing the recommended action opens the remote connection dialog with WSL preselected.
- Choosing to continue with the path still calls the original local-workspace open flow.
