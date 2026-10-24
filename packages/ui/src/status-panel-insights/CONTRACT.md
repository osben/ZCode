# status-panel-insights

The status panel's Context and Last turn sections (spec: `specs/status-panel-context-and-last-turn.md`).

Invariants:

- The v4 projection owns every fact shown here: `usage` for Context, `turnHeader.fileChanges` and
  `v4/conversation/fileChanges` for Last turn. This module only derives models from them; it adds no store slice,
  persistence or protocol.
- The sections never mount the status panel on their own: the panel renders them only when its existing
  sections already have content.
- Context mirrors the composer's usage mapping and tone rule (`V4ComposerToolbar.tsx`, upstream-owned); a unit test
  pins both to the same tone.
- Last turn derives its request options exactly as the chat's turn file summary does, so SessionPane's request cache
  serves both. A detail result is keyed by scope and turn facts, and a response for an older key is dropped.
- `useLastTurnSectionModel` keeps its identity until a turn fact changes, so streamed rows do not re-render the
  memoised panel.

Intersection with other modules: `ConversationStatusPanel.tsx` wraps the bodies in its private `StatusSection`
shell (this module never imports the panel, so there is no cycle); `SessionPane.tsx` passes `snapshot.usage`, the
model from `useLastTurnSectionModel` and its gated `fileChanges` reader. The last-turn selection and patch format come
from `review-last-turn`'s public index.
