# desktop-web-remote-relay

Isolates Main's HTTP, storage, and device WebSocket from manager assembly.

Only index.ts and contract.ts are consumed externally. The manager remains the sole owner of window runtimes and attachments; the transport is the sole owner of the socket and generation. Storage persists only non-sensitive identity: clearLegacy coalesces concurrent calls and is retryable on failure. Credentials are read from injected ports, and HTTP errors return only a classification.

Full semantics: [Relay V2 spec](../../../../../docs/web-remote-control/relay-v2-pairing.md).

## Notification reporting owner

MobilePushConnection manages HTTP notification eligibility, execution ownership, and single-shot reporting per account and environment; it does not establish a WebSocket for notifications. The remote-control transport is held independently by each window runtime and is unrelated to notifications. Notifications and remote control share the persistent device registration owner. Switching accounts or environments aborts old requests and clears execution ownership; repeated logins to the same account do not clear it. After an event attempt, deduplication is kept in memory with no retry and no backfill. GET status negotiates HTTP capability; POST events returns a processing receipt, and a receipt does not mean the phone received the notification.
