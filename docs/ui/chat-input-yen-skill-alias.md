# Chat Input Yen Skill Alias

## Background

The chat input uses `$` to trigger the skill mention. In Chinese and Japanese input environments users may find `¥` or full-width `￥` easier to type, which then fails to open the skill panel.

## Goals

- Typing `¥` or `￥` in the chat input acts as an alias trigger of `$` and opens the skill mention panel.
- The alias affects only trigger recognition; the character the user typed is not rewritten to `$` before entering the editor.
- After selecting a candidate, the existing `$` skill mention token insertion and send parsing are reused.
- Behavior is the same in the desktop, local Web and mobile remote-control inputs.

## Boundaries

- The trigger extraction layer recognizes `¥` / `￥` and normalizes them to the existing `$` skill trigger branch.
- No separate `¥` trigger type, no separate panel, and no change to the `$` candidate source.
- No change to the protocol or agent parsing layer; after selection the mention markdown still uses the existing `$skill` semantics.

## Compatibility

- The logic lives in the prompt trigger parsing layer of `packages/ui`; desktop, local Web and mobile remote control reuse the same input component and panel logic.
- It does not touch `@zcode/protocol` and does not affect sessions, continuous/replayable live message streams, remote-control snapshots or the task command queue.
- The original `$` input, matching, filtering and mention insertion are unchanged.

## Acceptance

- After typing `¥`, the skill mention panel opens as an empty-query `$` skill trigger.
- After typing `￥code`, skill candidates are filtered as `$code`.
- After selecting a candidate, `¥code` / `￥code` is replaced by the existing skill mention token, and the markdown is still equivalent to `$skill`.
- The editor content is not rewritten to `$` the moment the user types `¥`.
- The existing behavior of normalizing `、` at the very start of the text to `/` is unchanged.
