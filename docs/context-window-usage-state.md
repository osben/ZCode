# Context window usage state (current facts)

The conversation source of truth for context usage is V4 `ConversationSnapshot.usage`, not the renderer's legacy `taskRuntime`.

```text
CLI usage events -> ProductProjection.usage -> snapshot/delta
  -> SessionDataLayer -> composer toolbar / status UI
```

`V4ComposerToolbar` reads `snapshot.usage.contextWindow` to show usage. The UI does not accumulate tokens locally or assemble usage from the old task stream; after recovery, the snapshot wins.

## Cold recovery after compact

Todo123: cold recovery queries the Registry read-only with the explicit identity `runtime.getSessionModelSelection() ?? record.restoredModelSelection` — it does not require complete thinking tiers, does not create an executing Model, and does not write the selection back. One capacity is fetched within the same history load, and the matching usage seed is delivered with the load result into the projection; there is no separate cache. Unknown capacity is `null` in the internal seed's maxTokens; the protocol still sends the whole `contextWindow=null`. Used tokens are kept so the display can return once capacity is known — it must not fall back to 200,000. Real usage events and new events during recovery win over the old seed; a `ModelSelected` of the same model may update the cap but does not recompute usage.

```text
recovery identity -> Registry metadata (once) -> history events + usage seed
                                           |
                                      backfill live events
                                           |
                          continuous / replayable keep their own delivery paths
```

On cold recovery the runtime projection may not have usage yet; the first frame must restore the most recent watermark from the active branch's persisted messages and must not jump back past the compact summary to a pre-compaction assistant:

```text
active branch tail
  ├─ assistant       -> provider total / input + output
  └─ compact summary -> truePostCompactTokenCount ?? postCompactTokenCount
                                              |
                                              v
                                      cold snapshot usage
```

Runtime `contextUsed > 0` still wins; only the cold-recovery fallback walks the watermarks above in reverse order. Only a persisted user compact-summary boundary with a valid token count becomes the new watermark; old assistant boundaries or incomplete history keep the existing assistant-tokens fallback. The boundary watermark carries no cache from the pre-compaction request, consistent with hot `CompactCompleted`.

## Provider registry hot update

After the settings page changes the current model's `contextWindow`, the provider registry applies the new capacity to both the live session's runtime and the V4 conversation projection. The projection update only replaces `snapshot.usage.contextWindow.maxTokens` and keeps the existing `usedTokens`; it must not wait for the next `ModelComplete` to recalibrate.

When the registry clears the current model's explicit `contextWindow`, the runtime uses `undefined` for unknown capacity and `ModelSelected.contextWindow` uses `null` for "explicitly cleared". On receiving `null`, the V4 conversation projection must clear `snapshot.usage.contextWindow` to `null`; a missing field is only legacy-event compatibility and must never be read as a clear. While capacity is unknown, later `ModelComplete` events keep accumulating tokens but must not rebuild the window object with `maxTokens: 0`; the projection keeps the latest context usage internally so it can republish once capacity returns.

```text
provider registry (contextWindow changed)
  -> active session runtime.updateConfig
  -> ModelSelected (same model + new contextWindow | null)
  -> ProductProjection.usage.contextWindow.maxTokens | null
  -> desktop-continuous / web-remote-replayable each publish at their existing boundaries
```

This is a capability-metadata hot update of the same model: no model-switch marker, no recomputation of used tokens.
