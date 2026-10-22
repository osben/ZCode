# Incognito session

Status: slice 6 (2026-10-18, in progress): the profile has thirteen capability keys; four of them (`identity`, `harness`, `environment`, `automationTools`) gate prompt and tool text that was core before, see "Prompt toggles". Slices 1–5 implemented: shared profile contract and fork setting; CLI storage (`session.fork_incognito`); CLI runtime overrides, inheritance, dream exclusion and the `incognitoSession` runtime capability (apps/zcode-cli/docs/design/v2/incognito-session.md); Host and renderer capability gates and the `incognito` summary/task-meta projection; UI (composer toggle and checklist, prompt-shell tint and chip, prewarm bypass, sidebar/hover-card/session-manager marker, Settings «Incognito», i18n). Draft-intent generation (scenario 18, composer half) and the serialized Settings write harden the UI races found in review. The desktop E2E scenarios (13, 17) are written but have not been run.

## Problem

Every session starts with all configured extras: project instructions, skills listing, hooks, plugins, MCP servers, custom agents, memory, output style and system-prompt overrides. There is no way to start a clean, vanilla agent conversation to:

- get a clean-room baseline when something behaves oddly (skill/hook interference, context bloat);
- chat with a minimal prompt and no plugin/MCP startup cost;
- talk to the agent without project memory being read or written.

Today the only switches for these extras are global or per-project config, and several of them re-enable themselves (plugin hooks force `hooks.enabled: true` in `mergeRuntimeHooks`, `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts:269`; an empty protocol `mcpServers` list falls back to config servers in `protocol-mcp-config.ts:7`).

## Product rules

1. **Incognito is a per-session start option.** It is chosen in the new-session composer, frozen at session creation, and never changes for the session's lifetime. Mid-session toggling is out of scope.
2. **Minimum by default, opt back in.** An incognito session starts with every toggleable capability **off**. The user can switch individual capabilities back **on** for the session being started.
3. **Defaults live in Settings.** A dedicated Settings section «Incognito» holds the default on/off value of each capability. The composer checklist starts from those defaults; deviations apply to that one session only. There is no separate «Ask before start» dialog — the composer checklist is the pre-start checklist.
4. **Persisted, not ephemeral.** An incognito session is an ordinary persisted session (history, resume, sidebar) that ran with extras disabled. Ephemeral/discard-on-close is out of scope for V1.
5. **Marked everywhere it is listed.** Incognito sessions show an incognito marker in the sidebar, the same way worktree sessions show the worktree marker.
6. **Fail closed.** If any hop (Host or CLI) does not support incognito, session creation is rejected with an explicit error. It must never silently create a normal session.
7. **Inheritance.** Forks, side chats, Task-tool subagents and workflow children of an incognito session run with the parent's profile.
8. **Combines with worktree.** Incognito and execution worktree are independent; a session may be both and shows both markers.
9. **Honest naming.** The feature keeps the name «Incognito», but its UI hint states what it does («A clean session without project instructions, skills, hooks, plugins, MCP and memory») and what it does not do (see Non-goals). It is not a privacy guarantee.

### Capabilities

| Profile key             | When **off** (incognito default)                                                                                                                                                                                                                       | Owner today                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectInstructions`   | No `~/.zcode/AGENTS.md` and no project `AGENTS.md` in the request user context.                                                                                                                                                                        | `resolveUserInstructions`, `apps/zcode-cli/packages/adapters/src/context/index.ts:94`                                                                                   |
| `skills`                | No skills listing meta block. The Skill tool **stays registered**: the user can still invoke a skill explicitly, and the agent may run one the user names.                                                                                             | listing `core/src/context/builder.ts:191`; tool `core/src/runtime/helpers/runtime-tools.ts:55`                                                                          |
| `hooks`                 | No hook runner from user/project config, workspace hook snapshot or plugin hooks. SessionStart hooks do not run.                                                                                                                                       | `createRuntimeHookRunner`, `runtime-tools.ts:93`; `mergeRuntimeHooks`                                                                                                   |
| `plugins`               | Plugin discovery yields nothing for this session: no plugin skill roots, hooks, MCP servers, LSP servers, agents or runtime features. The `node_repl` MCP server, browser use and computer use come from official plugins, so they follow this toggle. | `resolveStartupPlugins`, `bootstrap/src/app/startup-marks.ts:12`                                                                                                        |
| `mcp`                   | No user/project-configured MCP servers.                                                                                                                                                                                                                | MCP merge, `runtime-config.ts:100`                                                                                                                                      |
| `customAgents`          | Subagent profiles resolve as `{ kind: "built-in-fallback" }` (built-in agents only).                                                                                                                                                                   | `packages/shared/src/subagent-runtime-config.ts:32`; `create-app.ts:260,890`                                                                                            |
| `memory`                | No memory root: no memory section, no MEMORY.md index, no recall prefetch, no extraction, `/dream` unavailable, no subagent persistent memory. Excluded from dream (see below).                                                                        | `resolveEnabledProjectMemoryRoot`, `core/src/runtime/helpers/project-memory.ts:4`                                                                                       |
| `outputStyle`           | No output-style system section and no output-style reminders.                                                                                                                                                                                          | `bootstrap/src/output-style.ts:48`, `create-app.ts:300`                                                                                                                 |
| `systemPromptOverrides` | `~/.zcode/system-prompt/<key>.md` overrides are ignored; built-in section texts are used.                                                                                                                                                              | `loadPersistedSystemPromptOverrides`, `bootstrap/src/system-prompt.ts:30`                                                                                               |
| `identity`              | No CLI prefix and no identity intro sentence. The safety notice stays (see "Prompt toggles").                                                                                                                                                          | `ContextBuilder.build`, `core/src/context/builder.ts`                                                                                                                   |
| `harness`               | No `# Harness` block, no desktop context, no dynamic behavior section, no session guidance and no subagent notes. The confirmation paragraph stays as a floor.                                                                                         | `core/src/context/builder.ts`, `core/src/subagent/context-builder.ts`                                                                                                   |
| `environment`           | No `# Environment` block (cwd, platform, shell, OS, git flag, model line) and no git system context. The execution-worktree line stays.                                                                                                                | `core/src/context/builder.ts`, `core/src/subagent/context-builder.ts`                                                                                                   |
| `automationTools`       | No `CronCreate`/`CronList`/`CronUpdate`/`CronDelete`, `OffPeakCreate`/`OffPeakList` and the 11 dynamic-workflow tools (`DYNAMIC_WORKFLOW_TOOL_NAMES`, incl. `ListModels`) are registered; the Agent and Task descriptions carry no workflow guidance.  | `registerBuiltInTools`, `core/src/tool/handlers/index.ts`; gates `core/src/runtime/helpers/runtime-tools.ts:74-82`, `core/src/runtime/helpers/tool-allowlist.ts:78-100` |

