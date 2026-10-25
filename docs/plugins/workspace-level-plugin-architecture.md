# Workspace-level Plugin Architecture

> Status: Accepted architecture; V1 implementation and local pending E2E evidence recorded; mobile remains focused integration only and formal admission is pending
> Date: 2026-08-19
> Decision: two-level User/Workspace configuration; no Local scope; the open Plugin security policy confirmed for ZCode
> Target: Desktop local, SSH/WSL/Docker workspace Agent Host, mobile `/remote` shared-host attachment

## 1. Final decision

Workspace-level Plugin means a Plugin's enabled state and runtime options can be decided by the current
Workspace's project config. The config scope matches Skill, Command and Hook and has only two levels:

```text
User       ~/.zcode/cli/config.json
Workspace  <workspace>/.zcode/config.json
```

Not implemented:

- `<workspace>/.zcode/config.local.json`;
- a Host-external `plugins/assignments/workspaces/<hash>.json`;
- Workspace-independent package/cache/data;
- automatic Plugin install on opening a project;
- resident App hot-plugging;
- independent approval for Plugin MCP;
- a Workspace trust gate in the Plugin domain.

Workspace config may be tracked in Git. By product decision `plugins.options`, credentials and secrets may
be injected by the project repository, but UI, logs, diagnostics, provider capture and mobile replayable
artifacts must redact them.

Plugin Marketplace is not a config scope: the marketplace owns only the target Host's User package
lifecycle, shows no User/Workspace selector and does not edit Plugin enabled/options directly. Install,
update, uninstall and the Marketplace cache all belong to the Host User inventory; a new install defaults to
enabled in User config. User and Workspace enabled/options are edited uniformly in the "Installed"
configuration view of Settings > Plugins.

## 2. Scope and precedence

### 2.1 Enabled state

```text
workspace.plugins.enabledPlugins[pluginId]
        ?? user.plugins.enabledPlugins[pluginId]
        ?? plugin manifest defaultEnabled
```

A missing key means inherit; an explicit `false` is a valid override and must not be implemented as
"missing equals false".

### 2.2 Options

Options deep-merge by Plugin ID and option key:

```ts
effectiveOptions[pluginId] = {
  ...user.plugins.options[pluginId],
  ...workspace.plugins.options[pluginId],
};
```

Example:

```json
{
  "plugins": {
    "enabledPlugins": {
      "formatter@team-market": true
    },
    "options": {
      "formatter@team-market": {
        "style": "compact",
        "apiToken": "shared-project-secret"
      }
    }
  }
}
```

Workspace config overrides only the fields it declares; the rest keep inheriting from User config.

## 3. Persistence ownership

### 3.1 Workspace config

Authoritative file:

```text
<workspace>/.zcode/config.json
```

Supported Plugin config:

- `plugins.enabledPlugins`: which Plugins the project enables/disables;
- `plugins.options`: project-shared plain options, credentials and secrets;
- `plugins.dirs`: in-project Plugin roots or project-relative Plugin paths, validated by path and manifest schema.

Workspace config stores no package bytes, install completion state, Marketplace cache, Plugin data or Host
user-level install records. An empty input for a sensitive option means keep the current value; an explicit
clear by the user deletes only the specified option key in the current scope and does not reset that
Plugin's enablement or other options.

### 3.2 User/Host state

```text
~/.zcode/cli/config.json
  plugins.enabledPlugins
  plugins.options
  plugins.suppressedBuiltins
  user-level plugins.dirs

~/.zcode/cli/plugins/
  known_marketplaces.json
  installed_plugins.json
  marketplaces/
  cache/{marketplace}/{plugin}/{version}/
  data/{pluginId}/
```

Plugin package, install, update, uninstall, cache and data remain User/Host state on the target Agent Host.
When Workspace config references a missing package, only the declaration is kept and shown as `missing`;
nothing is downloaded or installed automatically.

## 4. Runtime loading

The settings page does not load Plugins directly. The Agent reads and resolves them when creating the
Workspace's App/Session:

