# ZCode Desktop Context

## Status

- This is the current feature spec for injecting ZCode Desktop output-presentation constraints into the Agent context. The constraints are sent with the environment notice, not in the system prompt.
- Desktop context keeps asking the Agent to emit `::code-comment{...}`. Renderer parsing, cards and Review navigation are specified separately in [Assistant Code Comment Cards](../ui/assistant-code-comment-cards.md) and are controlled by a default-off gray-release capability.
- The existing Identity wording about terminal display is unchanged.

## Feature Summary

| Field               | Conclusion                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Change layer        | presentation, runtime config                                                                   |
| User entry          | ZCode Desktop local workspace, Desktop-attached SSH/WSL/Docker workspace                       |
| Evaluation entry    | `zcode --surface desktop --prompt <text>`                                                      |
| Authoritative state | `presentationSurface`, derived by Services from trusted host facts and frozen at Agent start   |
| Default             | `terminal`                                                                                     |
| Not involved        | UI directive parsing, protocol schema, telemetry, provider `sourceTitle`, V4 delivery/recovery |

## Context Section Contract

The Desktop surface uses a dedicated `buildDesktopContextSection()` with this metadata:

```text
name: ZCode Desktop Context
source: desktop_context
injectionTarget: meta_user
cacheHint: dynamic
```

`desktop_context` is announced by the runtime like `env_info`: the builder keeps the section only as a switch and for usage statistics, puts nothing in system and generates no meta user attachment. The body is sent through the environment notice; rules are in the next section.

`### Interactive views` and the session visualization directory are injected only when the official visualize plugin is effectively enabled and the host provides an output directory. It reuses the plugin resolution from App assembly; when disabled or uninstalled the whole Gen UI explanation is not injected, and no "unavailable" substitute text is injected either. Files & URLs and Inline Code Comments are unchanged. See `docs/specs/gen-ui-output-directory.md`.

This only controls newly added model context; it does not change skills, rendering, sandbox or the state echo of existing widgets. Enabling and disabling follow the plugin's runtime assembly timing: a new or re-assembled session reads the current configuration, no hot switch while running is added, and history prompts are not cleaned.

```text
existing plugin config -> effective enabled state after App assembly -> keep the Gen UI output root?
                                                                    -> does the environment notice carry the directory and Interactive views?
```

Body when enabled with a directory:

```text
# ZCode Desktop Context

### Files & URLs
- Return local web URLs as Markdown links (e.g., [label](http://127.0.0.1:8080)).
- File should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.
- Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)).

### Inline Code Comments
- Use the ::code-comment{...} directive when you need to attach feedback directly to specific code lines.
- Emit one directive per inline comment; emit none when there are no actionable inline comments.
- Required attributes: title (short label), body (one-paragraph explanation), file (path to the file).
- Optional attributes: start, end (1-based line numbers), priority (0-3).
- file should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.
- Keep line ranges tight; end defaults to start.
- Example: ::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." file="/path/to/foo.ts" start=10 end=11 priority=2}

### Interactive views
- This Desktop host supports Gen UI: …
- Widget modelContent may accompany a user input in <untrusted_gen_ui_state>. …
```

## Position in the environment notice

```text
system        CLI Prefix / Agent Identity / Dynamic Behavior / Session Guidance / ...   <- no Desktop section
first user    # Environment
              You have been invoked in the following environment:
               - ...
               - Visualization directory for this session: <path>   <- when there is a Gen UI directory
               - ...
              (blank line)
              # ZCode Desktop Context                                  <- zcode_desktop only
              ...
```

Reason: the presentation surface and server-side gray release are process-level facts, while the Gen UI directory changes per session; system is frozen by the prompt snapshot until compaction, and the snapshot compares only the model. With the Desktop section in system, a gray-release flip between two launches, or a session resumed under terminal, would still send the old Desktop section from the snapshot. Inside the environment notice, a change is appended as an environment update and the prefix already sent does not change:

