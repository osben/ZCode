# Process Topology: Connection Isolation and CLI Authoritative Facts

> Current fact (V4 wire v3): desktop and mobile share one session/runtime fact source but have isolated connections, subscriptions and delivery policies. The relay, desktop main and renderer are not conversation fact sources.

## 1. One fact chain, two delivery boundaries

```text
Desktop renderer / SSH/WSL/Docker window
  attachment A
  { connectionId=A, clientMode=desktop-continuous }
  profile=continuous
          │
          │ owned subscriptions only
          v
┌──────────────────────── Host process ────────────────────────┐
│ connection-scoped service facade                            │
│   A registry: sub-a1, sub-a2                                │
│   B registry: sub-b1                                        │
│   route(frame) -> attachment port of owner(subscriptionId)  │
│                                                              │
│ owner / lease / stale-run: cross-host command and blocking   │
│   request routing only                                       │
│ relay/main: auth, pairing, heartbeat, payload/congestion     │
│   signal passthrough                                         │
└──────────────────────────┬───────────────────────────────────┘
                           │ stdio / @zcode/protocol-v4
                           v
┌──────────────────────── CLI runtime ─────────────────────────┐
│ event log -> Projection -> per-subscriber publisher          │
│ CommandInbox FIFO -> queue/guided row/transcript             │
│ transcript / marker / child metadata: sourceCommandId        │
└──────────────────────────────────────────────────────────────┘
                           ^
                           │ shared-host attachment (no separate runtime)
Mobile / Web remote        │
  attachment B             │
  { connectionId=B, clientMode=web-remote-replayable }
  profile=replayable
```

One session can be subscribed by A and B at once. Intermediate frames may differ by profile, but the final projection must match field by field; slow consumption, resubscription or closing on one side must never replace or pollute the other.

## 2. Trusted connection context

When an RPC attachment is established, the host creates an unforgeable connection context:

```ts
interface TrustedConnectionContext {
  connectionId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryProfile: "continuous" | "replayable";
}
```

The mapping is a fixed product boundary, never guessed from UI parameters or the underlying socket type:

| attachment                                  | trusted `clientMode`    | profile      |
| ------------------------------------------- | ----------------------- | ------------ |
| Local desktop window                        | `desktop-continuous`    | `continuous` |
| SSH / WSL / Docker desktop window           | `desktop-continuous`    | `continuous` |
| Mobile `/remote` shared-host attachment     | `web-remote-replayable` | `replayable` |
| Web remote / relay WebSocket                | `web-remote-replayable` | `replayable` |

`zcode-server /ws` always uses replayable for ordinary connections; even a caller sending the old `x-zcode-rpc-client-mode` header cannot upgrade the connection to continuous. A desktop server-remote Node host must first request a short-lived, single-use random capability from `POST /api/rpc-host-capability` (protected by the existing server auth middleware), then put it into a Node-only header to connect the dedicated `/ws/host`. Only after the server consumes the capability does it create a continuous trusted relay attachment, still allocating a fresh `connectionId`. An open/no-token server follows the same explicit request and single consumption; forging a role header alone, or replaying a capability, never yields the trusted role.

```text
Desktop Node host
  │ POST /api/rpc-host-capability (existing server auth)
  v
short-lived capability ── first use ──> GET /ws/host ──> continuous trusted relay
       │                                    │
       └─ expired / replayed: rejected      └─ server generates connectionId

Browser / any ordinary client
  └─ GET /ws (old mode header ignored) ──────> replayable terminal
```

`hello/clientHello` only completes wire v3 negotiation, connection identity confirmation and telemetry identity registration. The client may report a stable `clientId`, version and a display-purpose `clientKind` but cannot override the host-injected `connectionId/clientMode/profile`. UI-facing `subscribe` no longer accepts `deliveryProfile` or `clientMode`.

Remote workspace connections, subscriptions, commands and caches carry `workspaceIdentity` and `remoteSessionId` end to end. The identity key is always `workspaceIdentity?.trim() || workspacePath`; only file IO and process cwd use `workspacePath`.