```text
Open Workspace / create new Session
          |
          v
Determine workspacePath, workspaceIdentity, remoteTarget
          |
          v
Read User config
          |
          v
Read <workspace>/.zcode/config.json
          |
          v
Merge effective enabled/options by Plugin ID/key
          |
          v
Discover installed/builtin/Workspace Plugin packages on the target Host
          |
          +-------------------+
          |                   |
     package present      package missing
          |                   |
          v                   v
Validate manifest/schema   overview=missing
          |
          v
Register Hook/Skill/Command/Agent/MCP directly
          |
          v
Create the current Session runtime
```

A Plugin's Hook, Skill, Command, Agent and MCP use one effective Plugin registry. The runtime does not need
to know whether config came from User or Workspace; scope affects only config reading, writing back and
source display.

### 4.1 Session activation boundary

```text
Save config
   |
   +-- config file updates immediately
   +-- Settings overview refreshes immediately
   +-- the current resident App keeps the Plugin catalog from its creation
   +-- a new Session uses the latest effective config
   +-- cold resume uses the latest effective config
```

V1 does not hot-plug a resident App and does not force-restart running tasks on a Settings save.

### 4.2 Plugin MCP

Plugin MCP goes straight into the runtime after Plugin registry registration:

- no Workspace trust needed;
- no Plugin MCP approval needed;
- manifest, config, path and protocol schema validation still apply;
- `${user_config.KEY}` may expand in sensitive sinks such as env/header/clientSecret;
- sensitive values must not expand into non-sensitive fields such as command, args, URL;
- runtime errors return only redacted diagnostics.

This is an exception of the Plugin domain only and does not change the existing security contract of
top-level project MCP, Hook, Agent and other non-Plugin config.

## 5. Settings control plane

The settings page reuses the Skill/Command/Hook scope interaction:

```text
Settings > Plugins

Scope: [User | Workspace]
Workspace: [local workspace / remote workspace]
```

After choosing Workspace, all reads and writes bind to the selected Workspace target.

Plugin Marketplace is a separate main view; the browse page has no scope selector; the in-page "Plugin
management" keeps the User / Workspace config scope.

```text
Settings / Sidebar
        | open marketplace
        v
Plugin Marketplace
  | install/update/uninstall package in Host User inventory
  | new install defaults User enabled=true
  | manage -> [User | Workspace] -> browse all
        | primary navigation back
        v
Chat
```

The main navigation returns to chat; marketplace management and details return to marketplace browse. The
Marketplace source comes only from User/Host config; Workspace cannot declare, add or refresh a Marketplace.
Package install writes Host User, while project enable/disable and config are decided by the scope chosen
explicitly in the management page. For the full interaction see [marketplace scope](plugin-market-interactions-scope.md).

Plugin details distinguish three kinds of state:

```text
Package: Installed v1.2.0 / Missing
Enabled: On / Off / Inherited
Source: User / Workspace
```

### 5.1 Enable/disable

```text
User scope:
  patch ~/.zcode/cli/config.json#plugins.enabledPlugins[id]

Workspace scope:
  patch <workspace>/.zcode/config.json#plugins.enabledPlugins[id]
```

The Workspace page offers "Restore User config", which deletes the key in Workspace instead of writing a
third sentinel.

### 5.1.1 Scope list semantics

The User / Workspace lists in settings are config views, not mutually exclusive resource ownership:

```text
Host available Plugin set
  = Host installed inventory
  + builtin Plugins
  + scope-specific Plugin roots/declarations

User view
  = User + manifest default projection

Workspace view
  = User + Workspace merged effective projection
```

One Host-installed Plugin can appear on both the User and Workspace pages. The User page edits User
enabled/options; the Workspace page shows that Workspace's effective state and source:

- Workspace has an explicit key: source is Workspace;
- Workspace has no key, User has an explicit key: source is User inheritance;
- neither layer has a key: source is manifest default.

A Workspace toggle writes an explicit `true`/`false` in the current Workspace; "restore inheritance" only
deletes the Workspace override. Workspace options show the effective value with its source, but writes only
modify Workspace. The User page must read the User/default projection without project overrides and must not
treat a Workspace override as a User value.