| Desktop form in the last notice                 | Current form          | Appended content                                                                                 |
| ----------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| none (including old metadata without the field) | with / without Gen UI | the whole ZCode Desktop Context (current wording; Interactive views omitted without Gen UI)      |
| with Gen UI / without Gen UI                    | the other one         | the whole ZCode Desktop Context (current wording; Interactive views omitted without Gen UI)      |
| with Gen UI / without Gen UI                    | none                  | `The ZCode Desktop Context above no longer applies: this session is not shown in ZCode Desktop.` |

When only the Desktop section changes, the update is just this text, without the `# Environment update` title; when environment entries change at the same time, the text comes after the entries with a blank line between. When only the Gen UI directory changes (fork), the form stays and only the directory line is appended. When a previously enabled session is resumed, the existing environment delta can still send one directory revocation (`none`), and the Gen UI usage explanation is not injected again.

`customSystemPrompt` replaces the default system prompt set, so Desktop context is not injected; workflow subagents and subagents do not get it either. Their environment notices carry no Desktop section.

## Surface and Launch Chain

Internal type:

```ts
type PresentationSurface = "terminal" | "zcode_desktop";
```

Real Desktop does not require callers to assemble CLI arguments. Services derive the presentation surface from existing host facts, and `ZCodeAgentProcessManager` appends the CLI arguments in one place. CLI evaluation uses the public argument entry:

```text
Desktop Local Host
  └─ agentTelemetry.runtimeSurface=desktop_local_host ─────┐
                                                           ├─> Services derive desktop internally
Desktop-attached Remote Host                               │            |
  └─ serviceAuthorityMode=desktop-attached-remote ─────────┘            v
                                                    app-server --stdio --surface desktop
                                                                       |
zcode --surface desktop --prompt ... -> CLI argument parsing ──────────+
                                                                       |
                                                                       v
                                                    presentationSurface=zcode_desktop
                                                                       |
                                                                       v
                                              AgentRuntimeConfig -> ContextBuilderConfig
```

Integration evidence for the remote Desktop Host must cover this whole assembly chain, not only the authority parser or the surface helper separately:

```text
remote connect command
  -> ZCODE_SERVICE_AUTHORITY_MODE=desktop-attached-remote
  -> entry-stdio bootstrap
  -> createLocalServices(serviceAuthorityMode)
  -> ZCodeAgentProcessManager command resolver context
  -> app-server --stdio --surface desktop
  -> protocol runtime presentationSurface=zcode_desktop
```

Plain `zcode --prompt`, TUI, HTTP server, or a manual `zcode app-server --stdio` stay `terminal` by default. `--surface` is allowed only with `--prompt`, `--target`, `app-server` and `agent-server`; supported values are `terminal` and `desktop`.

`--surface desktop` only simulates the output presentation capability. It does not change:

- provider `sourceTitle`: headless CLI stays `cli`, Protocol/Desktop stays `electron`.
- telemetry `runtimeSurface`.
- the delivery/recovery semantics of Desktop `desktop-continuous` and mobile `web-remote-replayable`.

## Multi-surface and Remote Boundaries

A Desktop local workspace is identified by the existing `agentTelemetry.runtimeSurface=desktop_local_host`; a Desktop-attached SSH/WSL/Docker workspace by the existing `serviceAuthorityMode=desktop-attached-remote`. Both use `zcode_desktop`. Callers do not pass a separate surface config, so the presentation policy does not spread into the Desktop Host and remote server assembly layers.

Mobile `/remote` does not start its own Agent; it attaches to the Host/CLI already in the desktop window. It sees text produced by the same Agent but still uses `web-remote-replayable`. The Desktop Root and both mobile workspace bridge Roots (external relay, token/WebSocket) explicitly enable the gray-release capability, and the Renderer deterministically projects the body and code-comment cards from the same raw row text. The plain Web Server entry stays default-off and keeps showing the raw directive. This UI projection does not change the continuous/replayable delivery boundary and adds no field to the session snapshot.

The config does not enter ZCode Protocol requests and does not take part in workspace identity. Remote workspaces still isolate by `workspaceIdentity?.trim() || workspacePath`; `workspacePath` is only the Agent cwd.

## Desktop SP Server-side Gray Release

