# MessagePort RPC: check binary payloads before control objects

Status: implemented (2026-10-18). Found by the desktop performance pass and verified with an interleaved A/B benchmark against a per-metric noise floor; the numbers are in the pull request description.

## Problem

`MessagePortProtocol` (`packages/rpc/src/protocol.ts`) carries every RPC message between the renderer and the Host as a `Uint8Array`, plus rare connection-flow control objects (`{ __zcodeRpcControl: "connection-flow-v1", state }`). Its message handler first calls `isMessagePortFlowControl(e.data)` and only then checks `e.data instanceof Uint8Array`.

`isMessagePortFlowControl` calls `Object.keys(record)` on any non-array object. A `Uint8Array` is such an object, and `Object.keys` on it allocates one string per byte. Every binary RPC message therefore costs time and garbage proportional to its size before it is delivered.

Measured in the renderer CPU profile of the benchmark's S4 phase (20 task switches across seeded sessions; E2E production build): `isMessagePortFlowControl` has 418 ms self time, the largest JavaScript self time in the phase. The actual delivery under the same handler takes about 120 ms. GC adds 117 ms.

## Product rule

A binary payload (`ArrayBuffer` view) is never treated as a control object, and the check must not enumerate its contents. Control-object semantics are unchanged: only an object with exactly the two keys `__zcodeRpcControl: "connection-flow-v1"` and `state: "saturated" | "drained"` is a control message. Forged or unknown objects are still dropped, and only `Uint8Array` reaches `onMessage`.

## State owners and interfaces

- Owner: `MessagePortProtocol` in `packages/rpc`. No change to `MessagePortPayload`, the wire format, the flow-control state machine, or any caller.
- Both ends (renderer and Host) use the same class, so both get the fix.

## Acceptance scenarios

1. Unit (`packages/rpc/test/messagePortBinaryFastPath.test.ts`): delivering a large `Uint8Array` never calls `Object.keys` on it, and the payload still reaches `onMessage` unchanged.
2. Unit: a valid control object still fires `onFlowState`; a forged control object and a plain object fire nothing. The existing test in `packages/rpc/test/protocol.test.ts` still passes.
3. Benchmark A/B (desktop performance benchmark, E2E production build): S4 renderer script time or CPU improves beyond its noise floor, and no gating metric regresses.
