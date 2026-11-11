# Agent runtime selection (Node / Rust)

Status: draft. Phase 1 (selection, Host resolver, storage preparation, hello overrides and command gate) implemented; phase 2 (UI switch) waits for the fork features below to be covered on the Rust side; phase 3 (packaged binary) is implemented: release builds ship `zcode-rs` while the default runtime stays `node`.

## Problem

The desktop Host always runs the Node agent (`zcode.cjs app-server --stdio`), which idles at ~350 MB RSS. Upstream's own Rust agent (`zcode-rs`, MBearo/ZCode-rs `packages/rust-cli`, Apache-2.0) speaks the same stdio protocol and idles at ~32 MB (measurements in `specs/rust-port-research.md` §9a). The only existing way to run another agent is `ZCODE_AGENT_SERVER_COMMAND`. With that override the Host turns off storage preparation, so startup fails with `unsupported_runtime`. That is intended for unknown custom commands, so the override stays as it is.

## Product rules

1. **Two runtimes, one choice per app process.** `node` (default) or `rust`. The choice is fixed when Main starts. Every Host that process spawns gets the same value. Changing the setting takes effect after an app restart. Windows never mix runtimes.
2. **Sources, highest first:**
   1. `ZCODE_AGENT_SERVER_COMMAND`: the upstream custom-command override, unchanged. It bypasses this feature entirely.
   2. `ZCODE_FORK_AGENT_RUNTIME=node|rust`: the shell env override. Invalid values are ignored with a `warn`. It is read from Main's own `process.env` at launch; the login-shell env patch that runs later does not change the latched choice.
   3. The fork setting `agentRuntime`.
   4. The default, `node`.
3. **Storage preparation always stays on Node.** The Rust agent is spawned only as the conversation process. Database preparation and migrations, including fork `9001_fork_*`, keep running in the Host Worker from the bundled `zcode.cjs` (`storagePreparationEntry`). If no Node bundle is available, Rust is not selectable, because a Rust agent without prepared storage would open an unmigrated database.
   - **The same step seeds the official plugins in Rust mode.** `zcode-rs` only reads the official plugin store (`platform/src/local/plugin_inventory.rs`: `cache/zcode-plugins-official/<name>/<version>` and `marketplaces/zcode-plugins-official/bundled-marketplace.json`) and has no copy of the plugin sources. Node's agent seeds that store itself on its first plugin resolution (`bundled-plugins.ts` `resolveOfficialPluginRoots`). With Rust effective no Node agent runs, so on a fresh home Rust would list no official plugin skill. The storage Worker already ships the plugin sources, so when its env has `ZCODE_FORK_AGENT_RUNTIME=rust` it runs the same `resolveOfficialPluginRoots` once the database is prepared (`fork-rust-agent-plugin-seed.ts`, called from the `prepareStorageOnly` branch of `runZCodeProtocolAgent`).
     - **Rust only.** With Node effective it does nothing, and the Node agent stays the only seeder. Measured on the dev bundle (Apple M-series, 17 plugins, 66 MB): a cold seed adds ~230 ms to the Worker, a warm one ~70 ms, because each Worker re-hashes every bundled plugin file (the hash memo is per process). Doing it in Node mode would add the warm cost to every default start for nothing.
     - **Store root.** The one the Rust agent reads (`StoragePaths::plugin_storage`): the merged `storage.dir` with `~/` expanded, a relative path resolved against the workspace, then `<cli storage root>/plugins`.
     - **Never fails preparation.** A seed error is logged at `warn` and the Worker still exits `0`; the Rust agent then sees whatever usable cache already exists. The seed writes nothing to stdout, the Host's control channel.
     - **Same content as Node.** Seeding writes every bundled plugin, including `computer-use`; `suppressedBuiltins`, default enablement and the Node-only plugins are filtered when `zcode-rs` discovers plugins (`ext/src/plugins/select.rs`), as Node filters at discovery.
4. **No silent lie about the runtime.**
   - Main resolves which runtime is in effect. If `rust` is selected but no `zcode-rs` binary is found, Main runs Node and logs at `warn`: `selected=rust effective=node reason=binary_missing`.
   - Main writes only the effective runtime into the Host env.
   - The Host repeats the check: if its env says `rust` but there is no binary path or no Node storage bundle (the dev source-tree command), it runs Node and logs once at `warn`: `selected=rust effective=node`, `reason=binary_path_missing|no_node_bundle`.
   - Once phase 2 lands, the UI shows the effective runtime next to the switch.
