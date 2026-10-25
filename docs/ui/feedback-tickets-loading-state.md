# My Feedback List Loading State

## Background

Selecting “My Feedback” in the feedback window opens the ticket list and immediately calls the feedback service to load the current user's tickets. During the initial list request, an empty content area previously remained blank, leaving users unable to tell whether the request was in progress or there were no records.

## Behavior

- After opening “My Feedback,” show a loading state centered in the content area while the first list request is pending and there are no cached tickets.
- Use the existing `common.loading` localized text and spinner, centered in the list content area. Do not affect the window title, back button, close button, or footer actions.
- If the list already contains content when the user refreshes, keep using the existing loading indicator at the bottom of the list so it does not cover existing tickets.
- When the request completes, show the existing empty state, list, or error message as appropriate.

## Non-goals

- Do not change feedback submission, screenshot/log uploads, background-upload notices, or ticket-detail behavior.
- Do not add feedback APIs or caching policies.
