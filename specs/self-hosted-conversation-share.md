# Self-hosted conversation share (own share server instead of z.ai)

Conversation sharing currently publishes to the vendor platform (`zcode.z.ai`): the desktop
client resolves its API base from the runtime ZCode endpoint origin and the share landing page
requires Z.ai OAuth before viewing. This spec replaces the vendor round-trip with a small
fork-owned storage service. User decisions: link TTL is **1 day**, and the "Only me" access
option is **hidden** whenever a non-vendor share endpoint is configured.

## Current state (verified)

- Share contracts (envelope schemas, error codes, snapshot versioning, access modes) live in
  `packages/shared/src/conversation-share.ts` (envelope `{code, msg, data}` shapes at lines
  ~441-457).
- Publishing client:
  `packages/services/src/conversation-share/conversationShareService.ts` +
  `conversationShareHttpClient.ts`. Publish is a **multi-step handshake**:
  1. `GET capabilities` — server-advertised limits; the client enforces them in preflight and
     publish, and `narrowConversationShareCapabilities` tolerates shrunken limits. Caveats:
     `max_rows`/`max_payload_bytes`/`max_artifact_bytes`/`max_total_artifact_bytes` must be
     positive; `max_artifact_count: 0` disables artifacts; the capabilities list may only
     advertise access modes/artifact types the client enum knows.
  2. `POST /shares/preparations` — manifest with `payload_sha256`, artifact count.
  3. `POST /shares/preparations/:id/artifacts` — multipart per artifact; client verifies
     `artifact_id`/`size_bytes`/`sha256` echoes.
  4. `POST /shares/preparations/:id/confirm` — finalizes; the client polls only on error code
     3215 (`confirmUntilReady`), so a server that never returns 3215 skips the poll loop.
     Import uses `getPreview` (GET) + `getContinuation` (**POST**, not GET) and then downloads
     artifact bytes from per-artifact URLs with bare unauthenticated `fetch`
     (conversationShareService.ts:713).
- Auth wiring: every publish route uses `auth: "required"` and `requestData` attaches
  `Authorization: Bearer <tokenProvider()>`, where both construction sites
  (`packages/services/src/node.ts:2500-2507`; the desktop local-global collection that was the second
  site was removed) wire the **Z.ai OAuth store**. A user not logged into Z.ai cannot publish at all, and a logged-in user would
  leak the vendor JWT to whatever origin the base URL points at.
- Access picker: `packages/ui/src/ConversationSharePermissionPicker.tsx` (presentational,
  hard-coded options) + `conversationShareSelectionStore.ts` (default `public_importable`,
  in-memory drafts). No publish-path dependency on `private` mode.
- Viewer: `packages/web-share` (standalone Vite app, `base: "/cn/share/"`) renders via
  `@zcode/share-ui` + `packages/web/src/share/`. It is built with its **own** `loadEnv` +
  `define` block (web-share/vite.config.ts), not via `scripts/build-time-config.mjs`. The
  login card renders only when the server answers `authentication_required`
  (ConversationShareLandingPage.tsx:607-645) — the OAuth gate is **server-driven**, so it
  disappears by not returning 401/3213; `ShareAuthPages` becomes dead code.
- Config resolution: the publisher's base URL is resolved at **runtime** from `process.env`
  (`buildRuntimeZCodeApiUrl(process.env, "/api/v1")`, node.ts:2499); build-time-config defines
  reach desktop tsup/vite only, not `packages/services`. The relay template
  (`packages/remote-relay`) hard-fails on half-configured paired options
  (`resolveWebRemoteControlReleaseDefaults`, build-time-config.mjs:60-93) — the pattern to
  copy.
- Import provenance validation: stored share URLs must match
  `^\/cn\/share\/[^/]+$` (`packages/shared/src/zcode-protocol-v4/shared-context-import.ts`),
  so the viewer **must** be served under `<origin>/cn/share/`.

## Product rules

1. **Wire contract.** The share server implements the **existing vendor wire endpoints** —
   same paths, envelope shapes (`{code, msg, data}` success / `{code, msg}` error), and error
   codes the `conversationShareHttpClient` already speaks. Route family (mounted under the
   configured base URL, which includes `/api/v1`): `GET capabilities`,
   `POST /shares/preparations`, `POST /shares/preparations/:id/artifacts`,
   `POST /shares/preparations/:id/confirm`, `GET` preview, `POST` continuation, plus **signed
   artifact-byte GET routes** (see rule 4). No listing, catalog, sitemap, or enumeration.
2. **Codes and capabilities.** Share codes and `preparation_id`s are 128-bit random URL-safe
   strings (preparation_id is the bearer capability for uploads/confirm). Share codes are
   stored **hashed** (SHA-256; no salt needed for 128-bit random). The server advertises
   conservative limits in `capabilities` (payload, artifact count/size/total, and the exact
   access-mode/type enums the client knows) — limits are server config, not client code.
3. **TTL.** Shares expire **1 day** after confirm; envelopes and artifact blobs are pruned
   lazily on access plus a periodic sweep; expired/unknown codes return the same not-found
   error code. Unconfirmed preparations are garbage-collected **by age** (max age 24h, well
   above the slowest legitimate handshake: size-scaled upload timeout + 120s confirm), never
   by "all unconfirmed".
4. **Artifact bytes.** Preview/continuation responses carry per-artifact URLs. The server
   serves them as signed, unguessable, **expiring** GET URLs with `X-Robots-Tag: noindex,
nofollow` and no auth header (the importer uses bare `fetch`). Artifact URLs expire **no
   later than their parent share** — the server clamps the signature validity to the share's
   remaining TTL — and the artifact route rejects requests for expired shares with the same
   not-found error even before the cleanup sweep prunes the blobs.