**Core (never toggleable):** safety notice, current date, context management, built-in tools, permissions and permission mode, model selection, internal mailbox hooks, the execution-worktree isolation line.

### Prompt toggles

The system prompt's identity, `# Harness` and environment text were core before these toggles existed. The profile makes them toggleable so an incognito session can start with no ZCode identity, harness or environment text. Default is off, like every other capability. The rule for each toggle is "what the section owns", and every section below belongs to exactly one owner. Plain sessions render byte-identically (pinned by tests).

Ownership (main agent, `ContextBuilder.build`; subagents use `SubagentContextBuilder`):

| Toggle            | Sections removed when off                                                                                                                      | Source (file:line)                                                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identity`        | `cli_prefix` system message; the identity intro sentence (`identity-intro` override included). Kept: safety notice.                            | main: `core/src/context/builder.ts:115-116` (cli prefix), `:134-140` (identity section); composition `core/src/context/sections/identity.ts:41-65`; subagent: `core/src/subagent/context-builder.ts:125`                                                           |
| `harness`         | `# Harness` block; `desktop_context`; `dynamic_behavior`; `session_guidance`; subagent `Subagent Notes`. Kept: confirmation paragraph (floor). | main: `builder.ts:151-152` (desktop), `:156-157` (behavior), `:161-163` (session guidance), `identity.ts:29` + `:60-64` (`# Harness`, floor); workflow: `core/src/context/sections/workflow-actor.ts:73`; subagent: `core/src/subagent/context-builder.ts:147-148` |
| `environment`     | `env_info` (`# Environment` heading, cwd, platform, shell, OS, git flag, model line); `system_context` (git snapshot). Kept: worktree line.    | main: `builder.ts:183-190` (env; worktree-only via `core/src/context/sections/env-info.ts:81`), `:202-204` (git); subagent: `core/src/subagent/context-builder.ts:152-158`, `core/src/subagent/system-prompt.ts:31`                                                |
| `automationTools` | Cron, OffPeak and the eleven dynamic-workflow tools; Agent/Task workflow instruction.                                                          | `core/src/runtime/helpers/runtime-tools.ts:74-82`; `core/src/runtime/helpers/tool-allowlist.ts:98-100` (gate), `:78-92` (dynamic workflow helper, shared with `embedded-search-branch.ts`)                                                                         |

Owned by no toggle (core, unchanged): `output_style` (its own toggle), `context_management`, `current_date`, `skills_listing`, `request_user_context` (its own toggles), custom sections, `workflow_actor_identity` persona and contract (the script-facing role contract is required for workflow children to work; only its `# Harness` block follows `harness`).

Minimal prompt, every toggle off (main agent): the stable system message is the safety notice plus the confirmation paragraph, and the dynamic system message is `# Context management`. Neither names ZCode or describes the environment. The system prompt is never empty: the safety notice is the floor, and `assembleSystemMessages` already skips empty groups for the other cases.

Decisions:

- **Safety floor.** With `harness` off, the paragraph "For actions that are hard to reverse or outward-facing, confirm first…" is emitted inside the identity section. Permission enforcement is runtime (permission mode, tool approval) and is untouched by any toggle; the paragraph is prompt text only and is kept so that incognito mode does not remove the model's own confirmation habit. This paragraph is a constant (`RISKY_ACTIONS_PARAGRAPH`) that the communication default also embeds, so the default render stays byte-identical.
- **`harness` drops the desktop context and session guidance, not only the `# Harness` block.** Desktop context is harness instructions for a host surface (Gen UI, file links); session guidance only lists skill usage and is already empty without skills. Both are about how the harness talks to the user, so they follow the harness owner.
- **`environment` keeps the worktree line.** It is the execution-isolation fact (`execution-worktree-model-context.md`): without it the model may merge or report paths outside the worktree. When `environment` is off and a worktree applies, the section is `# Environment` with that single bullet. Current date stays core: it is a meta-user line with no coupling to the other sections.
- **Tools and envInfo collection are unchanged.** `envInfo` (and its git status) is still collected for runtime use. Only prompt rendering is removed, so a toggle never changes tool behavior.
- **Workflow children.** The workflow identity opening sentence (no user, the script consumes results) stays because the script depends on it; a `harness` off workflow child omits its `# Harness` block and keeps the confirmation floor, like the main agent.

## Data model

### Profile (shared, strict)

New module `packages/shared/src/incognito-profile.ts`, exported from the shared public entry:

```ts
export const INCOGNITO_CAPABILITY_KEYS = [
  "projectInstructions",
  "skills",
  "hooks",
  "plugins",
  "mcp",
  "customAgents",
  "memory",
  "outputStyle",
  "systemPromptOverrides",
  "identity",
  "harness",
  "environment",
  "automationTools",
] as const;

// `true` = capability included in this session. Flat and strict: no version field, so any
// stored or sent object with an unknown or missing key is rejected (see "Compatibility").
export const incognitoProfileSchema = z
  .object({
    projectInstructions: z.boolean(),
    skills: z.boolean(),
    hooks: z.boolean(),
    plugins: z.boolean(),
    mcp: z.boolean(),
    customAgents: z.boolean(),
    memory: z.boolean(),
    outputStyle: z.boolean(),
    systemPromptOverrides: z.boolean(),
    identity: z.boolean(),
    harness: z.boolean(),
    environment: z.boolean(),
    automationTools: z.boolean(),
  })
  .strict();

export type IncognitoProfile = z.infer<typeof incognitoProfileSchema>;

export const INCOGNITO_LOCKDOWN_PROFILE: IncognitoProfile; // every capability false
export const INCOGNITO_UNSUPPORTED_ERROR = "proto.incognitoUnsupported";
export const INCOGNITO_SESSION_UNSUPPORTED_ERROR = "proto.incognitoUnsupported.sessionCapability";
export const INCOGNITO_PROMPT_TOGGLES_UNSUPPORTED_ERROR =
  "proto.incognitoUnsupported.promptToggles";
export function resolveIncognitoDefaults(
  stored?: Partial<IncognitoCapabilities>,
): IncognitoCapabilities;
export function buildIncognitoProfile(capabilities: IncognitoCapabilities): IncognitoProfile;
export function parseStoredIncognitoProfile(
  stored: string | null | undefined,
): IncognitoProfile | undefined;
```