5. **The Host tells the UI the truth about the runtime.** The Host's `hello` capability literals (`zcodeAgentService.ts` `helloConversationV4` and `zcodeAgentConnectionScope.ts`) claim fork capabilities statically. In Rust mode one fork helper, `forkAgentRuntimeHelloOverrides`, turns off the ones `zcode-rs` lacks: `incognitoSession`, `incognitoPromptToggles`. (`independentPlanState` was on this list until `zcode-rs` froze the plan switch per queued input, see `specs/fork-rust-agent-parity.md`.)
   - `durableFirstSubmission` stays claimed: `zcode-rs` implements the first-submission contract itself (reserve with `submissionPreparation`, activate with `preparedSessionId` + `expectedSubmissionId` and a `preparedActivation` result, completion on the first admitted `sendText`) and reports `durableFirstSubmission: true` from `runtime/capabilities`, so the Host gate `ensureDurableFirstSubmissionSupport` passes unchanged. The composer always uses the durable route (`SessionPane` passes the flag as a constant), so a runtime without the contract cannot be served by turning the hello flag off.
   - `zcode-rs` stores the marker in the same `session_entry` record the Node agent writes (`v4/fork_submission_preparation`, id `v4/fork_submission_preparation:<sessionId>`, data `{submissionId, status}`), so a session reserved by one runtime can be activated by the other after a switch.
   - The UI prewarms a new task's session with a plain `createSession` before the first send. The Node agent keeps that prewarm deferred and adopts it on reservation; `zcode-rs` persists it at once, so its reservation adopts an existing session only when it has no marker, no messages, no queued input, no running turn, and the same workspace. A repeated reservation by the same submission returns the same session; any other existing session is refused with `proto.invalidPayload`.
   - With the incognito flags off the UI does not offer incognito sessions.
   - Fork features that have no capability flag are refused by a Host command gate (rule 7) instead of silently degrading.
   - Phase 1 is env and sidecar only, meant for development. Phase 2 (the user-visible switch) waits until the table below has no "refused" or "lost" rows that users would hit.
6. **Local Host only.** Remote SSH/WSL hosts (`zcode-server.cjs`) never receive the env from Main and keep their own resolver chain. Web/server mode is unchanged.

7. **Fork features without a capability flag are refused, not dropped.** `forkAgentRuntimeCommandGateError` runs in the Host command path right after `getClient`, in Rust mode only, and fails the command with a stable error code:
   - `proto.forkRustAgent.executionWorktreeUnsupported` for `updateWorktreePreparation`, and for `createSession` carrying `worktreePreparation` or `executionWorktree`. Without the gate `zcode-rs` would ignore the field and run the task in the main checkout.
   - `proto.forkRustAgent.externalAgentUnsupported` for `setExternalAgentConfigOption`, and for any `modelSelection.providerId` starting with `acp:` (in the payload, in `config`, or in `firstInput`), and for a `provider` starting with `acp:` (`switchModelConfig.provider`, `createSession.config.provider`).

## Fork features in Rust mode

Fork agent-side features write agent-owned `fork_` columns in `db.sqlite` (`apps/zcode-cli/packages/adapters/src/storage/session-store/fork-migrations.ts`), and `zcode-rs` implements none of them. The rows below are the phase 1 behavior. They block phase 2.

