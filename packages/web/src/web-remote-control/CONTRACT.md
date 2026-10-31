# web-remote-control

Mobile remote control admission, device list, transport, and read-only pages.

The entry operates external state through the auth/HTTP/location/storage ports. The contract's device grouping and cached display types do not depend on any implementation. The entry's AbortSignal controls the current navigation; the transport's socket/generation controls the connection. It only extracts frame parsing and independent request correlation, and does not create a second recovery owner. Main/Host/CLI continue to own business state; the phone remains replayable.

The bootstrap request only reads the response. After the version guard validates the current request generation and version, it synchronously commits acceptance side effects such as the view epoch through `onAccepted`. Responses that are stale, released, or version-mismatched must not produce that side effect.

Invalidation notices are consumed idempotently by bridge identity; the raw adapter's first degraded transition is the only recovery entry.
A selected task that is recovering is not lost when the bootstrap workspace candidates omit it. An absent target is verified through the existing Host task navigation, a candidate that is clearly offline keeps disconnect semantics, and a draft without a taskId never enters task navigation. An old remoteSessionId must not be cached.
The recovery rules above require an explicit preferredWorkspaceKey. A cold start and a full page refresh reuse the initial selector; when the previous navigation target is absent or offline, a bridge-capable workspace is preferred, and no Host task navigation is started for an absent target.

The RPC client of each bridge is bound to the lifecycle signal of its acknowledged adapter. degraded and dispose end in-flight and not-yet-initialized calls, and late replies become invalid. A pending, briefly disconnected or replayed state of the same bridge does not revoke the signal.
An uncommitted draft is recovered by the existing Composer failure handling; registered commands keep being reconciled by query and snapshot.

For the full semantics, see the [Relay V2 spec](../../../../docs/web-remote-control/relay-v2-pairing.md).
