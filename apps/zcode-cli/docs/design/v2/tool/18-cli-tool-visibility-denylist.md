# CLI Tool Visibility Denylist Implementation Plan

This document is also the initial design spec of `--disallowedTools`; if semantics change before implementation, update this document first, then the code.

**Goal:** add `--disallowedTools` / `--disallowed-tools <tools...>` to the `zcode` CLI so the user can remove given tool rules from the runtime tool pool for one run, rather than only changing approval permission.

**Architecture:** a new runtime-scoped `toolDisallowlist` is parsed by the CLI and passed through to `AgentRuntimeConfig`. Built-in, MCP, embedded search and subagent child runtimes all consume the same denylist when registering or deriving tool sets, so a denied tool neither enters the provider-visible `tools[]` nor stays in the local executable registry.

**Tech Stack:** TypeScript, Node `parseArgs`, Vitest, zcode-cli core runtime, built-in tool registry, MCP registry, subagent runtime.

## Global Constraints

- Spec first, then implementation; this document is the initial spec of the feature.
- The semantics of `--disallowedTools` is tool exposure removal; it does not reuse `permission.disallowedTools`.
- `--disallowed-tools` and `--disallowedTools` share one help entry, explaining that the whole tool is removed from the tool set available to this prompt/TUI; examples use `"Bash Edit"` or `Bash,Edit`, so it does not imply matching by command content.
- `<tools...>` is variadic, supporting comma or out-of-parentheses ordinary space separation. Rule strings such as `Bash(git *)` are accepted for compatibility, but filtering uses only the tool name before the parenthesis: that input removes the whole `Bash`, not only `git *`.
- The denylist affects only this CLI runtime and is not written to persisted config.
- The agent schema semantics: an explicit `tools` replaces the default tool set; `disallowedTools` only removes from the default tool set, and is ignored when `tools` exists. The ZCode CLI main session has no public `--tools` flag at this stage; when the internal `toolAllowlist` and the CLI `toolDisallowlist` both exist, deny wins, so a default tool denied by the CLI is not re-exposed.
- It must cover both the headless prompt and the TUI prompt creation chains.
- It must cover built-in tools, MCP tools, the embedded search branch and the subagent child runtime.
- Do not change the desktop/app-server/mobile remote protocol; this stage covers only the zcode-cli runtime.
- After changes, run at least the target tests; before merge run `pnpm typecheck` and `pnpm lint`.

---

## Terms and boundaries

- **permission denylist**: the existing `permission.disallowedTools`, an approval/execution permission rule. It is not equivalent to whether a tool appears in the model request.
- **visibility denylist**: the new `toolDisallowlist` of this feature, meaning the tool is removed from the runtime visible and executable set.
- **provider-visible tools**: the final `tools[]` sent in the model request.
- **registry tools**: the set of tools registered and executable inside the runtime.
- **parent denylist**: the `toolDisallowlist` obtained from the top-level CLI flag.
- **subagent profile denylist**: the existing `disallowedTools` of a subagent profile/frontmatter, expressing only which tools the child agent subtracts further.

## User-visible semantics

### CLI help contract

- Chinese and English help uniformly use `-p, --prompt <text>`; the prompt is passed as one string argument.
- The parser-unimplemented `--print`, `--settings`, `--permission-mode`, `--max-turns`, `--allowed-tools`, `--allow-main-worktree-yolo` are not shown; they keep erroring as unknown arguments and no compatibility parsing is added.
- The denylist lists both aliases in a single entry, stating it applies only to this prompt/TUI, does not modify persisted config, and is not a permission rule matched by command content.
- This cleanup only fixes text and documents; it does not change argument parsing, tool registration, permission, protocol or session lifecycle.

### Flag semantics baseline

