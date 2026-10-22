# Task realtime batch splitting cost

Status: implemented (2026-10-21). Owner: `TaskRealtimeBus` in `packages/desktop/src/main/taskRealtimeBus.ts` (Electron main process).

## Product contract

- A stream-mirror batch larger than `STREAM_MIRROR_MAX_BATCH_BYTES` (512 KB) is not sent whole. The owner host receives consecutive chunks, each at most 512 KB by the same measure used for the batch: the UTF-8 byte length of its serialized JSON (`Buffer.byteLength(JSON.stringify(...), "utf8")`), not UTF-16 code units. Cyrillic and CJK text therefore counts 2 to 3 bytes per character.
- Chunk boundaries are the greedy rule: append ops in `seq` order and start a new chunk when the next op would push the chunk over the limit. A single op larger than the limit is sent alone. This rule is unchanged.
- Observers receive only a `stream_mirror_gap` snapshot invalidation for an oversized batch, never the body.
- The owner's `seq` stream stays contiguous across chunks.

## Cost rule

- Splitting is linear in payload size. Each op is serialized once per flush and measured in UTF-8 bytes. The batch's total size is computed from those per-op byte lengths plus the batch header, not by re-serializing the whole batch or each candidate chunk.
- Splitting must not re-serialize the accumulated chunk for every op (that is O(ops x bytes) and blocks the Electron main thread for every window).

## Owners and event order

1. Renderer or Host publishes `TaskStreamOpPublish`; the bus assigns `seq` at flush time.
2. `flushBatch` coalesces and splits large text, serializes each op once, and computes the batch size.
3. Under the limit: the batch is replayed and delivered to every host.
4. Over the limit: `deliverOversizedStreamBatchFallback` clears replay, sends the owner chunks in order, then invalidates observers with `stream_mirror_gap`.

## Acceptance scenarios

- 5 000 small mirrored ops flush with one `JSON.stringify` per op and batch headers serialized with `ops: []` only, at most one per op. The test counts serializations, not elapsed time.
- Chunk boundaries for a fixed fixture equal those of the greedy reference, including an oversized single op that is sent alone.
- A multibyte fixture (Cyrillic and CJK op text) splits by UTF-8 bytes: each owner chunk is at most 512 KB in UTF-8, and its boundaries are pinned to the UTF-8 greedy result (`[1,2,3]`, `[4,5,6]`, `[7,8,9]`, `[10]`).
- Every owner chunk is at most 512 KB by UTF-8 byte length, and observers receive `stream_mirror_gap` with the last `opSeq`.
