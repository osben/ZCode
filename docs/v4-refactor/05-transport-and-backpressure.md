# Transport and Backpressure: Subscriber Isolation, 1 MiB Physical Frames and Atomic Resync

> Current fact (V4 wire v3): profile filter, coalesce, bounded subscriber buffer, physical fragmentation and recovery are one sending pipeline. Every limit is computed on the real UTF-8 serialized wire bytes, never estimated from JavaScript character counts.

## 1. Layer boundaries

```text
CLI authoritative event log / projection
          │
          v
per subscription publisher
  profile filter -> coalesce -> compute op/UTF-8 bytes
          │
          ├─ ≤500 ops and ≤max(1 MiB, snapshot upper bound) ──> logical TopicFrame
          └─ over limit ────────────────────────────────────> clear buffer + needsResync
                                                               next send is only the latest snapshot
          │
          v
wire v3 encoder
  logical ≤ physical budget ──> complete envelope
  oversized snapshot/resume ──> fragment envelopes (each ≤1 MiB)
          │
          v
connection transport
  onSaturated / onDrained, ACK, heartbeat, short-disconnect replay
          │
          v
owning attachment port only
```

The trigger signals are at connection/transport level; the conversation degradation decision is at subscription-publisher level:

- transport only reports `onSaturated/onDrained` and does not parse topic, seq or snapshot;
- the publisher knows which deltas can merge and when a snapshot is required;
- relay/main only pass through flow-control signals and payload and hold no conversation buffer or recovery state;
- one subscription's buffer, resync or assembly can never block another subscription.

The publisher does not advance the watermark when "producing a logical frame". It must keep a stable reservation and commit only after all physical envelopes are accepted by the transport:

```text
committed sentSeq=N
  -> reserve R(frame=(N,M], logicalFrameId=L)
  -> encode R -> wire[0..k]
  -> emit every wire
       sync enqueue failure: keep R, sentSeq remains N
       all admitted to this connection queue: commit R, sentSeq becomes M
```

A retry of the same reservation before commit must keep `logicalFrameId` and the logical JSON unchanged. New events go into the post-reservation buffer; an old reservation must not reference the mutable buffer. Unsubscribe or resubscribe invalidates a late commit through a generation token. `Writable.write() === false` only means backpressure, not rejection; an async EPIPE appearing after enqueue ends the connection epoch directly, the old subscription does not continue on a new attachment, and the new connection recovers from subscribe/resync.

### 1.1 Per-subscription encoding and the workflowRuns growth bound

The retained log stores native ops. Each subscription remembers whether it declared `workflowRunDeltas` at handshake ([10-protocol-spec.md](./10-protocol-spec.md) §2); encoding is decided per subscription at fan-out, orthogonal to profile:

- A declaring subscriber receives `workflowRun.updated / workflowRun.removed` directly (same document §4.5).
- A non-declaring subscriber is flattened per batch: all `workflowRun.*` ops of the batch are dropped, and at the position of the last one a whole-key `state.updated{workflowRuns}` is placed, valued from the current authoritative projection clamped to the old bounds: each run keeps only the first 256 nodes and first 256 actors, and any trimming sets `truncated: true`. "First N" is exactly the product of the old reducer's reject-new semantics, so the old reader's `.max(256)` passes. A snapshot frame sent to a non-declaring subscriber applies the same clamp.
- Replaying from the retained log takes "current" state that is newer than the historical ops: acceptable, the end state is consistent and intermediate states are skipped, as coalesce already does.

The difference between the two ends is in encoding, not profile: under the same encoding continuous and replayable end states still match field by field (§2).

When the publisher ingests a workflow progress event it need not `JSON.stringify` the whole authoritative snapshot to check the 16 MiB bound: when `snapshot byte upper bound + this op's UTF-8 bytes + constant <= limit` it passes on the bound and accumulates in place (one upsert/patch grows the snapshot by at most its own bytes, so the bound holds); otherwise it falls back to the exact-metering slow path, which recalibrates the bound. This is the same accounting as the existing streaming-append fast path, not a second ledger.

## 2. Delivery profile is injected by the trusted connection

UI and subscribe parameters contain no profile. The connection-scoped facade picks the one profile from the host-injected trusted `clientMode`:

