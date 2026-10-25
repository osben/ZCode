# Viewing Feedback Processing Progress

## Goal

After submitting feedback, users can view its backend status, official replies, and timeline under “My Feedback.” Feedback status is queried only when users actively open a related feedback-center page, avoiding continuous background requests for the ticket list.

## Client Policy

- Do not poll the ticket list in the background at app startup or while the feedback center is closed.
- When the user opens “My Feedback,” `TicketsView` fetches the current user's ticket list.
- When the user selects a feedback item, the detail page fetches that ticket and displays its latest status, replies, attachments, and timeline.
- Refetch the list and current detail after the user clicks the list refresh button, after submission navigates to the detail page, or after supplemental information is submitted successfully.
- The feedback center no longer uses background polling to show toasts, desktop notifications, or an unread badge on “My Feedback.” Users can see the latest status by opening “My Feedback.”

## Click Behavior

The feedback entry point only opens the feedback center. To view processing progress, users open the “My Feedback” list and select the relevant ticket.

## Backend Contract

The client currently relies on `updated_at` and `status` from the list API, and on events, comments, and attachments from the detail API. The backend only needs to update a ticket's `updated_at` after the following actions for users to see the latest progress the next time they open or refresh “My Feedback”:

- An administrator changes the status.
- An administrator replies to the user.
- Assignment, release, or another processing action is added to the ticket timeline.

If the product later needs proactive notifications again, introduce WebSocket, SSE, or push notifications; do not restore fixed-interval client polling.
