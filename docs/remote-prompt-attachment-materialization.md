# Remote prompt attachment materialization

> **Current state:** the first `zcodeTaskService.sendPrompt` section below is kept as pre-V4 failure background; the current implementation follows the "V4 eager staging" section and `IPromptAttachmentTransferService`.

## Background

In WSL/SSH/Docker remote workspaces, the desktop renderer and host run locally while the ZCode Agent runtime runs remotely. `ZCodePromptAttachment.localPath` used to mean just "a local path" without saying whether it belonged to the desktop host or the remote runtime. That broke these chains under WSL remote:

- Long text pasted past a threshold: desktop main wrote to the Windows-side `.zcode/tmp/paste-attachments/...` and sent the Windows `localPath` as a file attachment.
- Desktop file picking, drag-and-drop, and large images also preferred `localPath` to avoid base64 inflation.
- Image attachments with local cache paths reaching the remote runtime made later tools read the wrong machine's filesystem.

The remote agent `stat/read`s such a `localPath` on the remote runtime's filesystem; reading `C:\Users\...` or other host paths under WSL fails, showing up as unreadable pasted content/attachments.

## Constraints

- The agent/core runtime must not learn Windows paths; core reads only paths accessible on its own machine.
- Large files and long text must not fall back to inline/base64, which would re-inflate the RPC payload and prompt context.
- Desktop local workspaces keep using `localPath` as-is.
- Remote workspaces materialize attachments before crossing the host -> remote boundary, keeping the web remote shared-host chain free of extra runtimes.

## Original approach

The desktop host wraps the remote `zcodeTaskService.sendPrompt` and materializes prompt attachments:

1. Scan `attachments` for entries with a `localPath`.
2. Upload host-readable attachments to a user-private temp directory readable by the remote runtime: `~/.zcode/tmp/prompt-attachments/<trace>/<random>/...`.
3. Replace the attachment `localPath` with the uploaded remote path, then call the remote `sendPrompt`.
4. Keep `sourceKind: "clipboard-text"`; long-text paste stays a deferred file reference and is not inlined into the prompt body early.
5. If the prompt body contains a replaced attachment path, replace it with the remote path too, so cached-image scenarios never prompt the model to read a host path.

This was a boundary fix only. A fuller long-term protocol could add an attachment locality field explicitly encoding host-local, runtime-local, and inline sources.

## V4 eager staging

The V4 composer no longer waits for send to materialize. After selecting a host-local attachment, the renderer immediately requests staging from the Local/Remote Host carrying the current workspace scope via `IPromptAttachmentTransferService`; the service publishes connection-scoped progress by operation id and supports cancel/cleanup.

```text
renderer composer（Desktop continuous / Mobile shared-host replayable）
  -> 当前窗口已有 Host attachment
     ├─ local：本地 transfer，localPath 零拷贝，staged=false
     ├─ SSH/WSL/Docker：attachment-scoped transfer
     │    -> SourceServerConnectionManager 当前 generation 的文件传输能力
     │    -> 同一 Transport Adapter / backend 的 exec + upload(progress, signal)
     │    -> Source 用户私有 ~/.zcode/tmp/prompt-attachments/...，staged=true
     └─ Server dev 直连：保持原 Source service；不开放 desktop localPath 暂存

attachment 关闭 / Source 换代 -> abort 未完成 operation + cleanup 未 adopt 文件
已 adopt -> CLI 已接受的 ref 生命周期，不由 attachment close 删除
```

### R3 wiring and lifecycle (2026-09-16)

Root cause: when R3 removed the old mixed service factory it also removed cross-machine staging; all forwarding pointed at the Source's `createLocalPromptAttachmentTransferService`, which only returns the original `localPath` with `staged:false`. That missing filesystem-boundary conversion cannot be fixed by restoring local JWTs, deleting composer guards, or faking `staged`.

Cross-machine staging is owned by the current Window Host's owning attachment — not a plain business RPC the Source Core can execute directly. A Host exposing an attachment overrides `IPromptAttachmentTransferService`; the RPC contract's Source service remains for Source-local path semantics. Only SSH/WSL/Docker attachments provide cross-machine capability. The Transport Adapter exposes only the narrow `exec/upload` capability over the established backend; the Manager binds capability to the current online connection — new operations on an old generation fail closed, and no new SSH/WSL/Docker connection or Agent is created. The Source's Provider, JWT, and file/session state stay remote-owned, not the old mixed authority.

