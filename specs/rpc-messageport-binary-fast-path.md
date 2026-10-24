# MessagePort RPC: check binary payloads before control objects

`MessagePortProtocol` (`packages/rpc/src/protocol.ts`) carries every RPC message between the renderer and the Host as a `Uint8Array`, plus rare connection-flow control objects (`{ __zcodeRpcControl: "connection-flow-v1", state }`). Its message handler checks `isMessagePortFlowControl(e.data)` first; that function calls `Object.keys(record)` on any non-array object, and a `Uint8Array` is one — allocating one string per byte. Every binary RPC message therefore costs time and garbage proportional to its size before it is delivered.

## Product rule

A binary payload (`ArrayBuffer` view) is never treated as a control object, and the check must not enumerate its contents. Control-object semantics are unchanged: only an object with exactly the two keys `__zcodeRpcControl: "connection-flow-v1"` and `state: "saturated" | "drained"` is a control message. Forged or unknown objects are still dropped, and only `Uint8Array` reaches `onMessage`.

## State owners and interfaces

- Owner: `MessagePortProtocol` in `packages/rpc`. No change to `MessagePortPayload`, the wire format, the flow-control state machine, or any caller.
- Both ends (renderer and Host) use the same class, so both get the fix.

## Acceptance scenarios

1. Unit (`packages/rpc/test/messagePortBinaryFastPath.test.ts`): delivering a large `Uint8Array` never calls `Object.keys` on it, and the payload still reaches `onMessage` unchanged.
2. Unit: a valid control object still fires `onFlowState`; a forged control object and a plain object fire nothing. The existing test in `packages/rpc/test/protocol.test.ts` still passes.
3. Benchmark A/B (desktop performance benchmark, E2E production build): S4 renderer script time or CPU improves beyond its noise floor, and no gating metric regresses.
