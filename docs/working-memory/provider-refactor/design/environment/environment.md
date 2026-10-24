# Provider's Environment Blueprint

> Mental model for Provider ownership, deployment, and long-term boundaries. Not a description of the
> current implementation, nor a scope the current Provider Refactor completes in one go.

Provider design applies simultaneously to local machines, SSH, and future Cloud Environments. Logical roles
describe responsibilities; roles may run in-process or be handled by Host, Worker, or remote services.

## Logical Roles

```text
Entry
├─ Desktop App
├─ Prompt CLI
├─ TUI
└─ Web / Remote Client
        |
        v
Environment
├─ Provider Config and account facts
├─ Provider Registry
├─ Session and Agent execution
├─ Workspace files, commands, and Git capabilities
└─ Environment persistent data
        |
        v
Model Provider
```

Entry expresses user operations. Environment owns the actual configuration and execution facts. When
crossing processes or networks, the Environment API transmits a portion of external capabilities; services
inside the Environment (Agent, Registry, files) collaborate through in-process interfaces or dependency
injection. The Environment API is the deployment boundary; it does not require all Services to become
independent Servers.

## Provider Ownership

The Environment executing the Agent owns Provider Config, account facts, and Registry:

```text
Local Environment  -> Local Provider facts / Registry
SSH Environment    -> Remote Provider facts / Registry
Cloud Environment  -> Cloud Provider facts / Registry
```

Desktop, Prompt CLI, TUI, and Web are Entries. They view, select, and execute models through the target
Environment. An SSH Environment uses its own remote Provider facts; a local App is not the permanent source
of truth for remote Provider config.

## Provider Domain Boundary

Inputs:

```text
ZCode Built-in Provider Config
Account Built-in Provider Config
Personal Provider Config
ZCode Built-in Model Config Rules
Personal Model Config Rules
ModelSelection
Request-time auth Service
Provider Adapter dependencies
```

Outputs:

```text
Provider Registry View
Model selection / settings facades
Model creation
Model request execution
Usage / Trace identity
```

The Provider domain does not perceive whether config comes from JSON, a database, Host memory, RPC, or a
remote management service. Renderer, React, Electron, Session Runtime, and concrete persistence
implementations are not dependencies of the Provider core module.

## In-Process Reuse

`zcode-cli` is one physical package/executable containing three Entry/running roles and a shared Core:

```text
zcode-cli package / executable
│
├─ Shared Core
│  └─ Agent, Submission, Registry, Model, Adapter
│
├─ Core Worker
│  └─ Wraps Shared Core into a stdio protocol process
│
├─ Prompt CLI
│  └─ Calls Shared Core in the current process
│
└─ TUI
   └─ Calls Shared Core in the current process
```

Prompt CLI, TUI, and Core Worker reuse the same Provider domain implementation. Prompt CLI and TUI assemble
local files, commands, network, and Session Store in the current process; they do not start a Server to call
Core. Window management, remote workspaces, operational sync, and native platform integration are handled by
Host or dedicated Environment services, not replicated in CLI/TUI.

## Current Desktop Mapping

```text
Renderer
    |
    | MessagePort / Service RPC
    v
Local Host
├─ Provider settings and account peripheral capabilities
├─ Workspace / Worker lifecycle
├─ Idle task scheduling
└─ Remote connection
    |
    | stdio Agent Protocol
    v
Core Worker
├─ Shared Core
├─ Agent Loop
├─ Model / Adapter
└─ Session execution
```

The App manages one Core Worker per Workspace to isolate Worker crashes from other Workspaces and Host. This
is a deployment/stability strategy; it does not require the Provider domain to replicate implementations per
Workspace.

Host and Worker use the same Provider domain implementation, each constructing a Registry from its own
Environment's facts. A full Registry Snapshot has left the official fact chain; M4 also removed the
`turnRuntimeModel` / Runtime Overlay previously used by idle tasks. Host provides only standard Selection and
dynamic Request Auth per dispatch; it no longer distributes Provider/Model static snapshots.

## SSH and Cloud Deployment

```text
Desktop / Web Entry
        |
        | SSH / HTTP
        v
Remote Host Server
        |
        | local protocol / stdio / in-process
        v
Remote Core Worker
        |
        v
Shared Core
```

The Remote Host Server exposes cross-network capabilities: connection, authentication, and Worker lifecycle.
The Remote Core Worker uses the same Registry, ModelFactory, Model, and Adapter interfaces as local.
Frequently-used capabilities (files, commands) can deploy in different service clusters in the same server
room; whether they cross processes is decided by deployment. Core depends on capability interfaces and does
not write RPC shapes into Agent execution logic.

## ZCode Built-in Config Publishing and Environment Sync

The server atomically publishes ZCode Built-in Provider Config and Model Config Rules through the existing
`/api/v1/client/configs.data.configs.zcodeBuiltin`:

```text
Bundled / Remote ZCode Built-in Release
├─ Provider Config
└─ Model Config Rules
        |
        | Environment owner fetch / cache
        v
Environment `<platform>/<appVersion>/<endpointKey>/active.json` (also serving as the LKG for this Endpoint)
├─ Host Registry
└─ Core Worker Registry
```

Each Environment caches only its own Active; Desktop does not push local Built-in to Remote Environments.
Host is responsible for remote refresh; the Worker only consumes the active file. When Prompt CLI/TUI lacks a
Host, the Entry itself assumes the same responsibility. If services are temporarily unavailable, Bundled or
LKG continues to be used; version ordering is by Release revision — clients never guess new/old by file
timestamp.

The Endpoint here is the Environment's currently configured ZCode Control Plane Origin, not a model API
Endpoint. Different Endpoints use different Active/LKG and refresh control directories; no cross-Endpoint
revision comparison or fallback. This implementation does not unify other Client Config requests and does
not change Personal/Account Overlay, credentials, or final server-side authorization. The built-in publishing
business integrity gate, canary deployment, and audit remain subsequent publishing-process tasks.

## Remote Environment Provider Authority

When Desktop connects to a remote Workspace, the Remote Environment still owns its own Provider Config,
Credential Store, Registry, and ModelFactory. `desktop-attached` only means Desktop can remotely operate this
Environment; the Desktop Provider Runtime does not extend to the remote side:

```text
Desktop Entry
├─ Display Remote Settings / Selection View
├─ Submit ModelSelection
└─ Control Remote Session
        |
        v
Remote Environment
├─ Remote Provider Config
├─ Remote Credential Store
├─ Remote Provider Registry
└─ Remote ModelFactory
```

Desktop does not inject a complete Registry Snapshot, Runtime Model, Account Built-in Config, or request
credentials into Remote Workers. Remote Workers always create Models from their own Remote Environment's
Registry.

How config and credentials reach the remote side is an independent Provisioning product capability; it does
not change runtime authority and is not part of this Provider Refactor or M4. The ownership boundaries to
maintain:

```text
Step 1: Remote becomes the sole source of execution facts
└─ Remove Provider Runtime injection from Desktop -> Remote

Step 2: Independent sync functionality continuously writes to remote Store
Local Config / Credential
        |
        | Remote Environment-level automatic provisioning sync
        v
Remote Config / Credential Store
        |
        v
Remote Registry rebuilds itself

Step 3: App remotely operates remote settings and login
└─ Calls Remote Settings / OAuth Service
```

Step 2 uses the Remote Environment as the sole sync unit: multiple Workspaces/windows share a single-flight
lane from Desktop Main; Main only coordinates identity, generation, and online Host; the selected Window Host
reads the Local Source and calls the Remote Target. Sync products must first land inside the Remote
Environment's own config and credential boundaries, then be published by the Remote Source. The sync link
does not construct Registry, Model, or request Headers, nor become an online dependency of every model
request. If sync stops, the remote side keeps running on the last successfully written local fact. Editing
remote config or initiating remote login in the App are likewise remote operations on Remote Environment
Services; credential exchange and persistence occur in the Remote Environment — Desktop's Credential Store is
never the remote request authentication source.

## Environment Config Sync

Environments can explicitly sync config. The target Environment writes sync results into its own config
boundaries and re-forms Effective Provider with its own ZCode Built-in Config and Account Built-in Provider
Config:

```text
Environment A Personal Config
          |
          | explicit sync
          v
Environment B Provider Config Service
├─ Environment B ZCode Built-in Config
├─ Environment B Account Built-in Provider Config
└─ synced Personal Config
          |
          v
Environment B Registry
```

The sync protocol must also define target Environment, conflict, credential, and managed field policies.
Sync can run continuously but only updates the target Environment's Store; Registry refresh and model
execution remain entirely within the target Environment.

## Two Types of State for Account Built-in Provider

```text
Static selection facts
├─ ZCode Built-in Provider Config
├─ ZCode Built-in Model Config Rules
└─ Account Built-in Provider Config
   └─ enabled + Start account model members

Dynamic request state
├─ Login Token
├─ One-time security verification / dynamic Header
├─ Cache and refresh
└─ Force update after auth failure
```

Registry uses static selection facts to decide which Providers and Models currently exist. Dynamic request
state is managed by a dedicated Service providing materials when the Model/Adapter truly initiates a request.
See [`../registry/model-creation.md`](../registry/model-creation.md) for detailed boundaries.

Start Plan, Individual Coding Plan, and Team Plan each have a stable providerId and share the Account
Provider type and execution infrastructure; Provider Family is product grouping only, never a replacement
for providerId. Normal structured connection selection enables only one of the matching Providers, so Model
Selection displays only the current connection; Settings can display these fixed Providers and their
enabled/disabled states, preventing runtime morphing between Individual and Team.
