# E2E builds bake a reserved telemetry report endpoint

## Problem

The warehouse event reporter (`packages/services/src/telemetry/telemetryCore.ts`) sends nothing when the build-time
`ZCODE_TELEMETRY_REPORT_ENDPOINT` is empty. Upstream builds take it from `config/private/build-defaults.json`
(`scripts/build-time-config.mjs`). The fork has no such file, so fork E2E builds had an empty endpoint, and every report
was dropped before `net.fetch`. The specs that capture `/api/v1/event/report` through a `net.fetch` mock
(`conversation-session-background`, telemetry parity specs) saw `{}`. Upstream 3.17.2, built without its private
defaults, fails the same four `background` cases.

## Rule

- E2E desktop builds (the WDIO `onPrepare` build and the sharded runner's build steps) set
  `ZCODE_TELEMETRY_REPORT_ENDPOINT=https://telemetry.e2e.invalid/api/v1/event/report` when the variable is unset.
- An explicitly set value wins, including an empty string, which keeps reporting off.
- `.invalid` is reserved (RFC 2606): a spec that does not mock `net.fetch` fails DNS locally, and nothing leaves the
  machine.
- The variable is part of the E2E build cache fingerprint (`E2E_DESKTOP_BUILD_ENV_NAMES`).
- Release and regular builds are unchanged: the fork still ships without a report endpoint.

Owner: `packages/desktop/scripts/fork-e2e-telemetry-endpoint.mjs`.

## Acceptance

- Unit (fork manifest, `packages/desktop/test/forkE2ETelemetryEndpoint.test.ts`): the default is applied when unset,
  an explicit or empty value is kept, and the name is in the cache fingerprint list.
- E2E: `conversation-session-background` passes 26/26 on the Node agent after a fresh build.
