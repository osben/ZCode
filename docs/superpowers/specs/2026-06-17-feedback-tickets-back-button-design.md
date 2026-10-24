# Feedback Tickets Back Button Design

The feedback center has "submit feedback" and "my feedback" (`tickets`) tabs. The `tickets` page header shows a back button to the left of the title, so users entering "my feedback" from the submit page find the expected return entry next to the title (previously only the bottom-right "new feedback" button switched back).

Rules:

- The back button renders only when the active tab is `tickets`. Clicking it sets the tab back to `submit`; it does not close the dialog or clear the submit-page draft.
- The top-right close button and bottom-right "new feedback" button keep their behavior; reaching `submit` via "new feedback" is unchanged.
- aria-label is bilingual: `feedback.center.backToSubmit` — zh "返回提交反馈", en "Back to submit feedback". Works on desktop, web, and mobile small screens.
- No navigation history stack: the back button always means tickets → submit.

Design: `packages/ui/src/feedback/FeedbackCenter.tsx` remains the tab control layer. The header splits into a left title group and right close button; for `tab === "tickets"` the title is preceded by a `Button variant="ghost" size="icon-md"` with the `ArrowLeft` icon from `lucide-react`, calling `setTab("submit")`. The header keeps `min-w-0` and the title `truncate` so long locales or narrow screens cannot overlap the close button. The ghost icon button stays low-emphasis versus the close button: left navigates within the dialog, right exits it.

Non-goals: no tab-state refactor; ticket list load/refresh/copy-ID/selection and submit flow unchanged.

Verification: `packages/ui/test/feedbackCenter.test.ts` — tickets tab renders the back aria-label and `feedback.center.ticketsTitle` plus the close button; submit tab renders no back button; the button triggers `setTab("submit")`.
