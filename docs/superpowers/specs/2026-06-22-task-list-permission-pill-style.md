# Task List Permission Pill Style

The "waiting for confirmation" state in grouped task rows reuses the `Badge` component (pill, `rounded-full`), matching plain TaskList rows. Previously grouped rows used a hand-written `span rounded-sm`, so the same task state looked different across list views.

Rules:

- Keep the success-color semantics and hover-hide behavior.
- Do not touch task selection, drag, archive, or permission state logic.
- Desktop sidebar, global grouped task views, and light/dark themes share the same pill style.
- This is UI label appearance only; the ZCode session/task realtime message stream is unchanged.