| Feature                                              | Owner of state                                  | Carried to agent by                                                                      | Gate                                                                               | Rust mode                                                                                                                                                                                             |
| ---------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First-message reservation (`durableFirstSubmission`) | agent (`session-mgmt.ts` reservation, receipts) | `createSession` `submissionId` / `prepared`                                              | `hello` capability                                                                 | implemented in `zcode-rs` with the Node-compatible marker record                                                                                                                                      |
| Incognito session                                    | agent (`fork_incognito_profile`)                | `createSession` options                                                                  | runtime capabilities (`zcode-rs` reports no `incognitoSession`), checked at create | off via hello override; not offered                                                                                                                                                                   |
| Independent plan state                               | agent                                           | `v4/conversation/plans`                                                                  | runtime capability `independentPlanState` (`zcode-rs`: true)                       | on: plan is frozen per queued input (`Command::SubmitWith`)                                                                                                                                           |
| Execution worktree                                   | agent (`fork_execution_worktree`)               | `createSession` `worktreePreparation` / `executionWorktree`, `updateWorktreePreparation` | none upstream                                                                      | refused by the Host command gate                                                                                                                                                                      |
| ACP agent binding / config / pending choice          | agent (`fork_session_acp_*`)                    | `modelSelection.providerId = "acp:<id>"`, `setExternalAgentConfigOption`                 | none upstream                                                                      | refused by the Host command gate                                                                                                                                                                      |
| Usage rollup / detached usage                        | agent, internal                                 | none (agent-internal pruning)                                                            | none                                                                               | **lost**: usage older than 30 days and totals of deleted sessions are not rolled up. Whether Rust-side pruning also removes rows the Node agent would have rolled up is unverified.                   |
| Draft prewarm                                        | agent (`session` row)                           | plain `createSession` before the first send                                              | none                                                                               | `zcode-rs` persists every prewarm: an abandoned new task leaves an empty `session` row (not shown in the sidebar in the 2026-11-07 run); draft cleanup returns `proto.unsupportedCommand`             |
| File attachments                                     | agent (session artifacts + user message)        | `v4/attachment/{begin,chunk,commit,abort,read,previewSource}`, `sendText` `attachments`  | none                                                                               | implemented in `zcode-rs` (see "Attachments in Rust mode"); video, image resizing, `topic-history`/`clipboard-text` refs, Share reads (`v4/conversation/attachmentRead`/`attachmentStat`) are missing |
| ChatGPT Plan provider (`account:chatgpt-plan`)       | agent (`chatgpt-account` access, account layer) | `modelSelection.providerId`                                                              | none                                                                               | listed but closed: `zcode-rs` has no `chatgpt-account` access, so the model has no credentials and the provider reports an `access` issue                                                             |

Responses from the agent are parsed with `.parse` (unknown keys stripped) and notifications with `safeParse` (invalid ones dropped), so a Rust agent that omits fork-only fields does not crash the Host.

## Attachments in Rust mode

`zcode-rs` ports Node's upload transaction and attachment mapping; the UI and the Host are unchanged.

- **Upload** (`attachment-upload-registry.ts` semantics): uploads are keyed by `connectionId`, `sessionId` and `uploadId`. `begin`, `chunk` and `commit` are idempotent for a repeat with the same metadata or bytes. `abort` waits for a commit in flight. A closed connection drops its uploads. Limits and `fault.attachment.*` codes match `PROTOCOL_V4_LIMITS`. Commit checks the SHA-256 and stores the bytes the way Node's `writePromptAttachment` does: a session artifact holding `data:<mime>;base64,<bytes>` as `text/plain`, referenced as `zcode-artifact://<session>/<artifact>`. Node reads it back by id.
- **Send** (`attachment-refs.ts` semantics): `sendText` reads each ref before admission:
  - an image up to 5 MiB is read inline (base64);
  - UTF-8 text up to 64 KiB is read inline;
  - any other file, or a ref that cannot be read, keeps only its metadata.

  Web-remote refs are the session artifacts `commit` answered. Desktop refs are local absolute paths: the Host's prompt attachment transfer is zero-copy on a local Host, so the agent reads the file itself (through `rust-cli-fs`). A ref that cannot be read, or an artifact of another session, is never dropped silently, and the log names only the fault code, never the path. While a turn runs, an input with attachments is queued until that turn ends; it is never steered in.

- **One owner, the `file` part:** each attachment is a kernel `ContentBlock::File` on the user message, stored as Node's `file` part after the user's text part:
  - inline text: `mime: text/plain`, `filename`, `source.text.value` = the file name, `metadata.preview.text`, `storageKind: inline`, `recoverability: provider_ready`;
  - image: Node's artifact shape (`persistAttachmentDataUrl`): `url` and `metadata.artifactUri` are the session artifact holding `data:<mime>;base64,<bytes>`, `storageKind: artifact`. A web-remote ref is already that artifact and is reused; a desktop image is written as a new artifact when the input is accepted. Node builds the chip's `ref` only from a `url` that is not a data URL, and reads the model image back from the artifact. If the artifact cannot be written, the part falls back to the inline data URL (`storageKind: inline`): both runtimes still read it, but the chip under Node has no ref;
  - metadata only: `recoverability: metadata_only`;
  - every part keeps the App's ref as `metadata.originalUrl`, its size as `metadata.sizeBytes`, and the App's `previewRef` as the fork key `metadata.previewRef`.

  The text part holds only the typed text; `metadata.modelInput` is not written for attachments. Both runtimes rebuild the model input from the parts: Node through `hydrateMessageHistoryFromSession`, Rust by reading the part back into `ContentBlock::File` and expanding it in `query::normalize` (the only expansion point) into Node's Read-style reminder pair, the image block, or the "Attached file" metadata reminder. An artifact-backed image part (written by either runtime) is read back when the store loads the session: the store reads the artifact and turns the block into the base64 image, before the model sees it. An artifact that is missing, of another session, larger than 5 MiB or not a data URL reaches the model as the metadata reminder. Rows stored before this change keep the reminders in `metadata.modelInput`; the bubble strips them.