- CLI help exposes `--disallowedTools, --disallowed-tools <tools...>`, described as comma- or space-separated tool names to deny.
- The SDK/child-process forwarding path serializes a `disallowedTools` array as `--disallowedTools` plus a comma-joined value.
- Command/skill frontmatter has both `disallowed-tools` and the normalized alias `disallowedTools`; the semantics is removal from the model tool surface while the current file is active.
- In the agent schema, `disallowedTools` means removal from the default tool set; if `tools` is explicitly set, `disallowedTools` is ignored.
- At this stage ZCode makes `-p` a short alias of `--prompt`, expressing the headless prompt entry.

### Supported flags

```bash
zcode --disallowedTools Bash,Edit -p "分析一下"
zcode --disallowed-tools Bash,Edit -p "分析一下"
zcode --disallowedTools Bash --disallowedTools Edit -p "分析一下"
zcode -p "分析一下" --disallowedTools Bash Edit
zcode -p "分析一下" --disallowed-tools "Bash Edit"
```

### variadic boundary

```bash
# This parses as disallowedTools = ["Bash", "Edit"], prompt = "分析一下",
# because <tools...> swallows following bare positionals until the next option; -p is an option boundary.
zcode --disallowedTools Bash Edit -p "分析一下"

# If there is no option boundary after it, bare positionals keep being taken as disallowedTools.
zcode --disallowedTools Bash Edit SomeBareToken

# This parses as disallowedTools = ["Bash(git *)", "Edit"],
# because inside a quoted token the split is still by out-of-parentheses ordinary spaces, and `git *` inside the parentheses stays in one rule.
# Registration takes only the name before the parenthesis, so the whole Bash and Edit are removed, with no git command matching.
zcode -p "分析一下" --disallowedTools "Bash(git *) Edit"
```

### Name normalization

- Input is split by comma or ordinary space inside each argv token; commas/spaces inside parentheses do not split; empty items are dropped.
- Full tool rule strings are supported, such as `Bash(git *)`, `Read(~/.zshrc)`, `mcp__github__get_issue`.
- Tool name matching takes the tool name prefix of the rule string: the tool name of `Bash(git *)` is `Bash`; without parentheses the whole string is the tool name.
- `web_search` is normalized to `WebSearch`, aligned with the existing allowlist helper.
- Other tool names stay case-sensitive.
- A rule with arguments such as `Bash(git *)` removes the whole `Bash` tool in this feature, not only a Bash command sub-rule, because provider-visible `tools[]` can only appear or disappear by tool schema and cannot hide one command pattern of Bash.

## Affected files

### Design documents to create or modify

- Modify: `apps/zcode-cli/docs/design/v2/tool/18-cli-tool-visibility-denylist.md`
- Optional Modify: `apps/zcode-cli/docs/design/v2/tool/README.md`
- Optional Modify: `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md`

### CLI entry

- `apps/zcode-cli/packages/cli/src/run.ts`
- `apps/zcode-cli/packages/cli/src/prompt-command.ts`
- `apps/zcode-cli/packages/cli/src/tui-command.ts`
- `apps/zcode-cli/packages/cli/src/tui-prompt-handler.ts`
- `apps/zcode-cli/packages/i18n/src/locales/en-US.ts`
- `apps/zcode-cli/packages/i18n/src/locales/zh-CN.ts`

### Runtime config and tool registration

- `apps/zcode-cli/packages/core/src/runtime/types.ts`
- `apps/zcode-cli/packages/core/src/runtime/helpers/tool-allowlist.ts`
- Create: `apps/zcode-cli/packages/core/src/tool/tool-visibility.ts`
- `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/embedded-search-branch.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/mcp.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/index.ts`
- `apps/zcode-cli/packages/core/src/mcp/index.ts`

### Tests

- `apps/zcode-cli/packages/cli/tests/cli.unit.test.ts`
- `apps/zcode-cli/packages/core/tests/main-tool-pool.test.ts`
- `apps/zcode-cli/packages/core/tests/mcp-tool-bridge.test.ts`
- `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`