```ts
const DELIVERY_PROFILES = {
  continuous: {
    // desktop, including SSH/WSL/Docker windows
    flushWindowMs: 30,
    streamPaths: { text: true, inputText: true, "output.text": true, summaryText: true },
    streamOutputCapBytes: 262_144,
    toolProgress: false,
  },
  replayable: {
    // mobile remote / WebSocket
    flushWindowMs: 150,
    streamPaths: { text: true, inputText: false, "output.text": false, summaryText: false },
    streamOutputCapBytes: 0,
    toolProgress: true,
  },
} satisfies Record<string, DeliveryProfile>;
```

The profile affects only intermediate frames, never schema, command/ACK, guard, recovery algorithm or end state. The same authoritative event sequence run through continuous/replayable may differ in intermediate frames but the final client state must match field by field. A streaming event filtered by the profile must be closed by an unfilterable completed `row.upserted` or a snapshot.

## 3. Hard bounds of the subscriber buffer

Each subscription keeps an independent volatile buffer; counting happens **after profile filter and after coalesce**:

```ts
const MAX_BUFFER_OPS = 500;
const MAX_BUFFER_BYTES = 1_048_576; // 1 MiB
```

Normal drain requires both bounds to hold:

```text
coalescedOps <= 500
AND serializedLogicalPayloadUtf8Bytes <= min(max(1 MiB, wireSnapshotBytesUpperBound), 16 MiB - 64 KiB)
```

`500/501 ops` and the byte-limit `byte before / exactly / byte after` are ruled mechanically by the formula. Multi-byte UTF-8 characters must use the encoded byte length; `string.length` is forbidden.

The byte limit is `min(max(1 MiB, wireSnapshotBytesUpperBound), 16 MiB - 64 KiB)` (revised 2026-09-30):

- `wireSnapshotBytesUpperBound` is the publisher's conservative upper bound of the current wire snapshot (tail 60 rows) logical frame, maintained for the 16 MiB assembly gate. The outer clamp to `16 MiB - 64 KiB` (the `PROJECTION_TERMINAL_RESERVE_BYTES` reserve) guarantees the deltas logical frame plus frame shell stays `<= 16 MiB`; beyond the physical frame it fragments as usual.
- Reason for the revision: the whole point of overflow is to swap a backlog of deltas for a smaller snapshot. When a single large delta (e.g. a 3 MiB bash output tool-row upsert) exceeds 1 MiB by itself, the replacing snapshot is only larger (the same row is in the tail window) and makes the client replace wholesale and drop paged-in history rows, so the turn navigator re-paginates everything; in long sessions every turn loops (measured host CPU 100%, 15 s+ per turn). When the snapshot is not smaller than the buffer, degrading has cost and no benefit.
- Degrade only when the buffer is truly larger than the snapshot upper bound (e.g. a backlog of updates to many rows outside the tail window). The op limit is unchanged.

On either bound being exceeded, one atomic state transition runs:

```text
draining
   │ buffer > limit
   v
needsResync
   ├─ clear this subscription's delta buffer immediately
   ├─ discard the previously pending logical delta frame
   ├─ no further deltas
   └─ on onDrained/when sendable take only the latest authoritative snapshot
          │ snapshot written to transport
          v
draining (resume streaming after the new watermark)
```

The "discard" here happens before entering the RPC transport and is recovered by the snapshot; a physical frame the transport already accepted is never semantically discarded. If the connection stays saturated the publisher keeps only the `needsResync` flag and does not stack multiple snapshots.

## 4. TopicWireFrame: logical vs physical

`TopicFrame<S,D>` still expresses one atomically-applicable logical frame. Wire v3 uses the `TopicWireFrame` physical envelope:

```ts
type TopicWireFrame<S, D> =
  | {
      wireVersion: 3;
      kind: "complete";
      logicalFrameId: string;
      logicalFrameOrdinal: number;
      topic: string;
      subscriptionId: string;
      frame: TopicFrame<S, D>;
    }
  | {
      wireVersion: 3;
      kind: "fragment";
      logicalFrameId: string;
      logicalFrameOrdinal: number;
      topic: string;
      subscriptionId: string;
      fragmentIndex: number; // 0-based
      fragmentCount: number;
      logicalBytes: number; // UTF-8 byte count of the canonical logical JSON
      checksum: { algorithm: "crc32"; value: string }; // transport integrity, not security auth
      dataBase64: string; // current slice of the canonical logical bytes
    };
```

