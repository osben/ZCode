# Product capability map: Office and Computer Use incubation capabilities

## Feature Summary

| Field            | Value                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | Add Office suite preview/editing and Computer Use to the capability map, distinguishing current foundations from future productized capabilities                                   |
| Capability       | Office Suite & Computer Use Incubation                                                                                                                                             |
| Change layer     | presentation                                                                                                                                                                       |
| Operating mode   | planning                                                                                                                                                                           |
| Primary seeds    | `packages/ui/src/PreviewPane.tsx`, `packages/ui/src/components/ui/pdf-viewer.tsx`, `apps/zcode-cli/packages/document-skills-plugin`, `packages/services/src/cua-permission-broker` |
| Out of scope     | Implementing native DOCX/XLSX/PPTX editors; changing the CUA permission model or enabling CUA by default                                                                           |

## Current Fact Versus Roadmap

| Domain              | Current                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Incubating / Planned                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Office preview      | Workspace file preview, PDF paginated/zoom preview, read-only DOCX/DOC and XLSX preview                                                                                                                                                                                                                                                                                                                                                                                                                            | High-fidelity PPTX preview, thumbnails, cross-page navigation; native Office editors still planned                  |
| Office editing      | The Agent can create, edit, and verify workspace artifacts via the official DOCX/PDF/PPTX/XLSX Skills                                                                                                                                                                                                                                                                                                                                                                                                              | Native document/spreadsheet/presentation editing, comments, revisions, incremental save, export                     |
| Computer Use        | CUA Helper enabled by default on macOS/Windows local, permission onboarding, screen reading, native input; the model calls through the shared-host `node_repl`'s `agent.computerUse` SDK; CUA runtime/Helper state stays in the shared host; the macOS PiP session coordinator is owned by the producer, with ZCode only publishing foreground session and turn facts; Windows shows a top operation indicator during CUA turns via the `computer-use/operation-event` runtime sideband, with a 30-second fallback | Pause/takeover, step-by-step confirmation, and Linux platform support                                               |
| Multi-client/remote | The Desktop local Host is the CUA permission subject; workspace file services support local/remote                                                                                                                                                                                                                                                                                                                                                                                                                 | Web/Mobile only consume projections or attach to an existing Desktop Host; remote Computer Use needs its own design |

“Planned” nodes in the capability map mark maintenance boundaries and roadmap, not currently callable product interfaces. Group-level LOC counts only landed code — planned capabilities get no prefilled code volume.

## UI Surface Matrix

| User scenario                    | UI entry                                                                                    | Shared implementation                                                                 | Display/draft owner                                                                 | Default/inherit source            | Validation/gating                                                               | Commit action                    | Authority/persistence                              | Mode boundary                                                       | Must remain isolated from                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Preview Office/PDF files         | Workspace File Tree → Preview Pane                                                          | Preview Pane, PDF Viewer, future Office renderer                                      | Renderer preview state                                                              | workspace file metadata           | MIME/extension, size, conversion capability                                     | Read-only open/page/zoom         | Host file/document service; workspace file         | Desktop/Web/Mobile UI reusable; local/remote service sources differ | Agent document generation and native edit commits                                         |
| Edit Office files                | Future Office Editor                                                                        | Future document/spreadsheet/presentation edit shell                                   | Renderer editor draft                                                               | current workspace file version    | file type, write permission, version conflict                                   | save/export/comment/revision     | planned Host Office Document Service               | Must support workspaceIdentity; path IO uses workspacePath          | CLI Document Skills' direct workspace execution                                           |
| Agent creates or edits documents | Conversation + DOCX/PDF/PPTX/XLSX Skill                                                     | CLI Skill runtime, built-in tools and scripts                                         | Agent turn                                                                          | official document-skills plugin   | Skill enabled, dependencies available, tool permissions                         | Write/modify workspace artifacts | ZCode CLI tool execution + workspace files         | local/SSH/WSL/Docker each run in their own CLI workspace            | Native Office Editor draft state                                                          |
| Use Computer Use                 | Generic `node_repl` tool result, CUA permission onboarding; Windows top operation indicator | shared-host node_repl runtime, CuaControlPort, Helper, Desktop Main native projection | CLI runtime lifecycle; Host CUA turn tracker; Renderer generic node_repl projection | MCP config + explicit kill switch | macOS/Windows, local Host, trusted Helper/broker token and platform permissions | observe/click/type/open app      | Desktop-local CUA Helper + shared-host CUA runtime | macOS/Windows desktop-local; mobile via shared-host attachment      | A remote host building its own Helper; other MCP/subprocesses inheriting the broker token |
| Pause or manual takeover         | Future Computer Use control surface                                                         | Future step projection / takeover protocol                                            | Renderer control intent                                                             | active CUA operation              | operation phase, permissions, high-risk actions                                 | pause/confirm/take over/resume   | Undefined; the map keeps only the planned node     | Desktop vs mobile control semantics need their own spec             | Ordinary conversation stop/permission semantics                                           |

