# zcode-rs: work segments of a turn with guided steers (`workSegments`)

When the user sends a guide (steer) message while a turn runs, Node splits the turn into work segments. The turn header
row gets `workSegments`, so the UI gives the steer its own work section, its own "worked for" time and its own
collapse state (`packages/ui/src/v4/conversationTurnWorkSegments.ts`, `conversationTurnRenderUnits.ts`). zcode-rs
appended the guided user row but wrote no segments, so the steer was merged into one block.

Node reference: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
(`openGuidedWorkSegment`, `completeWorkSegments`, `guideDrainOpen`). Schema: `turnWorkSegmentSchema` and
`turnHeaderRowSchema.workSegments` in `packages/shared/src/zcode-protocol-v4/rows.ts`.

## Rules

1. Owner: the projection (`packages/rust-cli/crates/protocol-zcode/src/projection/guide_segments.rs`). The segments
   live on the turn header row itself, so rows, `row.upserted` deltas and the snapshot window always agree. No other
   state holds them.
2. Absent until a guide: a turn without a guided steer has no `workSegments` key (Node writes the field only once a
   guide opened a segment). It is never an empty array.
3. First steer of a turn: the header gets two segments. The first is `{segmentId: "<turnId>:initial", startedAt:
   <header startedAt>}`, closed at the steer's time. The second is `{segmentId: <steer entityId>, triggerEntityId:
   <steer entityId>, startedAt: <steer time>}`, left open. The steer entity id is the stored message id of the
   attachment, the same id the guided `userInput` row carries.
4. Each later steer closes the open last segment and appends its own, the same way.
5. Closing a segment sets `endedAt = time` and `activeMs = max(0, endedAt - startedAt)`.
6. Steers absorbed with no model step between them share one segment. A model step is a streamed delta of a reply or a
   stored assistant message (Node: main-model stream event or `ModelComplete`). The flag `guide_open` on the live turn
   remembers that a steer opened a segment; a model step clears it; a new turn starts cleared.
7. Turn end (`finish_turn`, success, interrupted or failed): the open last segment is closed at the end time. A header
   without segments stays without.
8. A control-only turn (`executionKind: "controlOnly"`) never gets segments.
9. A steer message already projected (same key) opens nothing.

## Event order

A steer message arrives as `MessageDone(Attachment)`. The projection emits, in this order: `row.upserted` of the
turn header (with the new `workSegments`, only when a segment opens), then `row.appended` of the guided `userInput`
row. This is Node's order. The closing header update at turn end carries the closed last segment.

```
TurnStarted        -> header (running, no segments)
user, assistant    -> rows
steer (1st)        -> header upserted [initial closed, steer open], user row appended
steer (same drain) -> user row appended
reply stream/done  -> guide_open cleared
steer (next)       -> header upserted [.., closed, new open], user row appended
TurnFinished       -> header upserted (state, endedAt, activeMs, last segment closed)
```

## Cold projection

Node restores segments on cold hydration by replaying the stored history through the same projection: each stored guide
message becomes a `TurnSteerDrained` event and each assistant message a model-step event
(`transcript-hydration.ts`), so live and cold produce the same segment ids. zcode-rs does the same: the cold path
(`projection/cold.rs`) feeds stored steer attachments and assistant messages through `Projection::message`, which is
the code the live path uses. The same segment ids come out.

## Divergences

1. Cold timing: a cold read has no per-message time in zcode-rs (every row takes the session creation time), while
   Node uses each message's creation time. A cold segment therefore starts and ends at the session creation time with
   `activeMs: 0`. The ids, trigger ids and order match Node.
2. Sessions Node wrote: node-records reads a Node guide message (`metadata.turnSteerDelivery: "guide"`) as an ordinary
   typed user message, which opens a turn of its own. Such a session shows no segments in zcode-rs until the reader maps
   that message to a steer attachment. Not changed here; the mapping belongs to `node-records`.
3. A model step that stores no visible content (Node synthesizes a start event for it) is invisible to zcode-rs when
   no reply is stored for it. Two guides separated only by such a step share one segment in zcode-rs and get two in
   Node.

## Tests

`projection/guide_segments_tests.rs`: one guide gives two segments with the right trigger and timing; two guides
with a reply between give three; guides drained together share one; a streamed reply opens a new segment; no guide
means no key; control-only turn has none; a repeated steer opens nothing; delta header equals snapshot header; cold
read restores the segments; cold turn without a guide has none.
