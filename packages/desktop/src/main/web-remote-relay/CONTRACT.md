# desktop-web-remote-relay

Isolates Main's HTTP, storage, and device WebSocket from manager assembly.

Only index.ts and contract.ts are consumed externally. The manager remains the sole owner of window runtimes and attachments; the transport is the sole owner of the socket and generation. Storage persists only non-sensitive identity: clearLegacy coalesces concurrent calls and is retryable on failure. Credentials are read from injected ports, and HTTP errors return only a classification.

Full semantics: [Relay V2 spec](../../../../../docs/web-remote-control/relay-v2-pairing.md).
