# ZCode Packaging Platform API and Contract v1

- Status: Proposed
- Version: `release-platform.v1`
- Date: 2026-08-18
- Applies to: z-code build workers, the packaging platform control plane, the approval UI, the publishing service

## 1. Goals and Non-goals

Goal: make z-code a replaceable build worker and the packaging platform the single source of state for release candidates. The contract does not prescribe PostgreSQL, queues, object storage or a web framework; it defines only the cross-system observable and retryable boundary.

Non-goals: changing the Electron auto-update protocol into a new client protocol; requiring the platform to take over release-it version calculation in the first version; letting workers write the stable feed directly.

## 2. Resource Model

### 2.1 ReleaseCandidate

Full JSON Schema: [`release-candidate.v1.schema.json`](./release-candidate.v1.schema.json). Key fields:

| Field                     | Meaning                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `candidateId`             | Platform-generated immutable candidate identity, format `cand_...` |
| `source`                  | repository, full commit, SemVer version, optional ref              |
| `state`                   | Current state of the platform state machine                        |
| `platforms`               | Per OS/arch artifacts and base update metadata                     |
| `provenance`              | builder, image, tool versions and signer                           |
| `createdAt` / `expiresAt` | Candidate retention period                                         |

The source of truth for candidate artifacts is the object-storage `objectKey` and digest, not a runner path, a GitLab artifact URL or a shared workspace directory.

### 2.2 NotesDraft and Approval

Notes are versioned independently of candidate artifacts:

```json
{
  "candidateId": "cand_01J...",
  "revision": "sha256:...",
  "locales": {
    "zh-CN": { "markdown": "# Release ..." },
    "en-US": { "markdown": "# Release ..." }
  },
  "status": "approved",
  "approvedBy": { "userId": "u_123", "displayName": "Reviewer" },
  "approvedAt": "2026-08-18T14:00:00Z"
}
```

1. `approvedBy` and `approvedAt` are written by the platform from the current authenticated identity; a worker's self-reported request-body values are not trusted.
2. Modifying notes produces a new `revision`; an old revision is never overwritten in place.
3. `revision` is computed as: normalize each locale's Markdown to UTF-8 with LF line endings and trim leading/trailing whitespace; build an object keyed by locale in lexicographic order; serialize with RFC 8785 JSON Canonicalization Scheme; take SHA-256 hex, formatted `sha256:<64-hex>`. Different language runtimes then cannot produce different revisions from JSON key order.

### 2.3 Publication

A publication binds one candidate's artifacts to one approved revision:

```json
{
  "publicationId": "pub_01J...",
  "candidateId": "cand_01J...",
  "notesRevision": "sha256:...",
  "channel": "gray",
  "state": "publishing"
}
```

The platform generates the final `latest.yml` containing `releaseNotesByLocale`, writes it to the official object path, and only then advances to `published`. It must not generate a separate per-locale update manifest.

## 3. State Machine

```text
created -> building -> ready -> approval_pending -> approved -> publishing -> published
             |             |             |              |
             v             v             v              v
        build_failed    cancelled      rejected   publish_failed_retryable
```

| Current state              | Allowed transitions                     | Triggered by          |
| -------------------------- | --------------------------------------- | --------------------- |
| `created`                  | `building`, `cancelled`                 | platform scheduler    |
| `building`                 | `ready`, `build_failed`, `cancelled`    | build worker callback |
| `ready`                    | `approval_pending`, `cancelled`         | platform              |
| `approval_pending`         | `approved`, `rejected`                  | approval API          |
| `approved`                 | `publishing`, `cancelled`               | platform              |
| `publishing`               | `published`, `publish_failed_retryable` | publisher             |
| `publish_failed_retryable` | `publishing`, `cancelled`               | retry API             |

A repeated request returns the current resource and never creates a duplicate candidate, publish task or object.

## 4. API

Base URL: `/v1`. Every response includes `requestId`; every write supports `Idempotency-Key`.

### 4.1 Create candidate

```http
POST /v1/release-candidates
Idempotency-Key: <client-generated-key>
Authorization: Bearer <service-token>
Content-Type: application/json
```

```json
{
  "source": {
    "repository": "z-code",
    "commit": "40-to-64-char-git-sha",
    "version": "3.8.0",
    "ref": "refs/tags/v3.8.0"
  },
  "targets": [
    { "os": "macos", "arch": "arm64" },
    { "os": "macos", "arch": "x64" },
    { "os": "windows", "arch": "x64" },
    { "os": "windows", "arch": "arm64" },
    { "os": "linux", "arch": "x64" },
    { "os": "linux", "arch": "arm64" }
  ]
}
```

Returns `201` and `ReleaseCandidate`. Retrying the same `Idempotency-Key` returns the same `candidateId`.

### 4.2 Create build

```http
POST /v1/release-candidates/{candidateId}/builds
Idempotency-Key: <candidateId>:<os>:<arch>:<attempt>
```

```json
{
  "platform": { "os": "windows", "arch": "x64" },
  "workerPool": "windows-signing",
  "constraints": { "signingRequired": true, "notarizationRequired": false }
}
```

Response `202`:

```json
{
  "buildId": "build_01J...",
  "candidateId": "cand_01J...",
  "state": "queued",
  "upload": {
    "manifestUploadUrl": "https://...",
    "artifactUploadPrefix": "candidates/cand_01J.../windows/x64/",
    "expiresAt": "2026-08-18T15:00:00Z"
  }
}
```

Artifacts upload via presigned URLs or short-lived credentials, not through the control plane's application server.

### 4.3 Complete build