Prefer appending to existing test files over splitting out a new file for one small assertion.

---

## Phase 0: Pre-implementation confirmation

**Goal:** confirm that the current work tree, test commands and target files still match this document.

- Run `git status --short --branch` and confirm no user changes are left unexplained.
- Run `rg "toolAllowlist|disallowedTools|allowedTools" apps/zcode-cli/packages -n` to confirm the related entries have not been migrated heavily again.
- Run `rg "parseGlobalArgs|runPrompt|createTuiSubmitPrompt" apps/zcode-cli/packages/cli -n` to confirm CLI entry locations.
- Run `rg "RegisterBuiltInToolsOptions|RegisterMcpToolsOptions|resolveSubagentToolAllowlist" apps/zcode-cli/packages/core -n` to confirm tool registration and subagent derivation locations.
- If file locations changed, update "Affected files" first and continue.

**Acceptance:** the entry files listed here match the current code; no code implementation change happens in Phase 0.

---

## Phase 1: CLI parsing and runtime config pass-through

**Goal:** the CLI accepts `--disallowedTools` / `--disallowed-tools` and passes the normalized tool-name array into the runtime config.

**Interfaces**

- Produces:
  - `AgentRuntimeConfig.toolDisallowlist?: readonly string[]`
  - CLI normalized denylist: `readonly string[] | undefined`
- Consumed later:
  - Phase 2 registry filters consume `toolDisallowlist`
  - Phase 4 subagent inheritance consumes `toolDisallowlist`

**Rules**

- Add `toolDisallowlist?: readonly string[]` to `AgentRuntimeConfig`.
- Add `short: "p"` to the `prompt` option of `parseGlobalArgs`, so the headless prompt entry in the document examples runs.
- Before `parseGlobalArgs`, add an `extractDisallowedToolsArgs` preprocessing step: supports `--disallowedTools`, `--disallowed-tools`, `--disallowedTools=value`, the same flag repeated, and consumes following argv tokens until the next option token.
- Do not hand `--disallowedTools` directly to `node:util.parseArgs`; current Node `parseArgs` cannot express the required `<tools...>` variadic behavior.
- Add a CLI-layer normalization helper that: accepts the `readonly string[]` collected by preprocessing; splits by comma or out-of-parentheses ordinary space, keeping commas/spaces inside parentheses in the current rule; drops empty items; converts `web_search` to `WebSearch`; dedupes keeping first-occurrence order; returns `undefined` for an empty array.
- `runPrompt`, `runTuiCommand` and `createTuiSubmitPrompt` signatures gain `toolDisallowlist?: readonly string[]`; the `runtimeConfig` of headless and TUI `createZCodeApp` gains `toolDisallowlist`.
- `toolDisallowlist` is not written into `resolveAppConfigOptions` or any persisted config override.

**Tests**

- CLI unit tests cover: `--disallowedTools Bash,Edit`; `--disallowed-tools Bash,Edit`; repeated `--disallowedTools Bash --disallowedTools Edit`; the variadic option-boundary behavior of `--disallowedTools Bash Edit --prompt "hello"`; `-p "hello" --disallowedTools Bash`; `--disallowedTools "Bash(git *) Edit"`; `--disallowedTools web_search` becoming `WebSearch` after reaching the runtime; empty values not generating an empty array; unknown options still strictly rejected.
- A TUI prompt handler unit test covers runtimeConfig carrying `toolDisallowlist`.

Suggested test command:

```bash
pnpm --filter @zcode/cli exec node --disable-warning=DEP0205 --import tsx --test tests/cli.unit.test.ts
```

If the filter name does not match, first run:

```bash
pnpm -r list --depth -1 | rg "@zcode/cli|zcode-cli"
```

**Acceptance**

- `zcode --disallowedTools Bash,Edit -p "..."` no longer fails as an unknown option.
- `zcode -p "..." --disallowedTools Bash` runs.
- Headless and TUI both pass the denylist into `AgentRuntimeConfig`.
- A denied tool is not yet required to be actually removed; that is the Phase 2 acceptance.