- The profile is the **resolved, explicit** value of every capability, never a diff against Settings defaults, so later Settings edits do not change existing sessions.
- No `version` field. The strict key set is the compatibility contract: a reader that cannot parse a stored profile (damaged JSON, an unknown key, a missing key) uses `INCOGNITO_LOCKDOWN_PROFILE`, the most restrictive reading, never "normal session".

#### Compatibility

Choice: **one flat strict profile with the thirteen capability keys and no `version` field.** A version marker only helps a reader that understands it. Strictness makes every reader that does not know the exact key set fail closed, and no reader is asked to interpret a key it does not know. The earlier v1 → v2 upgrade-on-read is removed: it kept two shapes alive for one profile.

Verified (`packages/shared/test/incognitoProfile.test.ts`): zod 4 keeps `.strict()` through `.extend({ version: z.literal(1) })`, so the pre-toggle reader (nine keys plus `version: 1`) rejects a row with four unknown keys and no `version`. The `version: 2` reader of the toggle build also rejects it, because it requires `version: 2`. Both readers then use their own lockdown profile.

Rules:

1. **Writers** (renderer, Host, CLI `createRecord`) send and persist only the flat profile. The wire schema is `.strict()`; a sender that still sends the old `version` shape is rejected by the strict schema (`proto.invalidPayload`) and never creates a session.
2. **Stored readers** (`parseStoredIncognitoProfile`, used by `session.fork_incognito`): parse the flat strict schema; anything else (damaged JSON, an unknown or missing key, a `version` key) returns `INCOGNITO_LOCKDOWN_PROFILE`. There is no upgrade-on-read. The stored row is never rewritten.
3. **Accepted consequence (legacy rows).** Rows written with the pre-toggle nine-key profile (`{"version":1,…}`) read as lockdown: every capability off, including identity, harness and environment, which those sessions ran with. The development database held two such rows when this was decided (2026-10-18), both test sessions. No row written with `version: 2` existed in that database, so none is affected. Accepted by the user; no tolerant reader is added.
4. **Older builds reading a new row** fail their own strict reader (missing `version`, or unknown keys) and use their own lockdown. They never run a normal session.
5. **Older hosts or CLIs** do not advertise `incognitoSession` or `incognitoPromptToggles` (see Protocol), so the renderer and the Host reject before any row is written. The error codes say which flag is missing (see Errors).
6. **Settings defaults** (`incognitoDefaults`) hold all thirteen keys. A stored object with a missing key reads that capability as off.
7. **Future changes.** An existing key never changes meaning. A new capability is a new key; a reader that does not know it falls back to lockdown. A change that old readers would misread needs a new capability flag, gated like `incognitoPromptToggles`.

### Session storage (CLI `~/.zcode/cli/db/db.sqlite`)

- Fork migration `9001_fork_session_incognito`: `alter table session add column fork_incognito text;` — additive, nullable, no default, no backfill. Its id never appears in the upstream checksum pin list (docs/specs/sqlite-session-migration-checksum-compatibility.md).
- `fork_incognito`: `NULL` = normal session; JSON-encoded `IncognitoProfile` = incognito session.
- **Set once, never cleared.** The session upsert in `createSession` (`adapters/src/storage/session-store/repositories/sessions.ts:21`) writes the column on insert and uses `fork_incognito = coalesce(session.fork_incognito, excluded.fork_incognito)` on conflict — the same pattern as `execution_directory`. A profile can land after an earlier `NULL` insert, but once set it is never changed or cleared (upstream upserts do not list the column at all).
- `CreateSessionInput` gains `incognito?: IncognitoProfile`. Every path that writes a session row must carry it for incognito sessions: deferred first-send persistence (`core/src/runtime/methods/events.ts:606`), legacy create (`bootstrap/src/zcode-protocol/server-operations.ts:1158`), the v4 bridge (`v4-bridge.ts:1559`), fork (`core/src/runtime/methods/session-fork.ts:896`) and the session store's child/copy paths (`sqlite-session-store.ts:364,421,508`).
- `SessionInfo` gains `incognito?: IncognitoProfile`, decoded from the column.
- Upstream coexistence (verified): the migration runner checks only its own migration ids, so an upstream build ignores the `9001_fork_*` ledger row; upstream's session upsert lists columns explicitly, so it inserts `NULL` for its own new sessions and never touches the value on existing rows.

### Fork settings (`~/.zcode/v2/fork-settings.json`)

- New fork key `incognitoDefaults` in `FORK_SETTING_KEYS` (`packages/shared/src/forkAppSettings.ts:14`), never in `appSettingsObjectSchema` / `setting.json`.
- Value: the thirteen capability booleans of the profile. Effective default: every capability `false`. Reads tolerate a partial or damaged object (a missing capability is off). The patch schema requires every capability: the sidecar merges top-level keys only, so a partial object would replace the stored one and drop the others.

### Session summary projection