## Shared And Divergent Behavior

| Concern              | Shared across surfaces                                                         | Deliberately different                                                             | Why it matters                                                             |
| -------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| UI/component         | Reuse Preview Pane, Conversation Timeline, and the permission dialog framework | The Office editor and Computer Use control panel have separate draft/control state | “Can see a tool card” must not be mistaken for complete Computer Use UX    |
| Option source        | File types and Skill/MCP contributions all come from existing registries       | Office format capability and CUA platform capability are judged separately         | One capability being available does not make the other available           |
| Commit effect        | Both eventually affect user-visible workspace or desktop state                 | Office saves write files; CUA actions change external apps                         | Permission, undo, and recovery models are entirely different               |
| Persistence/recovery | Conversation only projects tool lifecycle                                      | Editor draft/version and CUA live control share no session recovery semantics      | Recovery protocols must be defined separately before future implementation |

## Feature Relationships

| Rank           | From                              | Semantic edge                    | To                                            | Condition                                                                                                                     | Why inspect it                                                                           | Evidence                                                                          |
| -------------- | --------------------------------- | -------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| must-inspect   | Office preview/edit experience    | reads/writes through             | Host Office Document Service                  | When native Office UI lands                                                                                                   | The Renderer never holds Node/LibreOffice file IO directly                               | `IPlatformService` / Host layering constraints                                    |
| must-inspect   | Document Skills                   | produces workspace artifacts for | Office Preview                                | Current DOCX/PDF/PPTX/XLSX skill runs                                                                                         | Agent production and UI preview are two owners                                           | `docs/document-skills-plugin.md`                                                  |
| must-inspect   | Computer Use SDK via node_repl    | executes through                 | shared-host CuaControlPort → Helper/Broker    | macOS/Windows desktop-local                                                                                                   | High-privilege actions must go through the signed Helper and fail closed                 | `docs/cua-permission-broker/zcode-cua-permission-broker.md`                       |
| should-inspect | Computer Use lifecycle projection | renders in                       | Conversation Timeline + Windows top indicator | Conversation uses the generic tool lifecycle; the Windows top indicator independently consumes `computer-use/operation-event` | The indicator only says the Agent is operating — not a live view or a takeover workbench | `packages/ui/src/v4`, `packages/desktop/src/main/windowsCuaOperationIndicator.ts` |
| invariant-only | Remote/Mobile Host                | must not create                  | Desktop CUA Helper                            | SSH/WSL/Docker/mobile remote                                                                                                  | The CUA authorization subject is the local desktop Helper                                | CUA broker fact spec                                                              |
| invariant-only | CUA broker credential             | must remain isolated from        | other MCP/hooks/Bash                          | All CUA runs                                                                                                                  | Prevent confused-deputy                                                                  | CUA broker fact spec                                                              |

## State Owners And Commit Sinks

| State/fact                      | Draft/display owner                    | Authoritative owner                                     | Commit command/service                                           | Persistence/cache                                    | Evidence                          |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| Preview page/zoom               | Renderer                               | Renderer preview component                              | read-only UI action                                              | ephemeral                                            | PDF Viewer                        |
| Office file bytes/version       | Renderer draft (planned)               | Host workspace document service (planned)               | save/export                                                      | workspace file                                       | layering constraints              |
| Agent document edit             | Conversation projection                | CLI Tool/Skill runtime                                  | Read/Write/Edit/Bash/Skill                                       | workspace file + session event                       | document-skills plugin            |
| CUA permission subject          | Permission dialog                      | signed Computer Use Helper                              | request_access / system settings                                 | macOS TCC                                            | CUA broker docs                   |
| CUA observation/action          | Generic node_repl projection           | CuaControlPort + Helper broker                          | `agent.computerUse.<tool>` via `mcp__node_repl__js`              | tool result/session event                            | CUA broker implementation         |
| Windows CUA operation indicator | Desktop Main native projection         | CLI runtime lifecycle + desktop-local Host turn tracker | `computer-use/operation-event` → Host→Main `cua-operation-state` | ephemeral; never into snapshot/replayable            | `windowsCuaOperationIndicator.ts` |
| macOS CUA PiP session surface   | `@zcode/zcode-cua` native presentation | Desktop Main focus router + Host turn fact publisher    | typed `pip-session` presentation client                          | Helper process-local; never into snapshot/replayable | producer `PipSessionCoordinator`  |
| Human takeover                  | Future dedicated UI                    | Undefined                                               | Undefined                                                        | Undefined                                            | roadmap only                      |

