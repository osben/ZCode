# V4 User Message Display

The V4 conversation `userInput` row keeps the authoritative `text` and attachments as its data source; the
read-only bubble restores the display semantics of the old `UserMessage`. Display state is renderer-local
UI, is not written to the conversation snapshot and does not change the desktop continuous or mobile
replayable chains.

## Body and Structured References

- Mention markdown in the read-only body is restored as skill, session, file/directory, subagent and
  command labels; internal paths or session targets are not shown directly.
- For a goal control query confirmed at the send entry, a leading `/goal` / `/target` in the read-only body
  renders as a `goal` / `target` label with a Goal icon and without the `/`; same-named text that
  degraded to an ordinary prompt stays as is.
- Copy and inline editing always use the raw `userInput.text`, never the already flattened display text.
- Attachments, Web element context and the conversation selection chip sit outside the collapsible body
  area and stay fully visible while the body is collapsed.

## Long Body Collapse

- The default maximum visible height of the user body is `120px`; with no overflow there is no mask or
  control button.
- With `scrollHeight > 121px` it becomes expandable. Collapsed state uses a bottom fade mask and a centered
  expand button at the bubble bottom.
- Expanding transitions the body height to the measured full `scrollHeight` and the button becomes
  collapse; clicking again restores `120px`. The transition is `300ms` and honors
  `prefers-reduced-motion`.
- A text change resets to collapsed and re-measures, so a virtual timeline reusing a row does not carry
  over the previous message's expand state.
- `ResizeObserver` covers window width, font and mention/file icon layout changes; measurement is merged
  through `requestAnimationFrame`, and the observer and RAF must be cleaned on unmount.
- Desktop and mobile Web remote share the same collapse semantics; on touch the button is normally
  tappable and does not depend on hover.