---

## Phase 2: Remove tools in built-in and MCP registration

**Goal:** a built-in/MCP tool hit by `toolDisallowlist` does not enter the runtime registry.

**Interfaces**

- Produces:
  - `normalizeToolNameAlias(toolName: string): string`
  - `getToolRuleName(rule: string): string`
  - `createToolRuleNameSet(rules?: readonly string[]): ReadonlySet<string> | undefined`
  - `isToolNameDisallowed(toolName: string, disallowedTools?: readonly string[]): boolean`
  - `filterDisallowedToolNames(toolNames: readonly string[], disallowedTools?: readonly string[]): readonly string[]`
  - `RegisterBuiltInToolsOptions.disallowedTools?: readonly string[]`
  - `RegisterMcpToolsOptions.disallowedTools?: readonly string[]`
- Consumes: `AgentRuntimeConfig.toolAllowlist`, `AgentRuntimeConfig.toolDisallowlist`

**Rules**

- Add `tool/tool-visibility.ts`, converging tool rule name extraction, alias normalization and denylist filtering into one helper.
- Migrate the `web_search -> WebSearch` normalization to the shared helper, keeping the existing `resolveBuiltInToolAllowlist` behavior compatible.
- `registerBuiltInTools` options gain `disallowedTools`. The built-in registration loop decides in order: skip if `allowedTools` exists and the tool is not in it; skip if the tool is in `disallowedTools`; otherwise register.
- `AgentRuntime` passes `this.config.toolDisallowlist` to `registerBuiltInTools` on construction.
- `RegisterMcpToolsOptions` gains `disallowedTools`; the MCP registration loop denies by exact tool name; `runtime/methods/mcp.ts` passes `this.config.toolDisallowlist` to MCP registration.
- The provider adapter layer does no main filtering; filtering is primarily the responsibility of the registry registration layer.
- Optionally a defensive filter: `filterRuntimeVisibleTools` may filter denied tools again but must not be the only line of defense.

**Tests**

- core: with `toolDisallowlist: ["Bash"]` the registry has no `Bash`; with `["Bash(git *)"]` the registry has no `Bash`; the provider-visible `tools[]` has no `Bash`; with `toolAllowlist: ["Read", "Bash"]` and `toolDisallowlist: ["Bash"]` only `Read` remains; with `toolDisallowlist: ["web_search"]` provider-visible has no `WebSearch`.
- MCP: an exact MCP tool name is not registered after deny; `mcp__server__tool(*)` removes the same-named MCP tool by name prefix; deny does not affect other tools of the same server.

Suggested test command:

```bash
pnpm --filter @zcode/core exec vitest run tests/main-tool-pool.test.ts tests/mcp-tool-bridge.test.ts
```

**Acceptance**: a denied built-in tool is neither in the registry nor in provider-visible `tools[]`; a denied MCP tool is not in the registry; the deny-wins rule is proven by tests.

---

## Phase 3: Embedded search branch semantics alignment

**Goal:** when `Bash` is denied, the embedded search branch no longer wrongly assumes Bash is available.

**Interfaces**

- Consumes: `AgentRuntimeConfig.toolAllowlist`, `AgentRuntimeConfig.toolDisallowlist`, the Phase 2 visibility helper.
- Produces: `resolveRuntimeEmbeddedSearchEnabled` correctly considers the denylist.

**Rules**

- Update the `bashAvailable` judgment of `resolveRuntimeEmbeddedSearchEnabled`: the allowlist is absent or contains `Bash`, and the denylist does not contain `Bash`.
- Keep the existing `toolset === "explore"` behavior.
- `refreshBranchAwareBuiltInTools` keeps passing the allowlist and denylist when registering direct search fallback tools.
- The product semantics must be fixed by tests: if the user denies only `Bash`, whether `Glob/Grep` appear in the direct fallback after embedded search is turned off.

