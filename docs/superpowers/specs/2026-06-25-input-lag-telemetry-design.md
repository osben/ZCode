# Input Lag Telemetry Design (perf_ui_input_lag)

The chat input is a Lexical editor (`packages/ui/src/LexicalChatInput.tsx`), not a plain textarea; users report typing lag with long text. Existing `uiPerfArmsTelemetry.ts` covers output-side perf (first token, message complete, agent step, `perf_ui_stream_stall`) but nothing input-side. `perf_ui_input_lag` reports input-handling latency to ARMS to verify causes with production data. Non-goals: no end-to-end keydown→paint pairing (no rAF), no session-level aggregation (first version captures only over-threshold lags).

Suspected hot path per keystroke:

```
editor content change
  → Lexical update
  → TextContentPlugin registerUpdateListener callback
      → getEditorMarkdown(editorState)    // full $getRoot().getTextContent() serialization, O(n)
      → getEditorMarkdown(prevEditorState) // second full serialization
      → nextText !== previousText comparison
      → onChange(nextText)                 // synchronous parent setState → React re-render
```

The two full serializations plus the synchronous `onChange` re-render are the primary hypothesis, verified via the `text_length` dimension.

Design:

- New event `perf_ui_input_lag` in the existing `packages/ui/src/lib/uiPerfArmsTelemetry.ts` (no new file), group `UI_PERF_ARMS_GROUP = "ui_perf"`, same source and group as `perf_ui_stream_stall`.
- Measurement: wrap the synchronous `getEditorMarkdown + onChange` block in the `TextContentPlugin` update listener with `performance.now()` → `lagMs`. Listener-internal sync time only, never to paint — the same plain caliber as `perf_ui_stream_stall`.
- Report only over threshold. `INPUT_LAG_REPORT_THRESHOLD_MS = 500` (conservative start, exported constant, tightened later per distribution, mirroring `STREAM_STALL_REPORT_THRESHOLD_MS`). `INPUT_LAG_SANITY_MAX_MS = 5000` — beyond this it is almost certainly debugger pauses, tab suspension, or device sleep; discard (same idea as `LAUNCH_TO_INPUT_SANITY_MAX_MS`). Failures never block input: existing `emit()`, `logger.warn` only.

Exclusions (not typing lag):

1. IME composition — CJK composition updates are naturally frequent and slow, so they are excluded. The update listener does not directly expose `isComposing`; use the editor root's composition state (confirm what Lexical exposes when writing the plan).
2. Programmatic rewrites — `replaceEditorText` / `setText` / mention insertion / history-navigation backfill perform large `editor.update`s that are slow but not typing. Tag those `editor.update` calls with a Lexical update tag; the listener reads `tags: Set<string>` and skips matches (tag name and call sites to be fixed at plan time).

Payload (existing `ArmsCustomEventPayload`):

| Field | Value | Purpose |
|------|-----|------|
| `name` | `"perf_ui_input_lag"` | event name |
| `group` | `"ui_perf"` | existing group |
| `value` | `Math.round(lagMs)` | main metric, dashboards do distribution/p95 |
| `properties.lag_ms` | same as value | mirrors `stall_ms` of stream_stall for dimension filtering |
| `properties.text_length` | current editor text length | key attribution: "longer text, worse lag" |
| `properties.task_id` | current taskId (empty in draft) | session correlation, consistent with other ui_perf events |

Deliberately excluded (YAGNI): text content (privacy + size), model (input side is model-independent), mention count (watch `text_length` first).

Wiring (symmetric with stream_stall):

- `uiPerfArmsTelemetry.ts` exports `recordInputLag(params: { lagMs; textLength; taskId? })` via existing `emit()`; no new reporter (reuses `armsReporter`; `Root.tsx` already calls `setUiPerfArmsReporter`, so Root is untouched).
- `TextContentPlugin` computes `lagMs`, skips programmatic tags and IME composition, and calls `recordInputLag` when `lagMs > 500 && lagMs <= 5000`, with `text_length` = `nextText.length`.

Tests (pure-function style, like `chatErrorArmsTelemetry.test.ts`): `shouldReportInputLag({ lagMs, isProgrammatic, isComposing })` covers below-threshold, above-threshold, above-sentinel, programmatic skip, IME skip; `recordInputLag` covers silent-no-reporter, correct payload, warn-not-throw on reporter error. No component-level E2E (Lexical update behavior is unstable under jsdom; the pure function covers the decision logic).

Files: `packages/ui/src/lib/uiPerfArmsTelemetry.ts` (constants + `recordInputLag` + `shouldReportInputLag`), `packages/ui/src/LexicalChatInput.tsx` (wiring + programmatic update tags), `packages/ui/test/uiPerfArmsTelemetry*.test.ts`.

Key decisions: broad event coverage but first version focuses on keystroke processing latency; report only over-threshold lags (minimal event volume); timing inside the update listener (closest to real processing cost, smallest change); 500ms threshold (user-specified conservative start); programmatic rewrites excluded (cleanest typing-only caliber).
