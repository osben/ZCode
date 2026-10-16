# Minimize the Window During Background Feedback Attachment Uploads

## Background

Feedback submission first creates a ticket, then uploads screenshots and diagnostic logs. Exporting and uploading diagnostic logs can take a while, which otherwise leaves users blocked in the submission dialog.

## Behavior

- Keep the feedback window open while the user clicks “Submit Feedback” and the ticket is being created.
- The ticket-creation request must have a finite timeout so a hanging feedback service or network connection cannot leave the button stuck on “Connecting to feedback service.”
- “Cancel” during ticket creation must truly cancel it: the UI uses the feedback service's creation operation ID to tell the host process to abort the current request and stop subsequent screenshot and log uploads.
- After ticket creation succeeds, upload screenshot and log attachments in the background and close the feedback window automatically.
- The “Report a problem” entry in the top help menu and all other new-feedback entry points always open a fresh submission form. They do not automatically bind to an existing background submission; users do not need to wait for the previous feedback's attachment uploads to finish.
- Each background submission task exists independently by `jobId`. If multiple tasks are still active, show a separate status card for each in the lower-right corner instead of showing only the latest task.
- Clicking an active task card binds the feedback dialog only to that card's `jobId`, shows its progress, and restores the original problem description, contact information, screenshots, log setting, and ticket classification from that submission. Closing the dialog leaves the task running in the background. Creating new feedback and opening a specific background task are distinct actions.
- A background task stores a snapshot of the user form at submission time. The problem description must use the original user input; do not try to reconstruct it from the backend `ticketInput.description`, which already includes diagnostic information such as model and type.
- If the user added no screenshots and disabled log uploads, there is no background attachment stage; keep the existing post-submission navigation behavior.
- Closing the window does not cancel background uploads for an already-created ticket. The existing background-upload status notice continues to show progress, pause, and errors. If the window closes before ticket creation succeeds, cancel the creation request.
- If ticket creation fails, do not close the window automatically; keep showing the existing error state so the user can edit the content and retry.
- If attachment upload fails, do not reopen the submission window; use the existing background-job error and notice handling.
- If the user explicitly cancels ticket creation, reset the submission state and show “Feedback submission canceled”; do not create an attachment-upload task. Ignore any later success response from the backend and do not restore the old submission job.

## State and Interaction Boundaries

```text
New feedback entry
    |
    v
[Fresh submission form, submissionJobId = null]
    |
    | Ticket created successfully; attachments continue uploading
    v
[Background job job-A + form snapshot A] ----\
                                             +--> Lower-right card list --> Click A --> [Progress dialog + form snapshot A]
[Background job job-B + form snapshot B] ----/                         \-> Click B --> [Progress dialog + form snapshot B]

Click “Report a problem” again ----------------> [Fresh submission form, submissionJobId = null]
```

- `openSubmit(draft)` means “create new feedback” and must clear `submissionJobId`.
- `openSubmissionJob(jobId)` means “view a specific background submission” and must not fall back to “the latest active task.”
- `FeedbackSubmissionJob.formDraft` is a per-task, read-only snapshot captured at submission time. The dialog restores that snapshot by `jobId`; it does not read another task's state or the current new-feedback form.
- The background card list subscribes to the global job registry. Tasks do not share the form's `submitting`, progress, or cancellation state.
- This is an app-level local feedback capability. It does not introduce workspace state or change the desktop `continuous` or mobile remote-control `replayable` message paths.

## Non-goals

- Do not change the feedback backend HTTP protocol, attachment-upload protocol, screenshot selection, or log packaging rules.
- Do not change “My Feedback” list or ticket-detail behavior.
