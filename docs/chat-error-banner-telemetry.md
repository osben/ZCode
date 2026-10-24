# Chat Error Banner Telemetry (V4 migration pending)

`chatErrorBannerTelemetry.ts` is reported in production through `ConversationTelemetrySupervisor.reportVisibleChatError` (called from `ConversationComposer.tsx` and `useSessionSubscriptionErrorTelemetry.ts`). Only the single `chat_error_banner` exposure event exists; CTA clicks and dismiss are not reported.

When rewiring, deduplicate by V4 error fingerprint and pane lifecycle; never report once per render, and verify under both desktop and mobile delivery profiles. Until production wiring lands, monitoring dashboards must mark this data as missing.