## State And Delivery Boundary

```text
Office
Renderer Office Preview / Editor
          |
          | read / convert / save (Editor backend planned)
          v
Host File Service + Office Document Service
          |
          v
workspacePath files
          ^
          | DOCX/PDF Skill + CLI tools (current)
ZCode CLI Document Skills

Computer Use (current macOS/Windows desktop-local beta)
Renderer Conversation / Permission UI
          ^
          | ProductProjection / tool lifecycle
ZCode CLI MCP Runtime -- node_repl js / CUA SDK call -->
          |
          | shared-host bridge token + request context
          v
Local Host CUA Broker --> signed ZCode Computer Use.app --> AX / Screen / Input

CLI runtime lifecycle
        -> computer-use/operation-event sideband
        -> desktop-local Host turn tracker
        -> strict Host→Main cua-operation-state
        -> capture-excluded Windows BrowserWindow

The sideband is sent before legacy delivery filtering; it is not `session/event`,
requires no `deliveryKind`/subscription projection, and never enters snapshots,
replayable recovery, the relay, or Renderer state.

Mobile/Web -- shared-host attachment --> existing Local Host
Remote Host --------------------------X--> create/launch local Computer Use Helper
```

## Must-Preserve Invariants

| Invariant                                                    | Surfaces/modes                    | Proof needed                                                                                  | Evidence                       |
| ------------------------------------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ |
| Planned nodes do not impersonate shipped features            | capability map                    | Node scope explicitly “current/planned”; group LOC counts only current code                   | map data + detail panel        |
| The Renderer never directly owns Office platform IO          | Desktop/Web/Mobile                | Future parse/convert/save goes through an injectable Host service                             | architecture spec              |
| Document Skills stay isolated from native Editor drafts      | Agent + UI                        | Skills work independently; canceling the Editor does not undo Agent-committed files           | document skill boundary        |
| CUA enabled by default and fail closed                       | macOS/Windows Desktop             | Never runs `zcode-cua` bare when explicitly disabled or when the broker/trusted runtime fails | CUA broker spec/tests          |
| Remote/Mobile never starts its own CUA Helper                | remote/mobile                     | Only shared-host attachment reusing the local Host is allowed                                 | web remote + CUA spec          |
| The Windows indicator never enters screenshots or replayable | Windows Desktop/Mobile attachment | `setContentProtection(true)`; state travels only via the Host→Main ephemeral message          | operation indicator spec/tests |

## Codegraph Evidence

The current capability-map worktree has no codegraph index, so this brief verified the current implementation with exact `rg`/file inventories and claims no complete call graph for unindexed code.

| Seed                            | Query               | Direct callers / key path                                                                                        | Depth | Interpretation                                                                                                                                  |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `PdfViewer` / Office Preview    | file/symbol scan    | Preview Pane → lazy PDF/Office content → file service                                                            | 2     | PDF and read-only DOCX/DOC/XLSX preview exist; PPTX/native editor still planned                                                                 |
| `document-skills-plugin`        | package/assets scan | official plugin seed → Skill discovery → scripts/references                                                      | 2     | DOCX/PDF/PPTX/XLSX Agent production exists — not a native editor                                                                                |
| `createDefaultCuaProductHelper` | focused call scan   | local services → shared-host CUA control port → Helper Host → broker                                             | 2     | CUA defaults on but stays desktop-local, disabled by an explicit kill switch                                                                    |
| `WindowsCuaOperationIndicator`  | focused call scan   | CLI runtime lifecycle → `computer-use/operation-event` → desktop-local Host tracker → Host→Main → native overlay | 4     | Windows shows the read-only operation indicator on Computer Use cell triggers with a 30-second fallback; live view and takeover not implemented |

## Graph Drift Candidates