5. **Anti-indexing.** `X-Robots-Tag: noindex, nofollow` on every response.
6. **Access modes.** `linkViewer`/`linkEditor` behave as today; "import and continue" is a
   local import — after preview + continuation + artifact downloads the server is out of the
   loop. `private` ("Only me") is **hidden from the picker** when the self-hosted endpoint is
   configured (user decision; the picker keys off endpoint config since it is not
   capabilities-driven).
7. **Viewer auth.** Viewing is by link only: the server never returns
   `authentication_required`/401/3213, so the viewer's login card never renders. No viewer
   code change is required for the gate itself.

## Client changes

1. **Credential boundary (blocker fix).** When the self-hosted endpoint is configured, both
   http-client construction sites swap `tokenProvider`: publish routes authenticate with a
   **static publish token** (`X-Share-Publish-Token` header) instead of the Z.ai Bearer JWT.
   **Acceptance: no vendor credential is sent to the self-hosted origin in any mode**, and
   publishing works without any Z.ai login.
2. **Publish token model.** A static shared secret header — deliberately NOT HMAC over a
   canonicalized request: the secret is extractable from distributed builds anyway
   (accepted risk below), so HMAC's replay/canonicalization machinery buys nothing v1. The
   server compares with `timingSafeEqual`. Client change: an optional publish-token provider
   on `ConversationShareHttpClientOptions` applied in `requestData` for publish routes only.
3. **Picker.** Hide `private` when self-hosted is configured.
4. **wiring points (three, kept in sync):** (a) services-layer DI — the base URL + publish
   token passed into both http-client construction sites (pattern: existing `shareWebUrl`
   option); (b) `web-share` vite define — its own `VITE_*` variable for the self-hosted API
   base (NOT `VITE_ZCODE_BASE_URL`); (c) runtime env override, precedence: explicit option >
   env > vendor fallback. Half-configured pairs (endpoint without web URL or vice versa)
   hard-fail at build/startup, mirroring the relay's paired-config check. The viewer must be
   deployed under `<origin>/cn/share/` to satisfy import-provenance validation.

## Accepted risk (v1)

The publish token ships inside desktop builds and can be extracted, so the server can be
abused as small-scale anonymous storage by determined fork users. Mitigations: server serves
artifact bytes only via expiring signed URLs (not raw directory storage), small advertised
limits, rate limits, 1-day TTL. The revocable alternative — per-device registration reusing
the relay's device-key machinery — is the designated v2 upgrade on first abuse.

## Architecture

`packages/share-store`, managed module in `architecture-policy.yaml`, layering copied from
remote-relay: `domain` (pure code/TTL/limit rules) -> `app` (share registry owner:
preparations, artifacts, confirmed shares) -> `adapters` (node:http server, sqlite worker,
entry). Transport schemas exported from a narrow `@zcode/shared` subpath entry, like
`@zcode/shared/web-remote-relay`; no aggregate-entry imports.

Storage: one SQLite database (WAL, dedicated worker). Confirmed shares hold the envelope;
artifact bytes are blobs keyed by share + `artifact_id`, sha256-verified against the manifest
at confirm **and** enforced at upload time (Content-Length + caps checked at preparation
creation and per-upload, streamed sha256 verified before persisting — unconfirmed preparations
must not be an unbounded-disk vector).

CORS: viewer GETs (preview, continuation via POST, artifact URLs) answer `OPTIONS` and echo
the viewer origin explicitly (never `*`) with `Authorization` in
`Access-Control-Allow-Headers` (the viewer attaches a bearer when a token exists —
conversationSharePreviewClient.ts:145-161). Publish routes: no CORS.

Rate limiting: per-IP on misses and publishes; behind Railway parse `X-Forwarded-For` from the
trusted proxy only.

Deployment: standalone Docker image (relay pattern; mount volume at `/data`, Railway cannot
mount `VOLUME`), one replica with a persistent volume behind HTTPS — third Railway service.

## Acceptance

1. Endpoint unset → existing vendor behavior byte-identical.
2. Endpoint set → full publish handshake (preparation → artifacts → confirm) completes with
   the real client; capabilities limits honored; works **without any Z.ai login**.
3. **No vendor credential reaches the self-hosted origin in any mode** (assert on recorded
   requests in tests).
4. `linkViewer` share opens in a clean browser on `<origin>/cn/share/<code>`; login card never
   renders; `noindex` present; CORS preflight from the deployed viewer origin succeeds.
5. `linkEditor` share imports locally (preview GET + continuation POST + expiring artifact
   URLs, sha256 verified) and continues offline.
6. "Only me" absent from the picker; no publish-path dependence on private mode.
7. Share older than 1 day returns not-found and is physically pruned; unconfirmed preparations
   older than 24h are GC'd while a slow in-flight publish survives.
8. Missing/wrong publish token rejected (timing-safe compare); misses rate-limited; artifact
   URLs expire no later than their parent share and the artifact route rejects expired shares
   pre-sweep; no enumeration endpoint; codes and preparation ids are 128-bit, codes stored
   hashed; upload-time cap enforcement verified.
9. `pnpm typecheck`, `pnpm lint`, architecture check pass; unit tests cover token gate,
   credential-boundary assertion, TTL prune, preparation GC-by-age, hashing, capability
   limits, artifact sha256, envelope round-trip.