- `deriveSessionSummary` (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts:119`) emits a **top-level optional** `incognito: true` when the session row has a profile (older parsers strip unknown top-level keys; nested schemas are strict — `packages/shared/src/zcode-protocol-v4/sessions-index.ts`).
- `mapSessionSummaryToTaskMeta` → `ZCodeTaskMeta.incognito?: boolean` (`packages/shared/src/zcode-task-types-core.ts:372`). Only the boolean leaves the CLI; the profile itself is not projected.

## Protocol

- v4 `createSession` (payload schema split out of `command.ts` into `packages/shared/src/zcode-protocol-v4/create-session-command.ts`) gains `incognito: incognitoProfileSchema.optional()`. Absent = normal session.
- **Worktree preparation cannot carry `incognito`.** The v4 prepare step (`worktreePreparation`) reserves the session row before any profile exists, and that reservation write has no profile, so a create that sends both is rejected — by a refinement on the shared payload schema and again in the handler (`proto.invalidPayload`). The profile is sent on the activation `createSession` (`preparedSessionId`) instead.
- **Prepared-row activation freezes the profile on first use.** The bridge compares the requested profile with the stored row profile (`getSession(...).incognito`) before any reuse of a prepared identity: a mismatch — including an absent profile on an incognito row, or a profile on a normal row — is rejected (deep-equal on the normalized profile), and materialization uses the stored profile once one exists. A retry can therefore never report success for a profile the session does not have.
- Legacy `session/create` (`packages/shared/src/zcode-protocol/index.ts:1927`) gains the same optional field, so the bridge (`bootstrap/src/zcode-protocol/v4-bridge.ts:1443`) and `createRecord` (`server-operations.ts:3503`) carry it explicitly. The handler pick list in `session-mgmt.ts:73` must name it. A create with `importedHistory` persists through `persistImportedSessionHistory`, whose session inputs carry the profile: the `app.resume()` that follows marks the runtime persisted, so first-send persistence never gets a chance to write it.
- `incognito` is **never** an optional compat field: it must not be added to `SESSION_CREATE_OPTIONAL_COMPAT_FIELDS` or `SESSION_RESUME_OPTIONAL_COMPAT_FIELDS` (`packages/services/src/zcode-agent/zcodeAgentService.ts:440`). If a CLI's `.strict()` schema rejects it, the create fails; the Host must not retry without it.
- Capability gate, two hops (precedent: `independentPlanState`):
  1. CLI advertises `incognitoSession: true` and `incognitoPromptToggles: true` in runtime capabilities (`zcodeRuntimeCapabilitiesSchema`). `incognitoPromptToggles` is the shape gate: it is advertised only by a CLI whose profile schema accepts the thirteen keys. A CLI with only `incognitoSession` (the nine-key era) must not receive a create, because it would reject the payload or read it as lockdown.
  2. Host checks the CLI with an `ensureIncognitoSupport(client)` gate (same shape as `packages/services/src/zcode-agent/independentPlanSupport.ts`) before forwarding a `createSession` that carries `incognito`; the gate requires both flags, checks `incognitoSession` first, and throws the subcode of the first missing flag (see Errors).
  3. Host advertises `incognitoSession: true` and `incognitoPromptToggles: true` in `hostCapabilitiesSchema` (`packages/shared/src/zcode-protocol-v4/transport.ts`); the renderer transport (`packages/ui/src/v4/agentConversationTransport.ts`) throws the subcode of the first missing flag before sending (`incognitoSession` is checked first).
- The Host never rewrites or fills the profile; the renderer sends the resolved profile.

## Owners and event order

| State                                 | Single owner / writer                                         | Readers                                                   |
| ------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| Defaults (`incognitoDefaults`)        | Host `SettingService` (fork sidecar)                          | Settings «Incognito» section, composer                    |
| Draft intent + per-session deviations | Renderer draft store (UI-local, not a server fact)            | Composer                                                  |
| Intent generation per workspace       | Renderer draft store (same owner as the intent)               | Composer toggle (activation), send cleanup (deactivation) |
| Session profile (`fork_incognito`)    | CLI `createRecord` → session upsert (set once, never cleared) | CLI runtime composition, resume, fork, child, dream       |
| Sidebar flag (`incognito: true`)      | CLI sessions-index projection (derived, read-only)            | UI task list, hover card, session manager                 |

```mermaid
sequenceDiagram
  autonumber
  participant S as Settings (fork-settings.json)
  participant C as Composer (renderer draft)
  participant T as Renderer transport
  participant H as Host
  participant CLI as CLI createRecord
  participant DB as db.sqlite session.fork_incognito
  participant RT as Session runtime (App)
  participant IX as Sessions index → sidebar

  S->>C: incognitoDefaults (on toggle activate)
  C->>C: user deviations (draft only, prewarm bypassed)
  C->>T: createSession{ incognito: resolved profile }
  T->>T: hello.capabilities.incognitoSession === true? else reject
  T->>H: v4 command
  H->>CLI: ensureIncognitoSupport (runtimeCapabilities) else reject
  CLI->>DB: insert session row + fork_incognito (set once)
  CLI->>RT: runtimeConfig.incognito = profile
  RT->>RT: first turn: context/MCP/skills/memory composed under profile
  CLI->>IX: summary incognito: true
  Note over RT,DB: evict / cold resume / fork / side chat / child<br/>read the profile from the row (or parent), never from Settings
```

Ordering constraints:

- The profile is persisted in the same insert as the session row, so no observable session exists without its profile. Draft sessions are deferred until first send (`session-mgmt.ts:24`); the profile travels with that first create and with the deferred-persistence write in `events.ts:606`.
- Runtime composition reads `runtimeConfig.incognito`, which `createRecord` and resume set from the row. No component reads Settings to decide whether a running session is incognito.

## Runtime composition (CLI)

- `AgentRuntimeConfig` (`apps/zcode-cli/packages/core/src/runtime/types.ts:122`) gains `incognito?: IncognitoProfile`. Set by `createRecord` from params, and on resume from `SessionInfo.incognito` (`resume.ts` alongside `executionWorktree`). The CLI's own TUI/headless resume resolves the target through `resolveResumeSession`, which returns the persisted profile with the id and forwards it into `createZCodeApp`'s `runtimeConfig`.
- Each capability has one override point that wins over every config source (global, project, plugin, env):
  - `projectInstructions` off → `resolveUserInstructions` is not called; `userInstructions` empty.
  - `skills` off → `ContextBuilder` omits the skills meta block; the skill port and Skill tool remain.
  - `hooks` off → no hook runner for config, workspace snapshot or plugin hooks (`mergeRuntimeHooks` must not re-enable). Internal mailbox hooks stay.
  - `plugins` off → plugin discovery for this App returns the empty outcome (same as `plugins.enabled: false`, `adapters/src/plugins/index.ts:145`), which also removes plugin skill roots, hooks, MCP, LSP and agents.
  - `mcp` off → user/project-configured MCP servers are dropped from the merge; plugin-provided servers (including `node_repl`) follow `plugins`. `mcp.enabled` is not used, because it would also remove plugin servers.
  - `customAgents` off → subagent runtime config is `{ kind: "built-in-fallback" }` regardless of the Host's `subagents/readRuntimeConfig`, and `subagents.builtInModelSelectionOverrides` is cleared (user-configured `Explore`/`general-purpose` model overrides included), so built-in agents run their default models.
  - `memory` off → `memory: { enabled: false }` regardless of the Host `memoryEnabled` preference; no memory root, recall, extraction or `/dream`.
  - `outputStyle` off → no active output style.
  - `systemPromptOverrides` off → overrides map empty.
  - `identity` off → no CLI prefix section and no identity intro (`ContextBuilder` gate; subagents skip the CLI prefix too).
  - `harness` off → no `# Harness`, desktop context, dynamic behavior, session guidance or subagent notes; the confirmation paragraph is emitted as a floor. Workflow children omit their `# Harness` block and keep the confirmation floor.
  - `environment` off → no `# Environment` block (except the worktree bullet) and no git system context; subagent environment keeps only the worktree line.
- Plain sessions (`incognito` absent) are byte-identical in prompt and behavior to today.
- Inheritance: `forkSession` (`server-operations.ts:2318`), side chats, Task-tool children (explicit config field list in `core/src/runtime/methods/subagent.ts`) and workflow child runtimes (`bootstrap/src/app/script-workflow-child-runtime.ts:295`, which re-reads skills config) receive the parent profile explicitly. Child session rows store the inherited profile.
- Dream exclusion: `selectProjectDreamSessions` (`core/src/runtime/helpers/project-memory-dream.ts:59`) skips sessions whose profile has `memory: false`, so another session's `/dream` never reads an incognito transcript.

## UI

- **Composer toggle.** Rendered in the composer's top row, the `contextHeader` row (`data-composer-context-row` in `packages/ui/src/v4/ConversationComposer.tsx`), after the workspace (project) chip and the Git branch chip. It sits at the row's trailing end (`ml-auto`). It is not in the bottom toolbar's trailing cluster (`submitControlNode`) and not in the leading group next to the mode switch. Available in every workspace type, gated by the same `draftMode && sessionId === null && !isWebRemoteControl` condition as before, plus the absence of an active first submission (`firstSubmissionActive`, the SessionPane `hasFirstSubmission` fact that also drops the draft context header and the Git destination control): the icon is a start-only option, exactly like choosing Git. Once any first send is frozen — ordinary, incognito, worktree or queued — the icon disappears even while the session is not bound yet, and drafts composed during preparation cannot arm or change the frozen profile (`specs/first-submission-lifecycle.md` rules 1 and 9). `aria-pressed`, tooltip, i18n label.
  - The top row keeps `flex-wrap`: when the composer is narrow the toggle drops to a second line instead of overflowing, with no horizontal page scroll at phone width (375px) or a ~380px composer.
  - The toggle is not part of `useComposerToolbarFit` (no `data-composer-collapse-priority`, no compact-only styling). The label is never collapsed to an icon; the row wraps instead.
  - **Off:** icon-only ghost button (lucide `VenetianMask`, `size-4`, `size-7`), tooltip «Incognito session», `aria-pressed="false"`. Clicking it turns incognito **on** directly: no menu opens. The per-session capability set is read from the Settings defaults (async read; the chip appears once that read resolves, and a late read never arms a newer draft, see Draft state).
  - **On:** a cyan pill chip (`rounded-full`, token `--color-incognito`) with the «Incognito» label. The chip is a `relative` wrapper (`group/incognito-chip`, carrying `data-testid` `v4-composer-incognito-marker`) that holds the trigger button and a sibling turn-off button; the wrapper never nests a button inside the trigger.
  - **Turn-off button** (`data-testid` `v4-composer-incognito-off`, `aria-label` = `chat.incognito.turnOff`): an absolutely positioned `Button` sibling, the same pattern as the project chip's detach button in `ChatEmptyState.tsx` (`composer-project-detach`). It is `opacity-0 pointer-events-none` and becomes visible on `group-hover/incognito-chip` and `group-focus-within/incognito-chip`, overlaying the mask icon, which fades out at the same time. It is reachable by keyboard focus (Tab) and is disabled with the control.
  - **On, trigger click:** clicking the chip text (not the inline turn-off button) opens the checklist menu. The trigger is a menu button: `aria-haspopup="menu"`, `aria-expanded` reflects the open menu, `aria-pressed="true"`.
  - **Turning off:** only the inline turn-off button (×) turns incognito off from the chip; the menu has no master row.
- **Checklist.** The menu (opened only from the active chip) lists one row per capability in `INCOGNITO_CAPABILITY_KEYS` order, each with a visible leading checkbox (the row stays a `menuitemcheckbox`), checked as in the draft's frozen capability set. The menu has no incognito on/off row (the chip's × is the only off control) and no footer link to Settings: Settings «Incognito» remains reachable from the Settings page. Changing a row changes that session's set only (draft deviation). Test IDs: `v4-composer-incognito-trigger`, `v4-composer-incognito-off`, `v4-composer-incognito-capability-<key>`.
- **Composer highlight.** New semantic token `--color-incognito` defined in all four theme blocks of `packages/ui/src/styles.css` (mirroring `--color-worktree-task`) and documented in DESIGN.md. Active incognito tints the prompt shell border via `shellClassName`. The active chip is always paired with the «Incognito» label, so the state is not color-only; the mask icon is not repeated next to the label.
- **Draft state.** Incognito intent and deviations are UI-local draft state keyed by the workspace identity key (`workspaceIdentity?.trim() || workspacePath`). They clear after the session is created. The draft store also owns a per-workspace **intent generation**: a counter bumped on every intent transition (activation, explicit deactivation — including a no-op one, which cancels a pending activation — capability change) and when a draft is submitted. Async continuations capture the generation when the user acts and apply only if it is still current, so a defaults read that resolves after the draft was sent never arms the intent for a later draft, and a send completion never clears the intent of a newer draft that re-armed or changed capabilities while the send was in flight.
- **Prewarm.** While incognito is active the draft does not use or promote a prewarmed session (same as worktree sends, `SessionPane.tsx:3507`); toggling invalidates the prewarm. This matters beyond reuse: `getSkillCatalog` on a prewarmed draft runs `ensureContextInitialized` and fixes its instructions and skills before the first message (specs/global-instructions.md).
- **Slash catalog.** Accepted V1 limitation: with `plugins` off, the composer slash catalog may still list plugin-sourced skills; invoking one fails as an unknown skill.
- **Sidebar marker.** `IncognitoTaskMarker` (uncolored, `size-3.5`, like `WorktreeTaskMarker`) reads `task.incognito`; rendered at the same sites as the worktree marker (`TaskListItem.tsx`, `workspace-grouped-tasks/task-row.tsx`, `TaskSidebarHoverCard.tsx`, session manager rows). Both markers render when both apply.
- **Settings «Incognito».** New section in the `agentCapabilities` group (`packages/ui/src/settings/settingsPageConfig.ts`), one `SettingsRow` + switch per capability, plus the honest-scope hint (Non-goals). Every write sends the full `incognitoDefaults` object (`resolveIncognitoDefaults(current)` with one capability flipped); the patch schema rejects partial objects. Because a full-object write races with the settings refresh, the section keeps an immediately-updated optimistic draft as the single source for the next write and serializes writes through a promise chain, so quick successive toggles compose instead of the second write erasing the first; the draft resyncs from the refreshed settings once the write queue is idle, and a failed write reverts the draft to the stored defaults.
- **Mobile Web.** The mobile Web task list currently renders no worktree marker; the incognito marker follows the same treatment (added wherever the worktree marker is rendered, so out of V1 on mobile today). Creating incognito sessions from mobile remote control is out of scope for V1 (toggle hidden in the compact remote shell).
- **i18n.** All strings in `en-US`, `zh-CN`, `uk-UA`. The turn-off aria-label is `chat.incognito.turnOff` (renamed from `chat.incognito.removeMarker`, same text and translations).
- **Errors.** Every capability-gate failure throws a code that starts with `proto.incognitoUnsupported`, so one prefix check matches them all. The suffix says which flag is missing:
  - `proto.incognitoUnsupported.sessionCapability`: the CLI or Host does not advertise `incognitoSession`. Toast: «This agent version can't start incognito sessions. Update the app or the remote agent and try again.»
  - `proto.incognitoUnsupported.promptToggles`: `incognitoSession` is advertised but `incognitoPromptToggles` is not, so the agent is a stale build (typically a local desktop agent that was not rebuilt). Toast: «The agent is out of date. Restart the app or update the remote agent (dev: restart dev:desktop to rebuild the agent) and try again.»
  - A failed capability read keeps the bare `proto.incognitoUnsupported` and shows the sessionCapability text.
    The codes reach the renderer unchanged: `packages/rpc/src/channelServer.ts` sends `error.message` and `channelClient.ts` rebuilds the error from it. The toast choice is `incognitoUnsupportedMessageId` (`packages/ui/src/lib/incognitoUnsupportedMessage.ts`). Both toasts use the warning variant. The draft text and the incognito selection are kept. Fail-closed is unchanged: no row is written on any of these codes. The toast never shows flag names or code strings. The renderer checks the Host hello and the Host checks the CLI, in the same order: `incognitoSession`, then `incognitoPromptToggles`. Both sites call the one helper `incognitoCapabilityGateError` (`packages/shared/src/incognito-profile.ts`), which owns that order and the subcode choice.

