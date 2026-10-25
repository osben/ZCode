# Simplified Feedback Submission Flow

## Background

The old feedback flow required users to fill in fields such as title, type, module, and impact level. It felt more like an internal ticket form. In the AI era, users should only describe the issue; the client should automatically add troubleshooting context.

## Goals

- Rebuild the feedback submission dialog as one simplified flow; do not reuse the old multi-field dialog design.
- Users only enter a problem description, optional screenshots, and optional contact details, then submit.
- Log upload is enabled by default, and users can uncheck it before submitting.
- The client continues to collect device, model, framework, and other context automatically for backend AI/engineering classification.
- Rebuild “My Feedback” as a read-only list; it no longer contains details, a workflow timeline, or a supplemental-feedback entry point.

## New Submission Form

The form has four user-visible areas:

Layout rules:

- Follow the Coding Plan purchase panel for the dialog shell: `rounded-2xl`, `p-0`, and separate header/body/footer areas, without heavy borders dividing them.
- Set the desktop dialog maximum width to `34rem` so the feedback form does not feel like a wide configuration page.
- Target a desktop dialog height of `38rem`, with automatic shrinking to `calc(100vh - 2rem)` in shorter windows. On mobile Web, continue using nearly the full screen height to provide sufficient vertical space for the description, screenshots, contact details, and log section.
- The Header shows only the current-page title and close button. Render the title through i18n: `Submit feedback / My feedback` in English.
- Keep only one scroll container in the dialog content; do not wrap each field in another card.
- Show top/bottom fade masks in the content scroller based on scroll position: show the top fade when hidden content exists above and the bottom fade when hidden content exists below; show neither when there is no hidden content.
- Use unframed groups for the problem description, screenshots, and contact details. Establish hierarchy through headings, spacing, and the input controls' own boundaries.
- Use light borders or subtle surfaces only for repeated attachment items such as the Logs configuration area, screenshot upload area, and screenshot thumbnails.
- Use `rounded-xl` consistently for the problem-description input, screenshot upload container, contact input, and Logs configuration area.
- Use `p-3` and `gap-3` for the screenshot upload container so the thumbnail grid, action row, and outer padding are consistent.
- Follow the Coding Plan purchase panel for the Footer, using natural whitespace for actions. On the submission page, show `Cancel` / `Submit` on the right; on the list page, show `New feedback` on the right.
- Keep the “My feedback” entry on the left side of the submission-page Footer on the same row as `Cancel` / `Submit`; make it a fixed left-side action, use an outline button, and show a Lucide icon with text.
- Let the primary submission button's width adapt to its label; do not set an extra fixed minimum width that makes short-label buttons feel too heavy.
- Do not create nested visual hierarchy such as “a card inside a dialog, with another card inside it.”

1. Problem description / Issue description
   - One required multiline input.
   - Show a red `*` required marker before the heading, reusing the same marker component as the product requirement dialog. The asterisk is hidden from screen readers; the input provides an accessible name in the current language plus required semantics.
   - Empty or whitespace-only descriptions cannot be submitted. Once valid content is entered, submission is allowed; clearing it blocks submission again. Contact information remains optional.
   - Show `current character count/4000` to the right of the heading.
   - Limit the input to 4000 characters.
   - Show at most 5 lines in the input; scroll within it beyond that.
   - Do not ask users to enter a title.
   - The client generates the title from the first line of the description.
   - When users enter from a chat error banner's “Report a problem” action, prefill the description with an error troubleshooting template. Do not add a generic opening such as “I encountered an error while using the app; please help investigate.” Combine the error-summary label and error message directly on the first line, for example: `Error summary: Provider authentication failed.` Keep TraceID, error details, “What I was doing,” and “Expected result” as separate following paragraphs so the user can add context.
   - If session subscription fails and the page enters a full-page “Reconnect” error state, show compact “Report a problem” and “Reconnect” buttons below the error. “Report a problem” reuses the chat error-banner submission flow. Prefill the first line of the description with the current subscription-error summary and include the session ID and redacted diagnostic summary (logs enabled by default; users must add screenshots). Users should not need to copy the error or reopen the feedback center from the global help menu.

2. Screenshots
   - Show `current image count/6` to the right of the heading, for example, `3/6`.
   - Support pasting images from the clipboard. When focus is not in a `textarea` or `input`, the whole feedback dialog accepts image pastes.
   - When focus is in the problem-description or contact input, do not intercept paste events; preserve native text-paste behavior.
   - Support dragging images into the upload area.
   - Support selecting images through the file picker.
   - Show selected images inside the same screenshot-upload container, with thumbnails above the action guidance.
   - Support multiple images, thumbnail preview, removal, and click-to-preview.
   - Keep the six-image maximum to prevent feedback attachments from becoming unbounded.

3. Contact
   - Optional.
   - Continue to support email, WeChat ID, and other social accounts.
   - Fix the input height at `h-10` and horizontal padding at `px-3`.
   - Continue reusing locally remembered contact details.

