# web-remote-relay

Relay V2 message, HTTP and connection-lifecycle rules.

`contract.ts` is the wire schema and error classification. `domain/` only computes
backoff and heartbeat intervals and the open-enrollment proof-of-work layout
(`enrollmentPow.ts`, shared with the self-hosted relay). `adapters/` owns the timers:
each transport owns its retry and heartbeat, and stop clears both. Do not log JWTs or
tokens, and do not hold task or workspace state here.

The protocol is V2 only: there is no HMAC proof, pass-hash challenge or proof vector.
Legacy `hash` and `t` QR parameters are rejected by the QR parser. The contract does not
provide end-to-end encryption.

Full semantics: [Relay V2 spec](../../../../docs/web-remote-control/relay-v2-pairing.md).