## Sidebar marker durability

Status: implemented (2026-10-18) for items 1-5 below; dev-web end-to-end verification is pending (see Limit). Proposed after the dev-web investigation. The marker today depends only on the live sessions-index overlay, so any client that does not observe the CLI sessions-index (dev web: the server shows no zcode-cli child and the rows carry only tasks-index meta) renders no marker, and tasks-index never stores `incognito`.

Root cause (file:line, verified in the code and in the dev web DOM):

- The only writer of `incognito` on the list path is the overlay: `sessionOverlay` (`packages/services/src/window-controller/windowHostControllerService.ts:107`) → `buildSourceRows` (`windowHostControllerProjection.ts:179`) → row (`windowHostControllerService.ts:706,761`). Without an observer the row has no `incognito`.
- Persisted meta has no field for it: the runtime snapshot upsert rebuilds meta from explicit fields (`packages/services/src/session/taskIndexRepo.ts:1700-1725`), which would drop `incognito` on every sync, and `zcodeTaskMetaSchema` (`packages/shared/src/validation.ts:1704`) has no `incognito` key.
- Convergence exists only for the execution-worktree fact (BUG-GWT-010: `convergeExecutionWorktreeFacts`, `windowHostControllerService.ts:215`; `applyExecutionWorktreeFacts`, `taskIndexRepo.ts:2175`). It runs inside the overlay observer, so it does not help a client without one.
- Legacy rows: `sess_f17a4862-…` has `fork_incognito` in `cli/db/db.sqlite` but no `incognito` in `tasks-index` meta_json. The desktop observer, which shares the DB, can converge it.