Normative limits:

1. Every physical JSON/RPC frame **including its full envelope** must serialize to `<= 1_048_576` UTF-8 bytes. The metered value is the maximum over three actual carriers: CLI NDJSON notification (including newline), Channel/Socket event binary, and the mobile relay `data.payload.rpc-frame` outer JSON (Channel bytes base64'd again).
2. The mobile relay is the strictest outer layer. The encoder must decide fragments with a real envelope meter/binary search; transport ids such as `bridgeSessionId/recoveryId` are up to 256 chars, metered with that limit and worst-case numeric widths.
3. The encoder must compute envelope overhead first and then the `dataBase64` slice length; never cut a 1 MiB payload first and wrap it afterwards.
4. A normal delta logical frame is bounded by the subscriber buffer byte limit: usually `<=1 MiB` sends `complete`; a single large delta pushing the buffer over 1 MiB (but not over the snapshot upper bound) fragments like an oversized snapshot.
5. An oversized snapshot or resume logical frame uses `fragment`; a fragment changes only physical carriage, not `(fromSeq,toSeq]` or apply semantics.
6. One logical frame has at most `1_024` fragments; schema, encoder and reassembler must all fail closed to avoid a forged `fragmentCount` triggering unbounded missing-index/assembly allocation.
7. The publisher assigns each subscription a strictly increasing `logicalFrameOrdinal` starting at 1; retrying the same reservation keeps ordinal and id unchanged. A late wire below the admitted ordinal is silently dropped; the same ordinal with a different `logicalFrameId` is a typed protocol fault.
8. All fragments of one logical frame must share `logicalFrameId/logicalFrameOrdinal/topic/subscriptionId/fragmentCount/logicalBytes/checksum`.
9. The encoder may slice in the middle of a code point of the logical UTF-8 byte stream; each slice is valid base64 independently and the client must first join the original bytes and then UTF-8 decode once; per-slice text decoding is forbidden.

## 5. Assembly atomicity and the 16 MiB limit

The client keeps one active assembly per `(topic, subscriptionId)` and identifies a logical frame by `(logicalFrameOrdinal, logicalFrameId)`; maxima:

```ts
const MAX_LOGICAL_ASSEMBLY_BYTES = 16 * 1_048_576;
const MAX_LOGICAL_ASSEMBLY_FRAGMENTS = 1_024;
const MAX_CONCURRENT_ASSEMBLIES = 32;
const MAX_STAGED_DECODED_BYTES = 32 * 1_048_576;
const ASSEMBLY_TIMEOUT_MS = 30_000;
```

```text
fragment 0 ─┐
fragment 2 ─┼─> staging assembly (store unchanged)
fragment 1 ─┘        │
                     ├─ all fragments + bytes + checksum correct ─> parse/schema validate ─> atomic apply
                     └─ missing/conflict/over limit/validation failure ─> drop whole assembly ─> resync
```

Always forbidden: applying a partial snapshot first, treating a fragment as an independent seq frame, truncating after assembly overflow, merging after a checksum failure.

The incremental assembler base64-decodes each fragment once, accumulates in fixed fragment slots and concatenates once at the end (O(n) overall). The timeout counts from the first fragment and duplicates do not extend it. Completion, fault, timeout and consumer fail-closed abort must all keep that route's ordinal tombstone until unsubscribe/generation cleanup (a late old fragment must never resurrect). A higher ordinal can evict the old active assembly; a later lower ordinal cannot supersede in reverse. An identical duplicate fragment is a no-op; a conflicting duplicate releases the assembly and raises a typed fault. A new `logicalFrameId` on the same `topic/subscriptionId` closes the old assembly explicitly with `proto.frameAssemblySuperseded`; exceeding concurrency, total staging budget or the single-logical limit fails closed, never silently evicting a healthy assembly.

When admitting new input/attachments would push the transmittable authoritative projection over 16 MiB, the CLI must explicitly return `rejected` or `failed` before admission (`proto.payloadTooLarge` or the matching fault). Large tool/model output produced while running must not fall back on truncating the whole snapshot: tool output becomes an artifact ref keeping the protocol's head/tail, and model text that still exceeds the limit terminates the turn with an explicit protocol fault. No path may produce an untransmittable half authoritative state.

## 6. Gap and automatic resync

`v4/conversation/resync` is a production path, not a test helper:

```ts
interface ConversationResyncParams {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}
```

Triggers: seq gap, fragment assembly failure, publisher overflow and transport rebuild. Client rules:

1. `toSeq <= localSeq` is silently dropped.
2. The first gap starts only one resync; no duplicate request while in flight.
3. A second gap after resume upgrades to `forceSnapshot=true`.
4. After attachment rebuild or CLI epoch change, automatically re-subscribe; the old stream is not received before the new subscriptionId takes effect.
5. A snapshot replaces wholesale after full assembly; the store is unchanged until all fragments arrive.
6. `proto.frameAssemblyInvalidPayload` (schema rejection) is a **deterministic content failure** and does not take the transient ladder of rules 2/3: send one `forceSnapshot=true` directly, and if still content-rejected, stop and write `fault.subscription.contentRejected`. Full semantics: 04-sync-and-recovery closed rule 11.

## 7. Mobile raw RPC physical envelope

The topic wire's 1 MiB promise cannot replace the mobile raw Channel transport's own physical boundary. 04D-3 switched desktop main and mobile web atomically to the shared acknowledged adapter: before entering the external relay, a Channel message must be encoded as the following transport-only payload; the global app parser accepts only the new strict fragment/ACK, and the legacy single-piece `rpc-frame` is no longer a production compatibility branch. The relay continues to treat it as an opaque `data.payload`:

```ts
type WebRemoteControlRpcTransportPayload =
  | {
      zcode_type: "rpc-frame";
      bridgeSessionId: string;
      bridgeGeneration?: number;
      recoveryId?: string;
      seq: number; // physical fragment seq
      messageSeq: number; // raw Channel message seq
      fragmentIndex: number; // 0-based
      fragmentCount: number;
      messageBytes: number;
      checksum: { algorithm: "crc32"; value: string };
      dataBase64: string;
    }
  | {
      zcode_type: "rpc-frame-ack";
      bridgeSessionId: string;
      bridgeGeneration?: number;
      recoveryId?: string;
      ackMessageSeq: number;
    };
```

Normative boundaries:

- The schema must be strict; extra fields, non-safe integers, invalid transport id/base64/checksum are all rejected.
- `bridgeSessionId/recoveryId` are at most 256 JSON-safe ASCII characters.
- The encoder meters the final, uncompressed `{type:"data",payload,client_ts,server_ts}` JSON in real UTF-8 and decides decoded chunk size by binary search; transport ids and numbers are metered at the protocol maximum width.
- Every final relay JSON is `<=1_048_576` bytes; a raw logical Channel message is `<=16 MiB` and `<=64` fragments.
- The receiver allows one active raw message assembly per direction, with a 30s timeout from the first fragment; a payload whose identity mismatches is rejected before occupying/advancing an assembly.
- A same fragment duplicate of the active/last-settled message is a no-op; a conflicting duplicate, physical gap, metadata/length/base64/CRC mismatch or over-limit all yield a typed transport fault; an earlier physical seq is a no-op by the cumulative delivery watermark and is never delivered twice. Logical bytes are delivered atomically once only after all fragments validate.
- Once `seq/messageSeq` reaches `Number.MAX_SAFE_INTEGER` only the current single piece/message may close out; any new fragment or message demands a new bridge generation through a typed exhaustion fault (no wraparound or accumulation on unsafe integers).

A raw `rpc-frame-ack` only confirms that a complete Channel message was handed to the peer's parser/enqueue. It is not a V4 command ACK and cannot prove input admission, clear the pending-command registry or replace topic resync. While the first message is not completely delivered, an active duplicate returns only a no-op and produces no wire ACK; only when a completed message exists is the latest positive cumulative `ackMessageSeq` resent.

### 7.1 Production acknowledged adapter

One adapter carries TX replay for one direction and RX assembly for the other and still holds only transport facts. Desktop main and mobile web connect the owning bridge's MessagePort/Channel straight to it:

```text
Channel send(raw)
  -> encode immutable physical batch
  -> reserve exact final outer bytes before first send
  -> local transport accepts frames
  -> wait cumulative rpc-frame-ack

rpc-frame fragments
  -> one-message assembler
  -> complete + synchronous Channel delivery succeeds
  -> queue latest cumulative ACK (ACK always flushes before data)
```

1. TX first runs admission on the whole batch's final relay JSON bytes, then reserves the immutable batch. `send=false` does not change `seq/messageSeq`; same-bridge resume replays from the first fragment of the un-ACKed batch and does not refresh the oldest reservation time.
2. The transport creates each payload's immutable final relay JSON exactly once; `measureFrameBytes` and `sendFrame` reference the same serializer/cache and un-ACKed replay reuses the same byte string (never meter one JSON and send another, nor change the ledger through timestamp drift).
3. `unacknowledgedBytes` is the final uncompressed outer JSON bytes of all batches not cumulatively ACKed; default high/low `1 MiB / 256 KiB`, notifying once on each state edge `> high` and `<= low`.
4. Replay is bounded by both `8 MiB` and `45s` after the first un-ACKed message; crossing a bound before sending half a logical message enters typed degraded. The reserve/flush/replay entries and every physical payload send must synchronously check age (not relying only on timer callbacks). The RX `30s` assembly deadline after the first fragment is independent and duplicates do not renew it.
5. `8MiB / 45s / 30s` are hard upper bounds; test or caller options may only tighten them.
6. ACK `K` releases all `messageSeq <= K` at once; an older ACK is a no-op; a messageSeq beyond "the whole batch's physical frames accepted by the local transport" is a typed fault. The ACK payload itself does not enter replay accounting.
7. Complete bytes may queue an ACK only after the synchronous `onMessage` delivery returns normally; a delivery throw, fragment fault, future ACK, byte/age overflow each trigger exactly one terminal degraded.
8. The queued ACK keeps only the largest positive cumulative value and takes priority over data flush; the first pending ACK is also subject to the 45s age deadline and a later higher cumulative value does not renew it. A send callback may re-enter ACK synchronously; the adapter must process this re-entrancy serially without misjudging a future ACK or deleting the batch being sent.
9. New bridge identity, terminal degraded and dispose clear old timers, assembly references, pending ACK and unacked batches; no automatic replay across bridge generations.

## 8. Connection flow control

The transport exposes a read-only congestion interface:

```ts
interface ConnectionFlowControl {
  readonly unacknowledgedBytes: number;
  onSaturated(listener: () => void): Disposable;
  onDrained(listener: () => void): Disposable;
}
```

- `onSaturated`: pause that connection's publisher drain but keep coalescing within each subscription's own limits; a subscription over its limit turns `needsResync`.
- `onDrained`: resume drain fairly; `needsResync` subscriptions send one latest snapshot first and other subscriptions are not reset.
- The mobile relay passes the signal through to the shared-host attachment; relay/main hold no un-ACKed conversation events.
- A local MessagePort may degrade to a pass-through that is never saturated but still uses the same interface and owned routing.
- Port close must clean the connection registry, buffer, assembly and listeners.
- `PersistentProtocol` only declares that it structurally satisfies the public `ConnectionFlowControl`; production mobile does not switch to it.
- The production mobile flow edge uses a strict sideband all the way to the CLI, not entering Channel deserialize:

```text
raw adapter SAT/DRN
  -> desktop main owning MessagePortProtocol.sendFlowState
  -> host attachment MessagePort sideband (consumes control objects only)
  -> ZCodeAgentConnectionScope per-scope serial chain
  -> trusted v4/connection/flow {connectionId,state}
  -> CLI pausedConnections
  -> pause/resume only that connection's conversation/index/config subscriptions
```

- The sideband has only `saturated|drained`; the host adds one `closed` on port close. A terminal RPC caller cannot call the transport-control method directly; the remote trusted-host-relay keeps namespacing downstream connectionId unambiguously.
- `saturated` clears the connection's pending flush timer while ingest/coalesce continue; `drained` immediately drains only that connection, and `needsResync` subscriptions naturally get the latest snapshot first from the publisher; `closed` only clears the pause state (owned facade dispose still handles unsubscribe/registry cleanup).
- A fast SAT->DRN->close in one scope is serialized on a promise chain and duplicate states send no RPC; when already saturated, a new subscription syncs the current state to its trusted connection/workspace route immediately after the ACK.
- Desktop main's 50-item pending buffer keeps only small app payloads such as bootstrap/workspace/platform; `rpc-frame`/ACK replay ownership belongs exclusively to the adapter and never enters a second buffer.
- Both ends apply a hard `<=1 MiB` gate on raw UTF-8 bytes before `JSON.parse`. A permanent oversize and a temporary socket unavailable are different outcomes; oversize immediately yields a typed fault/hard bridge recovery and is never buffered repeatedly.
- When desktop tells mobile to rebuild the bridge it sends only the generic `bridge-degraded: rpc-transport-fault`; specific typed reasonCodes (checksum, gap, future ACK, oversize) go only to safe local logs and must not be disguised uniformly as frame gaps.

### 8.1 Attachment upload is not logical-frame fragmentation

Attachment bytes go through an independent business transaction; do not stuff 20 MiB `dataBase64` into one Channel/NDJSON request and expect the mobile raw adapter to re-fragment it (that constrains only the relay outer, not host->CLI NDJSON).

```text
UI high-level put(bytes)
  -> attachment/begin
  -> attachment/chunk x N       decoded <= 512 KiB / physical request <= 1 MiB
  -> attachment/commit
  -> artifact ref
```

1. The UI transport's default chunk is 384 KiB (divisible by 3, so base64 has no padding except the last chunk), leaving envelope room for workspace, Channel method/header and the trusted carrier; the protocol hard cap stays 512 KiB decoded.
2. Both the renderer->host Channel request and the host->CLI NDJSON request are metered on actual parameters; either exceeding 1 MiB is an immediate `proto.frameTooLarge`, never handed to a lower relay to split.
3. CLI staging holds only decoded bytes, under three hard limits: `20 MiB/upload`, active upload count and global staged bytes; a duplicate chunk keeps only the digest/existing bytes and is not double-accounted.
4. The trusted `connectionId` takes part in the upload key. `closed` clears that connection, `disposeSession` clears that session, TTL clears expired transactions, CLI restart clears naturally with process memory; none of these cleanups produces an artifact.
5. commit validates full chunk count, totalBytes and SHA-256 and writes the session artifact once; the artifact content keeps the existing provider-readable data-URL form, but that base64 is produced only inside the CLI memory/storage boundary and no longer crosses RPC. A successful result is kept as an idempotency tombstone so a retry after a lost commit ACK returns the same ref without writing twice.
6. abort is idempotent; an upload failure throws up the composer call stack and no command was committed yet, so text and attachments must be kept.

RPC ACK, heartbeat and short-disconnect replay only probe and switch the pipe: no in-place resend on a stuck TCP/ws; on a new socket the un-ACKed physical frames are replayed with the same msgId and the peer dedups. A long disconnect or crossing the grace window still returns to subscribe/resync.

## 9. Acceptance boundary

Protocol golden tests must mechanically cover at least:

- continuous/replayable intermediate frames differ while end states match field by field;
- the end state of a `workflowRunDeltas`-declaring subscriber equals the authoritative projection, and a non-declaring subscriber's equals the old whole-key encoding (after clamp); the same subscription's snapshot and continuing stream use the same clamp;
- buffer `500/501 ops`;
- physical JSON/RPC `1 MiB-1 / 1 MiB / 1 MiB+1`;
- mobile raw RPC 1/2/many-fragment atomic restore, duplicate tombstone, identity mismatch, `16 MiB/+1`, `64/65` fragments and the 30s timeout;
- multi-byte UTF-8 straddling exactly the boundary;
- fragments out of order, duplicate same fragment, missing fragment, field conflict, checksum failure;
- assembly exactly `16 MiB` and one byte over;
- only the latest snapshot after overflow;
- a single large delta over 1 MiB but within the snapshot upper bound keeps sending deltas (no wholesale replacement) and the client end state equals full replay; a buffer over the snapshot upper bound still degrades;
- two connections subscribing the same session: a slow mobile resync does not affect desktop, and the mobile link never carries a desktop `subscriptionId`;
- attachment 20 MiB exactly, 20 MiB+1 pre-admission reject, per-chunk Channel/NDJSON envelope `<=1 MiB`, and cleanup for empty/missing/future/duplicate-conflict/checksum/ACK-loss/abort/TTL/close/restart.

These boundaries are protocol correctness gates, not performance tuning.
