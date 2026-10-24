# Chat Composer Placeholder

The chat composer placeholder depends on task state and terminal width:

- Idle, no history (desktop): `Ask ZCode anything, @ for files, folders, or whiteboards, / for commands or agents, $ for skills, # for related conversations`
- Idle, no history (mobile Web remote): `Ask ZCode anything…`
- Idle, with history: `Ask for follow-up changes`
- Processing a task: `Keep typing to queue follow-up changes`

Design constraints:

- The new-task placeholder shows only while the message list is empty.
- A historical task with messages that is not processing shows the follow-up copy.
- `submitting`, `creating`, `restoring` and `streaming` all count as processing, so the placeholder does not flash back at task start.
- The processing state does not lock input; it only changes the placeholder, telling the user they can keep typing and the input will be queued.
- The mobile Web remote new-task copy stays short; the full `@` / `/` / `$` / `#` capability hints are carried by the action entry below the input.
- The mobile Web remote placeholder shows at most two lines, as a layout guard for i18n copy growth; it must not cover the toolbar below.
- Desktop keeps showing the full capability hint, unaffected by the mobile shortening rule.
- Copy is configured through i18n, currently `en-US` / `zh-CN`.
