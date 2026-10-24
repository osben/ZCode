# Chat Error Banner Telemetry (V4 migration pending)

`chatErrorBannerTelemetry.ts` currently has helpers and tests only, with no V4 production call sites; error banner exposure, CTA clicks, and dismiss must not be treated as reported.

When rewiring, deduplicate by V4 error fingerprint and pane lifecycle; never report once per render, and verify under both desktop and mobile delivery profiles. Until production wiring lands, monitoring dashboards must mark this data as missing.