Desktop Main requests `/api/v1/client/configs` on the side at startup, and later Host creation triggers an expired refresh on a 1-hour TTL. It reads:

```json
{
  "data": {
    "configs": {
      "desktopContextPrompt": {
        "enabled": true,
        "config_version": "desktop-sp-v1"
      }
    }
  }
}
```

Only a successful response with `code` omitted or `0` is adjudicated: when the config is delivered, `enabled` must be a boolean; when `desktopContextPrompt` is not delivered it is treated as `{enabled:false}` and overrides an older enabled snapshot. Main passes the resulting snapshot to the Local Host through `ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED=1|0`, and along the existing Remote runtime env allowlist to Desktop-attached remote Hosts. Hosts do not call the server and do not re-bucket. When the variable is not provided, the historical Host assembly semantics are kept so CLI, plain HTTP server and existing tests keep running.

A successful result is cached in the Desktop Main process for 1 hour and concurrent in-flight requests are merged. A single request waits at most 3 seconds:

```text
Main ready
   |
   +-- request config (on the side, does not block the first Host)
   |       |
   |       +-- success + valid --> cache {enabled, config_version}
   |       |
   |       +-- error/invalid/timeout (>3s)
   |                    |
   |                    +-- earlier success exists --> reuse the previous snapshot
   |                    +-- none                   --> {enabled:false}
   |
   +-- Host spawn --> read the current snapshot --> inject / do not inject Desktop Context
```

Network failure, a malformed response or a timeout never blocks client startup. A successful snapshot is reused only within the current Desktop Main lifetime; a newly started Host reads the latest snapshot, and an already-running Agent does not switch presentation surface at runtime.

## Acceptance Cases

| Case    | Setup                                                  | Action                                               | Assertions                                                                                                        |
| ------- | ------------------------------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| DCTX-01 | default/terminal ContextBuilder                        | build context                                        | no `desktop_context`                                                                                              |
| DCTX-02 | `zcode_desktop` ContextBuilder                         | build context                                        | section appears exactly once, metadata correct, neither system nor attachment contains the body                   |
| DCTX-03 | `zcode_desktop` + custom system prompt                 | build context                                        | no `desktop_context`                                                                                              |
| DCTX-04 | subagent runtime                                       | build context                                        | no `desktop_context`                                                                                              |
| DCTX-05 | `--surface desktop --prompt`                           | create App                                           | runtime config is `zcode_desktop`, `sourceTitle` unchanged                                                        |
| DCTX-06 | `app-server --stdio --surface desktop`                 | start protocol runner                                | every session App gets `zcode_desktop`                                                                            |
| DCTX-07 | local Desktop runtime fact / attached remote authority | create Services and resolve Agent command            | arguments contain `--surface desktop`                                                                             |
| DCTX-08 | plain HTTP server / manual stdio, no Desktop host fact | create Services and resolve Agent command            | Desktop surface is not added automatically                                                                        |
| DCTX-09 | invalid value / unsupported command                    | CLI argument validation                              | clear error, App not started                                                                                      |
| DCTX-10 | `entry-stdio` receives `desktop-attached-remote`       | resolve Agent command through real Services assembly | authority, resolver surface and command arguments all stay Desktop                                                |
| DCTX-11 | `zcode_desktop` runtime, first turn and cold resume    | send request                                         | the full environment block carries the Desktop section; form changes append per the table above, system unchanged |

## Impact Brief

| Rank           | Relation                                             | Conclusion                                              |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| must-inspect   | CLI parser -> Runtime config -> ContextBuilder       | the single injection chain for the Desktop section      |
| must-inspect   | Host facts -> Services -> Agent process args         | reuses trusted host facts to derive the Desktop surface |
| conditional    | mobile remote -> shared Host/CLI                     | inherits the same prompt, replayable delivery unchanged |
| invariant-only | `sourceTitle` / telemetry                            | does not change with CLI evaluation arguments           |
| invariant-only | custom prompt / subagent                             | the default Desktop section is not injected             |
| evidence-only  | Core/CLI/Bootstrap/Services/Server integration tests | cover local and remote host assembly, no UI E2E         |