MCP, Skill, Command and Hook contributed by a Plugin are shown by the selected target's actual effective
enablement: capabilities that take effect through User inheritance must appear in the Workspace view, and
capabilities of a disabled Plugin must not appear merely because the package exists.

`installed_plugins.json` is always the Host User inventory. Its legacy `scope` has no `workspacePath` /
`workspaceIdentity` and does not take part in Workspace isolation or config-source decisions.

### 5.2 Options

The options form writes to the currently selected scope. `sensitive: true` uses masked input but may be
saved to User or Workspace config; trust or approval must not block saving.

### 5.3 Package actions

Install, update, uninstall and config writes stay independent:

```text
Workspace enable succeeds + package missing
  -> the project keeps the enabled declaration, status is missing

Marketplace install succeeds
  -> package written to Host User inventory
  -> User enabledPlugins defaults true
  -> Workspace config is not modified by Marketplace
```

No cross-file pseudo-atomic transaction, and no rollback of a legitimate user operation that already
succeeded because the other side failed.

## 6. Remote and mobile boundaries

```text
Renderer
   |
   v
one window-scoped Local Host
   |
   +--> local workspace service
   |
   +--> RemoteConnectionRegistry
          |
          +--> SSH / WSL / Docker / Server Agent Host
```

File reads and writes use execution semantics:

```text
<target workspacePath>/.zcode/config.json
```

Cache, Session, async request and state isolation use:

```ts
workspaceKey = workspaceIdentity?.trim() || workspacePath;
```

A remote workspace must carry `workspaceIdentity` and `remoteSessionId`. Plugin state must not be reused
across two targets merely because their `workspacePath` is the same.

Mobile `/remote` only attaches to the existing shared Host and creates no separate Plugin runtime, config
copy or install state. Desktop stays `desktop-continuous`, mobile stays `web-remote-replayable`, and Plugin
config must not change either delivery semantics.

## 7. Service and protocol contract

The UI does not write files directly; it keeps:

```text
UI -> PluginManagementStore -> IPluginManagementService
   -> ZCode Protocol -> Agent config loader/runtime
```

Interfaces carry scope and Workspace context explicitly:

```ts
type PluginScope = "user" | "workspace";

configurePlugin({
  pluginId,
  options,
  scope,
  workspacePath,
  workspaceIdentity,
});
```

`setPluginEnabled`, Marketplace mutations and overview/list follow the same target resolution. The overview
returns final values and sources:

```ts
{
  effectiveEnabled: true,
  enabledSource: "workspace",
  effectiveOptions: { GITHUB_HOST: "github.example.com" },
  optionSources: { GITHUB_HOST: "workspace" },
  package: { installed: true, version: "1.2.0" },
}
```

Settings overview/list requests gain an optional `configScope`:

```ts
type PluginConfigScopeView = "user" | "workspace";
```

- `user`: ignores project Plugin config and returns the User + manifest default projection;
- `workspace`: returns the User + Workspace merged effective projection;
- omitted: keeps the existing effective behavior, compatible with old callers.

When a Plugin declared in config cannot be discovered as a package on the target Host, `plugins/list` still
returns the config row with an optional `packageStatus: "missing"`; omitted means the package is available.
A missing row does not enter the installed inventory and projects no MCP/Skill/Command capabilities, but
still allows writing an enabled override, restoring inheritance and jumping to the Marketplace for an
explicit install.

UI async results and caches must bind to both `(workspaceIdentity?.trim() || workspacePath, configScope)`.

## 8. E2E contract

Each feature needs its own setup, action, assertion and evidence; one long path cannot claim coverage by
the way. Formal cases:

- [Plugin Management Lifecycle Case Catalog](../plugin-management-lifecycle-case-catalog.md)
- [Plugin Management Lifecycle E2E Coverage Matrix](../testing/plugin-management-lifecycle-e2e-coverage-matrix.md)

Workspace-level E2E feature groups:

| Feature                          | E2E case  | Must prove                                                                                                                                                                                    |
| -------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User/Workspace scope UI          | `WPL-001` | Both config views share Host candidates; User not polluted by project overrides; Workspace inheritance/override and A/B isolation                                                             |
| enabled-state priority           | `WPL-002` | Workspace explicit true/false overrides User, missing key inherits                                                                                                                            |
| options deep merge               | `WPL-003` | Merge by Plugin/key, un-overridden User options kept                                                                                                                                          |
| sensitive/secret                 | `WPL-004` | Workspace can save and run; UI/log/provider/mobile artifacts do not leak raw values                                                                                                           |
| all Plugin components to runtime | `WPL-005` | Hook/Skill/Command/Agent/MCP enter a new Session without trust/approval                                                                                                                       |
| missing package behavior         | `WPL-006` | Only shows missing, no automatic install; runs only after an explicit install                                                                                                                 |
| config vs package lifecycle      | `WPL-007` | enable/disable and install/uninstall do not wrongly roll each other back                                                                                                                      |
| resident/cold resume             | `WPL-008` | Resident App frozen, new Session/cold resume reads new config                                                                                                                                 |
| Global Marketplace install       | `WPL-009` | Only the User Marketplace can add/refresh; a declaration alone triggers no download; marketplace install writes User inventory/config, not Workspace enabled/options                          |
| Remote target isolation          | `WPL-010` | Same path, different identity do not cross config and runtime                                                                                                                                 |
| Remote missing/explicit install  | `WPL-011` | Connecting does not copy the local package; explicit Sync/Install materializes only on the remote Host                                                                                        |
| Mobile shared-host               | `WPL-012` | `/remote` uses the existing Host and does not copy Plugin runtime/store                                                                                                                       |
| builtin Workspace disable        | `WPL-013` | Changes only enabledPlugins, does not delete builtin asset/user data                                                                                                                          |
| project Plugin root/MCP          | `WPL-014` | A legal project Plugin root activates directly; illegal manifest/path fails closed                                                                                                            |
| Marketplace/installed roundtrip  | `WPL-015` | From User installed into the global marketplace; browse page has no scope/config; install writes User; primary nav returns to chat, then entering management switches to Workspace for config |

E2E evidence layers:

```text
UI scope/source state
  + persisted User/Workspace config snapshot
  + Agent protocol/effective overview
  + new Session runtime evidence
  + package/cache/remote target evidence
  + no-secret and no-trust/approval evidence
```

Current evidence is not "all done": `WPL-001` to `WPL-011`, `WPL-013`, `WPL-014`, `WPL-015` have separate
pending specs with targeted/replay passes on local macOS. On 2026-08-31 remote verification used an isolated
SSH target: `WPL-010` run `desktop-e2e-20260831-060023-004` proved config, catalog and runtime do not cross
for the same path with different workspace identity; `WPL-011` run `desktop-e2e-20260831-054511-469` proved
connecting does not copy the local package and only an explicit Sync materializes it on the remote Host and
enters the new Session runtime. `WPL-012` has only a shared-host focused integration test and source
evidence for explicit external bridge field projection; it is not a mobile end-to-end E2E. All pending
cases still lack manual review, promotion, Docker admission and three-platform CI. `WPL-005` currently
proves direct-to-runtime with only a representative Skill+MCP fixture; the per-component loop for Command,
Agent and Hook is still to be added.

## 9. Implementation slices

- Slice A, config foundation: User/Workspace config contract; Workspace config discovery; `enabledPlugins` and `options` deep merge; relaxed sensitive option persistence and output redaction; boundaries between User Marketplace source, Host inventory and the Workspace config view.
- Slice B, runtime resolution: startup, `mcp/list` and Settings overview use one effective resolver; installed/builtin/Workspace Plugin candidate discovery; Hook/Skill/Command/Agent/MCP registered from one source; resident freeze, new Session and cold resume regressions.
- Slice C, Settings control plane: User/Workspace config selector; scope-free Marketplace package lifecycle; Marketplace `returnScopeKey` back to the source installed list; enable/disable/reset inheritance; sensitive option masking and saving; missing package / install CTA; independent package/config error states; remote target stale-result guard.
- Slice D, remote/mobile and rollout: RemoteConnectionRegistry target routing; remote Host package/config evidence; mobile shared-host focused integration evidence; macOS/Linux/Windows targeted E2E.

