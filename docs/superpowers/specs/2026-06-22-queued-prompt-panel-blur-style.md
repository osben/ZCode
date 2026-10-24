# Queued Prompt Panel Blur Style

The queued prompt panel sits above the composer, joined to the input by the `-mb-7 pb-7` overlap.

Rules:

- The panel uses `rounded-t-2xl` with the existing overlap and `bg-surface backdrop-blur-md` for layering. It must not use a shadow (`shadow-xl/5`) to create hierarchy: in dark themes a shadow made the panel and the input read as two separate cards.
- Other bottom panels (composer, permission, elicitation, quota, error banner) are unchanged.
- Desktop and mobile Web share the same panel style; themes use semantic surface tokens, no hardcoded colors.
- Queued prompt ordering, send-now, edit, and delete logic are unchanged.
