# web-remote-control

Mobile remote control admission, device list, transport, and read-only pages.

The entry operates external state through the auth/HTTP/location/storage ports. The contract's device grouping and cached display types do not depend on any implementation. The entry's AbortSignal controls the current navigation; the transport's socket/generation controls the connection. It only extracts frame parsing and independent request correlation, and does not create a second recovery owner. Main/Host/CLI continue to own business state; the phone remains replayable.

The bootstrap request only reads the response. After the version guard validates the current request generation and version, it synchronously commits acceptance side effects such as the view epoch through `onAccepted`. Responses that are stale, released, or version-mismatched must not produce that side effect.

For the full semantics, see the [Relay V2 spec](../../../../docs/web-remote-control/relay-v2-pairing.md).
