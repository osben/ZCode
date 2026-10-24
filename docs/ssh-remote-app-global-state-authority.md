# SSH remote workspace state authority boundary

> Current-state document. The old Desktop Provider Registry snapshot-push design is retired; its history lives only in working-memory, old plans/specs, and incident reviews.

## Core conclusion

Desktop-attached SSH/Docker/WSL describes a connection and operation relationship only — it does not extend the Desktop Environment to the remote side. The Remote Environment that runs the Agent owns the Provider Config, account facts, Credential Store, Registry, and ModelFactory.

```text
Desktop Environment                     Remote Environment
===================                     ==================
Desktop app-global settings             Remote ZCode Built-in Config
Desktop OAuth / UI state                Remote Personal Provider Config
Local Provider Runtime                  Remote Account Provider Config
Local Registry                          Remote Credential Store
                                        Remote Registry
        |                                     |
        | remote settings/selection/task RPC  |
        +------------------------------------>|
                                              v
                                      Remote ModelFactory
                                              |
                                              v
                                      Remote model request
```

Desktop never injects into the Remote Worker:

- a full Provider Registry or its serialized snapshot;
- Runtime Model or Provider/Model static-config snapshots;
- Desktop Account Provider Config;
- Desktop API keys, JWTs, Team Runtime Keys, or dynamic request headers.

The old `workspace/updateProviderRegistry`, `ZCodeProviderRegistrySnapshot`, and `remoteWorkspaceProviderSync` are no longer part of the production protocol or runtime chain.

## State ownership

| State | Authority | Read path for Desktop-attached remote |
| --- | --- | --- |
| Workspace files, Git, Terminal | Remote Environment | remote service |
| Task, Session, Agent execution | Remote Environment | remote service |
| Provider Settings View (remote runtime) | Remote Environment | remote `provider-settings` facade |
| Desktop model settings page (app-global) | Desktop Environment | local `IProviderSettingsService` |
| Model Selection View (remote runtime) | Remote Environment | remote `model-selection` facade |
| Provider Config / Registry | Remote Environment | no Registry object or snapshot crosses Environments |
| Provider Credential / Request Auth | Remote Environment | never injected from the Desktop Credential Store |
| Desktop theme, windows, local UI state | Desktop Environment | local service |
| Desktop continuous / Mobile replayable | their existing delivery owners | unchanged by the Provider boundary |

The remote workspace ServiceCollection facing the renderer may mix local UI services with remote business services, but the mixing is only a facade assembly and never changes the ownership above. A remote workspace's runtime, session, and model execution must use the target Environment's Provider Settings and Model Selection; the Desktop settings page's app-global model-config editing is the explicit exception — it reads/writes the Desktop Local Environment only and never implicitly routes edits to the remote side.

## Intra-Environment sync

Within one Environment, the Host and the Core Worker each hold a Registry instance and share that Environment's config facts:

```text
Environment Provider Sources
├─ ZCode Built-in Config
├─ Personal Provider Config
└─ Account Provider Config
          |
          +-------------------+
          |                   |
          v                   v
     Host Registry       Worker Registry
          |                   |
     Settings/View       ModelFactory/Execution
```

The Host may send its Environment's secret-free Account Overlay to its own Core Worker via `provider/updateAccountConfig`. That protocol carries only `revision + basedOnZCodeBuiltinRevision + ProviderConfigMap` — no API keys, JWTs, or dynamic headers. It is an inter-process consistency mechanism, not Desktop-to-remote Provider sync.

Both Registries rebuild themselves after Source changes; Registry views are not shared across processes. An already-created Active Model keeps the facts frozen at creation; a new view affects only Models created later.

## Startup and recovery

```text
Remote Host 启动
      |
      v
读取 Remote Built-in / Personal / Account Sources
      |
      v
Remote Host Registry ready
      |
      +--> 暴露 Provider Settings / Model Selection
      |
      v
Remote Worker 启动并读取同一 Environment 的 Sources
      |
      v
Remote Worker Registry ready -> 创建 Session / Model
```

While the remote Provider Runtime is not ready, callers wait on the target Environment's own ready barrier. A Desktop Registry snapshot must not serve as bootstrap, fallback, or retry material. Remote reconnects and Worker generation changes rebuild only the remote runtime and never replay the local Registry.

On disconnect, the RPC client must still reject all pending requests and clean up the old generation — a generic transport lifecycle invariant, unrelated to the retired Provider-sync feature.