```http
POST /v1/release-candidates/{candidateId}/builds/{buildId}/complete
Idempotency-Key: <buildId>:complete
```

The body is the platform's manifest subset and provenance. Before accepting, the platform checks:

1. all `objectKey` values are under the candidate's prefix;
2. objects exist with matching size and SHA-256/SHA-512;
3. platform/arch match the build request;
4. base update metadata version, path and files digest match the artifacts.

Success returns `200` and the build is `succeeded`; validation failure returns `422` and the candidate moves to `build_failed` or stays retryable.

### 4.4 Submit notes draft

```http
POST /v1/release-candidates/{candidateId}/notes
Idempotency-Key: <candidateId>:notes:<revision>
```

```json
{
  "revision": "sha256:<canonical-localized-notes-json>",
  "locales": {
    "zh-CN": { "markdown": "# Release ..." },
    "en-US": { "markdown": "# Release ..." }
  }
}
```

The platform validates the revision, creates a `notesDraftId` and sets the candidate to `approval_pending`. Idempotent per revision.

### 4.5 Approve notes

```http
POST /v1/release-candidates/{candidateId}/approvals
Idempotency-Key: <candidateId>:approve:<revision>
If-Match: <candidate-etag>
```

```json
{
  "notesRevision": "sha256:...",
  "decision": "approve"
}
```

`decision` is `approve` or `reject`. The approver comes from the authenticated token; the endpoint does not accept a caller-supplied `approvedBy`.

### 4.6 Publish

```http
POST /v1/release-candidates/{candidateId}/publications
Idempotency-Key: <candidateId>:publish:<notesRevision>:<channel>
```

```json
{
  "notesRevision": "sha256:...",
  "channel": "gray"
}
```

Before entering `publishing` the platform confirms: the candidate is `approved`, the revision matches, all target platforms are `ready`, and no publication for the same channel is in progress. Returns `202` and `publicationId`. Official YAML generation, upload and release API calls belong to that publication; on failure it returns `publish_failed_retryable` and never falls back to rebuilding.

### 4.7 Query and retry

```http
GET  /v1/release-candidates/{candidateId}
GET  /v1/release-candidates/{candidateId}/events
POST /v1/release-candidates/{candidateId}/retry
```

`retry` is allowed only for `build_failed` or `publish_failed_retryable`, must produce a new attempt, and never changes existing artifact digests.

## 5. Error Contract

Every 4xx/5xx returns:

```json
{
  "error": {
    "code": "ARTIFACT_DIGEST_MISMATCH",
    "message": "artifact sha256 does not match object",
    "details": { "artifactId": "art_01J..." },
    "retryable": false,
    "requestId": "req_01J..."
  }
}
```

Minimum error codes: `INVALID_SCHEMA`, `CANDIDATE_NOT_FOUND`, `INVALID_STATE_TRANSITION`, `IDEMPOTENCY_CONFLICT`, `ARTIFACT_NOT_FOUND`, `ARTIFACT_DIGEST_MISMATCH`, `UPDATE_METADATA_MISMATCH`, `NOTES_REVISION_MISMATCH`, `APPROVAL_REQUIRED`, `PUBLICATION_IN_PROGRESS`, `PUBLISH_FAILED_RETRYABLE`.

## 6. Event Contract

The platform emits CloudEvents 1.0 style events. Events express state changes only and carry no large files:

```json
{
  "specversion": "1.0",
  "type": "zcode.release.candidate.state_changed.v1",
  "id": "evt_01J...",
  "source": "packaging-platform",
  "subject": "cand_01J...",
  "time": "2026-08-18T14:00:00Z",
  "data": {
    "candidateId": "cand_01J...",
    "from": "building",
    "to": "ready",
    "buildId": "build_01J..."
  }
}
```

Minimum event types: `zcode.release.candidate.created.v1`, `zcode.release.build.state_changed.v1`, `zcode.release.notes.approval_changed.v1`, `zcode.release.publication.state_changed.v1`. Consumers deduplicate by `id` and treat the query API as the final source of truth.

## 7. Authentication and Security

- Workers use OIDC workload identity or short-lived service tokens; long-lived OSS keys are not put in GitLab variables.
- API scopes distinguish at least `candidate:create`, `build:complete`, `notes:submit`, `publish:create`, `release:promote`.
- Presigned upload URLs have an expiry, a candidate prefix and a single-object limit.
- The platform server recomputes/reads object digests; a digest submitted by the worker alone is not trusted.
- Before publishing, keep a full audit record: initiator, approver, candidateId, notes revision, publicationId, object digests.

## 8. Migration Boundary

1. The existing GitLab worker generates the v1 manifest and uploads the shared directory as candidate objects.
2. Introduce a platform adapter: `create candidate -> build complete -> notes submit -> publish`.
3. The platform takes over approval and final YAML generation; z-code `release:approve` stays only as a compatibility path.
4. The platform takes over OSS/CDN/release API credentials and gray/stable state.
5. Delete z-code's internal official-publish scripts, keeping only the local manifest/YAML validation tools.

## 9. Contract Acceptance Cases

- Retrying the same `Idempotency-Key` never creates a second candidate/build/publication.
- Any wrong artifact digest in the manifest keeps the build out of `ready`.
- A notes revision that does not match the candidate makes both approval and publish return `NOTES_REVISION_MISMATCH`.
- Publish on an unapproved candidate returns `APPROVAL_REQUIRED` and writes no official object.
- Retry after a publish failure does not rebuild and keeps artifact digests unchanged.
- Duplicate event delivery causes no duplicate state transition.
- A worker token cannot call `release:promote`.