Design (mirrors BUG-GWT-010; `incognito` is frozen per session, so a persisted `true` never goes stale and needs no clearing):

1. `zcodeTaskMetaSchema` accepts optional `incognito: boolean` (tasks-index meta_json only; the wire row keeps its own `incognito` field).
2. The runtime snapshot upsert preserves the stored value: `incognito: params.meta.incognito ?? existingMeta?.incognito`.
3. Convergence: the observer's incognito overlays are persisted into meta_json (`true` only, idempotent) through an explicit write method, `IZCodeTaskService.persistIncognitoMarkers({ workspacePath, workspaceIdentity, taskIds })` → `TaskIndexRepo.persistIncognitoMarkers` (implemented by `zcodeTaskServiceAdapter`). It is not a side effect of a list read.
   - One transaction covers all ids (one BEGIN IMMEDIATE, one COMMIT, one prepared UPDATE per row that needs it); it waits for queued per-task writes first.
   - Covers active, pinned and archived rows. The list read excludes pinned and archived rows, so they were never acknowledged before and were retried on every publish.
   - Returns the ids whose row carries the marker after the call. Absent, deleted and unreadable rows are not returned.
   - A reservation placeholder (`cli_created_at` NULL, `created_at` 0, `meta_json` '{}', the signature of `RESERVATION_PLACEHOLDER_SQL`) is absent for convergence. Writing the marker into it would break the signature and leave a zero-time phantom row, and the admission write (`applyCliFacts`) replaces the whole `meta_json`, which erased a converged marker while the acknowledgement still reported it persisted. The id is therefore not returned and is retried on the next publish, which runs after admission (the same rule covers the execution-worktree fact, which shares `convergeTaskMetas`). Test: `taskIndexIncognitoMarker.test.ts` "never writes the marker into a reservation placeholder".
   - Acknowledgement: the window controller adds exactly the returned ids to its per-source acknowledged set, without a second read. Ids not returned are retried on the next publish. The set is bound to the task-service instance, so a replaced service starts empty. The bookkeeping (in-flight, ack, service reset) is shared with the execution-worktree fact (`persistSourceFacts`); only the batch write and its confirmation differ.