| Candidate               | Live-code evidence                                           | Missing/stale graph relation                             | Proposed follow-up                                                                  |
| ----------------------- | ------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Document production     | The official DOCX/PDF plugin is enabled by default           | The Extension Runtime has only a generalized Skills node | Add a dedicated Document Skills node                                                |
| Computer Use foundation | Substantial CUA broker/Helper/AX/Input implementation exists | The single “CUA permission helper” node over-compresses  | Split into Helper lifecycle, trusted broker, observation, and input execution nodes |
| Native Office UX        | Only PDF preview exists today                                | No roadmap boundary in the graph                         | Add an incubation group, marking DOCX/XLSX/PPTX native UX as planned                |

## Graph Delta

| Status    | Node/edge                                   | Semantic reason                                                 | Evidence      | Action       |
| --------- | ------------------------------------------- | --------------------------------------------------------------- | ------------- | ------------ |
| confirmed | `capability.office-computer-use-incubation` | User asked to add Office and Computer Use future capabilities   | user decision | update graph |
| confirmed | Office preview/edit roadmap nodes           | Current PDF/Skills and future native Office UX must be separate | code + user   | update graph |
| confirmed | Computer Use Host/CLI support nodes         | Current CUA implementation spans the Host broker and CLI MCP    | code/docs     | update graph |
| confirmed | remote/mobile isolation edges               | The Helper is desktop-local only today                          | CUA fact spec | update graph |

## Unresolved Questions

| Question                               | Candidate answers                                             | Scope difference                                                     | Owner                     |
| -------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------- |
| Office native editor parse/render core | Web/WASM; Host conversion; hybrid                             | Affects Web offline capability, remote latency, and file consistency | Future Office owner       |
| Computer Use manual takeover protocol  | Single-owner lease; step-by-step confirm; pause-then-takeover | Affects multi-client control, recovery, and audit                    | Future Computer Use owner |
| Linux Computer Use                     | Per-platform native backend; unsupported for now              | Affects permission model, packaging, and the E2E matrix              | Platform owner            |

## Boundary Decisions

| Boundary        | Decision                                                                                                                                                                                                                                         | Includes                                                                      | Excludes / prunes                                                                       | Source                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------- |
| Map attribution | The Renderer gets a new incubation group; Host/CLI get support nodes in existing groups                                                                                                                                                          | Product entries, platform foundation, Agent runtime                           | A fourth product runtime layer                                                          | user + architecture                      |
| Current/future  | Scope explicitly marked; LOC counts only current                                                                                                                                                                                                 | PDF, DOCX/DOC/XLSX preview, DOCX/PDF/PPTX/XLSX Skills, macOS/Windows CUA beta | Writing PPTX preview or the Office native editor as done                                | user + code                              |
| CUA platform    | The local macOS/Windows Helper is the current product permission subject; the model calls via the shared-host `node_repl` SDK; the extra Windows Main projection is a top indicator triggered by the Computer Use cell with a 30-second fallback | shared-host attachment                                                        | A remote Host building its own Helper; writing indicator state into replayable/snapshot | CUA fact spec + operation indicator spec |
| Office IO       | Future service boundaries go under Host Workbench Services first                                                                                                                                                                                 | local/remote files, conversion, save                                          | Renderer doing Node/LibreOffice IO directly                                             | architecture                             |

## Accepted Cases

| Case ID        | Setup                             | Action                     | Assertions                                                                                | Evidence layers | E2E status |
| -------------- | --------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------- | --------------- | ---------- |
| DOC-CUA-MAP-01 | Load the capability map           | Search for Office          | Find the standalone incubation group with document/spreadsheet/presentation/editing nodes | data + DOM      | automated  |
| DOC-CUA-MAP-02 | Select an Office node             | View first-order relations | Trace to the Host document service and CLI Document Skills                                | data + DOM      | automated  |
| DOC-CUA-MAP-03 | Search for Computer Use           | Select the node            | Trace Renderer UX, Host CUA, and CLI MCP; scope shows current/planned                     | data + DOM      | automated  |
| DOC-CUA-MAP-04 | Desktop/Mobile, light/dark themes | Adapt the global view      | The new group does not occlude; no page horizontal overflow                               | screenshot      | manual     |

## Planning Handoff

| Item             | Destination                                | Status   |
| ---------------- | ------------------------------------------ | -------- |
| Spec update      | `docs/product-capability-map.md`           | complete |
| Case catalog     | Accepted Cases in this document            | complete |
| Coverage matrix  | Accepted Cases in this document            | complete |
| Decision backlog | Unresolved Questions in this document      | complete |
| E2E handoff      | dev-docs data/layout tests + browser smoke | ready    |
