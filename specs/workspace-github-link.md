# Open a workspace on GitHub

## Scope

Workspace actions can open the GitHub repository for a workspace when a configured Git remote points to GitHub. The menu entry is hidden when no GitHub remote can be resolved.

## Ownership and flow

- `GitCliRepo` owns Git CLI access and lists configured remotes for a workspace. It prefers each remote's fetch URL and sorts `origin` first.
- `IGitService` exposes the read-only remote list through the existing Git service boundary.
- The sidebar row resolves a supported remote URL to an HTTPS web URL when its workspace action menu opens. It selects the first GitHub URL from the remote list.
- The renderer calls `IPlatformService.openExternal` only after the user selects “Open on GitHub”.
- A remote lookup failure leaves the other workspace actions usable and hides the GitHub entry.

## URL rules

Supported Git remote forms are SCP-like SSH, `ssh://`, `https://`, `http://`, and `git://`. User information and SSH ports are omitted from the web URL; the repository path is retained, trailing slashes and `.git` are removed, and the web scheme is HTTPS. Only resolved `github.com` URLs produce a menu entry.

## Acceptance scenarios

1. Given a workspace with a GitHub origin, opening its action menu lists “Open on GitHub”; selecting it opens the repository HTTPS URL externally.
2. Given a workspace with several remotes, `origin` is considered before other remotes; a non-GitHub origin does not prevent a later GitHub remote from being selected.
3. Given a workspace with no GitHub remote, the menu does not show the GitHub action.
4. Given a failed remote lookup, the rest of the workspace menu remains usable and the GitHub action is hidden.
5. The URL helper converts supported remote syntaxes and rejects empty or non-repository values.
