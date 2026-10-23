# Model trajectory v2 projection

Host-side, stateless, read-only projection behind `IZCodeTaskService.getModelTrajectoryV2`. Product rules: `specs/model-trajectory-v2.md`.

It reads three sources it does not own, through ports:

- `ModelIoWindowPort`: the v1 bounded model-io window (CLI-written JSONL).
- `ToolTimingPort`: the CLI session database `tool_usage` table, opened read-only; every failure becomes `toolTiming.source = "unavailable"`.
- `ContextWindowPort`: the provider registry's model `contextWindow`; a miss or a throw means unknown.

Records are the v1 projection (same mapping and input deltas) enriched with request parameters, cache breakpoints, `timing` and `cacheWriteTokens`. Tool definitions and system blocks are interned per response under fixed byte budgets; ids are only stable within one response. The module keeps no cache and never writes any source.

Layers: `domain` (pure parsing, interning, budgets) < `app` (orchestration) < `adapters` (files and sqlite).
