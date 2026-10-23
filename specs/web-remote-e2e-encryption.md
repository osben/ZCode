# Web remote control: end-to-end payload encryption

Status: **design, awaiting owner approval. No code yet.** Decisions in section 10 need an answer first.
Related: `specs/relay-v2-migration.md` (sections 14 and 15), `docs/web-remote-control/relay-v2-pairing.md`,
`packages/shared/src/web-remote-relay/CONTRACT.md` (its sentence "The contract does not provide end-to-end
encryption" changes when this ships).

## 1. Problem

The relay (`packages/remote-relay/src/app/relay.ts`) forwards every `data` frame verbatim. The only protection
is TLS to the relay host, so whoever runs or breaks into that host reads every prompt, file, diff and terminal
line in both directions. The Railway incident of 2026-10-21 (secrets exfiltrated) shows the risk is real. The
self-hosted relay already isolates users (device keys, single-use pairing codes, open enrollment caps). This
spec adds the missing piece: the relay forwards only ciphertext it cannot read or forge.

## 2. Product rules

- In `device-key` identity mode, every `data` payload between Desktop and phone is sealed end to end. There is
  no plaintext fallback in that mode (decision D2).
- `zai-jwt` mode is unchanged: no key in the QR, plaintext payloads, byte-identical QR. Reason: the phone can
  connect from the account device list without scanning, so there is no out-of-band channel to carry a key,
  and upstream web pages do not speak this protocol (D1).
- The QR (and the Bot `/remote` link) is the only channel that carries the key. The key never reaches the
  relay, the web host's access logs, storage or logs.
- The relay contract and the relay code do not change. The relay stays an unchanged, untrusted forwarder.
- Phone socket reconnects never need a re-scan while the phone's relay JWT is valid. A page reload needs a
  re-scan, as it already does today (the pairing JWT is memory-only).
- `desktop-continuous` and `web-remote-replayable` keep their owners and recovery boundaries. Encryption sits
  below them and is invisible to the manager and the web app layer.

## 3. Threat model

| Adversary                                                      | Today                 | With this spec                                                                                                              |
| -------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Relay operator or relay host, passive                          | Reads all payloads    | Sees ciphertext and metadata only (list below)                                                                              |
| Relay, active (inject, replay, reorder, drop)                  | Can forge any command | Every change is detected and the session is torn down. Can still deny service.                                              |
| Relay impersonates a phone (it can mint JWTs)                  | Gets full access      | Cannot pass the handshake without the QR secret. Desktop sends it nothing.                                                  |
| Relay impersonates the Desktop to the phone                    | Possible              | Cannot produce the `welcome` MAC. The phone shows a failure.                                                                |
| Recorded traffic plus a later leak of the QR secret            | n/a                   | Past sessions stay unreadable: ephemeral ECDH per handshake gives forward secrecy.                                          |
| **Web host (serves the phone's JS)**                           | Full access           | **Still full access.** Malicious JS reads `#ek` from the fragment. See below.                                               |
| QR observer, screenshot, Bot `/remote` link on a chat platform | Can pair first        | Unchanged: the QR and the link are credentials while valid. Using them first locks out the real phone, which the user sees. |
| Desktop or phone compromised                                   | Out of scope          | Out of scope                                                                                                                |

**The web host is in the trusted base.** E2E removes the relay from the trusted base, not the server that
delivers the phone's code. `zcode-web` runs in the same Railway project as `zcode-relay`, so a Railway-wide
compromise still defeats E2E. The goal "safe for anyone" therefore also needs D5: serve the web client from
a different provider, built by CI from a tagged commit, with a strict CSP. That is a deployment task, separate
from this code.

**Metadata the relay still sees:**

- the `auth_init` meta (device name, platform, version)
- device SIDs and `dk:` user ids
- client IPs
- frame sizes and timing
- the `pid` (pairing id) in each `hello`, which links one phone's reconnects

The web host also logs the query-string routing hints (`sid`, `mid`, `name`, `app_version`). Hiding them is out
of scope.

## 4. Owners

| State                                                                                | Owner                                                                                                                                                          | Lifetime                                              |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Wire schema, key schedule, seal/open, handshake state machine (pure, WebCrypto only) | New module `packages/shared/src/web-remote-e2e/` (no `node:crypto`, no timers)                                                                                 | n/a                                                   |
| Pairing secrets `S` (pending and bound)                                              | Desktop Main: one install-wide `WebRemoteControlE2ePairings` registry in `packages/desktop/src/main/web-remote-relay/`, injected into every window's transport | Memory only (D4)                                      |
| Desktop session keys and counters                                                    | `WebRemoteControlDeviceTransport`, one session per window socket                                                                                               | Until the next `hello`, an unmatch or a socket change |
| Phone `S`                                                                            | `webRemoteControlEntry`, held next to `pairedJwt`                                                                                                              | Page lifetime                                         |
| Phone session keys and counters                                                      | `packages/web` relay transport, one session per socket generation                                                                                              | Until an unmatch, a reconnect or a `reset`            |

The manager (`webRemoteControlManager.ts`), the acknowledged relay protocol, rpc-frame fragmentation and the
web app layer keep their current owners. They see only plaintext app payloads and the existing `paired` /
`onSendReady` signals.

## 5. Key material and the QR

- `S`: 32 random bytes from `crypto.getRandomValues`. Desktop mints one each time it mints a pairing code `pk`:
  every QR build, every 240 s refresh and every Bot `getConnectUrl`. `S` and `pk` are independent random
  values. `pk` goes to the relay, `S` never does.
- QR fragment: `#pk=<22 chars>&ek=<43 chars base64url(S)>`. `buildWebRemoteControlExternalQrUrl` takes an
  optional `e2eKey`. `parseWebRemoteControlExternalQrParams` returns it only when it is exactly 43 base64url
  characters, and rejects a malformed `ek` (it does not ignore it).
- The web entry reads `pk` and `ek` from the fragment and removes both in the same `replaceHref`. `ek` is
  read only from the fragment, never from the query string: no Desktop has ever put it there.
- `pid = HKDF-SHA-256(ikm=S, salt="", info="zcode-e2e/v1/pairing-id", 16 bytes)`, sent as base64url (22
  characters). Desktop uses it to find `S` without trial decryption. It reveals nothing about `S`.

**Registry rules (Desktop):**

| Rule         | Detail                                                                                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending      | An `S` that no phone has completed a handshake with. It expires 300 s after minting, the same as `pk`. Cap 8; minting a ninth evicts the oldest pending entry.                                                                                                   |
| Bound        | The first verified `finish` promotes the entry. Later handshakes with that `pid` are accepted, so reconnects need no re-scan. Cap 8, least recently used evicted. Hard expiry 24 h after binding, the maximum relay JWT TTL: the phone cannot outlive it anyway. |
| Install-wide | A phone paired through one window can open any window of the same install. This matches the relay: a pairing JWT already grants every device of that `dk:` user. The transcript binds the target `deviceSid`.                                                    |
| Revocation   | Stopping remote control in the last window clears the registry. Any later `hello` gets `reject`, and the phone asks for a new scan.                                                                                                                              |

## 6. Handshake

The design is PSK-authenticated ephemeral ECDH, the same shape as Noise `NNpsk0` built from WebCrypto
primitives. It runs on every transition of the phone into relay `matched`.

```mermaid
sequenceDiagram
    autonumber
    participant M as Desktop manager
    participant DT as Desktop transport + E2E session
    participant P as Pairing registry (Main)
    participant R as Relay (untrusted forwarder)
    participant WT as Phone transport + E2E session
    participant E as Phone entry (holds S, pairedJwt)
    Note over M,P: QR build: pairing.issueCode() -> pk ; registry.mint() -> S (pending)
    M-->>E: QR #pk=..&ek=..  (out of band, never via R)
    E->>R: POST /session {pairing_code: pk} -> pairing JWT
    E->>WT: connect(deviceSid, jwt, S)
    WT->>R: ws2 + auth_init(sid)
    R-->>WT: auth_ack(matched)
    R-->>DT: pair_status_ack(matched)
    Note over DT: relay matched -> "securing" (reported as waiting_terminal)
    Note over WT: relay matched -> "securing" (connecting screen; waiting timer not started)
    WT->>R: data{zcode-e2e hello: pid, eT, nT}
    R->>DT: hello
    DT->>P: lookup(pid) -> S (pending or bound) | none -> data{reject}
    Note over DT: th = H(sid, pid, eT, nT, eD, nD); keys = HKDF(ECDH, salt=S, info=th)
    DT->>R: data{welcome: eD, nD, macD}
    R->>WT: welcome
    Note over WT: verify macD (Desktop knows S) -> session keys
    WT->>R: data{finish: macT}
    R->>DT: finish
    Note over DT: verify macT (phone knows S); P.bind(pid)
    DT-->>M: state paired + onSendReady(reconnected-socket)
    Note over M: flush pending, replayUnacknowledged() -> resealed with new keys
    WT-->>E: state paired + onSendReady
    DT->>R: data{box s,c=0,d}
    R->>WT: box -> open -> app payload / rpc-frame
```

**Messages.** Every handshake message is the `data.payload` of a relay `data` frame. Each one carries
`zcode_type: "zcode-e2e"` and `v: 1`, and the schemas are strict (exact keys, exact base64url lengths). Any
other `v` is dropped and logged once.

| `k`       | Direction | Fields                                                | Authenticated                                                         |
| --------- | --------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| `hello`   | T→D       | `pid` (22), `e` (P-256 raw, 87), `n` (16 B, 22)       | No (bound by the transcript)                                          |
| `welcome` | D→T       | `e`, `n`, `mac` (43)                                  | Yes, `macD`                                                           |
| `finish`  | T→D       | `mac`                                                 | Yes, `macT`                                                           |
| `box`     | both      | `s` (11, session tag), `c` (integer), `d` (base64url) | AES-GCM                                                               |
| `reset`   | D→T       | none                                                  | No. A forgery only causes a re-handshake, which is denial of service. |
| `reject`  | D→T       | `reason: "unknown-pairing"`                           | No. A forgery only causes denial of service.                          |

**Key schedule.** All values are byte strings. `||` joins fields, and each field carries a 2-byte length
prefix.

- `th = SHA-256("zcode-e2e/v1" || deviceSid || pid || eT || nT || eD || nD)`
- `ecdh = ECDH-P256(own ephemeral private key, peer ephemeral public key)`, 32 bytes. The public key is
  imported as `raw`, and WebCrypto validates that the point is on the curve.
- `HKDF-SHA-256(ikm=ecdh, salt=S, info="zcode-e2e/v1/keys" || th)` produces 128 bytes, split into four
  32-byte keys:

| Key    | Algorithm    | Use                     |
| ------ | ------------ | ----------------------- |
| `kT2D` | AES-256-GCM  | Phone-to-Desktop boxes  |
| `kD2T` | AES-256-GCM  | Desktop-to-phone boxes  |
| `mD`   | HMAC-SHA-256 | Desktop's `welcome` MAC |
| `mT`   | HMAC-SHA-256 | Phone's `finish` MAC    |

All are imported non-extractable.

- `macD = HMAC(mD, "welcome" || th)` and `macT = HMAC(mT, "finish" || th)`. Both are checked with
  `subtle.verify`, which compares in constant time.
- `s = base64url(th[0..8])`. It lets a receiver tell a late box from the previous session (drop silently)
  from a forged box (tear the session down).
- Ephemeral private keys are generated non-extractable and dropped once the session keys exist. That
  discard is what gives forward secrecy.

**Why the relay cannot sit in the middle:**

- Swapping `eT` or `eD` changes `ecdh` and `th`, so `macD` and `macT` fail.
- Without `S`, the relay cannot compute either MAC.
- Replaying an old `hello` or `welcome` fails, because the fresh nonces and ephemeral keys on the other side
  change `th`.

**Rules on each side:**

| Side    | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone   | Starts a handshake only on a transition into relay `matched`: `auth_ack(matched)`, or `pair_status_ack` going from `waiting` to `matched`. A repeated `matched` heartbeat ACK on a paired socket never starts one. Has a handshake deadline of 10 s from `hello`, a liveness watchdog like the existing heartbeat ACK deadline. When it passes, the phone reconnects the socket through the existing retry policy. On `reset` it starts a new handshake, at most one per retry-policy delay. On `reject` it shows the terminal failure "Scan the QR code again". |
| Desktop | On `hello` it drops any existing session, reports `waiting_terminal` and answers. At most one handshake is in flight per window. A token bucket allows 10 `hello`s per minute; extra `hello`s are ignored and logged once per window. Drops its session when its relay state leaves `matched`, when its socket generation changes, or on a failed `finish`. An unknown `pid` gets `reject`.                                                                                                                                                                      |

## 7. Data boxes

- Plaintext is the UTF-8 JSON of the original `data.payload`: an app payload, `rpc-frame` or
  `rpc-frame-ack`.
- The `box` envelope takes the place of `data.payload`. `client_ts` stays where the relay contract requires
  it.
- The IV is 12 bytes: a 4-byte direction constant (`T→D = 1`, `D→T = 2`) followed by an 8-byte big-endian
  `c`.
- `AAD = "zcode-e2e/v1/box|" + s + "|" + c`.
- Each direction has its own key and its own counter, starting at 0. The receiver requires
  `c === expected`. Anything else is a gap, a replay or reordering, and every one of them tears the session
  down.
- The relay forwards frames in order over one socket per side, so a correct relay never produces a gap. A
  gap always means loss or tampering.

**On a failed box:**

- A box whose `s` does not match the current session is dropped silently. These are late boxes from the
  previous session.
- A failed tag or counter tears the session down. The Desktop sends `reset`. The phone drops its session
  and sends `hello`. Payloads queued meanwhile are kept by the existing owners and replayed after the new
  `onSendReady`.
- A box arriving when there is no session: the Desktop answers `reset` (rate limited by the same bucket),
  and the phone ignores it.

**Sealing:**

- Seal at send time. Never seal inside the serializer cache. `WebRemoteControlRelayPayloadSerializer` keeps
  caching the plaintext JSON. `replayUnacknowledged()` resends through `sendPayloadResult`, which reseals
  with the current keys and counter. A cached ciphertext would replay under old keys and be rejected as a
  replay.
- Metering reports what goes on the wire. When E2E is active, `measurePayloadBytes`, the `sent` result's
  `bytes` and the oversize check all use `sealed(P)` of the cached plaintext, never `P`. Replay accounting
  therefore still records the bytes actually written, which is the reason the serializer cache exists.
- Sealed size depends only on plaintext size, because AES-GCM adds no padding:
  `sealed(P) = F + ceil(4·(P + 16) / 3)`. `F` is the fixed envelope byte count measured with a 16-digit
  `c`.
- The shared module exports `measureWebRemoteControlE2eSealedBytes(P)` and
  `WEB_REMOTE_CONTROL_E2E_MAX_PLAINTEXT_BYTES`, the largest `P` with `sealed(P) ≤ 1 MiB`, about 786 000.
- When E2E is active, the transports pass that budget as `maxPhysicalFrameBytes` to the rpc-frame fragmenter
  and the oversize check. Measuring the outer envelope is safe, because it is always at least as large as
  the inner plaintext.
- Capacity check: 16 MiB divided into 64 fragments is 256 KiB of raw bytes per fragment. A fragment under
  the reduced budget holds about 589 KiB of raw bytes, so the limits still fit.
- Counter ceiling: when a sender's `c` reaches 2^31, it forces a new handshake. The phone sends `hello`; the
  Desktop sends `reset`. GCM would allow far more, and the ceiling is unreachable in practice.

**Unwrap order on receive (both sides):**

1. Relay frame parse.
2. If `payload.zcode_type === "zcode-e2e"`, route to the session. A `box` is opened and its plaintext goes on
   to step 3.
3. The existing `rpc-frame` / `rpc-frame-ack` raw intercept.
4. `parseWebRemoteControlAppPayload`.

When E2E is required, a plaintext payload is dropped and counted, never processed. Old clients drop
`zcode-e2e` payloads silently, the same as any payload they do not recognize.

**Bandwidth.** Base64 makes JSON payloads 1.33× larger. `rpc-frame` data is already base64, so sealing it
gives about 1.78× the raw bytes. Ciphertext also cannot be compressed, so `perMessageDeflate` gains are lost.
All of this counts against the open tier's 512 MiB/day inbound budget, so the usable plaintext is roughly
300 MiB/day before compression losses. Compressing before encryption is D3.

## 8. Transport states

| Side    | Relay `matched`, handshake not done                                                             | Handshake verified                                                                       |
| ------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Desktop | Internal `securing`, reported as `waiting_terminal`. `sendPayloadResult` returns `unavailable`. | `paired`, plus `onSendReady({kind: "reconnected-socket"})` for every new session         |
| Phone   | Internal `securing` on the connecting screen, with no waiting or desktop-offline timer          | `paired`, plus `onSendReady` with the existing `same-socket` / `reconnected-socket` rule |

`reconnected-socket` is used for every new session, because a new phone session always needs the flush,
`requestMobileTaskView` and `replayUnacknowledged`.

**Gating rules (both transports):**

- **Heartbeat ACKs while securing.** Today both sides call the pair-state mapping on every `pair_status_ack`.
  The Desktop calls `setState(webRemoteControlV2PairState(...))` and the web calls `applyPairStatus`. Every
  `matched` heartbeat ACK therefore reports `paired`, and on the web it also fires
  `onSendReady(same-socket)`. While securing, a `matched` ACK only refreshes the heartbeat: it never reports
  `paired` and never fires `onSendReady`. A same-socket `onSendReady` fires only while a session is
  established.
- **Data while securing.** Both transports drop incoming `data` unless the state is `paired`. While securing,
  they accept `zcode-e2e` handshake frames (`hello`, `welcome`, `finish`, `reset`, `reject`). Every other
  payload stays gated.
- **Leaving `matched`.** Either side drops its session on any relay `waiting`. The phone keeps the same
  socket across `waiting → matched`, and that is still a transition into `matched`, so a new handshake starts.

**Link semantics:**

| Link                    | Behaviour                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-continuous`    | Streaming pauses while the session is `securing`. Buffered frames flush when `onSendReady` fires.                                                 |
| `web-remote-replayable` | Recovery (`recoveryId`, snapshot and gap) starts after `paired`, as it does today. Handshake latency adds to the recovery time, not to its rules. |

## 9. Compatibility and rollout

| Desktop                             | Web page                                                                               | Result                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New, `device-key`                   | New                                                                                    | E2E                                                                                                                                                                                                                                                                                                                                                                                                                  |
| New, `device-key`                   | Old (stale cached tab)                                                                 | The old page has no securing step. It reports `paired` on relay match and sends plaintext bootstrap requests, which the Desktop drops, and it never sends a `hello`. The requests end in the existing `desktop-bootstrap-timeout` failure (`payloadRequester`, 10 s). The Desktop sends it nothing. `packages/web` has no service worker, so a fresh scan loads the new page.                                        |
| New, `device-key`                   | Page on plain `http://` other than localhost (`ZCODE_WEB_REMOTE_CONTROL_URL` override) | `crypto.subtle` does not exist outside a secure context, and `#ek` would cross the network in clear. The Desktop refuses to start `device-key` remote control with such a base URL and reports `relay-unavailable` with a log line naming `ZCODE_WEB_REMOTE_CONTROL_URL`. If the page runs without `crypto.subtle` anyway, it shows the failure `insecure-context` ("Open this page over HTTPS") and does not crash. |
| Old, `device-key` (QR without `ek`) | New                                                                                    | D2. Recommended: a terminal failure screen, "Update ZCode Desktop to connect securely".                                                                                                                                                                                                                                                                                                                              |
| Any, `zai-jwt`                      | Any                                                                                    | Unchanged plaintext                                                                                                                                                                                                                                                                                                                                                                                                  |

- Deploy order: the web host first, then the Desktop release. This is the same rule as the `#pk` move in
  section 15.6.
- The relay needs no deploy.
- Reading the QR: `ek` present means E2E is required for that connection. `ek` absent with a z.ai JWT means
  plaintext (upstream). `ek` absent with a bearer from `pk` is D2.
- Desktop policy: E2E is required exactly when `ZCODE_WEB_REMOTE_CONTROL_RELAY_IDENTITY_MODE=device-key`.
  There is no separate switch to turn it off.

## 10. Decisions for the owner

| #   | Question                                                       | Recommended                                                                                                                                                             | Alternative                                                                                                     |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| D1  | Scope                                                          | E2E in `device-key` mode only. `zai-jwt` stays unchanged.                                                                                                               | Opt-in E2E in `zai-jwt` too. It needs per-device keys stored on the phone (IndexedDB) for device-list connects. |
| D2  | New web page and an old Desktop QR without `ek` (`device-key`) | Refuse, with "Update ZCode Desktop".                                                                                                                                    | Allow plaintext for a transition period, with a visible "not end-to-end encrypted" banner.                      |
| D3  | Compress before encrypting                                     | No. Plaintext length would leak through compression, a CRIME-style risk where agent-read content mixes with secrets.                                                    | `CompressionStream("deflate-raw")` before sealing, which saves budget.                                          |
| D4  | Do bound pairings survive a Desktop restart?                   | No, memory only: a restart means a re-scan.                                                                                                                             | Persist them in the credential entry `fork_web-remote-control:e2e-pairings`, never in `setting.json`.           |
| D5  | Web host trust                                                 | Move `zcode-web` off Railway to a separate provider (for example Cloudflare or GitHub Pages, deployed by CI from a tag), with a strict CSP. Do this as a separate task. | Keep it on Railway and accept that a Railway compromise defeats E2E.                                            |
| D6  | Curve                                                          | P-256: every browser and Node 26 support it in WebCrypto.                                                                                                               | X25519: needs Safari 17+, Chrome 133+ and Firefox 130+. Older phones would fail.                                |

## 11. Logging and errors

- Never log `S`, `pid`, nonces, ephemeral keys, MACs, ciphertext or plaintext.
- `info`: handshake established, handshake failed. The failure category is one of `unknown-pairing`, `mac`,
  `timeout` or `rate-limited`.
- `warn`, at most once per session: box failure (`tag`, `counter`, `stale-session`), plaintext dropped while
  E2E is required, unknown `v`.
- `debug`: per-box counters, never content.
- The phone has three new failure reasons:

| Reason                    | Shown for                      | Copy                        |
| ------------------------- | ------------------------------ | --------------------------- |
| `e2e-repair-needed`       | `reject`                       | "Scan the QR code again"    |
| `desktop-update-required` | D2                             | "Update ZCode Desktop"      |
| `insecure-context`        | `crypto.subtle` is unavailable | "Open this page over HTTPS" |

Each needs English and Chinese copy and the mobile layout from `DESIGN.md`.

## 12. Acceptance scenarios

Tests come first, at implementation.

**Shared (`packages/shared/src/web-remote-e2e/*.test.ts`, Node WebCrypto, with injected randomness):**

- Handshake happy path, and a key-schedule vector test: fixed inputs give fixed `pid`, `th`, MACs and the
  first box.
- Wrong `S` on either side, and an unknown `pid`.
- A swapped `eT` or `eD` (man in the middle) is detected.
- A tampered `welcome` or `finish` fails. A `hello`/`welcome` replayed from an earlier session fails.
- A box that is tampered (`d`, `s` or `c`), replayed, reordered or has a gap fails. A box reflected back to
  its sender fails. A late box from the previous session is dropped silently.
- An invalid curve point is rejected. Unknown `v` and extra keys are rejected.
- `sealed(P) ≤ 1 MiB` holds for `P = MAX_PLAINTEXT_BYTES`, and `MAX_PLAINTEXT_BYTES + 1` overflows.
- The counter ceiling forces a new handshake.

**Desktop transport and registry (`packages/desktop/test`):**

- No app payload or rpc-frame leaves before `finish` is verified, and `sendPayloadResult` returns
  `unavailable`.
- `paired` and `onSendReady(reconnected-socket)` fire after the handshake. Unacknowledged frames are resealed
  on replay.
- Plaintext data is dropped while E2E is required.
- `matched` heartbeat ACKs while securing do not report `paired`. Measured and sent bytes equal `sealed(P)`.
- A `device-key` start with a plain `http://` page URL other than localhost is refused.
- The `hello` token bucket applies, and only one handshake is in flight.
- A pending `S` expires after 300 s, and caps and eviction work. A bound `pid` is accepted after a phone
  reconnect. One phone can open two windows.
- Stopping the last runtime clears the registry, and the next `hello` gets `reject`.
- The QR and the Bot `getConnectUrl` both carry `ek`. `zai-jwt` QRs stay byte-identical.

**Web (`packages/web`):**

- `ek` is read from the fragment, removed together with `pk`, and never read from the query string. A
  malformed `ek` is a failure.
- A missing `ek` with a pairing bearer follows D2.
- A repeated `matched` ACK does not start a handshake. A new socket does, without a re-scan.
- While securing, a `matched` ACK neither reports `paired` nor fires `onSendReady(same-socket)`.
- `waiting` on the same socket drops the session, and the next `matched` starts a new handshake.
- With no `crypto.subtle`, the page shows `insecure-context`.
- `reset` starts a new handshake. `reject` shows "Scan the QR code again". The handshake timeout reconnects.

**End to end through the fake relay (`@zcode/shared/testing/fake-relay-v2`, both real transports):**

- **Canary.** A task title containing a unique canary string streams to the phone, and a prompt containing
  another canary goes to the Desktop. Neither canary, nor its base64 form, appears in any `data` frame the
  fake relay recorded.
- **Forged terminal.** A terminal that holds a valid JWT but no `S` connects. The Desktop sends it only
  `reject` and never an app payload.
- **Relay tampering.** A fake-relay `onMessage` hook flips one ciphertext byte. The session resets, recovers
  through a new handshake, and no corrupted payload reaches either app layer.
- **`desktop-continuous`.** A stream continues across a phone socket drop with no re-scan.
- **`web-remote-replayable`.** A phone socket drop, then a new handshake, then snapshot and gap recovery
  produce the same view as without E2E.

**Real devices:** an iOS Safari and Android Chrome phone pair against the Railway relay, and the relay logs
show only `zcode-e2e` payloads.

## 13. Implementation slices (after approval)

1. **Shared module.** Add `packages/shared/src/web-remote-e2e/` (schemas, key schedule, session state machine,
   size helpers) and register its module id in the architecture policy. Update `CONTRACT.md` and the protocol
   doc.
2. **Desktop.** Add the registry, the transport wrap, QR/Bot `ek`, and the fragment budget.
3. **Web.** Update the entry, the transport wrap, the failure screens and the copy.
4. **Tests.** Fake-relay end-to-end tests (canary, forged terminal, tampering, both link semantics), then
   real-device checks.

D5 (moving the web host) is a separate deployment task.