4. Logs
   - Enabled by default; users can uncheck it, and submission uses the current choice. New feedback defaults to enabled again; restoring a background submission preserves its original choice.
   - Show “Upload diagnostic logs.”
   - Explain the scope of current-day diagnostic logs, the safe projection of CLI configuration, and the possibility that business information may remain. Logs for problem reports also include the non-sensitive projection of `~/.zcode/cli/config.json` and the current day's model-call traces from `~/.zcode/cli/rollout/`.
   - Users may disable log upload, but do not restore other advanced fields from the old form.

5. Submit button
   - Disabled when the description is empty.
   - During submission, show ticket creation and screenshot-upload progress. When logs are enabled, also show log export and upload progress.

## Submission Field Mapping

- `title`: take up to 80 characters from the first line of the problem description; if the first line is empty, normalize and truncate the body instead.
- `description`: retain the user's original problem description and append the context block collected automatically by the client.
- `type`: defaults to `bug`. The backend AI later reclassifies from the original text, screenshots, and logs.
- `severity`: defaults to `P2-Medium`.
- `module`: defaults to `Other`. Backend AI/rules later reclassify it.
- `framework`: fixed to `zcode-agent`.
- `source`: remains `desktop-app`.
- `contact`: submit when provided by the user; omit when empty.
- `locale`: current UI language.
- `device`: continue including automatic context such as version, operating system, model configuration, and necessary model information; do not upload the model-configuration list.

## Log Semantics

Logs are optional troubleshooting material, enabled by default for all entry points. When enabled at submission, upload only allowlisted diagnostic logs; see [Log Upload Boundaries](feedback-log-export-alignment.md). Opening the form does not take screenshots automatically; users add and preview images by pasting, dragging, or using the file picker.

If logs remain enabled but upload fails, this phase retains the existing background-submission state machine's failure semantics: show feedback submission as failed and append a system note to the ticket explaining that automatic full-log upload failed. Changing this later to “ticket succeeds first, logs can be retried” requires a new design for submission-task recovery and supplemental uploads.

Treat background-submission notices as lightweight toast overlays, not large dialogs with oversized corners; use `rounded-xl` for the shell. Arrange content in three columns: “status icon / two lines of text / action buttons on the right.” The first line shows “Submitting feedback”; the second shows a specific progress description and percentage. Show the status icon directly in its semantic color without a border or subtle-surface base. Keep expand and close buttons on the right compactly spaced so the action area does not dominate the content.

## My Feedback

“My Feedback” shows only the feedback list as a lightweight place to confirm submission and copy an ID:

- Use a single table-like container; do not add hierarchy by grouping items by date.
- Show each feedback item's status, title, submission time, and feedback ID.
- Display the feedback ID in a monospaced font and provide a copy button.
- Do not open a detail page on click; do not show processing timelines, detail replies, or a supplemental-feedback form.
- All visible titles, table headings, buttons, ID prefixes, and descriptions must use i18n; do not hard-code English in components.

## Cross-platform Impact

- Desktop continues to create tickets and upload screenshots/logs through the existing host-process `feedbackService`.
- The Web remote-control home currently uses an unsupported fallback for `feedbackService`. This change does not add remote-control business state or affect task realtime, snapshot, queue, or replayable/continuous semantics.
- The session-subscription error entry point belongs to shared UI: retain the button and prefilled error summary on desktop and mobile Web. Degrade screenshot capability based on current host support; do not add a separate Agent runtime, subscription, or recovery path for mobile.
- Use semantic tokens, a compact dialog layout, and i18n copy that support both wide desktop screens and narrow mobile Web screens.

## Verification

- The feedback-submission page no longer renders type, module, impact-level, or model-display fields.
- Pasting/selecting multiple images, previewing, and deleting them remain available.
- The log toggle is enabled by default; unchecking it sets `includeLogs` to `false`.
- The session-subscription error page shows both “Report a problem” and “Reconnect.” After reporting, the draft includes the current error, session ID, and redacted diagnostic summary; logs are enabled by default and no window screenshot is captured automatically.
- Run `pnpm typecheck`.
- Run `pnpm lint`.

| Case ID    | Scenario                                                                               | Assertion                                                                                                                                        | E2E location                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| FB-DESC-01 | Problem reports in Chinese and English, narrow and wide windows, light and dark themes | The required marker is visible; the input has required semantics; empty values cannot be submitted                                               | `packages/desktop/test/e2e/feedback/manual-review/pending/feedback-upload-privacy.test.ts`, FB-PRIV-01/08 / FB-DESC-01 |
| FB-DESC-02 | Real form and in-memory feedback service                                               | Empty, whitespace-only, and cleared values cannot be submitted and create no ticket, archive, or upload; a valid description can create a ticket | Same file; FB-DESC-02 isolated Chromium fixture                                                                        |
