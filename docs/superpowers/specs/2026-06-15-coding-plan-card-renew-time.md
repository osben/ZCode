# Coding Plan Plan Card Renew Time

The purchased Coding Plan card in Model Settings shows the 5h, 1w, and MCP usage buckets. Each bucket shows its renew time, so the card and the sidebar "remaining quota" panel agree on the same quota data.

Rules:

- Renew time renders to the right of the remaining percentage, on the same line; no extra row below the progress bar. On small screens or long locales it may truncate within that flex row but must not stretch the card.
- Source is the bucket's `UsageQuotaLimit.nextResetTime`. Do not derive from subscription renewal or expiry time.
- Formats match the sidebar remaining-quota panel: 5h uses dateTime (time only within today, otherwise month-day and time); 1w and MCP use date.
- When `nextResetTime` is missing or invalid, show no renew-time placeholder.
- Sidebar state-card fields, Start Plan model balance cards, and server/protocol fields are unchanged.
