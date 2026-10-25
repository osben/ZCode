# Model trajectory input deltas

## Problem

The model trajectory RPC sent every record with its full projected input. A main-session call repeats the whole previous context, so the payload grew as records × context length (5.5 MB for five calls of a real session) and froze the viewer on load.

## Owner

- Host projection (`packages/services/src/zcode-agent/modelTrajectory.ts`, `projectInputDeltas`) decides, after projection and segment budgeting, whether a record is sent as a delta. The model-io disk format does not change.
- The viewer (`packages/ui/src/ModelTrajectoryTimeline.tsx`, `reconstructTrajectoryRecords`, a pure function derived per render) rebuilds full inputs before display rules, row windowing, search, preview and copy. No other module sees deltas.
- Type: `ZCodeModelTrajectoryInputDelta` (`packages/services/src/zcodeTaskService.ts`), optional `inputDeltaOf = { previousRequestId, sharedPrefixCount }` on a record. The trajectory data has no runtime protocol schema; the field is type-only and optional.

Full contract, event order and measurements: `docs/model-trajectory-viewer.md` ("输入增量" and "输入还原").

## Product rules

1. Only `callSource.kind === "main"` records may be deltas. Sidecar, compact and subagent records are always full.
2. The base is the nearest preceding main record inside the `limit` window; a base with an empty `requestId` is never used. The first main record of the window is always full.
3. A record is a delta only when the base's full projected input is an exact content prefix of its own (role and serialized parts compared one by one). Counts, lengths or object identity never stand in for content.
4. A delta carries only `full.slice(sharedPrefixCount)`, with `sharedPrefixCount` equal to the base input length. A missing field means a full record, so older Hosts stay compatible with the new viewer.
5. Reconstruction: `[...base.slice(0, sharedPrefixCount), ...delta]`, base taken from the nearest preceding record with that `requestId`. A missing base or a length mismatch shows the delta rows with a "base missing" notice (`data-trajectory-input-context="base-missing"`); it never throws or hides the record.
6. Host and viewer ship in the same app version. A viewer older than the Host shows only the delta rows of delta records (no crash). An opt-in request flag for version-skewed remote web clients is an open follow-up.

## Acceptance scenarios

Unit tests: `packages/services/test/modelTrajectoryInputDelta.test.ts`, `packages/ui/test/modelTrajectoryInputDelta.test.ts`. E2E: `conversation-session-model-trajectory-viewer`.

1. Three main calls with growing context: the first is full, the next two are deltas; the viewer's reconstruction equals the full projection.
2. A sidecar call between two main calls: the second main call is a delta of the first; the sidecar is full.
3. A non-prefix input (after compaction): full record.
4. A delta whose base fell out of the window or mismatches in length: delta rows with the base-missing notice.