## Config and credential provisioning

Copying config or credentials into another Environment is a separate Provisioning capability, not part of remote workspace runtime attachment; current implementation and scope: `docs/remote/provider-provisioning.md`.

```text
Source Environment Config / Credential
                 |
                 | explicit provisioning
                 v
Target Environment Config / Credential Store
                 |
                 v
Target Sources publish change
                 |
                 v
Target Registry rebuilds itself
```

Provisioning must write the target Environment's official Store first and let the target Registry rebuild. It must not construct Registry, Model, or Runtime headers directly, nor become an online dependency of every model request. Remote settings editing and remote login likewise call the target Environment's official Services — the Desktop Credential Store is never the remote auth source. Current sync is explicit Local → Remote; current Provisioning auto-triggers after a local allowlisted credential save or delete succeeds, and the next successful sync revokes the same-name remote allowlisted credential with replace semantics, leaving non-allowlisted credentials untouched. During offline periods or sync failures, a local deletion must not be treated as proof the remote side was revoked — see the current Provisioning spec for details.

## Invariants

- `workspaceIdentity` is identity isolation; `workspacePath` is for files and command execution only.
- A Desktop remote attachment creates no second Agent Runtime and no second accepted-input queue.
- Desktop `desktop-continuous` does not splice mobile replayable recovery messages; mobile `web-remote-replayable` does not bypass gap/snapshot recovery.
- Provider/Model static facts come only from the target Environment's Config and Registry.
- Dynamic request credentials never enter Account Provider Config, Registry views, or session persistence.
- The retired full-Registry writer provides no compatibility fallback.

## Related current designs

- `docs/working-memory/provider-refactor/design/environment/environment.md`
- `docs/working-memory/provider-refactor/design/registry/runtime.md`
- `docs/working-memory/provider-refactor/design/registry/configuration.md`
- `docs/remote/zcode-agent-remote-deployment.md`
- `docs/web-remote-control/web-remote-control-architecture.md`

## Settings page app-config ownership (2026-09-16 fix A2)

Activating a remote workspace changes workspace services only, never the owner of Desktop settings. The settings page loads and saves per consumer:

| Setting | Read/write owner | Reason |
| --- | --- | --- |
| Chromium hardware acceleration, Windows tray, built-in browser cert policy | base Local Host | Desktop Main reads only local bootstrap config at startup |
| Data storage directory | base Local Host | the native picker returns a local path; the copy and bootstrap pointer must be on the same machine |
| Integrated terminal shell choice | base Local Host | candidates come from the local systemService; a local shell path must not be written to the Source |
| HTTP proxy, No Proxy, custom CA paths | base Local Host | startup config of the desktop renderer, built-in browser, and local subprocesses; never implicitly configures another Environment |
| Terminal profile inheritance, terminal font | current workspace Environment | read by the target terminalService when creating the PTY |
| Task auto-archive toggle and days | current workspace Environment | executed by the target taskService holding the tasks |
| Skills/MCP/Plugins/Hooks/Subagents | existing target scope resolver | keeps current User / Source / workspace ownership |

```text
Desktop 设置页（可在远程 tab 打开）
  ├─ 应用设置读取/保存 ──> base Local Host ──> 本机 setting.json ──> Main 冷启动
  └─ 运行设置读取/保存 ──> workspace Source ──> Source setting.json ──> 目标服务
native picker ── 本机目录 ──> Local Host.updateDataBaseDir ──> 本机复制成功后保存指针
```

- The first wrong wiring point fixed was SettingsPage; the remote ServiceCollection was not modified and the settings page did not switch providers wholesale.
- Local and Source loads are independent; after unmount or target switch, old read results are ignored so a stale Source cannot overwrite the new page.
- Write/copy failures propagate to existing feedback — no success-state update, no falling back to the other side, no added retries.
- Fields previously mis-written to a Source are not auto-migrated or deleted: a field name cannot prove it was intentional remote user configuration.
- The Desktop local flow reuses the same base service. Web/mobile keep existing base services and platform visibility; no new Host, connection, or Agent, and no change to continuous/replayable, queue, snapshot, or login state.
- Verification: real SettingsPage callbacks with separated local/remote test doubles; an SSH single case covers local save, Source staying clean, Source auto-archive comparison, native directory migration, and Electron cold restart. Windows Shell/tray is covered by contract tests only, which is not real Windows machine verification.