4. Reads: `buildSourceRows` and the search path use `overlay?.incognito || membership.meta.incognito`, so a persisted marker shows without a live overlay.
5. Fork-safe: meta_json is a JSON blob (no migration, no new column, no `setting.json` key). Upstream strips unknown meta keys on read; the marker is re-converged by the next observer publish after an upstream rewrite.

Limit: convergence needs a live sessions-index overlay with `incognito`. A client that never receives one (dev web today: its sidebar rows carry only tasks-index meta) cannot converge, so the marker appears only after a build that includes this change has observed the sessions (desktop Host restart, or a web controller that receives the overlay). Verified by tests: services `taskIndexIncognitoMarker.test.ts` (live convergence, cold restart, sync preserve, absent row) and UI `buildTaskListResultFromSessions.test.ts` (persisted marker kept when the summary lacks it).

Scenario 23: the web sidebar (no sessions-index observer in-process) shows the incognito marker for a session whose tasks-index meta carries `incognito: true`; a runtime snapshot sync does not erase it; a legacy row converges from the CLI row via the observer.

## Acceptance scenarios

1. Incognito with all defaults → first-turn prompt has no AGENTS.md, skills listing, memory section/index, output style or overrides; no hook runs; no configured or plugin MCP server connects; only built-in agents are listed; no `node_repl`, browser use or computer use (they come from official plugins).
2. Each capability switched back on individually → only that capability returns (one scenario per key).
3. Skills off → a skill named explicitly by the user still runs via the Skill tool.
4. Plugin hooks installed + hooks off → no hook runs (regression for the forced `enabled: true`).
5. Normal session → prompt and behavior byte-identical to before (regression guard).
6. Incognito session idle-evicted and cold-resumed, or app restarted → same profile applies (read from `fork_incognito`).
7. Settings defaults changed after an incognito session started → that session's behavior unchanged.
8. Fork, side chat, Task-tool subagent and workflow child of an incognito session → same profile; child rows store it.
9. Another session in the same workspace runs `/dream` → the incognito session's transcript is not selected.
10. Stored profile unparsable (damaged JSON, unknown or missing key, a `version` key) → session runs with the lockdown profile, not as normal.
11. CLI without `incognitoSession` capability (older or remote CLI) → create rejected with `proto.incognitoUnsupported.sessionCapability`; no session row created.
12. Host without the capability → renderer rejects before sending.
13. Sidebar shows the incognito marker for incognito sessions, both markers for incognito + worktree, none for normal sessions; at every site that renders the worktree marker.
14. Database written by the fork, opened by an upstream build → upstream starts normally (ledger and upsert compatibility).
15. A CLI whose legacy `session/create` `.strict()` schema rejects `incognito` → create fails; the Host does not retry without the field.
16. The deferred first-send write and the create write race (row first inserted without profile) → the profile still lands and is never cleared afterwards.
17. Composer: toggle on → shell tinted and chip shown; checklist reflects Settings defaults; deviation applies to the next session only; toggle off → normal session; prewarmed session never promoted for an incognito send.
18. Stale-intent races: the defaults read resolving after the draft was sent or the toggle unchecked does not arm the intent; a send completing after a newer draft re-armed the intent (or changed capabilities) does not clear it. Two quick Settings toggles both persist (the second write composes on the first).
19. v4 `createSession` with both `worktreePreparation` and `incognito` → rejected (`proto.invalidPayload`); no session row is reserved. The profile is accepted on the activation create instead.
20. Prepared-row activation profile mismatch: a repeat createSession whose `incognito` differs from the stored row profile (present vs absent, or a different capability set) → rejected; a matching retry returns the existing session, and materialization uses the stored profile.
21. A session created incognito in Desktop, resumed in the CLI (TUI `--resume`/`--continue` or headless `-p --resume`) → runs with the frozen profile (no plugins/MCP/hooks/`AGENTS.md`/memory extraction), not as a normal session.
22. `session/create` with `importedHistory` and `incognito` (both import sources) → the session row stores the profile; a later first send does not overwrite it and the runtime keeps the profile.
23. Incognito with all thirteen defaults off → the model request's system messages contain the safety notice and the confirmation paragraph, plus `# Context management`; no text containing the CLI prefix, the identity intro, `# Harness`, `# Environment`, `Primary working directory`, `gitStatus:`, `# ZCode Desktop Context`, `# Communicating with the user` or `# Session-specific guidance` (the test asserts each marker is absent in the built messages and in the model-io request).
24. Each prompt toggle switched on individually → only its own sections return: `identity` → the CLI prefix and intro; `harness` → `# Harness`, desktop context, communication and session guidance; `environment` → `# Environment` and the git system context; `automationTools` → the Cron, OffPeak and dynamic-workflow tool names appear in the registered tool list and the Agent/Task descriptions carry workflow guidance. Each one is asserted against the built prompt or tool list.
25. Normal session → prompt byte-identical to the pre-change prompt (the existing snapshot tests for the default prompt, including desktop, subagent and workflow children, must not change).
26. `environment` off with an execution worktree → the prompt keeps the worktree bullet under a `# Environment` heading and nothing else from the environment block; the worktree line stays in subagent environment context.
27. `harness` off → the confirmation paragraph is present exactly once; `harness` on → it is present exactly once, inside Dynamic Behavior.
28. A pre-change nine-key profile row (`{version: 1, …}`) read by this build → lockdown profile (every capability off); the row is not rewritten and no upgrade happens. Covered by a test that pins the lockdown reading.
29. A 13-key row, or any row with a `version` key, read by an older build → that build's strict reader rejects it and uses its own lockdown. `incognitoProfile.test.ts` reproduces the pre-change reader shape (`.strict()` then `.extend({ version: z.literal(1) })`) and pins the rejection.
30. CLI with `incognitoSession` but without `incognitoPromptToggles` → Host create rejected with `proto.incognitoUnsupported.promptToggles`; the renderer rejects a Host hello without `incognitoPromptToggles` with the same subcode; no session row is created.
31. Desktop E2E (written, not run; `manual-review/pending/conversation-session-incognito-draft.test.ts`): clicking the composer icon turns incognito on with no menu and the chip appears; clicking the chip text opens the checklist of thirteen capability rows in `INCOGNITO_CAPABILITY_KEYS` order (the four new rows unchecked by default), with no master row and no Settings link; the × turns incognito off. Settings «Incognito» shows the same thirteen switches; switching `harness` on in Settings and then starting a new incognito draft pre-checks it; the session's first request then contains `# Harness`.
32. `automationTools` off → the tool names `CronCreate`, `CronList`, `CronUpdate`, `CronDelete`, `OffPeakCreate`, `OffPeakList` and every `DYNAMIC_WORKFLOW_TOOL_NAMES` entry are absent from `getTools()` on the main runtime, on the embedded-search refresh path (`refreshBranchAwareBuiltInTools`) and in the request's tool list; `automationTools` on → present. Subagent and workflow children of an off session stay off (inherited profile).
33. Gate toasts: `proto.incognitoUnsupported.promptToggles` shows the stale-agent text; `…sessionCapability` and the bare code show the unsupported text; both as warnings, with the draft and incognito selection kept.
34. First-send attachments in incognito: create the profile-bound session before uploading frozen files, then send. No normal prewarm is created or promoted. Upload failure preserves the draft and profile and admits no prompt (ui-draft-send-path.md, Incognito attachment admission).

