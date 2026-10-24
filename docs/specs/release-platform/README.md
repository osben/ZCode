# Release Platform Contract

Entry point of the v1 contract between z-code and the standalone packaging platform.

| File                                                                                                           | Purpose                                                          |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`release-candidate.v1.schema.json`](./release-candidate.v1.schema.json)                                       | Machine-validated schema for release candidates and platform artifacts |
| [`release-platform.v1.openapi.yaml`](./release-platform.v1.openapi.yaml)                                       | OpenAPI 3.1 description of the control-plane REST API            |
| [`release-platform-api-v1.md`](./release-platform-api-v1.md)                                                   | State machine, validation rules, errors, events, security and migration constraints |
| [`docs/adr/0004-release-packaging-platform-contract.md`](../../adr/0004-release-packaging-platform-contract.md) | Why the platform hosts candidate state and official publishing   |

## Required Before v1 Implementation

1. Include `release-candidate.v1.schema.json` in the platform server and worker contract tests.
2. Compute the notes revision uniformly as `sha256:<hex>` over RFC 8785 JCS.
3. Adapt the current runner shared directory to an object-storage candidate prefix; the shared directory must not enter the platform API.
4. The platform server must re-read objects and verify size, SHA-256, SHA-512 and the base update YAML.
5. The publish endpoint must implement idempotency, auditing and `publish_failed_retryable` retry.

`release:approve` and the runner shared directory in the current z-code are migration-period compatibility paths, not the final state source of platform v1; the repo no longer generates a separate `candidate-manifest.json`.
