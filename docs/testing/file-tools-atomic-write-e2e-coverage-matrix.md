# File Tools Atomic Write E2E Coverage Matrix

## Scope

This matrix covers the real filesystem path from CLI file tools to `NodeFileSystemAdapter.writeTextFile`, to prevent `Write` / `Edit` of an existing executable script from losing the execute bit.

Two layers: `FT-AW-01` to `FT-AW-03` are deterministic CLI/adapter-layer regressions and do not enter the conversation-session `manual-review/pending` flow; `FT-AW-04` is a conversation-session replay candidate awaiting manual review and re-promotion, using a case-local DeepSeek fixture and case manifest to verify permission behavior in a real desktop session; it is not a default quality gate.

Implementation: the default `atomic: true` write of `NodeFileSystemAdapter` uses an `O_NOFOLLOW` temp file, copies the original file's permissions, syncs, renames; if the atomic path fails it cleans the temp and falls back to a non-atomic `O_TRUNC` write of the target. Under abnormal disk errors this fallback may truncate an existing target; the permission regression accepts that behavior and adds no extra fallback or fault-injection hook.

The matrix covers permission preservation and symlink rejection only; it does not cover `ZCODE_E2E_FS_FAULTS`, atomic temp/rename failure recovery or disk-full semantics. Related storage faults belong to the `D02` product-semantics confirmation.

## Case Index

| ID       | Status  | Spec / harness                                                                                                                                                                                                                                                       | Setup                                                                                                                           | Action                                                                                                  | Assertion                                                                                                                                                        |
| -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FT-AW-01 | covered | `apps/zcode-cli/e2e/file-tools-atomic-write/run.mjs` / `write-preserves-executable-mode`                                                                                                                                                                             | POSIX temp workspace; existing `0755` `write.sh`; read state prepared for `Write`                                               | Call built dist `writeToolEntry.handler` to overwrite the content                                       | Content updated; mode still `0755`                                                                                                                               |
| FT-AW-02 | covered | `apps/zcode-cli/e2e/file-tools-atomic-write/run.mjs` / `edit-preserves-executable-mode`                                                                                                                                                                              | POSIX temp workspace; existing `0755` `edit.sh`                                                                                 | Call built dist `editToolEntry.handler` to replace text                                                 | Content updated; mode still `0755`                                                                                                                               |
| FT-AW-03 | covered | `apps/zcode-cli/e2e/file-tools-atomic-write/run.mjs` / `write-rejects-symlink-target`                                                                                                                                                                                | POSIX temp workspace; `link.sh` points to `target.sh`                                                                           | Call built dist `writeToolEntry.handler` writing the symlink path                                       | Throws `Refusing to write through symlink: ...`; the real target content is not rewritten                                                                        |
| FT-AW-04 | partial | `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-file-tools-atomic-write.test.ts` / `Write 和 Edit 修改可执行脚本后应保留 POSIX 执行位` ("Write and Edit keep the POSIX execute bit after modifying an executable script") | Electron/WDIO default workspace; two existing `0755` scripts; case-local provider replay fixing `Read -> Write -> Read -> Edit` | Send the prompt through the UI; the real conversation runtime runs the `Write` and `Edit` tool handlers | The candidate spec has UI, content and mode assertions; it counts toward the default E2E gate only after manual review against current V4 behavior and promotion |

## Run commands

From the repo root:

```bash
pnpm --filter @zcode/contracts build
pnpm --filter @zcode/shared-types build
pnpm --filter @zcode/adapters build
pnpm --filter @zcode/core build
node apps/zcode-cli/e2e/file-tools-atomic-write/run.mjs
```

`run.mjs` returns skipped on Windows, which has no mode semantics equal to POSIX `0755`.

Window-level replay E2E:

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/conversation-session-file-tools-atomic-write.test.ts
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-file-tools-atomic-write.json \
  pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/conversation-session-file-tools-atomic-write.test.ts'
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/conversation-session-file-tools-atomic-write.test.ts'
```

To bring `FT-AW-04` into the `conversation-session-verified` Docker suite later, run container admission:

```bash
E2E_SPEC=./test/e2e/conversation-session/conversation-session-file-tools-atomic-write.test.ts pnpm run test:e2e:container
pnpm --filter @zcode/desktop e2e:docker:admit -- --spec ./test/e2e/conversation-session/conversation-session-file-tools-atomic-write.test.ts --verified --artifact packages/desktop/.e2e-artifacts/<run-id> --apply
pnpm run test:e2e:container:conversation
```

## Lifecycle decision

- `manual-review/pending`: `FT-AW-04` currently lives there and is candidate evidence only. Although its semantics come from a confirmed filesystem bugfix, it still needs review against the current V4 replay before promotion.
- `fixtures/upstream` / `fixtures/cases`: not used by `FT-AW-01` to `FT-AW-03`; `FT-AW-04` must use a case-local provider fixture and case manifest fixing the `Read -> Write -> Read -> Edit` tool-call contract.
- `e2e:fixture:check`: mandatory for `FT-AW-04`, proving fixture, manifest, spec marker and request contract agree.
- `e2e:promote`: after a human confirms the current V4 UI / network / snapshot assertions are stable, use it to promote `FT-AW-04` back to the default conversation-session directory and sync this matrix status.
- Docker admission: only when `FT-AW-04` must enter the `conversation-session-verified` container suite; it must first pass single-spec `replay-isolated`, then `e2e:docker:admit` syncs the Docker preset and admission docs.
- `pnpm --filter @zcode/desktop typecheck:e2e`: kept as the lifecycle closing gate so the E2E type environment is not broken by this test infrastructure change.
