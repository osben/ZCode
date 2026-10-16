# Task Snapshot On-Demand Loading (Phase 1)

## Background

When mobile remote control first opens a historical task, `getTaskSnapshot` previously returned the entire `messages` array, causing significant first-screen wait times with long histories (transmission, JSON parsing, and rendering are all affected).

## This Change

- `IZCodeTaskService.getTaskSnapshot` supports an optional parameter: `messageLimit?: number`
- The server trims the tail of `messages` when assembling the ZCode task snapshot:
  - When `messageLimit` is not passed: maintain existing full behavior
  - When `messageLimit <= 0`: return an empty messages array
  - When `messageLimit > 0`: return the most recent `messageLimit` messages

## Client Enablement Strategy (Phase 1)

- Enabled only for Web remote control: `messageLimit = 100`
- Desktop and non-remote-control scenarios do not pass this parameter by default; behavior unchanged

## Compatibility

- The new parameter is optional and does not affect existing callers
- Old callers work without modification

## Future Recommendations

- Add a pagination interface for historical messages (cursor/beforeId)
- Add "load older messages" entry to the UI chat list
- Gradually migrate desktop to on-demand loading (grayscale rollout)
