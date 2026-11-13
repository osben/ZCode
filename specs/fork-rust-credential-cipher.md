# Rust agent: credential cipher bridge (desktop `enc:v2:`)

Status: bridge shipped in PR #436 (2026-11-13). Follow-ups (Host attach acknowledgement, usage "unknown" state,
re-settled default, standalone system cipher) are specified below in "Follow-ups (2026-11-13)".
Parent: `specs/fork-rust-agent-parity.md`. Code: `packages/rust-cli/crates/{kernel-api,platform,protocol-zcode}`.

## Problem

Upstream 3.18 desktop writes `~/.zcode/v2/credentials.json` values as `enc:v2:<source>:<fp24>:<iv>.<tag>.<ct>`.
The AES key lives in Electron Main (OS keyring). The Node agent asks the Host for each decrypt and encrypt
through the reverse request `interaction/requestCredentialCipher`. `zcode-rs` only knows `enc:v1:`
(`crates/platform/src/credentials.rs`, `Cipher::decrypt`) and returns any other string verbatim, so:

- the OAuth token and `user_info` are ciphertext, the profile id does not parse, and the personal plan is
  treated as not entitled with no network call and no log;
- the account models vanish from the catalog;
- every turn fails with `invalid request: model account:zai-individual-coding-plan/GLM-5.3-Flash is not available`.

Root-cause evidence (both sides, at `c12012582`):

- Rust: `crates/platform/src/credentials.rs` `Cipher::decrypt` returns `Ok(value)` for any value without
  the `enc:v1:` prefix; `Credentials::present` turns every error into `None` (logged-out look).
- Node: `packages/shared/src/credential-security/systemCredentialCipher.ts` decrypts `enc:v2:` only with the
  Main-held key; `packages/shared/src/credential-security/bridge.ts` answers the reverse request in Main.
