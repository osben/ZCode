# E2E FS Fault Injection

Goal: a stable, reproducible filesystem error-injection capability for external-environment faults in the conversation area, so cases such as `ENOSPC`, `EACCES`, corrupted snapshots and log write failures reproduce under one protocol locally, in CI and in Docker, instead of relying on a really full disk or hand-edited permissions.

Related cases:

- `D01`: session history write `ENOSPC`
- `D02`: workspace file write `ENOSPC`
- `D03`: provider/settings save `EACCES`
- `D04`: corrupted session snapshot on startup recovery
- `D05`: log/artifact write failure

## Injection boundary

Filesystem faults may be enabled only in test runtime. By default only injection config under `ZCODE_ENV=test` is accepted; enabling it in a special debug package requires an explicit `ZCODE_E2E_FS_FAULTS_ALLOW=1`, so a leftover environment variable cannot inject errors into a user's production environment.

A standalone helper exists, first wired into the `atomicWriteText` config atomic-write entry. Wired injection points:

1. provider `config.json` atomic write: covers the core save path of `D03`.
2. settings `setting.json` direct write: covers the app settings save path of `D03`.
3. provider display order direct write: covers provider preference save failure.
4. SQLite session DB open: covers database-cannot-open at startup/recovery, for `D04`.
5. SQLite session history write: wired in `sqliteRun`; covers write failures of `saveMessage` / `savePart` / `createSession` and the compact marker write, for `D01`.
6. workspace tool file write: `NodeFileSystemAdapter.writeTextFile` `createParents`, non-atomic direct write and the delete boundary, for `D02`. The default `atomic: true` path (temp write, chmod, sync, rename, fallback) is not wired to the fault injector.
7. tool artifact sink: `NodeToolArtifactStore` directory creation and text/binary artifact write, for the artifact branch of `D05`.
8. CLI log sink: `NodeLoggerFactory` log directory creation and JSONL append, for the CLI log branch of `D05`.
9. desktop main log sink: append of main-process normal logs and web remote control dedicated logs, for the desktop main log branch of `D05`. A startup log-directory creation failure keeps the existing behavior; swallowing it completely needs a separate product confirmation.

### Workspace atomic write note

The default `atomic: true` path of `NodeFileSystemAdapter.writeTextFile`: write a temp file, copy the original file's permissions, sync, rename. If the atomic path fails, the temp file is cleaned up and it falls back to a non-atomic `O_TRUNC` write of the target. Under abnormal disk errors such as `ENOSPC` / `EIO` the fallback may truncate an existing target; the current file tools permission regression accepts this behavior.

So that test-only `ZCODE_E2E_FS_FAULTS` does not pollute this production logic, the workspace default atomic temp write / rename has no fault hook. `D02` should simulate workspace write failure through `atomic: false` direct writes, parent directory creation, deletion or another wired storage boundary. Whether to reintroduce a dedicated test seam for the default atomic path needs a separate product-semantics confirmation first.

## Config format

Environment variable: `ZCODE_E2E_FS_FAULTS`

The value is a JSON array; each rule describes one fault equivalence class:

```json
[
  {
    "id": "D01-session-history-enospc",
    "code": "ENOSPC",
    "operations": ["writeFile", "rename"],
    "pathIncludes": "/.zcode/",
    "maxMatches": 1,
    "message": "Injected ENOSPC while persisting session history"
  }
]
```

| Field | Meaning |
| --- | --- |
| `id` | Stable case id or fixture id; must be non-empty |
| `code` | Node-style error code, such as `ENOSPC`, `EACCES`, `EPERM` |
| `operations` | Matching fs / storage operations: `mkdir`, `writeFile`, `appendFile`, `rename`, `rm`, `sqliteOpen`, `sqliteRun`, `any` |
| `pathIncludes` | Path contains match; paths normalize `\` to `/` |
| `pathEndsWith` | Path suffix match |
| `pathRegex` | Regex match on the normalized path |
| `maxMatches` | Maximum number of hits; default `1`; `0` means unlimited |
| `message` | Readable description of the injected error |

Matching rules:

- `operations` omitted equals `["any"]`.
- If `pathIncludes` / `pathEndsWith` / `pathRegex` are all omitted, all paths match.
- Several path conditions must all hold.
- `maxMatches` triggers once by default so one fault case does not contaminate later unrelated writes.

## Error object

The injected error must keep the Node `ErrnoException` shape:

```ts
{
  code: "ENOSPC",
  syscall: "writeFile",
  path: "/tmp/workspace/.zcode/session.json",
  zcodeFsFaultId: "D01-session-history-enospc"
}
```

The product layer can then handle real error codes while the E2E artifact can locate the matched rule.

## Acceptance evidence

Every storage-fault E2E keeps at least:

| Layer | Evidence |
| --- | --- |
| UI | User-visible error, button state, whether queue/runtime match product expectation |
| Runtime | `activeInputId`, queue, session status, compact marker |
| Files | Whether the target file is missing, partially written, corrupted or recovered |
| Log | Error code and recovery log for the same `sessionId` / `inputId` |
| Fault artifact | Matched `id`, `operation`, `path`, `code`, hit count |

## Current state

The injection protocol and helper unit tests are fixed, and the injection points listed above are wired. `D01-D05` stay `decision-needed`: having an injection capability does not mean the product case is covered. Only when a business write point is wired to the helper and the case has explicit setup/action/assert can the coverage matrix mark it `covered`.
