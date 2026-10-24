# Slash Command Skill Suggestions

## Background

Users are used to typing `/` in the chat input to search for available capabilities. Skills were shown only in
the `$` trigger panel, so users entering the `/` menu could not see enabled skills and mistook them for
unavailable.

## Product Semantics

- The `/` panel remains the capability discovery entry, showing slash commands, skills and subagents.
- Selecting a skill from the `/` panel still inserts the existing `$skill` mention semantics; no `/skill`
  command protocol is added, and the agent side must not mistake a skill for a custom slash command.
- The Skill list reuses the `$` panel's enabled state, provider filtering, same-name folding and localized
  descriptions, so the two entries do not show inconsistently.
- With an empty query it shows groups in order commands, skills, subagents; with a query each group reuses the
  existing fuzzy search, and the global keyboard default selection still picks the best item by unified scoring.

## Boundary

- This change affects only the UI composer suggestion panel and mention serialization; it does not modify
  `@zcode/protocol`, session stream, task queue, snapshot or remote replayable/continuous semantics.
- Desktop and Web remote both read skills through the existing shared skill store; a remote workspace keeps
  being isolated by the existing `workspaceIdentity` binding.
- If the skill store is not loaded or errors, the `/` panel shows loading/error state only in the skills group
  and does not block commands and subagents.

## Acceptance

- Typing `/` shows the enabled skills group.
- Typing `/code` matches skills such as `code-review`.
- After selecting a skill the input generates the existing skill mention markdown, and the send path is
  equivalent to selecting that skill from the `$` panel.
- The `/` panel still shows `/goal`, `/compact`, `/init`, custom commands and subagents.
