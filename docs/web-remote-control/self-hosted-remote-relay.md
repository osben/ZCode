# Self-hosted remote relay

The V1 design that this page used to describe (per-device `pass_hash`, `ZCODE_RELAY_STORAGE_KEY`,
encrypted SQLite) has been removed. The self-hosted relay now speaks Relay V2 only.

- Deployment, environment variables, identity modes (`zai-jwt` and `device-key`) and Railway steps:
  [`packages/remote-relay/README.md`](../../packages/remote-relay/README.md).
- Protocol and pairing flow: [`relay-v2-pairing.md`](./relay-v2-pairing.md).
- Design and decisions: `specs/relay-v2-migration.md` (identity modes in section 15).