- **Rows and preview**: a `userInput` row, live or cold, carries chips built from its `file` parts (`{fileName, mime, bytes, ref?, previewRef?}`, Node `attachmentMetasOfMessage`); a queued input shows the refs it was sent with. `attachmentRead` serves a ref only if a row of that session carries it, so it keeps working after an agent restart. `previewSource` always answers `{kind: "chunked"}`.
- **Command correlation after a restart**: a cold `userInput` row and its turn header carry `sourceCommandId`, read from the stored `anchor.sourceCommandId` (Node writes the same anchor). The kernel keeps a `message id → command id` map: the store loads it, and the session actor adds an entry when it commits a typed user message (Human, not an interrupt, not bash output; the same filter as the store's anchor) under a command. `v4/commands/query` can still answer a pending command from the stored command facts; the row is what settles a held first-submission copy (`commandRowProjected`) and a pending entry from the snapshot alone.

## State owners

- **Setting:** the fork settings sidecar `~/.zcode/v2/fork-settings.json`. The key `agentRuntime: "node" | "rust"` goes in `FORK_SETTING_KEYS`. The default `node` is materialised by `forkAppSettingsSchema` and never written back. It must not go into `setting.json`, because upstream writes strip unknown keys.
- **Selection:** the managed Main module `desktop-fork-agent-runtime` (`packages/desktop/src/main/fork-agent-runtime/`).
  - It resolves selected → effective runtime once, before the first Host fork. It does this inside the existing `awaitFirstHostSpawnDecision` latch, reading `mainSettingService.get()` asynchronously.
  - `mainSettingService.get()` returns effective settings, with the `node` default materialised. So the logged `source` is `setting` whenever the env does not override, including on a fresh profile; `default` appears only when the read fails. Precedence is unaffected.
  - It latches the result for the rest of the process.
  - Main is the only one that decides: it deletes any inherited `ZCODE_FORK_AGENT_RUNTIME` / `ZCODE_FORK_RUST_AGENT_PATH`, then writes the decided values into the Host env, the same pattern as the Dynamic Workflow env.
- **Binary location:** Main resolves the binary, first match wins:
  1. `ZCODE_FORK_RUST_AGENT_PATH`, the explicit path. It must exist.
  2. Packaged builds: `<resources>/zcode-rs/zcode-rs[.exe]`.
  3. Dev builds: `packages/desktop/resources/zcode-rs/zcode-rs[.exe]`.

  It must not live under `resources/glm/`: `findZCodeAgentRuntimeBinary` scans that directory and would pick `zcode-rs` up as the native fallback, without storage startup.

- **Command, hello overrides, command gate:** the managed Host module `services-fork-agent-runtime` (`packages/services/src/zcode-agent/fork-agent-runtime/`). All three read the Host env (`ZCODE_FORK_AGENT_RUNTIME`), which Main writes once per Host.
- **Command:**
  - It takes the bundled Node command and returns either that same command or the Rust command: `[app-server, --stdio]`, plus `--surface desktop` added by the existing presentation step. The Rust command reuses the Node command's `storagePreparationEntry`.
  - Upstream `resolveDefaultZCodeAgentCommand` gets a one-line wrap around its bundled branch. `prepareSessionStorage` and the process manager both call that resolver, so storage preparation and agent spawn see the same decision with no further edits.

## Event order

```text
app start (Main)
  awaitFirstHostSpawnDecision ─┬─ desktop-context-prompt rollout (existing)
                               └─ forkAgentRuntimeSelection.prime()
                                    mainSettingService.get().agentRuntime
                                    + ZCODE_FORK_AGENT_RUNTIME (env override)
                                    + resolve zcode-rs binary
                                    → latched {selected, effective, rustAgentPath}   (info log once)
spawnHostProcess (every window)
  env = buildHostProcessEnv(...) − inherited ZCODE_FORK_* + latched effective values
Host (utility process)
  InitLocal → createHostDatabaseStartup
    prepareHostStorage (tasks-index)                       Node Worker
    prepareSessionStorage → resolveDefaultZCodeAgentCommand
                             → storagePreparationEntry = bundled zcode.cjs   Node Worker, migrations
                               → effective=rust: seed official plugins        same Worker, after storagePrepared, before exit
  getClient → resolveDefaultZCodeAgentCommand
               → effective=rust ? zcode-rs app-server --stdio : zcode.cjs   conversation process
```

Both resolver calls read the same immutable Host env, so storage preparation and agent spawn cannot disagree within one Host. Both processes resolve the database path from the same env (`ZCODE_DATA_BASE_DIR`, `ZCODE_STORAGE_DIR`, `ZCODE_SESSION_DB_PATH`, and the `storage` config). Acceptance scenario 4 checks that they agree.

## Source

The Rust agent lives in this repository at `packages/rust-cli`, the same path it has in MBearo/ZCode-rs:

- osben/ZCode#382 imported `packages/rust-cli` from MBearo/ZCode-rs `cfc27e0e` unmodified and added the fork patches on top. It was squash-merged, so the whole fork delta is the diff between MBearo/ZCode-rs `cfc27e0e:packages/rust-cli` and this tree. A later upstream refresh replaces the imported tree and replays that delta.
- `crates/platform/assets/zcode-builtin.json` is the fork's `config/provider/zcode-builtin.json` (the test `the_bundled_builtin_is_the_repository_copy` keeps them equal); sync it whenever the fork's catalog changes.
- The tree keeps upstream bytes. `.gitattributes` marks it `linguist-vendored` (the staged-file size check skips it) and `-whitespace` (its migration SQL feeds checksums shared with the Node agent). `.oxfmtrc.json` ignores it. Rust code is checked with `cargo fmt`, `cargo clippy --workspace --all-targets -- -D warnings` and `cargo test`. It has no `package.json`, so pnpm and the architecture check do not see it.
- CI: `pr-checks.yml` job `Rust CLI (fmt, clippy, tests)` runs `cargo fmt --check`, clippy with `-D warnings`, `cargo nextest run --workspace --retries 2` (upstream's runner and `.config/nextest.toml`) and the doctests, on the debug profile with the toolchain from `rust-toolchain.toml`, when a PR changes `packages/rust-cli/**`; it is skipped otherwise. The retries absorb the known upstream flakes (`rust-cli-fs` `exclusive::tests::only_one_holder_at_a_time`, `rust-cli-platform` `team::platform_tests::an_account_change_during_the_query_discards_the_round`), which are reported as flaky. The job fails if `build-number` changes.
- Local build: from `packages/rust-cli`, `CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP=false cargo build --release -p rust-cli`, then point `ZCODE_FORK_RUST_AGENT_PATH` at `packages/rust-cli/target/release/zcode-rs`. The strip override keeps proc-macro dylib metadata on macOS. A local release build bumps the tracked `build-number` counter (upstream's version scheme); do not commit that bump.

## Packaging and licensing (phase 3)

- `fork-release.yml` builds `zcode-rs` in both release jobs (macOS arm64, Windows x64): the toolchain from `packages/rust-cli/rust-toolchain.toml`, `cargo build --release --locked -p rust-cli --bin zcode-rs` with `CARGO_PROFILE_RELEASE_BUILD_OVERRIDE_STRIP=false`.
- `scripts/fork-rust-agent/stage-resources.mjs` stages the binary into `packages/desktop/resources/zcode-rs/` (gitignored) with its license material:
  - `LICENSE`: the repository's Apache-2.0 license, which is also `zcode-rs`'s (MBearo/ZCode-rs is Apache-2.0).
  - `NOTICE.md`: the repository notice.
  - `VENDORED-THIRD-PARTY-NOTICES.txt`: `packages/rust-cli/vendor/THIRD-PARTY-NOTICES.txt`, the C and C++ sources vendored under `vendor/`.
  - `CRATE-LICENSES.md`: the licenses of the linked crates, generated by `cargo about` (0.9.3) from `scripts/fork-rust-agent/about.toml` and `about.hbs`. `about.toml` lists the accepted licenses; a crate with an unlisted license fails the release build (`--fail`) until it is reviewed.
- `electron-builder.config.js` ships `resources/zcode-rs` as `<resources>/zcode-rs/` when the staged directory exists, so local packaging without a Rust build still works and ships Node only. Main resolves the packaged binary there (rule 2 of "Binary location").
- The repository-wide `THIRD-PARTY-NOTICES.md` is not changed: it is hash-pinned by `third-party/inventory.json` and covers the JavaScript bundle; the Rust material travels next to the binary.

## Acceptance scenarios

1. Fresh profile, no env: `forkAppSettingsSchema.parse({}).agentRuntime === "node"`, logged with `source: "setting"` (see State owners). The Host env has `ZCODE_FORK_AGENT_RUNTIME=node` and no Rust path. The agent is `zcode.cjs`.
2. `agentRuntime: "rust"` stored and the binary present: the Host env has `effective=rust` and the path. `resolveDefaultZCodeAgentCommand` returns `zcode-rs` with `supportsStorageStartup: true` and `storagePreparationEntry` pointing at the Node bundle. `prepareSessionStorage` runs the Node Worker.
3. `rust` selected, binary missing: effective is `node`, logged once at `warn`, and the agent is `zcode.cjs`.
4. Database path agreement: with Rust effective and `ZCODE_DATA_BASE_DIR` set, the database the Rust agent opens has the fork migration ledger rows `9001`–`9005` written by the Node Worker. No second `db.sqlite` is created.
5. Env override: `ZCODE_FORK_AGENT_RUNTIME=node` with a stored `rust` gives `node`. An invalid value is ignored with a `warn`.
6. `ZCODE_AGENT_SERVER_COMMAND` set: the custom command is used as today, and storage startup stays `unsupported_runtime`.
7. Changing `agentRuntime` while the app runs does not change any running or newly spawned Host until restart.
8. Rust effective: a new task's first message, a follow-up and a tool turn render end to end. The first-submission overlay ("Message saved; delivery not confirmed") clears once the reply streams, and `session_entry` holds the marker with `status: "active"`. History: on 2026-11-07 the hello-override route failed here because the composer always takes the durable route; the contract was then implemented in `zcode-rs`. After a full desktop restart the reopened task shows no overlay. A card that stayed after a restart in the 2026-11-07 run came from pre-contract records: composer drafts left in the draft scope with no reservation, which the reconciliation never visits.
9. Rust effective: creating a task in an execution worktree, or with an ACP agent selected, fails with the matching `proto.forkRustAgent.*` error instead of running in the main checkout or with a different model. With Node effective the same commands are admitted.
10. Rust effective, web-remote and desktop, in a fresh session: attaching a text file with a secret word on a line the model has not echoed, and asking for it, gives the word in the reply. The chip shows the file name, and the bubble shows only the typed text. After an agent restart the chip is still there and an attached image still previews. Reopening the task under `ZCODE_FORK_AGENT_RUNTIME=node` shows the same bubble and chips, and a follow-up question quoting the unechoed line exactly is answered from history.

11. Rust effective: after a full agent restart, subscribing to a task (`v4/conversation/subscribe` with `topic: conversation/<session>`, `connectionId`, `clientMode`) gives `userInput` rows and turn headers whose `sourceCommandId` equals the stored `anchor.sourceCommandId` of that input. An image attached under Rust shows a chip with a ref when the task is reopened under Node, and an image attached under Node reaches the Rust model as an image.
12. Rust effective on a fresh home (no `~/.zcode/cli/plugins`): after the first start the plugin store has `bundled-marketplace.json` and the `visualize` cache, and the first model request of a new task lists the `visualize` skill. With Node effective the storage Worker leaves the plugin store untouched.

## Tests

Fork unit tests go in `scripts/fork-test-files.json`:

- selection precedence and the binary-missing fallback, in Main;
- Host env injection, including removal of inherited values;
- the Host resolver returning Rust with the Node storage entry, and the Node command unchanged by default;
- the schema default;
- the hello overrides (empty for Node) and the command gate (worktree and ACP refused in Rust mode only).
- prepare-storage seeding the official plugins in Rust mode only, without failing preparation when the seed throws (`apps/zcode-cli/packages/bootstrap/tests/fork-rust-agent-plugin-seed.test.ts`).

Desktop E2E stays on Node. `wdio.conf.ts` already removes `ZCODE_AGENT_SERVER_COMMAND`, and it should also remove `ZCODE_FORK_AGENT_RUNTIME` unless an explicit opt-in is set.