**Recommended product semantics (first version)**

- `--disallowedTools Bash` means Bash is unavailable.
- Because embedded search depends on Bash, embedded search is no longer enabled.
- If the direct fallback branch registers `Glob/Grep`, they remain available unless the user also passes `--disallowedTools Glob,Grep`.
- If the product expects "deny Bash also forbids all search fallbacks", `Glob/Grep` must also be written into the spec as derived denies before implementing.

**Tests**: `toolDisallowlist: ["Bash"]` makes `resolveRuntimeEmbeddedSearchEnabled` false; `toolAllowlist: ["Bash"]` with `toolDisallowlist: ["Bash"]` makes deny win; the provider-visible result of `Glob/Grep` under the direct fallback is fixed by tests per the recommended semantics.

Suggested test command: `pnpm --filter @zcode/core exec vitest run tests/main-tool-pool.test.ts`

**Acceptance**: when `Bash` is denied, the runtime does not consider Bash-backed embedded search available; the search branch behavior is fixed by tests and does not depend on manual guessing.

---

## Phase 4: Subagent inherits the parent denylist

**Goal:** the parent CLI denylist still applies to the subagent child runtime, so explicit profile tools cannot bypass it.

**Interfaces**

- Consumes: `this.config.toolDisallowlist`, `request.allowedTools`, `request.disallowedTools`, subagent profile `disallowedTools`.
- Produces: `toolDisallowlist` in the child runtime config; the child runtime `toolAllowlist` already has the parent denylist and profile/request denylist subtracted.

**Rules**

- When creating the child runtime config pass `toolDisallowlist: this.config.toolDisallowlist`.
- `resolveSubagentToolAllowlist` merges deny sources: parent `this.config.toolDisallowlist` and the request/profile-level `disallowedTools`.
- When `allowedTools: ["*"]` expands, the merged denylist is subtracted from the parent-visible tools obtained from `this.getTools()`.
- With explicit `allowedTools: ["Bash"]`, if the parent denylist contains `Bash`, the result must not contain `Bash`.
- Keep the existing self-filtering of subagent dispatch tools, for example not wrongly exposing the Task/Agent dispatch tool to the child.
- Keep the Skill special case: `Skill` is added only when skills exist and `Skill` is not hit by any denylist.
- The subagent MCP required-server check uses the effective allowed tools with the parent/profile denylist already subtracted, so an MCP tool denied by the parent does not still trigger a missing-server error.

**Tests**: parent `toolDisallowlist: ["Bash"]` with subagent `allowedTools: ["*"]` leaves the child without `Bash`; parent denying `Bash` with explicit subagent `allowedTools: ["Bash", "Read"]` leaves the child with only `Read`; profile/request `disallowedTools` merge with the parent denylist; `Skill` denied by the parent is not auto-added back because skills exist; when the parent denies an MCP tool in the profile, that MCP server is no longer required to be connected.

Suggested test command: `pnpm --filter @zcode/core exec vitest run tests/subagent-explore.test.ts`

**Acceptance**: top-level `--disallowedTools Bash` applies to both the main agent and the child agent; a subagent profile cannot add back a tool the parent has denied.

---

## Phase 5: CLI help, docs and user notes

**Goal:** users understand the exact semantics of the flag from help and docs and do not confuse it with the permission denylist.

**Rules**

- Chinese and English help each list `--disallowed-tools, --disallowedTools <tools...>` in one entry (`en-US.ts`, `zh-CN.ts`).
- Help uses tool-name examples such as `"Bash Edit"`, stating comma or space separation is supported.
- Help/spec state clearly that this removes the whole tool from the tool set available to this prompt/TUI and is not a permission rule matched by command content.
- Doc examples include comma-separated and repeated flag forms.
- The doc states that a `Bash(...)` rule removes the whole `Bash` tool and does no Bash sub-command-level provider-visible trimming.
- The doc states this is runtime scoped and not persisted.
- If the README has a tool spec index, add a link to `18-cli-tool-visibility-denylist.md`.