## 3. Connection-scoped subscription registry

The host keeps an independent registry per attachment, with minimal indexes:

```text
connectionId -> subscriptionId -> { topic, profile, visibility, state }
subscriptionId -> owning attachment port
```

Normative rules:

1. Resubscribing the same topic on one connection replaces only that connection's old subscription; different connections never replace each other.
2. A CLI downstream frame may be written only to the port owning that `subscriptionId`. No workspace broadcast followed by mobile dropping desktop frames by subId.
3. When an attachment port closes, handshake fails or the connection is reclaimed, the facade must unsubscribe all subscriptions of its registry at once and release fragment assembly and buffers.
4. On attachment rebuild or CLI runtime epoch change, the client automatically resubscribes with the current valid base; an epoch mismatch goes to snapshot.
5. `onSaturated/onDrained` are connection-level flow-control signals. The mobile link may pass them through relay/main to the owning attachment, but relay/main never interpret topic, seq, queue or snapshot.
6. Before sending subscribe, establish pending ownership; the server puts the initial frame into a request-scoped post-response outbox, and the connection writes NDJSON strictly as `response -> initial notification`. Even when both lines arrive in one read, early host/UI/task-index frames before the ACK only enter bounded staging; once the ACK binds `subscriptionId` they are released to the unique owner in original order; close / stale generation clears references. A task-index overflow clears that generation's staging and marks recovery-needed; the physical staging overflow fault semantics of host/UI stay in 04B. The UI transport must also wait until the store has written `subscriptionId` and explicitly activated before delivering.
7. unsubscribe must build a full `{ topic, subscriptionId, connectionId }` route from the owned registry entry; the CLI publisher deletes only subscriptions matching all three, never broadcasting a bare `subscriptionId` across topics.

## 4. Ownership of authoritative state

| State                                   | Sole authoritative location                          | Other layers' role                                  |
| --------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| session event log / projection          | CLI                                                  | host only routes and bounded-buffers; UI applies    |
| Committed busy/running input            | CLI `CommandInbox` / runtime queue                   | UI keeps only the optimistic overlay                |
| Uncommitted draft, scroll position      | Current client                                       | Not part of protocol facts                          |
| command idempotency result              | CLI LRU + transcript/marker/child + discarded ledger | UI 24h pending registry used for reconciliation     |
| subscription buffer / fragment assembly | Per connection/subscriber volatile state             | Dropped on close, recovered by resync               |
| owner / lease / stale-run               | host routing layer                                   | Guarantees single owner, blocking responses and correct cross-host commands |

Mobile V4 no longer goes through the host runtime command queue. All committed input, from desktop or mobile, enters the same `CommandInbox` FIFO in CLI serial admission order. owner/lease must not be deleted because the shared-host main path exists: remote workspaces, bot/proxy, cross-host fallback and blocking requests still depend on it, but it no longer owns a second conversation queue.

## 5. Fork process boundary

When running, forking an earlier stable assistant copies, inside the CLI only, the stable transcript, fork-point config and the goal state before the fork point:

```text
parent runtime (keeps running) ── stable boundary ──> child transcript
shared workspace             ── no rewind / no checkpoint copy ──> shared as-is
parent queue/active/background/continuation ──X──> child
```

The workspace checkpoint behavior of completed/idle fork is not widened. A running fork does not enter the legacy bridge with `ensureNoActiveTurn`.

## 6. Three implementation gates

Delivered in dependency order; a later gate must not ship by bypassing an earlier one:

1. **Connection, subscription, frame and recovery**: trusted attachment context, owned routing, 1 MiB physical frame, subscriber buffer and automatic resync.
2. **Authoritative input, queue and idempotency**: unified CLI FIFO, `ConversationInputIntent`, `commands/query`, `sourceCommandId` and discarded reconciliation.
3. **Stable assistant fork**: the single target resolver, running conversation-only fork and duplicate child closeout.

Final invariant: every committed input must be in exactly one of `queue / guided row / transcript / explicit rejected|failed|discarded`; "UI cleared but no CLI authoritative record" must never occur.
