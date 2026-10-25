# Issue Tracker: Local Markdown

Project Issues are local Markdown files. The user explicitly requested that Issues not be created in remote repositories; the target changes to online publishing only if explicitly requested later. The Git remote only indicates the code repository location and must not be used to infer where Issues are published.

## Files and Status

- Complete specs already in `docs/` can be used directly as local Issues, keeping the original path without copying the body.
- New independent Issues go in `docs/issues/<feature-slug>/<NN>-<slug>.md`, one file per task; features are numbered sequentially from `01`. Implementation subtasks of existing specs link to that spec.
- Record status in a `Status:` line below the file title. Directly implementable specs use `Status: ready-for-agent`; other triage statuses are `needs-triage`, `needs-info`, `ready-for-human`, `wontfix`. Update to `in-progress` when a task starts and `done` when it completes.
- Use local Markdown links for associations and dependencies. Append discussion records under `## Comments` at the end of the file as needed; do not copy the full session into the file.

## Skill Operation Mapping

- "publish to the issue tracker": write or update local Issue files, apply the `Status:`, return the file link.
- "fetch the relevant ticket": read the Markdown file the user specifies or the one matching the local Issue number.
- "apply ready-for-agent label": write `Status: ready-for-agent`; do not create remote labels.
- Issue workflows do not call GitHub/GitLab creation or update APIs. MR workflows keep following the project's existing MR rules; the two are independent.

## Current Issues

- [Desktop Local Message TTFT Phased Telemetry](../monitoring/ttft-stage-telemetry.md)
