# SSH Remote MCP Sync Design

Local user-level skills already sync to SSH remote hosts. MCP runs similarly: the local settings page reads the local user directory's MCP config, and session create/resume passes enabled MCP configs explicitly to the agent, which starts stdio MCPs or connects HTTP/SSE MCPs in its own runtime. In an SSH remote workspace the MCP processes run on the remote zcode-server host; local configs passed via session parameters work transiently, but the remote user directory never persists them — reopening the workspace remotely, entering via mobile shared-host attachment, or the remote runtime reading its own config still lack the remote `~/.zcode/cli/config.json` user-level MCP entries. This design syncs them.

Goals:

- Sync local user-level ZCode Agent MCP configs to the SSH host's remote `~/.zcode/cli/config.json`.
- Candidates are user-level MCP only — no workspace-level, plugin, built-in, or external-Agent-source MCP.
- Discovery matches local MCP settings: prefer `mcp.servers` in `~/.zcode/cli/config.json`; with no ZCode servers in that scope, fall back to `mcpServers` in `~/.agents/mcp.json`.
- Import writes `mcp.servers` in the remote `~/.zcode/cli/config.json`, never `.agents`.
- Same-name remote MCP is skipped by default, never overwritten.
- Command-type MCPs (stdio, context7) copy config verbatim — no checks for installed commands, package managers, or dependencies remotely.
- HTTP/SSE MCP copies URL, headers, and token secrets verbatim; secrets may land in the remote config file.
- filesystem MCP rewrites local paths to remotely usable paths.
- Remote workspace `workspaceIdentity` / `remoteSessionId` routing boundaries hold; imports never land in the local user directory.

Non-goals (v1): no overwriting; no workspace-level MCP (project files belong to the repo, remote editing, or a separate workspace-config sync design); no plugin MCP (tied to plugin install state); no remote environment validation (missing context7/npx/uvx/custom commands surface through remote `mcp/list` or session startup); no migrating remote `.agents/mcp.json` into `.zcode/cli/config.json` (an existing effective same-name server shows as skipped); no generic remote file-write API.

## Local MCP runtime chain

1. `mcpStore.loadMcpFromUserDirectory()` reads the host user directory via `IPlatformService.loadMcpFromUserDirectory()`.
2. The desktop platform reads workspace scope then user scope; each scope reads `.zcode` first, then `.agents` when no servers exist.
3. The UI holds `ZCodeMcpServer[]` for enable/disable/edit/delete.
4. Before task create/resume, `getEnabledMcpServersForZCode()` converts enabled `zcodeagentmcp` configs into the ZCode Protocol `mcpServers` parameter.
5. The service adapter passes `mcpServers` to zcode-agent create/resume session.
6. zcode-server/bootstrap converts protocol MCP to runtime config; the agent runtime invokes the MCP adapter.
7. stdio MCP starts with the runtime machine's `command`/`args`; HTTP/SSE connects by URL and headers.

Hence MCP in an SSH remote runs on the remote zcode-server machine; passing local config is transient and does not persist the remote user directory.

## Service boundary

A restricted MCP sync service, not an extension of platform directory I/O:

- `listLocalUserMcpCandidates()` — user-level candidates on the caller's machine (local user directory via base services; remote user directory via remote services).
- `listRemoteUserMcpStatuses({ names })` — same-name existence on the remote.
- `exportMcpServers({ serverIds })` — export MCP config DTOs by candidate id, carrying the local home path for rewriting.
- `importMcpServers({ servers, localHomeDir, remoteWorkspacePath, localWorkspacePath?, overwrite: false })` — write into remote `~/.zcode/cli/config.json`, skip same names, rewrite filesystem MCP paths before writing.

Like skill-sync, the service registers on both the local host and the remote zcode-server collection; the desktop renderer's remote workspace service merge must override `mcpSyncService` with the remote service, or imports write back to the local user directory.

## Sync payload

Minimal unit: one user-level MCP server config — `name`; `enabled` (disabled writes the compat field `enable: false`; enabled writes nothing extra); raw `config` fields: stdio `type`, `command`, `args`, `env`, `timeout`/`timeoutMs`; HTTP/SSE `type`, `url`, `headers`, `http_headers`, `timeout`/`timeoutMs`; provider-specific secrets like `apiKey`, `personalAccessToken`, `Authorization`. Never synced: file contents, binary packages, npm/uv/pip dependencies, host environments behind env-var references, or workspace `.zcode/config.json`.

## filesystem MCP path rewriting

Recognition: server name normalized equals `filesystem`, `file-system`, or `fs`; or stdio `args` contains `@modelcontextprotocol/server-filesystem`; or stdio `command`/`args` contains `mcp-server-filesystem`.

