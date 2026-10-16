# Issue Tracker: Local Markdown

Project Issues use local Markdown files. The user has explicitly requested that Issues not be created in remote repositories; only when explicitly requested later will the target of that operation change to online publishing. Git remote only indicates the code repository location and cannot be used to infer Issue publishing location.

## Files and Status

- Complete specs already present in `docs/` can be used directly as local Issues, preserving the original path without copying a second copy of the body.
- New independent Issues go in `docs/issues/<feature-slug>/<NN>-<slug>.md`, one file per task; features are numbered sequentially from `01`. Implementation subtasks of existing specs link to that spec.
- Use a `Status:` line below the file title to record status. Specs that can be directly implemented use `Status: ready-for-agent`; other triage statuses follow `needs-triage`, `needs-info`, `ready-for-human`, `wontfix`; update to `in-progress` and `done` when tasks start and complete, respectively.
- Use local Markdown links for associations and dependencies; discussion records are appended to the end of the file under `## Comments` as needed, without copying the full current session into the file.

## Skill Operation Mapping

- "publish to the issue tracker": Write or update local Issue files, apply the corresponding `Status:`, return the file link.
- "fetch the relevant ticket": Read the Markdown file the user specifies or the one corresponding to the local Issue number.
- "apply ready-for-agent label": Write `Status: ready-for-agent`; do not create remote labels.
- Issue workflows do not call GitHub/GitLab creation or update APIs. MR workflows continue to follow the project's existing MR rules; the two are independent of each other.

## Current Issues

- [Desktop Local Message TTFT Phased Telemetry](../monitoring/ttft-stage-telemetry.md)
