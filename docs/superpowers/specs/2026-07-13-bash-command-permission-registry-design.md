# Bash Command Permission Registry Design

## Background

Project-level Bash "always allow" used to write the full `input.command` as the permission rule. Even with a `:*` suffix, matching happened on the raw string, so it could not stably share the action of `pnpm run lint --fix` and `pnpm run lint --reporter=dot`, and `npm run:*` could wrongly cover `npm run test && rm -rf ...`.

Two independent registries with non-overlapping responsibilities:

- Command prefix registry: `@withfig/autocomplete` specs plus built-in overrides provide command/subcommand/option shapes, used to find a stable action prefix.
- Bash readonly policy: decides whether an invocation can be auto-allowed read-only; stays with ZCode's existing data-driven Bash policy.

The prefix registry never makes a command readonly; the readonly registry never decides the persisted authorization scope.

## Goals and non-goals

Goals:

- Upgrade Bash project-level authorization from full command strings to AST-aware stable command prefixes.
- Compound commands are judged per approval-requiring invocation; one authorized prefix never executes appended commands.
- Suggestions become durable permission facts, consistent across desktop, mobile replay, refresh recovery, and TUI display.
- Keep the `permission/ruleset` JSON and `PermissionRuleValue`; no new SQL migration.
- Keep read compatibility for legacy exact, `:*`, wildcard, and tool-only rules; no bulk expansion of permissions.

Non-goals:

- No LLM prefix extraction.
- No new session/global permission scopes.
- No permission-rule management page or editable pattern input.
- No Fig package or specs in the CLI runtime.
- No real-network mobile E2E this round; desktop-continuous and mobile-replayable boundaries unchanged.

## Overall data flow

```text
build/dev only
@withfig/autocomplete@2.692.3
        |
        v
deterministic generator ---> compact generated registry ---> zcode.cjs / SEA
                                  |
runtime                           v
Bash input ---> unbash AST ---> permission rule policy
                                  | evaluator + suggestions
                                  v
PermissionService ---> permission.requested durable event
                                  |
              +-------------------+--------------------+
              |                   |                    |
              v                   v                    v
 desktop-continuous       web-remote-replayable   TUI approval
 PermissionDialog         snapshot / gap restore  read-only scopes
              |                   |                    |
              +-------------------+--------------------+
                                  |
                                  v
                    option.response.permissionUpdates
                                  |
                                  v
              local_setting(permission/ruleset JSON)
```

Relay, desktop main, host bridge, and UI only forward or display suggestions — they never re-parse Bash. Mobile `/remote` keeps attaching the desktop's shared host; the permission snapshot stays owned by the host runtime, business state never sinks to relay/main, and replayable recovery never splices into the desktop-continuous main link.

## Build-time registry

### Input and output

Generation pins `@withfig/autocomplete@2.692.3` exactly. The generator walks Fig root specs and keeps only:

- command/subcommand names and aliases;
- whether an option consumes an argument;
- argument `isCommand`, `isModule`, `isVariadic`, `isOptional`, `isDangerous`;
- file/folder path template info.

Output uses compact tuple/short-field encoding, stable sort, no timestamps; the header records the Fig version, input hash, skip statistics, and ISC attribution. `registry:check` regenerates into a temp directory and compares byte-for-byte, and asserts the uncompressed output stays under 3 MiB. CLI bundle, desktop-agent, and SEA tests must prove the runtime never reads Fig package files.

Built-in policy fills wrapper specs, recursion limits, and depth overrides, including action boundaries that generic spec depth cannot derive for `git push`, `docker`, `kubectl`, `aws`, `az`, `gcloud`.

### Lazy materialization

The generated module owns one synchronous cache per module instance. It embeds each root tuple as JSON text and exposes the readonly `BASH_COMMAND_REGISTRY` record through enumerable getters. Importing the module, enumerating keys, and checking `Object.hasOwn` must not construct command trees. Reading a root parses only that root and replaces its getter with the cached tuple; repeated reads return the same object. No runtime file reads, dynamic imports, timers, or Fig dependency. Unknown commands, aliases, tuple contents, key order, source hash, and permission/telemetry semantics stay identical.

```text
module import -> generated record owns unmaterialized root getters
telemetry     -> hasOwn(record, executable) -> public-name membership only
policy lookup -> record[executable] -> parse that root -> cache tuple -> resolve prefix
next lookup   -> cached tuple
```

Acceptance evidence: deterministic generator output and `--check`; the full 707-root tuple digest matching the eager baseline; all static command/subcommand aliases through permission suggestions and allow/ask/deny evaluation; a test proving an untouched root stays lazy after another root is read. Existing unsafe/compound, readonly, wrapper, and telemetry privacy tests keep applying. No UI interaction or protocol behavior changes.

The profiling gate, fixed before measuring: at least 5% and 10 ms lower median fresh-process CLI startup, no more than 20 ms higher p95 first Bash call. Compare alternating baseline/candidate processes on the same Node version and build settings, three warmups and 40 measured pairs with a warm OS file cache. Record both the normal CLI and minified desktop-agent results; isolate user shell startup cost with a controlled Bash executable in addition to the default shell.

### Prefix resolver

The resolver reuses the `unbash` AST — no shell token guessing on raw strings:

1. Handle only safely enumerable invocations; parse failure, redirects, command/process substitution, subshells, functions, loops, conditionals, case, here-docs, or unknown dynamic nodes fall back to full-string exact.
2. Known global options skip themselves and their arguments per the registry, then look for the subcommand; path, URL, and plain file arguments never enter the prefix.
3. Wrappers nest at most two levels; total parse recursion depth at most ten. Saved prefixes keep the wrapper and the user's original executable token; only registry lookup may use the basename — never silently widen an absolute path.
4. Static env assignments survive only when both name and value are unambiguously provable; dynamic or unknown assignments fall back to exact.
5. Shell interpreters and delete/permission-changing high-risk commands without a stable action boundary fall back to exact.
6. Any prefix token containing whitespace or not unambiguously serializable falls back to exact.

Stable prefixes persist as `ruleContent: "<prefix>:*"`; exact saves the trimmed full raw command. Compound commands save multiple independent rules (never a merged longest-common prefix), at most five; beyond the limit, fall back to full-string exact. Invocations already auto-allowed by readonly policy generate no redundant durable rule.

## Permission rule policy

`ToolEntry` gains optional `resolvePermissionRulePolicy(input, runtimeContext)` returning:

- an evaluator over the whole set of allow/ask/deny rules;
- the `PermissionUpdate[]` suggested for this project-level allow.

`PermissionService` stays tool-agnostic. Tools without a custom evaluator keep exact/wildcard logic; the Bash evaluator first checks the full raw exact, then, when the AST is safe, matches token-boundary prefix/wildcard per invocation.

```text
ruleset priority
  deny: any required invocation matched -> deny
   ask: any required invocation matched -> ask
  plan: existing plan-mode precedence
 allow: every required invocation covered -> allow
  else: ask
```

Security invariants:

- `npm run:*` may match a single `npm run test --watch` invocation but never swallows `npm run test && rm -rf ...`.
- Multiple allow rules may jointly cover a compound's invocations; one missing still asks.
- deny/ask take effect when any invocation matches.
- Readonly invocations count as covered but generate no suggestion.
- When the AST is unsafe, prefix/wildcard never grant; full raw exact can still match.
- Tool-only legacy rules keep their all-tools authorization semantics.
- plan-mode precedence is unchanged by the Bash evaluator.

## Durable suggestion and protocol

`suggestedPermissionUpdates?: PermissionUpdate[]` joins `PermissionBrokerRequest`, `PermissionRequestedPayload`, and `PendingPermission`. Suggestions are computed before entering the broker and written together with the `permission.requested` durable event. The v4 permission option gains an optional raw `response`; new snapshots carry the allow-project response verbatim, legacy snapshots without `response` still map allow/deny by option kind and generate an exact suggestion for legacy pending Bash requests. `buildProtocolPermissionOptions`, desktop, and TUI no longer derive rules from input themselves.

## Storage and legacy compatibility

No new tables, no SQL migration upgrade, no `local_setting.schema_version` change:

- Keep writing project-scope `namespace=permission`, `key=ruleset` JSON.
- `PermissionRuleValue` keeps `toolName + ruleContent`; ruleset version keeps its current value.
- Legacy exact rules stay as-is and match by full raw first.
- Legacy `:*` and wildcard rules for Bash go through the AST-safe evaluator instead of raw startsWith over compounds.
- Tool-only rules keep legacy semantics.
- The ruleset is rewritten only when the user adds an authorization, via the existing path — no bulk migration, no silent widening of historical grants.
- Existing `0003_backfill_permission_local_setting` results are never rewritten.

## UI and TUI

The desktop `PermissionDialog` shows one to five read-only prefix scopes under the "always allow in this project" option:

- Prefix: `pnpm run lint …` directly replaces the "won't ask again for the same command" helper copy; no extra "command prefix" label or bordered container; multiple prefixes render line by line with natural wrapping on narrow screens and long unbroken text.
- Exact: no duplicate "this command only" card inside the option; the actual command shows in the tool preview above; the full `ruleContent` lives only in the option response for answering and persistence — never in scope DOM, `title`, or ARIA copy.
- Compound: multiple prefixes line by line, never merged; exact invocations are not repeated.
- Monospace, existing semantic colors, and popover/input tokens; light/dark themes and mobile widths supported. Any single scope's display text has a fixed character cap — here-docs, inline scripts, or generated content must never grow the permission option.

No free-form editing input; optionId, number shortcuts, arrow keys, and focus behavior unchanged. All existing locales gain scope copy. The TUI shows the same read-only list and returns the suggestion carried by the request directly.

## Coverage and pruning

- `BPR01`: stable prefix display, persistence, reuse across transient args.
- `BPR02`: sibling actions and partially covered compounds still ask.
- `BPR03`: exact fallback for dynamic/redirect/parse failure.
- `BPR04`: legacy exact, `:*`, wildcard, tool-only, and DB reopen compatibility.
- `BPR05`: durable event, refresh/snapshot/replay, and allow-project response losslessness.
- `BPR06`: TUI and desktop suggestion/response consistency.

The formal desktop E2E uses one `pnpm run <script>` for the BPR01/BPR02 user loop and extends the existing refresh-permission case for BPR05. Compounds, legacy DB, TUI, and registry/build use deterministic unit or integration tests — no brittle GUI state injection. Real-network mobile E2E is pruned this round: v4 schema, projection, and replay snapshot tests prove field losslessness only and must not be claimed as mobile shared-host real-network coverage.

## Logging and privacy

Production logs may record only the registry version, generation result category, and rule counts. Never log raw commands, full `ruleContent`, or scope text; high-frequency parse detail is dev-only `debug` and equally avoids sensitive arguments.
