# Context Usage Breakdown Bar

The agent already counts context characters by source in the `context_usage_snapshot` debug log; the context usage dialog surfaces that breakdown so users can see what fills the context after each request.

Rules:

- The dialog reuses the header's context-used progress bar and splits the used portion by source. No second bar in the body.
- Proportions use each source's `chars` and show percentages only — never raw character or token counts.
- Sources cover at least: Messages, System prompt, Other, Skills, Tool prompt, System tools, MCP tools. "Other" maps to the agent's internal `meta_user_context`; the UI never exposes the "meta user" concept.
- The field is optional. Old agents, old snapshots, or requests without a breakdown keep showing only totals and cache hit rate.

Data flow:

1. The agent runtime builds the context usage snapshot from the actual request options before the main model request.
2. `{ source, chars }` from the snapshot's `categories`, filtered for invalid or zero values, becomes `contextUsageBreakdown` in the `ModelComplete` payload.
3. The app/service compatibility layer maps `contextUsageBreakdown` to the legacy task stream's `usage_update.breakdown`.
4. UI store, runtime snapshot, and replay projection keep the optional field.
5. `ChatContextUsage` computes segment widths and legend percentages from `breakdown[].chars / sum(chars)`.
6. If a final or restore snapshot carries only `used/size/cache` without breakdown and `used/size` matches the current live usage, the UI must keep the live `usage_update.breakdown` — snapshot alignment after `task_complete` must not wipe the bar.

UI rules:

- Segments use dedicated low-saturation blue-scale tokens for the breakdown, not the global usage-chart rainbow palette; colors are assigned in descending order, largest share darkest.
- The legend uses a compact row layout, works for zh/en and mobile Web narrow widths, and shows no raw char/token counts.
- With no breakdown or zero total chars, the header bar falls back to a plain single-color used fill; the compact button and cache hit rate are unaffected.

Non-goals: token accounting for used/size is unchanged; tool/skill debug-log detail is not exposed to the UI; no new ordering semantics for the desktop busy queue or mobile replayable queue. Desktop `desktop-continuous` and mobile `web-remote-replayable` only pass through the same usage payload — snapshot, stream, queue, owner, and recovery semantics unchanged.
