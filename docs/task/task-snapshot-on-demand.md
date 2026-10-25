# Task Snapshot On-Demand Loading (Phase 1)

## Background

When mobile remote control first opened a historical task, `getTaskSnapshot` returned the entire `messages` array, so long histories made the first screen slow (transmission, JSON parsing and rendering).

## Behavior

- `IZCodeTaskService.getTaskSnapshot` takes an optional `messageLimit?: number`. The server trims the tail of `messages` when assembling the ZCode task snapshot:
  - not passed: full behavior as before;
  - `messageLimit <= 0`: empty messages array;
  - `messageLimit > 0`: the most recent `messageLimit` messages.
- Client enablement (Phase 1): only Web remote control passes `messageLimit = 100`. Desktop and non-remote-control scenarios pass nothing; behavior is unchanged.
- Compatibility: the parameter is optional, so existing callers work unmodified.

## Follow-ups

- Add a pagination interface for historical messages (cursor/beforeId).
- Add a "load older messages" entry to the UI chat list.
- Gradually migrate desktop to on-demand loading (grayscale rollout).