## Validation

- Unit tests: `ui/test/incognitoUnsupportedMessage.test.ts` (toast choice per gate subcode, scenario 33); `core/tests/incognito-prompt-toggles.test.ts` (main and subagent builder per toggle, automationTools runtime gate through the registered request tools); `shared/test/incognitoProfile.test.ts` (flat strict shape, `version` rejected, pre-change reader shapes reject 13-key rows, nine-key rows read as lockdown, `incognitoPromptToggles` capability); `services/test/runtimeCapabilitySupport.test.ts` (both flags required); `ui/test/agentV4ConnectionTransports.test.ts` (renderer needs `incognitoPromptToggles`); `ui/test/v4ComposerIncognitoControl.test.ts` (icon turns on, chip opens capability checklist, × turns off, no master row, no Settings link).
- Measured on the built request (`createContextBuilder` and `createTestAgentRuntime`, 2026-10-18, default test fixtures): system prompt 8,300 chars normal → 3,011 all toggles off (-64%); harness is the largest owner (about 4,600 chars); the request's tool JSON 146,749 chars / 31 tools normal → 67,106 / 16 tools with `automationTools` off (-54%); with `automationTools` on the tool set is back to 31.
- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`, `pnpm fmt:check`.
- CLI unit: migration test (fresh DB, upstream-shaped DB, ledger coexistence, set-once upsert, 16); context builder per capability (1–5); resume/fork/child inheritance (6–8); dream selection (9); profile decode fallback (10).
- Services/UI unit: capability gates (11–12, 15), fork-settings key round-trip, summary → task meta mapping.
- E2E (desktop): scenarios 13 and 17.

## Implementation slices

1. Shared profile schema, fork settings key, protocol fields and capabilities.
2. CLI storage: migration `9001_fork_session_incognito`, insert, decode, `SessionInfo.incognito`.
3. CLI runtime: `runtimeConfig.incognito`, per-capability overrides, inheritance, dream exclusion. Advertise `incognitoSession: true` only as the final step: the in-tree CLI's strict legacy schema already accepts `incognito` and ignores it, so until then the missing capability is the only fail-closed guard.
4. Host gate and projection → task meta.
5. UI: composer toggle/checklist/highlight/prewarm bypass, sidebar marker, Settings section, i18n, DESIGN.md token.

Precondition: resolve the separate audit of fork migration `0023_session_execution_worktree` (upstream numbering, unprefixed columns) first, so `9001_fork_session_incognito` does not build on a non-compliant pattern.

## Non-goals (V1)

- Ephemeral sessions (not persisted / discarded on close).
- Changing the profile mid-session.
- Creating incognito sessions from mobile remote control.
- Privacy guarantees. Still recorded for incognito sessions: local usage tables (`model_usage`, `turn_usage`, `tool_usage`), model-IO dumps, input history, OTLP/ARMS/app telemetry, title generation, debug logs.
- Upstream builds: an upstream app opening this database runs incognito sessions as normal sessions and its `/dream` may select them; this cannot be prevented from the fork.
- Custom session profiles beyond the single built-in incognito mode.