Rewriting applies only to path arguments in stdio `args` — never command, env, HTTP URL, or headers:

1. A local workspace path (or subpath), with both `localWorkspacePath` and `remoteWorkspacePath` provided, maps to the remote workspace path keeping the relative suffix.
2. A local home path (or subpath) maps to the remote home path keeping the relative suffix.
3. Other absolute paths stay as-is (e.g. `/tmp/mcp-cache`); the remote runtime reports any nonexistence.
4. Relative paths, package names, flags, URLs, and plain values stay as-is.
5. Windows local home paths rewrite to POSIX or Windows remote homes; separators follow the remote `process.platform`.

Example — local:

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/alice/workspace/z-code", "/Users/alice/Documents"],
        "enable": true
      },
      "context7": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@upstash/context7-mcp"]
      },
      "docs-api": {
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": {
          "Authorization": "Bearer secret"
        }
      }
    }
  }
}
```

Synced to `dev@host:/home/dev/z-code` with remote home `/home/dev`:

```json
{
  "mcp": {
    "servers": {
      "filesystem": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/dev/z-code", "/home/dev/Documents"],
        "enable": true
      },
      "context7": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@upstash/context7-mcp"]
      },
      "docs-api": {
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": {
          "Authorization": "Bearer secret"
        }
      }
    }
  }
}
```

## UI

`Settings > MCP Servers` follows the current workspace services like Skills: local workspaces read/write local user and workspace directories; SSH remotes read/write the SSH host's; the page top shows the remote context to avoid confusing remote with local config; before creating/resuming/queue-draining a task, the MCP store refreshes via the current workspace services — an SSH remote task only passes remote MCP config to the remote agent runtime.

In SSH remote context, an icon button `同步 MCP 到此 SSH 主机` opens `RemoteMcpSyncDialog`: target SSH host and remote workspace path on top; local user-level MCP list with name, type, source file path, status; remote-missing items pre-checked; existing ones unchecked and marked "远端已存在" (remotely existing); `显示远端已存在` filter and select-all-missing checkbox; synced/skipped/failed results after submit. Completion refreshes the MCP store's remote user-directory read and the remote MCP status list. Dialog "local candidates" keep using base services; the settings list outside uses current workspace services.

Skill and MCP sync entries must appear paired everywhere via one shared entry-component set: workspace header more menu, workspace sidebar more menu, the post-connection directory selection page, and the Settings Skills/MCP pages show sync entries only in SSH remote context; menus share the `同步 Skill` / `同步 MCP` items so no entry misses MCP; the directory selection page uses a single `同步` split button (upload-cloud icon + dropdown arrow) containing `同步 Skill` and `同步 MCP`, extensible later with `同步 Subagent` / `同步 Plugin`; the MCP item stays disabled until the current remote directory path is available (filesystem path rewriting depends on it); all entries open the same `RemoteSkillSyncDialog` / `RemoteMcpSyncDialog` with their own refresh callbacks.

## Remote and multi-client compatibility

- Local workspaces show no entry; SSH remotes show it; Docker/WSL remotes do not (v1), avoiding mixed path-rewrite semantics across transports.
- Mobile web remote adds no runtime and does not bypass shared-host attachment — service calls route through the existing remote services.
- Workspace-level state lookups use `workspaceIdentity?.trim() || workspacePath`; file I/O uses `workspacePath`.

## Error handling

- Remote disconnect: dialog error, submit disabled. No local user MCP: empty state. Same-name remote: skipped, not overwritten.
- Partial failure: successes kept, failures show errors. JSON write failure or insufficient permissions: explicit remote service error.
- A filesystem path missing the home/workspace mapping stays as-is without blocking the sync.

## Tests and verification

- Unit: candidate list reads local `~/.zcode/cli/config.json` user-level `mcp.servers`; falls back to `~/.agents/mcp.json` `mcpServers` when `.zcode` user scope is empty; HTTP import preserves URL/headers/secrets; context7/stdio import copies command/args/env verbatim; filesystem import rewrites local home to remote home; same-name remote MCP skipped, not overwritten.
- UI: no entry on local workspaces; `Settings > MCP Servers` shows the entry under SSH remote context; dialog pre-selects missing items and shows results.
- Repository: `pnpm typecheck`, `pnpm lint`.

## Risks

- Copying secrets to the remote is an explicit product choice — no sanitization or filtering; the user must trust the SSH host.
- context7/npx/custom stdio commands may be unavailable remotely; v1 does no environment probing and relies on remote MCP status and runtime logs.
- filesystem rewriting covers only certain mappings; un-inferable absolute paths stay as-is and may fail to connect remotely.