- Node agent: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` `createProtocolCredentialCipher`
  delegates every call and has no local key fallback.

## Product rules

1. The OS keyring is owned by Electron Main. In desktop (app-server) mode the Rust agent never reads a key,
   never touches the keyring, and never decrypts locally. Every encrypt and decrypt goes to the Host.
2. Standalone Rust (TUI, `-p`, `zcode login`) uses the system cipher, like the standalone Node CLI
   (`shared-credentials.ts` → `createSystemCredentialCipher`): key from `ZCODE_CREDENTIAL_SECRET`,
   `ZCODE_CREDENTIAL_SECRET_FILE`, the default `credential-secret` file, or the OS keyring; reads `enc:v1:` and
   `enc:v2:`, writes `enc:v2:`. See "Standalone system cipher".
3. Unavailable and decrypt failures are not logout. They never clear tokens, never produce `login_required`,
   and never write `credentials.json`. The user sees that credentials could not be read.
4. Values that look encrypted but are not understood are errors, never plaintext.

## Owners

| Concern                                                              | Owner                                                                        |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| AES key, keyring, `credentials.json` binding                         | Electron Main (`createSystemCredentialCipher`)                               |
| Routing of the reverse request                                       | Host (`zcodeAgentService.ts`, `interaction/requestCredentialCipher` handler) |
| Decrypt/encrypt call policy, error taxonomy, file lock, atomic write | Rust agent `platform::credentials`                                           |
| Bridge transport and reply validation                                | Rust agent `protocol-zcode::cipher` (`HostCredentialCipher`)                 |
| Trait and error type                                                 | `rust-cli-kernel-api::provider` (`CredentialCipher`, `CipherError`)          |

## Interface

kernel-api (`provider.rs`, next to `HeaderSource`):

```rust
#[async_trait]
pub trait CredentialCipher: Send + Sync {
    async fn encrypt(&self, plaintext: &str) -> Result<String, CipherError>;
    async fn decrypt(&self, value: &str) -> Result<String, CipherError>;
}
pub enum CipherError {            // every variant carries a static reason; no values
    Decrypt { reason: &'static str },
    Encrypt { reason: &'static str },
    Unavailable { reason: &'static str },
}
```

Implementations:

- `platform::LocalCipher`: the v1 codec, kept for tests and examples (standalone uses `SystemCipher`, F4). Rules: no prefix → plaintext; `enc:v1:` → v1
  decrypt; `enc:v2:` → `Unavailable` ("standalone agent cannot read desktop-encrypted (v2) credentials yet");
  any other `enc:` prefix → `Decrypt` ("unknown encryption format"); encrypt → v1.
- `protocol-zcode::HostCredentialCipher`: the bridge (below). Used for every app-server run.

`CredentialStore::new(file, secret)` builds `LocalCipher` (standalone, tests). `Platform::with_cipher(paths,
cipher, services)` takes the cipher at construction, because `Platform::new` clones the store into the
registry, personal plans and auth before it returns. `Controller::app(headers, cipher, desktop)` carries
the bridge into the app-server assembly.

## Bridge wire contract

Request (agent → Host, reverse JSON-RPC request on the agent's stdio):

```json
{"method":"interaction/requestCredentialCipher",
 "params":{"requestId":"<uuid v4>","operation":"encrypt"|"decrypt","value":"<string>"}}
```

Limits (`packages/shared/src/validation.ts`, enforced in Rust before the request and on the reply):

- encrypt input: plaintext at most 1,048,576 UTF-8 bytes, refused locally (`Encrypt`, nothing sent);
- decrypt input: a stored value at most 1,398,232 UTF-16 code units (zod `.max` counts code units,
  `CREDENTIAL_CIPHERTEXT_MAX_CHARS`), refused locally (`Decrypt`, nothing sent);
- reply ok value: at most 1,398,232 UTF-16 code units for either operation (schema), and for decrypt at most
  1,048,576 UTF-8 bytes (plaintext); a larger reply is `Unavailable`.

Reply, strict (`requestId` must equal the sent id; any other shape is invalid):

```json
{"requestId":"<same uuid>","result":{"ok":true,"value":"..."}}
{"requestId":"<same uuid>","result":{"ok":false,"error":{"code":"...","message":"..."}}}
```

Error mapping (`HostCredentialCipher`):

| Outcome                                                                   | Result                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------- |
| `ok:true`, value within the limit                                         | success                                            |
| `ok:false`, `ZCODE_CREDENTIAL_DECRYPT_FAILED`                             | `Decrypt`                                          |
| `ok:false`, `CREDENTIAL_CIPHER_INVALID_PAYLOAD`                           | `Decrypt` (decrypt) / `Encrypt` (encrypt)          |
| `ok:false`, `CREDENTIAL_SECURE_STORAGE_UNAVAILABLE`, any other code       | `Unavailable`                                      |
| JSON-RPC error (including `-32602` "Credential cipher is unavailable")    | `Unavailable`                                      |
| invalid reply (shape, `requestId` mismatch, size limit)                   | `Unavailable`                                      |
| connection closed before a reply                                          | `Unavailable`                                      |
| no reply within the bridge timeout                                        | `Unavailable`                                      |
| JSON-RPC error (any code, including `-32602`), closed connection, timeout | `Unavailable`; the Host message is never passed on |

Timeout: 300 s, one bounded wait per request. The Host drops a reverse request that arrives before its
listener is attached (`zcodeAgentService.ts` attaches `onRequest` after the client is returned from spawn),
so without a bound a lost request would hang the caller forever. A first Keychain prompt can also wait on
the user, so the bound is generous. The timeout is the only one in the bridge; there is no retry.

## Sequence

```mermaid
sequenceDiagram
  participant A as Rust agent (platform)
  participant H as Host (zcodeAgentService)
  participant M as Electron Main (system cipher)
  A->>A: seal(value) before taking the file lock
  A->>H: interaction/requestCredentialCipher {requestId, operation:"encrypt", value}
  H->>M: cipher request over parentPort
  M-->>H: {requestId, result:{ok:true, value:"enc:v2:os:..."}}
  H-->>A: reply (validated by the agent against inbound.json)
  A->>A: lock credentials.json; get() decrypts only the keys the comparison needs
  A->>H: interaction/requestCredentialCipher {operation:"decrypt", value:"enc:v2:..."}
  H->>M: decrypt
  M-->>H: {ok:false, error:{code:"CREDENTIAL_SECURE_STORAGE_UNAVAILABLE"}}
  H-->>A: reply → Unavailable: mutate aborts, nothing written, no token cleared
```

## Read and write surface

- `Credentials::get`, `present` are async and return `Result`. `present` no longer maps errors to `None`.
  Only a missing key, or a value that is empty after trim, is absent.
- Writes: `CredentialStore::seal(value)` encrypts first (outside the lock). `mutate` takes an async closure
  that runs under `with_file_lock`; it reads, applies the change (which may `get` for comparisons), and
  atomically writes back only when the closure returned `Ok`. A failed closure, a corrupt file or an
  Unavailable cipher leaves the file unchanged.
- Lock file, atomic write and JSON layout are unchanged.

## Account overlay on Unavailable

- A credential read that fails with Unavailable or Decrypt does not publish a logged-out overlay.
- If a snapshot is already published, `Registry::current` keeps it (last known result). The credentials
  stamp is not recorded, so the next call re-reads the file.
- If nothing has been published yet, the snapshot is published without account entitlements, flagged
  `credentials_unreadable`. API-key providers are unaffected.
- `Platform::endpoint` for a model that is not in the catalog checks the flag first and fails with
  "ZCode credentials could not be read (<static reason>)". It does not say "not available" and does not
  say "log in".
- Node reference: `bridge.ts` and `CONTRACT.md` say cipher unavailability must not be classified as a
  logged-out state. Node's `shared-credentials.ts` throws a read error rather than treating the store as empty.

## Logging

- One `warn` per transition from readable to unreadable, with a static reason
  (`reason = "credential storage unavailable" | "credential could not be decrypted"`). Never log a value,
  a key, a Host message or a user id.
- Recovery is logged at `info` once.

## Acceptance scenarios

| #   | Scenario                                                 | Expected                                                                       |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A1  | Standalone: `enc:v1:` value                              | decrypts as before (Node-identical vectors)                                    |
| A2  | `LocalCipher`: `enc:v2:` value                           | `Unavailable` (standalone reads it through `SystemCipher`, F4)                 |
| A3  | Standalone: `enc:v9:` or `enc:` garbage                  | `Decrypt`, never the raw string                                                |
| A4  | Bridge: encrypt then decrypt round trip with a fake Host | same plaintext                                                                 |
| A5  | Bridge: reply `requestId` differs                        | `Unavailable`                                                                  |
| A6  | Bridge: JSON-RPC `-32602`                                | `Unavailable`                                                                  |
| A7  | Bridge: `DECRYPT_FAILED` / `INVALID_PAYLOAD`             | `Decrypt` / `Encrypt`                                                          |
| A8  | Bridge: plaintext over 1,048,576 bytes                   | rejected before sending; no request                                            |
| A9  | Bridge: reply over the limit                             | `Unavailable`                                                                  |
| A10 | Bridge: connection closed / no reply within the timeout  | `Unavailable`                                                                  |
| A11 | `enc:v2:` credentials file + fake Host decrypts          | entitled account overlay; account models in the catalog                        |
| A12 | Host answers Unavailable during a read                   | tokens, `credentials.json` and the auth state unchanged; no `login_required`   |
| A13 | Host answers Unavailable during `mutate`                 | closure aborted, file byte-identical                                           |
| A14 | Unreadable credentials after a successful publish        | last known account models remain                                               |
| A15 | Unreadable credentials at first read                     | API-key models present; account model error says credentials could not be read |

## Before and after

|                         | Before                                        | After                                       |
| ----------------------- | --------------------------------------------- | ------------------------------------------- |
| `enc:v2:` in desktop    | returned as plaintext (bug)                   | decrypted by Main through the bridge        |
| `enc:v2:` standalone    | returned as plaintext (bug)                   | `Unavailable` with a clear message          |
| bridge unavailable      | every value silently absent (logged out look) | error, tokens kept, last known catalog kept |
| write while unavailable | not reached; reads treated as absent          | `mutate` aborts, file unchanged             |

## Startup ordering (app-server)

Found in review. Red test `cli/tests/app_server_credentials.rs` failed before the fix: the agent sent a cipher
request during startup and waited for a reply it never read, so `ready` did not arrive within 10 s.
`Controller::app` sets `wait_model`, so `assemble::ports` → `models::default_model` reads the catalog (and so
`credentials.json`) before `serve()` reads stdin. Every desktop start with account credentials would have
stalled to the bridge timeout before `ready`, and the Host waits for `ready`.

Options:

- (b) Node parity: no cipher use before serving; fail fast as Unavailable. Rejected. With `wait_model`,
  `default_model` settles the default from the catalog and persists it (`memory::remember`). A fail-fast read
  would persist a default chosen without the account models.
- (a) Reader first (chosen). The app-server starts `connection::serve` on stdin before assembly, with a
  `connection::Deferred` service. Replies to the agent's own requests resolve inline, so a cipher reply is
  routed during assembly. The Host's requests are spawned and wait in `Deferred` until the kernel exists
  (`Install::install` after `Startup::ready` and the defaults), so none are dropped. If assembly fails before
  install, waiting requests get an error.

Node differs on purpose: Node creates the server before it reads stdin, and its default-model startup does not
read credentials, so its early bridge call fails as Unavailable without a stall. Rust settles the default in
assembly, so its reader must run first.

Host side (`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`, `zcodeAgentService.ts`): the
protocol client, and so the stdout reader, is created at spawn. `onRequest` is attached in `wireClient`, right
after `getClient` returns (chat lane, `zcodeAgentService.ts`). The agent sends its first reverse request only
after its own process start, argument parsing, config and store open, which is tens of milliseconds after
spawn. This ordering alone is not formal; the acknowledgement (F1) closes it.

## Degraded default (not remembered)

If the credentials are unreadable when the default is settled (locked keyring, or the Host attach race), the
catalog has no account models and the default is picked from what is left. That settlement is marked degraded
(`Settled { degraded: true }`, cli `assemble/models.rs`), and `default_model` does not call `memory::remember`
for it. The remembered choice therefore stays the remembered one, and the next startup with readable
credentials settles from the full catalog again. Test: `a_default_settled_while_credentials_are_unreadable_is_not_remembered`.

The default is settled again when the store becomes readable later in the same session (F3).

## Follow-ups (2026-11-13)

### F1. Host attach acknowledgement

Problem: the Host attaches `onRequest` in `wireClient`, after `getClient` returns from spawn. A reverse request
that arrives earlier is dropped, and assembly (`wait_model`) then waits for the 300 s bound before `ready`.

Contract (`packages/shared/src/zcode-protocol/index.ts`):

- Spawn declaration: `ZCodeAgentProcessManager` sets `ZCODE_HOST_ATTACH_ACK=1` (`ZCODE_HOST_ATTACH_ACK_ENV`) in
  every agent's environment. Every client it returns is wired by `zcodeAgentService.wireClient` before use (chat,
  plugin and mcp-status lanes), so every declared agent gets the acknowledgement.
- Notification Host → agent, sent once per client by `wireClient`, right after `client.onRequest(...)` is attached:

  ```json
  { "method": "process/hostAttached", "params": { "credentialCipher": true } }
  ```

  `zcodeProcessHostAttachedParamsSchema = z.object({ credentialCipher: z.boolean() }).strict()`.
  `credentialCipher` says whether this Host can answer `interaction/requestCredentialCipher`.

- Node agent: the transport drops the notification on arrival (it never enters the serial queue). Node sends its
  reverse requests only from a served connection and fails an early cipher call fast, so it needs no gate.
- Rust agent (`protocol-zcode::Context`):
  - The app-server reads `ZCODE_HOST_ATTACH_ACK` once at start. Declared: reverse requests (credential cipher,
    provider runtime headers) wait for the acknowledgement before they are sent. Not declared (an older Host, a
    test harness): they are sent at once, as before.
  - The wait is part of the existing per-request bound (300 s cipher, headers bound unchanged); there is no new
    timeout.
  - `credentialCipher: false`: cipher calls fail as `Unavailable` ("the host has no credential cipher") without a
    request.
  - The acknowledgement is handled by a wrapper in front of `connection::Deferred`, inline in the reader's
    notification task. It must not go through `Deferred`: assembly waits for it, and `Deferred` waits for assembly.
  - Params are validated against `inbound.json` (`methods["process/hostAttached"]`). An invalid acknowledgement is
    ignored with a `warn`; the bound applies.
- Compatibility: a new Host with an older agent sends a notification the agent ignores. An older Host never
  declares, so a new Rust agent behaves as before.

```mermaid
sequenceDiagram
  participant PM as Host process manager
  participant S as Host service (wireClient)
  participant A as Rust agent
  PM->>A: spawn (env ZCODE_HOST_ATTACH_ACK=1)
  A->>A: reader starts, assembly begins
  A->>A: cipher call waits for the ack (inside the 300 s bound)
  PM-->>S: getClient returns
  S->>S: client.onRequest(...) attached
  S->>A: process/hostAttached {credentialCipher:true}
  A->>S: interaction/requestCredentialCipher (now routed)
  S-->>A: reply
  A->>S: startup/storageState ready
```

### F2. Usage panel "unknown" state

`FamilyAccount.signed_in: bool` becomes `login: FamilyLogin { SignedIn, SignedOut, Unreadable }` (platform), and
the TUI's `FamilyStatus` carries the same three states.

- `Unreadable` when `credentials.json` cannot be read (`CredentialStore::read` fails), or this family's login or
  manual key read fails with `Unavailable`/`Decrypt`. It is per family: one family's undecryptable value does not
  mark the other family.
- `SignedOut` only when the values are absent (the existing rule).
- TUI: the family row says "sign-in unreadable"; the family page shows an Account row "Could not read the saved
  sign-in" and offers neither Sign in nor Sign out (a write would abort, product rule 3); the session page's Account
  row says "sign-in unreadable"; `/logout` with no signed-in family but an unreadable one says the sign-in could
  not be read and signs nothing out.

### F3. Re-settled session default

When the default was settled degraded (credentials unreadable, `Settled { degraded: true }`), the default-model task
keeps running in the `default-model` scope (TUI and app-server alike, held by `Built`):

1. It waits for `Platform::credentials_readable()`, which resolves when a registry read
   (`Registry::current`) succeeds after an unreadable one. Recovery is pull-based: the next catalog read does it
   (a Host model or registry request, a session's endpoint lookup, the TUI model picker or settings).
2. It runs the same choice again (`--model`, effort) and revises `DefaultModel` (`SettleDefault::settle` may be
   called again; `settled()` returns the latest value).
3. A non-degraded result is remembered (`memory::remember`); a degraded one waits again.

Only sessions created after the revision take the new default. Existing sessions keep their selection. The
app-server's `Defaults.selection` becomes the shared `DefaultModel`, read at each session creation.

A degraded choice that finds no model does not write the model port's permanent "no model" reason
(`Assembled::late`): it would outlive the recovery. Until then, the endpoint lookup reports that the credentials could
not be read.

```mermaid
sequenceDiagram
  participant T as default-model task
  participant P as Platform / Registry
  participant D as DefaultModel
  participant K as session creation
  T->>P: choose(): catalog read, credentials unreadable
  T->>D: settle(degraded choice), not remembered
  K->>D: current() → degraded choice
  P->>P: later read succeeds (Host answers again)
  P-->>T: credentials_readable()
  T->>P: choose() again
  T->>D: settle(full choice), remembered
  K->>D: current() → full choice (new sessions only)
```

### F4. Standalone system cipher

`platform::SystemCipher` ports `systemCredentialCipher.ts` for standalone Rust (TUI, `-p`, `zcode login`). The
app-server keeps `HostCredentialCipher` (product rule 1).

- Key sources, in Node's order: `ZCODE_CREDENTIAL_SECRET` (both it and `ZCODE_CREDENTIAL_SECRET_FILE` set:
  `Unavailable`); `ZCODE_CREDENTIAL_SECRET_FILE` (readable file, 32–4096 bytes); otherwise, under the
  `<credentials.json>.keyring` file lock: `credential-source` must be absent or `os\n`; if neither it nor
  `enc:v2:os:` pins the OS source, the default `<dir>/credential-secret` (private: no group/other mode bits on Unix,
  32–4096 bytes) is the `env` key; a file with `enc:v2:env:` and no secret is `Unavailable`; else the OS keyring
  entry (service `ZCode Credential Encryption`, account = hex sha256 of the resolved `credentials.json` path),
  43 base64url characters → 32 bytes. Creating the key (encrypt only, when nothing pins the OS source and the file
  has no `enc:v2:`) writes a random key, reads it back, and pins `credential-source` to `os\n`.
- Keyring backend: the same crates `@napi-rs/keyring` 2.1.2 uses (`keyring-core` 1, `apple-native-keyring-store`
  keychain on macOS, `dbus-secret-service-keyring-store` with `crypto-rust`+`vendored` on Linux,
  `windows-native-keyring-store` on Windows), with `Entry::new(service, account)`: the same item the desktop app
  reads and writes. Calls run on the blocking pool.
- Format: `enc:v2:<os|env>:<first 24 hex of sha256(key)>:<iv>.<tag>.<ct>` (base64url, AES-256-GCM). Decrypt
  checks the shape (`Decrypt`), then the source and fingerprint (`Unavailable`), then the tag (`Decrypt`).
- `enc:v1:` values: the legacy candidates are `[secret, secret.trim(), fallback]` with the env secret, or the
  fallback alone with the OS source (Node passes `ZCODE_CREDENTIAL_SECRET: undefined`). Plaintext values are returned
  as they are. Neither needs the keyring value, so reading them never touches the keyring (Node resolves the key
  first; the outputs are the same).
- Any other `enc:` prefix: `Decrypt`.
- Cache: one key lookup per cipher; a failure is cached only when the lock was acquired (a denied Keychain
  prompt is not repeated; a lock timeout is retried).
- Not ported: read-time migration of `enc:v1:` values to `enc:v2:` (`migrateCredentialRecord`). Rust rewrites a
  value only when it writes that key. The file is shared with the desktop app, which reads both formats.
- Tests never construct the OS keyring: the key store is injected (`KeyStore` trait). Parity vectors come from the
  Node implementation (fixed key, fixed IV) in both directions.
- `zcode login` without any key source (headless Linux without Secret Service) fails as `Unavailable` with Node's
  message, like the Node CLI.

### Acceptance scenarios (follow-ups)

| #   | Scenario                                                                | Expected                                                        |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| B1  | Ack declared; cipher call before the ack                                | not sent until the ack; sent right after it                     |
| B2  | Ack declared; ack says `credentialCipher:false`                         | `Unavailable` at once, no request                               |
| B3  | Ack not declared                                                        | request sent at once (as before)                                |
| B4  | App-server process with the ack declared; Host acks after a delay       | `ready` follows the ack; the cipher request comes after the ack |
| B5  | Host `wireClient`                                                       | one `process/hostAttached` per client, after `onRequest`        |
| B6  | Node transport receives `process/hostAttached`                          | dropped, connection unaffected                                  |
| B7  | Stored values unreadable                                                | those families `Unreadable`, no Sign in / Sign out              |
| B8  | One family's token undecryptable                                        | that family `Unreadable`, the other unaffected                  |
| B9  | Default settled degraded, then a registry read succeeds                 | default revised to the full choice and remembered               |
| B10 | Standalone: Node-encrypted `enc:v2:os` / `enc:v2:env` values            | decrypted; Rust output decrypts in Node                         |
| B11 | Standalone: fingerprint or source mismatch                              | `Unavailable`                                                   |
| B12 | Standalone: both env sources / bad secret file / pinned non-`os` source | `Unavailable`                                                   |
| B13 | Standalone: encrypt with no key yet                                     | key created once, read back, `credential-source` = `os\n`       |
| B14 | Standalone: decrypt `enc:v2:` with no key                               | `Unavailable`, no key created                                   |

## Open gaps

- Process test covers the startup stall and the cipher round trip, not the account entitlement or the
  selected default after startup at process level. The entitlement path is covered by the platform
  integration test `desktop_encrypted_credentials_entitle_the_account_models`. A process test needs the account
  HTTP fake served from the cli test; follow-up.
- Standalone read-time `enc:v1:` → `enc:v2:` migration is not ported (F4).
- Node's own bridge has no timeout; the Rust bound (300 s) is a Rust-only addition, see the timeout rationale above.
