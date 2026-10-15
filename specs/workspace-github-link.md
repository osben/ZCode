# Workspace GitHub link

## Product rules

- A workspace action opens the repository web page only when the current workspace has a supported GitHub remote.
- HTTPS, HTTP, Git, SSH URL, and SCP-style remotes may identify the repository. SCP-style remotes may omit the username when SSH configuration supplies it; scheme URLs are parsed as URLs, and Windows drive paths are not remotes. GitHub's SSH-over-443 host `ssh.github.com` maps to the canonical web host `github.com`; the SSH port is not part of the web URL.
- When reading `git remote -v`, prefer a remote's fetch URL over its push URL even when Git appends a partial-clone filter annotation such as `[blob:none]` to the fetch line.
- Each time the workspace action menu opens, refresh the remote lookup and hide any previously resolved URL while it is pending.
- Only the newest lookup may update the action. A stale success or failure must not replace or clear the result of a newer lookup.
- A failed lookup or a workspace with no supported GitHub remote has no GitHub action.

## Acceptance scenarios

| Scenario                                                    | Expected result                                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A GitHub SSH-over-443 remote is configured                  | The action opens `https://github.com/<owner>/<repository>`.                                        |
| A username-free SCP-style GitHub remote is configured       | The action opens `https://github.com/<owner>/<repository>`; Windows drive paths are rejected.      |
| A partial-clone fetch URL differs from the push URL         | The unannotated fetch URL is selected, not the push URL.                                           |
| The menu is reopened after the remote changes or is removed | The old repository action is hidden while refreshing and does not return from a superseded lookup. |
| A remote lookup fails                                       | The action stays hidden.                                                                           |
