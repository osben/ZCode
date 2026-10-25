# Chat Context Usage Refresh Action

## Scope

The action slot on the right of the Coding Plan remaining-quota header in the composer context hover panel opens usage details.

## Behavior

- While a remote quota refresh is in flight, the slot hides the "more/details" button and shows a loading icon.
- When the refresh finishes loading without error, the slot shows a green success check for 1 second, then restores the "more/details" button.
- Quota details stay visible whenever a cached snapshot exists; this behavior only affects the header action slot.
- On refresh failure with cached quota, the content area is not taken over: the cached quota bar stays and a warning-colored info icon appears next to "more", with a tooltip explaining the failure.
- With no displayable quota, an info notice is used: info icon on the left, user-facing copy in the middle, refresh icon button on the right.
- Failure notices never show provider/raw errors (for example timeout codes); background refresh details stay out of the hover panel.

## Implementation notes

- State lives in `CodingPlanUsageHeaderAction`, keeping refresh-completion feedback out of the context panel aggregation file.
- The cached-quota error hint is carried by `CodingPlanUsageHeaderAction`; the no-cache/unavailable empty state is `CodingPlanUsageNotice`.
- A `silent` access refresh keeps `entitlement.loading=false` when a cached snapshot exists, so cached content does not flash back to checking; the hover-triggered refresh icon is therefore tracked by `ChatContextUsage` via the `onAccess` promise and passed down as `refreshing`.
