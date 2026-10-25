# quick-prompts

Fork-owned store of composer quick prompts (spec: specs/composer-quick-prompts.md). Lives in the controller
Host's tasks-index.sqlite (`fork_quick_prompts`, `fork_quick_prompt_hidden`, migration
`9003_fork_quick_prompts`).

Invariants:

- The database is the only truth. Every desktop window runs its own Host and its own service instance on the same
  file, so writes run in `BEGIN IMMEDIATE` transactions and nothing in memory is authoritative.
- Every committed write broadcasts `state:quick-prompts` with an empty payload; failed writes do not broadcast.
  Readers re-read and drop out-of-order responses.
- Project identity is the (hostId, projectId) pair in two columns; it is never derived from a path.
- A global quick prompt never contains project-bound mentions (`findQuickPromptGlobalBlockers`); the service
  re-checks this on every write instead of trusting the UI.
- Mobile web-remote gets a read-only scope of this service.
- Shape validation (zod) runs before the transaction; every rule that depends on stored rows (limits, positions,
  blockers on the stored body, reorder membership, hidden marks) runs inside the same `BEGIN IMMEDIATE` write.
- The fork migration `9003_fork_quick_prompts` is ensured on the shared tasks-index handle; it is never listed in
  the upstream checksum pin.

Errors reach callers as `Error.message` with these stable codes:

| Code                                                        | Meaning                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `quick-prompt.name-required` / `quick-prompt.name-too-long` | Name empty after trim / over 40 characters                                      |
| `quick-prompt.body-too-long`                                | Body markdown over 8000 characters                                              |
| `quick-prompt.body-required`                                | Body markdown empty or whitespace-only (every create and body update)           |
| `quick-prompt.body-nodes-invalid`                           | Body nodes are not a JSON array                                                 |
| `quick-prompt.scope-mismatch`                               | Global without project, project without project, or project set on a global     |
| `quick-prompt.global-mention-blocked`                       | Global body with file, workspace skill, session, subagent or whiteboard mention |
| `quick-prompt.limit-reached`                                | 50 globals or 50 in one project already exist                                   |
| `quick-prompt.not-found`                                    | Unknown prompt id                                                               |
| `quick-prompt.not-global`                                   | `setHidden` on a project prompt                                                 |
| `quick-prompt.reorder-mismatch`                             | `orderedIds` is not exactly the current members of the list                     |
| `quick-prompt.read-only`                                    | Mutation sent through a mobile attachment                                       |

`delete` of an already removed prompt is a no-op without a broadcast. `duplicate` keeps the name and sets
`pinned: true`. Moving a global to a project removes its hidden marks.

**Color label** (spec rules 22-24): `QuickPrompt.color` is a palette hue or `null`. The column is added by the
separate migration `9004_fork_quick_prompt_color`; the `9003` DDL and checksum never change. The repository keeps the
raw column value and normalizes only in `toPrompt` (unknown, empty or non-string values read as `null`). `update`
writes `color` only when the input carries it (`undefined` unchanged, `null` clears), `duplicate` copies the raw
value, and the service schema degrades an unknown hue in a write to `null` instead of rejecting the write.