**Tests**: a CLI help snapshot or text unit test covers the new flag; manually run `zcode --help` and confirm the text does not wrap badly in Chinese/English environments.

**Acceptance**: users can tell from help that the flag controls tool visibility; the docs do not describe this feature as a permission rule.

---

## Phase 6: End-to-end verification and regression

**Goal:** prove the final provider request contains no denied tools, and the runtime cannot execute denied tools.

- Run the CLI unit tests, core tool pool tests, WebSearch tests, MCP registration tests and subagent tests.
- Run `pnpm typecheck` and `pnpm lint`.
- Use debug/model-io or a test double to confirm that after `--disallowedTools Bash` the provider request `tools[]` has no `Bash`, and after `--disallowedTools web_search` the provider request has no `WebSearch`.
- Use a subagent test to confirm the child runtime has no parent-denied tool.

Suggested verification commands:

```bash
pnpm --filter @zcode/cli exec node --disable-warning=DEP0205 --import tsx --test tests/cli.unit.test.ts
pnpm --filter @zcode/core exec vitest run tests/main-tool-pool.test.ts tests/mcp-tool-bridge.test.ts tests/subagent-explore.test.ts
pnpm typecheck
pnpm lint
```

If the package filter names do not match the current workspace, confirm with:

```bash
pnpm -r list --depth -1 | rg "zcode-cli|core"
```

**Acceptance**: unit tests all pass; `pnpm typecheck` and `pnpm lint` pass; no denied tools in the provider-visible request; no denied tools in the runtime registry.

---

## Phase 7: Code review focus

- `permission.disallowedTools` is not used as the source of this feature.
- `toolDisallowlist` is not written into persisted config.
- Deny wins covers built-in, MCP and subagent.
- The `web_search` alias is compatible with the existing `toolAllowlist`.
- The embedded search Bash availability judgment includes the denylist.
- A subagent's explicit tools cannot bypass the parent denylist.
- The provider adapter does not carry the main filtering duty.
- The CLI strict parser still rejects unknown arguments.
- Docs/help do not promise wildcards or a permission matcher.
- No desktop/app-server/mobile remote protocol change is introduced.

---

## Rollback plan

- If the CLI parser has compatibility problems, first roll back the Phase 1 flag exposure, keeping the pending status in the document.
- If registry filtering causes embedded search or MCP regressions, first roll back the Phase 2/3 runtime use points, keeping the helper and failing test samples to continue locating.
- If subagent inheritance causes a dispute about existing profile behavior, keep the parent registry deny and do not let the main agent expose a denied tool; the subagent inheritance semantics return to this document for re-review before landing.

## Open Questions

- Should wildcards such as `mcp__github__*` be supported? Only rule strings like `Bash(git *)` are defined today; extending wildcards to the tool name itself requires defining matcher priority, escaping rules and the difference from the permission matcher.
- Should `--disallowedTools Bash` also disable the `Glob/Grep` direct search fallback? This document does not chain it by default; the user may explicitly deny `Glob,Grep`.
- Should the same-name configuration be exposed to desktop/app-server/mobile remote? Not in this document's first version.

## Done Definition

- `zcode --disallowedTools Bash,Edit -p "..."` runs.
- `zcode -p "..." --disallowedTools Bash` runs.
- `zcode --disallowed-tools Bash,Edit -p "..."` runs.
- A denied built-in tool is not in the registry.
- A denied MCP tool is not in the registry.
- A denied tool is not in provider-visible `tools[]`.
- The subagent child runtime cannot regain a parent-denied tool.
- The `permission.disallowedTools` semantics are unchanged.
- Chinese/English help are updated.
- This document is updated to the final semantics.
- Target unit tests, `pnpm typecheck` and `pnpm lint` all pass.
