# Built-In Subagent Colors

Built-in subagents must provide an explicit color in the profile data and not depend on the UI's name-hash
fallback.

- `general-purpose` uses `blue`; `Explore` uses `cyan`.
- The UI keeps the name-hash fallback only for old events, external agents or custom subagents with no
  configured color.
- A built-in color is only an identity marker and expresses no success, failure, danger or other status
  semantics.

This avoids the built-in `general-purpose` showing `red` through its name hash, which would make users think it
is an error or danger state.