## 10. Acceptance gates

1. The Plugin page has a User/Workspace selector behaving like Skill/Command scope.
2. Workspace config is written to `<workspace>/.zcode/config.json` and no Local file is created.
3. Workspace `enabledPlugins` takes effect for new Sessions, and a missing package is not installed automatically.
4. Workspace options override User by option key; plain, credential and secret values all take effect.
5. Sensitive values may be persisted, but UI, logs, diagnostics, provider capture and mobile replay do not leak them.
6. Plugin Hook/Skill/Command/Agent/MCP enter the new runtime without Workspace trust or independent MCP approval.
7. Package lifecycle does not modify project declarations; a config failure does not wrongly roll back a successful package operation.
8. Remote reads files by target workspacePath and isolates state by workspaceIdentity.
9. Mobile reuses the shared Host and creates no separate Plugin runtime/store.
10. The resident App does not hot-change; new Session/cold resume use the latest config.
11. WPL cases with a current targeted pass have independent E2E setup/action/assertion/evidence; pending, review, fixture, Docker and multi-platform gates remain later promotion conditions.
12. Only when `WPL-001` to `WPL-015` all have their implementation, independent E2E, manual review and platform gates may the feature be declared complete; this V1 commit makes no such claim.
13. The commit itself must pass `pnpm typecheck`, `pnpm lint`, E2E typecheck and the targeted E2E of implemented WPL cases.
14. The Marketplace browse page shows no scope or options controls; install always writes the Host User inventory/User enablement; the management page keeps project scope, and the primary nav returns to chat.

## 11. Out of scope

- Workspace-external assignment store;
- Local scope and `config.local.json`;
- Workspace-independent package/cache/data;
- automatic package install on opening a repo;
- resident App hot-plugging;
- multiple coexisting versions of one Plugin ID on one Host;
- editing User/Workspace enabled/options inside the Marketplace;
- relay/main holding Plugin business state;
- guessing remote identity from workspacePath;
- changing the trust/approval contracts of non-Plugin project hooks/MCP/subagent.

## 12. Security posture

```text
clone/open repository
        |
        v
Workspace Plugin config loads without Workspace trust
        |
        +--> Hook/Skill/Command/Agent/MCP enter a new App
        +--> options/credentials/secrets enter Plugin runtime
        +--> Plugin MCP starts without separate approval
```

This is an explicit exception of the Plugin domain. A tracked `.zcode/config.json` may contain plaintext
secrets and may change Plugin runtime parameters or start Plugin MCP; the product does not block this and
keeps only schema/path/protocol validation and output redaction.

| Boundary                               | Decision                                                     |
| -------------------------------------- | ------------------------------------------------------------ |
| Workspace Plugin enable, dirs, options | No Workspace trust, goes straight into new App resolution    |
| Plugin Hook/Skill/Command/Agent        | Activate with the enabled Plugin                             |
| Plugin MCP                             | Goes straight to runtime, no independent approval            |
| Top-level project hooks/MCP/Agent      | Keep the existing security contract                          |
| sensitive value persistence            | User/Workspace may both save in plaintext                    |
| sensitive value output                 | UI/log/diagnostic/provider/mobile artifacts must be redacted |

## 13. Evidence and source boundary

- Project config loads through the existing `.zcode/config.json` discovery chain.
- Plugin startup, `mcp/list` and Settings overview must unify on one effective resolver.
- Plugin package/installed records are currently user-level on the target Host.
- `workspaceKey = workspaceIdentity?.trim() || workspacePath` is the state isolation contract.
- The persistence block on `sensitive` options in User/Workspace is removed; output still follows the redaction contract.
- Marketplace sources are stored only at the User/Host layer; Workspace config does not declare, add or refresh a Marketplace; only an explicit User Marketplace refresh/install materializes cache/package state on the target Host.
- Local, dual-SSH remote and lifecycle pending E2E have local evidence; mobile only proves that shared-host attachment does not copy Plugin state and has no real-phone `/remote` E2E.

Implementation cannot change only the Settings UI; the config loader, Plugin discovery, Session startup,
protocol/service contract and E2E fixtures/coverage must change together.
