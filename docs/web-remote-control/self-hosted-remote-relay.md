# Self-hosted remote relay

The V1 design that this page used to describe (per-device `pass_hash`, `ZCODE_RELAY_STORAGE_KEY`,
encrypted SQLite) has been removed. The self-hosted relay now speaks Relay V2 only.

- Deployment, environment variables, identity modes (`zai-jwt` and `device-key`) and Railway steps:
  [`packages/remote-relay/README.md`](../../packages/remote-relay/README.md).
- Protocol and pairing flow: [`relay-v2-pairing.md`](./relay-v2-pairing.md).
- Design and decisions: `specs/relay-v2-migration.md` (identity modes in section 15).

## Open enrollment for public release builds

A relay in `device-key` mode can accept installs that hold no shared secret
(`ZCODE_REMOTE_RELAY_ENROLLMENT_MODE=open`). The client proves possession of its Ed25519 key and solves a
small proof of work issued by the relay; per-identity quotas, a global key cap and a rate breaker bound abuse.
Existing keys keep working when the breaker opens. Owner keys (enrolled with the secret) get 4x the quotas.

| Variable                                 | Default   | Meaning                                                |
| ---------------------------------------- | --------- | ------------------------------------------------------ |
| `ZCODE_REMOTE_RELAY_ENROLLMENT_MODE`     | `secret`  | `secret` (secret required) or `open` (secret optional) |
| `ZCODE_RELAY_ENROLLMENT_DIFFICULTY`      | 22        | Leading zero bits of the PoW (8 to 32)                 |
| `ZCODE_RELAY_MAX_ENROLLED_KEYS`          | 10000     | Open-tier key cap; reaching it opens the breaker       |
| `ZCODE_RELAY_ENROLLMENTS_PER_HOUR`       | 300       | Open enrollments per hour before the breaker opens     |
| `ZCODE_RELAY_MAX_SOCKETS_PER_IDENTITY`   | 8         | Live WebSockets per identity (owner 4x)                |
| `ZCODE_RELAY_BYTES_PER_IDENTITY_PER_DAY` | 536870912 | Inbound bytes per identity per UTC day (owner 4x)      |
| `ZCODE_RELAY_KEY_IDLE_EXPIRY_DAYS`       | 30        | Open keys idle this long are deleted                   |

Behind Railway (or any proxy) set `ZCODE_RELAY_TRUSTED_PROXIES` to the proxy addresses, otherwise every client
shares one anonymous rate-limit bucket. The release build bakes only the mode
(`ZCODE_WEB_REMOTE_CONTROL_RELAY_IDENTITY_MODE=device-key`), never a secret. Event order, wire format and
acceptance scenarios: `specs/relay-v2-migration.md` section 15.6.