- The operation record exists only inside the attachment; the Host's trusted scope validates workspaceIdentity, workspacePath, and remoteSessionId and rejects cross-scope staging. Main/relay store no progress, tasks, queues, or copies.
- A retry with the same operationId first invalidates and aborts the old record; a late result may clean up only itself and never deletes the new record.
- cancel/cleanup/dispose synchronously remove the record and abort; even a late upload success must not publish ready and must reclaim the file.
- Attachment close runs this closure for all non-adopted operations; adopting removes the staging record while keeping the CLI-accepted reference. Offline cleanup is best-effort, with a 24-hour janitor reclaiming leftovers; no reconnect or line switch is triggered for cleanup.
- Desktop uses continuous; mobile keeps attaching to the existing Host only; paste temp files follow the same staging contract; inline bytes keep the existing V4 attachment transaction. Staging changes no stream/queue/replay semantics.

- Identity isolation uses `workspaceKey = workspaceIdentity?.trim() || workspacePath`; remote connection routing keeps passing `remoteSessionId`.
- When deciding whether an attachment must be materialized remotely, the composer fails closed for any non-empty `workspaceIdentity`, without requiring the current resolver to recognize it; `remoteSessionId` also directly proves a remote target. With identity established but the session id not yet injected, a host-local attachment must stay in `waitingSession` until the session is ready; a non-canonical/new-format identity must never degrade to local `localPath` zero-copy during the injection window.
- The session service accessor for SSH/WSL/Docker workspaces must explicitly use the remote `promptAttachmentTransferService`. Inheriting it from local `baseServices` would complete the eager stage on the desktop and hand host paths like `/Users/...` or `C:\Users\...` to the remote CLI verbatim.
- A remote host-local attachment calling `stage` must get `staged: true`. `staged: false` means the transfer service did not cross the host -> remote filesystem boundary; the composer must fail closed, keep the send gate, and never wrap the returned host path as a ready `AttachmentRef`.
- In-flight staging records belong to the Local/Remote Host carrying that workspace scope; relay/main keep no mirror.
- After a successful send, mark the staged file adopted so the runtime can read it in the current session/queue; deleting or cancelling before send cleans up immediately.
- Eager stages never cleaned up explicitly are reclaimed by the 24-hour janitor, avoiding files left by renderer crashes/disconnects.
- When SSH SFTP falls back to the exec pipe, the operation id is kept and progress never regresses; WSL/Docker use the same progress/cancel contract.
- After a runtime generation change, uncommitted refs are invalid and the renderer re-stages within the attachment retry budget; `AttachmentRef`s already inside the CLI queue/transcript stay managed by CLI authoritative state.

Regression tests must inject different transfer service instances for local and remote accessors and assert:

- A local workspace selects the window's Local Host instance; `stage` returns `staged: false`, keeps the local `localPath`, and never calls `IRemoteBackend.upload`.
- A normal remote workspace selects the remote instance, triggering `IRemoteBackend.upload`.
- A server remote workspace keeps the server-authoritative accessor with all services provided remotely.
- With a remote identity known (including non-canonical/new formats the current resolver does not recognize) but `remoteSessionId` missing, host-local files keep waiting; after id injection only the remote `stage` is called, never local `attachmentPut`/zero-copy.
- When the remote `stage` returns `staged: false`, the attachment becomes permanently failed and `prepareForSend` returns null.

## State and multi-client boundary

```text
desktop remote composer（renderer-local draft）
  | workspaceIdentity=remote:*，remoteSessionId 暂缺
  v
waitingSession --remoteSessionId ready--> queued/uploading
  |                                      |
  |                                      v
  |                              remote transfer stage
  |                                      |
  |                         staged:true  |  staged:false
  |                              ready <-+-> permanent failed
  |                                           |
  +-------------------------------------------+-> 禁止 sendText admission

mobile /remote
  -> 继续 attachment 到桌面已有 shared host
  -> 不创建新 runtime，不在 relay/main 保存附件状态
  -> replayable 只恢复已 admission 的 conversation intent，不恢复 renderer-local 上传进度
```
