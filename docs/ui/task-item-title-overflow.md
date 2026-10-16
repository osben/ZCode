# Task Item Title Overflow

When a task title in a workspace task item or timeline task item exceeds the available width, do not show an `...` ellipsis.

Implementation rules:

- Keep the title on one line so long titles do not make the sidebar task list taller.
- Enable a right-side fade mask only when the browser's actual layout measurement satisfies `scrollWidth > clientWidth`; do not mount a mask for a fully visible short title.
- Remeasure when the title or container size changes: add the mask when the title starts overflowing, and remove it when the title becomes fully visible again.
- Use the same right-side fade as the grouped task row for the overflowing portion, preserving text continuity.
- After the pointer hovers over the entire task item for 1 second, switch an overflowing title to a one-way seamless marquee. The track contains “full title + fixed gap + title copy.” Scrolling should continue when the pointer is over the row's time, status, or action area. Leaving the entire row while waiting or scrolling cancels the wait and immediately restores the static state.
- After the marquee moves by “full title width + gap,” the copied title returns exactly to the original title's starting point. Hold that frame for 2 seconds, then reset directly to the starting frame and continue the next cycle. Since both pieces of text are identical, the transition should not reverse or jump visually.
- Calculate marquee speed from the full title width so titles of different lengths do not have drastically different speeds due to a fixed duration. When the pointer leaves, immediately restore the title to its starting position and show the right-side fade.
- In the static state, fade only the right side. Within 150ms after the marquee starts moving, restore the left-side fade so text entering and leaving both edges does not end abruptly.
- As the first title's tail reaches the left edge, immediately remove the left fade; do not fade across the 24px gap between the title and its copy. Keep only the right-side fade while the copy enters, aligns, and remains for 2 seconds, so the title's beginning stays fully visible. Restore the left fade as the next cycle begins moving.
- Set `aria-hidden` on the copied title so assistive technology does not read the task name twice.
- Disable the marquee under `prefers-reduced-motion: reduce`; retain only the static fade.
- Do not render a native `title` attribute for task names. Use the marquee on hover to show the full content and avoid browser tooltips covering the title.
- Apply the fade only to the task-title text itself. Do not affect the time, change summary, permission labels, or hover action buttons on the right.
- Do not apply this rule to the workspace header task name; keep the existing `truncate` / `...` behavior.

This applies to both the desktop sidebar and mobile Web remote-control task list because both use the same `TaskListItem` UI.

The grouped task row reuses the same overflow measurement and fade component so the default list, timeline, and grouped view do not use different title-truncation semantics.
