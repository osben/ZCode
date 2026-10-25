# Guarded permission mode V1

Guarded (dangerous-command confirmation) is an explicitly opted-in mode: guarded = the YOLO base policy plus single-use user approval for clearly dangerous commands. Existing `yolo/build/edit/plan/auto` behavior is unchanged (`auto` remains unimplemented). Default values, existing tasks/automation/settings, and persistence are not migrated; no new protection boolean or database migration. It is not a complete Auto Mode classifier and promises nothing about unknown syntax. Shell is limited shared syntax for POSIX bash/zsh, the existing Bash AST for Git Bash, and an independent limited CMD parser that does not borrow Bash quoting rules.

Full history (verification runs, dated review fixes, stash/backup references): `git show aac4755666d09fdcd70272fcf063c077a639015f:docs/dangerous-command-approval-v1-plan.md`.

## Batch deletion (2026-09-24 extension, recognition layer only)

Recognition only — the approval core is not restructured: rm recursive or explicit batch, CMD `rd/rmdir /s`, CMD `del/erase`, `find -delete`, effective Git clean force, Robocopy `/MIR` or `/PURGE`. rm keeps one ruleId for recursive and batch; the others add IDs to the catalog below.

- rm no longer requires force; at least two targets, or an unreferenced/unescaped glob, also confirm. File existence, duplicates, and glob expansion counts are not checked. A single plain file, a single purely dynamic target, and a quoted/escaped literal glob add no confirmation; `rm -- -r` does not hit, `rm -- -r -f` hits via two targets. Help/interactive options cannot cancel known dangerous evidence.
- CMD switches are case-insensitive; rd/rmdir needs `/s`, del/erase confirms with any target; no target and standalone `/?` queries do not hit; `/p` cannot replace single-use approval. POSIX/Git Bash empty-directory `rmdir` is out.
- find is POSIX/Git Bash only: declared-arity predicates and output parameters are skipped; `-exec/-execdir/-ok/-okdir` payloads are skipped, not recursively matched; unknown arity stops analysis but keeps previously reliable `-delete` hits, without inferring whether the expression actually matches. BSD find's declared `-d`/`-x` are consumed as zero-arg leading options, so `find -d . -type f -delete` and `find -x . -type f -delete` hit.
- Robocopy is CMD/Git Bash only: reliably positioned `/L` listing does not confirm; `/JOB` files are not expanded and unknown arguments cannot create a listing exemption. Git clean cancellation requires `-d` or a pathspec condition; help, dry-run, and cancellation ordering are unchanged. Bare-glob file-filter arguments (e.g. Git Bash `robocopy src dst *.txt /MIR`) remain unsupported and run under the YOLO base policy — a known coverage limitation, not a safety statement.
- Per-word facts add internal `hasUnquotedGlob`; dynamic/positional semantics are unchanged. Dialect reaches rule dispatch, so POSIX paths or `rmdir` are never interpreted as CMD.
- Still excluded: PowerShell, brace/variable/command-substitution expansion, scripts, implicit configuration, rimraf/shred/truncate, remote deletion, partial Git reverts; wrappers remain env/time/sudo only; xargs/find-exec/npx are not extended. No match / unsupported keeps the original policy and does not mean safe.

Argument attribution: CMD's `rd/s/q target`, `rd target/s/q`, `del/q file` recognize glued built-in switches; slashes inside quoted paths and redirect targets are not split into switches. Git Bash Robocopy recognizes static `/c/...` drive paths without loosening unknown switches or `/JOB` arity. rm keeps GNU-style dangerous-option scanning, with batch counting also covering BSD's "first target then `--help` as filename" semantics; no platform or filesystem probing — when a batch-deletion interpretation exists, confirm.

Chain unchanged: matcher → Bash ToolEntry.userApprovalRule → PermissionService → executor/broker → single approve/deny → original tool result. No UI, mode/Plan, subtask, automation, persistence, or protocol changes. Acceptance maps to DCA-V1-19..25 (seven classes of positive/negative cases, Guarded deny/approve, YOLO controlled execution; Hook allow does not pre-approve, cancel does not execute, zero project-rule writes, pending cleanup).

## UI copy (2026-09-23)

`guarded` displays as “自主模式 / Autonomous mode” with the one-line description “在有风险时询问 / Ask when there's risk”. Desktop/mobile Composer and Automation/OffPeak share the translations and mode catalog; internal mode value, CLI commands, permission semantics, defaults, and save/restore are unchanged; keep the light-blue color and Edit icon.

## Guarded visual identity (2026-09-17)

Presentation only: the Guarded trigger uses the existing `icon-blue` light blue (including hover/expanded states) and reuses Edit's `ShieldCheckIcon`; menu items use the same icon. Old Edit stays at default foreground color in shared components; YOLO keeps orange `warning` with `ShieldAlertIcon`. Names, candidates, defaults, permission semantics, and persistence are unchanged. The only change point is the shared `ConfigSelect`, covering Desktop/mobile Composer, Automation, and OffPeak forms; theme tokens are reused with no new CSS variables or per-platform branches.

## Feature Summary / scope decisions

- Nine user-confirmed rules (catalog below), subtask inheritance, PowerShell excluded; no open product questions.
- Change layers: validation, option-source, commit-effect, persistence/recovery mode passthrough.
- Desktop and CLI ship version-matched in-package; runtime version mismatch is not a supported scenario (the old Host `switchCollaborationMode` follow-up and `firstInput.mode` completion branches were withdrawn — Host forwards the original creation only; an empty Guarded `createSession` returns the original ACK and the original caller submits the input; config mode and firstInput mode pass through as-is; automation records are not rewritten).

### staging merge compatibility (2026-09-18)

- Plan stays an independent state: `guarded + planEnabled=true` is still limited by Plan; entering/exiting Plan keeps guarded permissions and does not restore the old mode=plan state switch.
- Normal approvals keep staging's tool preview, session authorization, and Full access; for dangerous requests the `user-once` constraint wins — no project/session permanent authorization or Full access is offered or accepted, and `prepareApproval.proceed` cannot bypass it.
- New workflow tools' `alwaysAsk`, previews, and session authorization follow staging behavior; removed old CLI workflow commands stay removed. Ordinary subtasks keep passing through the same broker registration signal and innermost origin.
- The mode menu keeps the independent Plan checkbox and draft semantics; the permission list replaces Edit with Guarded; historical edit still echoes, and Guarded keeps the blue color and Edit icon.

```text
提交 {mode: guarded, planEnabled} → Runtime 唯一执行状态
  → Plan 开启：既有 Plan 判权
  → Plan 关闭：危险命中 → user-once → 已登记的 broker → 单次批准/拒绝
                        普通请求 → 既有工具预览 / Hook / Full access
```

### Menu replacement and compatibility (2026-09-15)

Guarded replaces only the Edit entry in menus; YOLO is untouched and existing edit sessions/settings are not migrated.

| Entry/relationship                            | Candidates, display, submission                                                                                          | Single authority / compatibility boundary                                                                         | Priority       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------- |
| Desktop/mobile Composer → shared mode catalog | build/guarded/plan/yolo; draft submits with Submission                                                                   | Old edit drafts/restored values still display as edit, not filtered to build/guarded                              | must-inspect   |
| Automation/OffPeak forms → same catalog       | New selections exclude edit; untouched old edit saves as-is                                                              | Each record is separate; no writes to the current conversation or global defaults                                 | must-inspect   |
| TUI /mode suggestions, shortcut cycling       | plan/build/guarded/yolo; only explicit selection submits the mode                                                        | Runtime is authority; explicit old `/mode edit` and `--mode edit` stay compatible                                 | should-inspect |
| Session/config/protocol normalization         | The optional menu is not a restore-value allowlist; edit stays accepted                                                  | Existing permissions, Plan round-trips, and persistence are not migrated                                          | invariant-only |
| full-auto/full_auto aliases                   | Restore maps to yolo; guarded maps separately                                                                            | Other providers' aliases are unaffected                                                                           | must-inspect   |
| executor → logger                             | Restored evaluated/denied/resolved/hook_race_forfeited levels, event/module/status/reason, trace/tool correlation fields | Logs are derived observation, not part of approval; inputSummary keeps type/keys/lengths only, never input bodies | must-inspect   |

```text
模式目录（新选择） -> Composer/表单/TUI -> 原提交链路 -> runtime.mode
历史 edit（兼容值） -------------------------------> 原 edit 策略
审批生命周期 ------------------------------------> 原结构化日志
```

Dimensions: entry × new-selection/historical-edit × guarded/yolo. Pruned: no permission algorithm, shell grammar, database migration, or remote-recovery changes, no full permutations. Desktop continuous and mobile replayable keep their state and routing.

## Command catalog / Boundary Decisions

| ruleId (prefix `safety.bash.`) | Explicit hit                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| remove-critical-path           | rm recursive, or at least two targets / unquoted unescaped glob; no path-risk analysis        |
| system-storage                 | dd, mount, umount, mkfs/mkfs.\*; declared help/version and argument-less mount listing exempt |
| git-reset-hard                 | git reset --hard                                                                              |
| git-clean-force                | effective force, except a true dry-run                                                        |
| git-push-force                 | effective force/force-with-lease/mirror/+refspec, except a true dry-run                       |
| git-discard-tree               | checkout -f, or checkout/restore whole-tree rollback of ., ./, :/; pure staged restore exempt |
| git-stash-clear                | git stash clear                                                                               |
| git-worktree-force-remove      | git worktree remove -f/--force, including repeated force                                      |
| rsync-delete                   | delete/del/delete-before/during/delay/after/excluded, except a true dry-run                   |
| cmd-remove-tree                | CMD rd/rmdir /s; standalone help exempt                                                       |
| cmd-delete-files               | CMD del/erase actually deleting; no target and standalone help exempt                         |
| find-delete                    | POSIX/Git Bash find `-delete` action; exec payloads not interpreted                           |
| robocopy-delete                | CMD/Git Bash robocopy /MIR or /PURGE; reliable /L listing exempt                              |

Per-word parsing preserves literalness, dynamism, and position; only direct calls, ordering, AND/OR, and pipelines are extracted. Strings/comments/redirect targets are not commands. A dynamic target does not erase an explicit rm recursive+force.

CMD `REM` comment recognition must exclude redirect targets: in `>rem git reset --hard`, `rem` is a file name and the Git command still matches; a real `rem git reset --hard` stays a comment. No new rules; unsupported and old-mode policies are unchanged.

The wrapper first batch is env/time/sudo only, consuming options via a declared arity table; `time -o file` must be included. Git supports leading parameters `-C/--git-dir/--work-tree/-c` (`-c` skips by value arity only; config content is not interpreted). Unknown arguments get no guessed arity; scripts, functions, loops, dynamic executables, command substitution, Git alias/config semantics, pathspec files, and PowerShell payloads are not expanded. The existing 10000-character parse limit applies.

Results are matched/notMatched/unsupported: a reliably positioned standalone hit wins over other local unsupported results; structures that cannot be reliably extracted never fabricate a hit. No match/unsupported keeps the YOLO base policy; parse failures do not add ask, and user cancellation still aborts execution.

### Command semantics and exemption contract

A shell AST proves words, boundaries, and positions — not how the invoked program interprets argv.

- rm is an existence rule for recursive + force within a limited grammar; it does not infer whether the command actually deletes. `--help/--version/-i` do not cancel a hit, so `rm -rf --help` also confirms — a deliberately conservative trade-off. `rm --help` without recursive + force still does not hit; `-rf` after `--` remains an operand.
- Generic option parsing must explicitly declare `stop-at-operand` or `interspersed`; there is no default. Wrappers and Git leading parameters stop at the first operand; the rm existence rule, Git subcommands, and rsync keep scanning per declared grammar.
- A new exemption must state its command, valid option positions, arity, cancellation precedence, and independent verification basis; it cannot be derived from one platform's help behavior. Parameter values, operands after `--`, and same-named words inside other commands never create exemptions.

| Rule                      | Verified hit-cancellation conditions                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| rm recursive + force      | no query/interactive exemption; the rm help/version exemption was removed                                     |
| system-storage            | only standalone single-argument `--help/--version`, argument-less mount; help words in other args not scanned |
| git reset --hard          | Git help, explicit other reset modes/patch; rm scan semantics are not borrowed                                |
| git clean force           | Git help, effective dry-run; exclude values and paths after `--` do not create dry-run                        |
| git push force            | Git help, effective dry-run; force/lease/mirror reduce via their respective cancel options                    |
| git discard tree          | Git help; staged-only restore; cancelling checkout force does not erase an independent whole-tree target      |
| git stash clear           | Git help; stash drop is out of scope                                                                          |
| git worktree force remove | Git help, effective no-force; repeated force still hits                                                       |
| rsync delete              | declared dry-run/help/version; filter/exclude parameter values and operands after `--` give no exemption      |

### Unknown options, tail redirection, and missing shell selection

Option scanning is a two-dimensional declaration: `ordering` (`stop-at-operand` | `interspersed`) × `unknown` (`abort` | `continue`), with no default.

- Wrappers (env/time/sudo) and Git leading parameters use `stop-at-operand` + `abort`: the arity of an unknown option determines where the real command starts; if it cannot be told, the whole line is `unsupported`. `time --unknown rm -rf build` stays `unsupported`.
- rm, rsync, and Git subcommands use `interspersed` + `continue`: an unknown option only marks `unsupported`, consumes no next word, and never enters recognized `flags`; recognized recursive+force / `--delete` / `--force` evidence survives an extra unknown word.
- Callers converge hit-first: judge rules with recognized options; hit → `matched`; miss with unknown seen → `unsupported`; otherwise `notMatched`. This implements "reliably positioned standalone hit wins over other local unsupported" inside one command.
- Conservative direction: an unknown valued option's value may be taken as a standalone flag; the worst case is one extra ask. The residual risk — the value happening to equal a cancel word like `-n` — is accepted and documented; no arity guessing is introduced for it.
- Only the Git leading-parameter table is extended (`-c <key=val>`, `-p`/`-P`, `--bare`, `--exec-path[=path]`, etc.); leading parameters abort on anything unrecognized. rm/rsync/Git-subcommand tables stay as-is: under `continue`, unknown options in `rm -rfx`, `rsync --delete --info=progress2`, `git push --force --no-verify`, `git checkout -f -t` only add an unsupported marker beside the match, and `bash.ts` consumes only `matched` — extending those tables has zero runtime effect.

CMD tail redirection: `git reset --hard 2>nul` and `git reset --hard > out.txt` must match. Only a redirect operator with no started target word is "missing target" (`git reset --hard >` stays `unsupported`); once a target word has started accumulating, EOF flushing discards it as a redirect target and the command matches normally.

Shell selection missing: `bashShellSelection === undefined` is an infrastructure state, not a syntax boundary. Like the existing `isRuntimeReadOnlyBashCommand`, matching falls back to POSIX grammar; explicit `legacy-shell` stays `unsupported`. No platform probing.

Out of scope examples: `timeout`/`nohup`/`nice`/`exec`/`command`/`xargs` prefixes (outside the wrapper allowlist) and CMD `format`.

## Single authority and event order

```text
runtime.mode -> 本次权限快照(mode, input, cwd) + 既有 session Shell selection
                         |
               guarded ? +---- no --> 原权限路径
                         |
                    有限命令规则
                      /       \
                  matched     未命中/unsupported
                     |             |
                 user-once       YOLO 基础策略
                     |
             当前 requestId 用户批准
                     |
             同一 input/shell/cwd 执行

Hook modified input -> normalize/schema -> 重判 -> 必要时新 requestId
broker 批准 modified input -> normalize/schema -> 固定新输入 -> 执行
desktop continuous -----------\
                               > 同一 CLI/broker 权威
mobile replayable 恢复 -------/
```

The executor fixes the current mode/input/cwd; the shell reuses the existing session selection; ToolEntry exposes dynamic approval capabilities that PermissionService consumes — the matcher is not duplicated at entry points. Explicit `approvalMode=user-once` flows through broker/events/projection; an empty suggestions list never substitutes for the capability. After a hit, project allow, PreToolUse allow, and PermissionRequest Hook cannot approve on the user's behalf; dangerous requests go straight to the broker, while normal requests keep the existing Hook/broker race, Memory, and prefix semantics.

Both Hook and broker input rewrites return to unified normalize/schema. A Hook rewrite requires re-judging permissions: the old requestId ends, and a new input needing confirmation gets a new requestId. In Guarded, a trusted broker's allow/modify + modifiedInput means the user approved the modified input — no re-judging or re-asking; the current mode/cwd stay fixed, and the normalized input is cloned and frozen for execution. The shell reuses the session selection without extra cloning or freezing. Illegal input never executes; a dangerous request's permissionUpdates rejection is never persisted. No broker, timeout, cancellation, illegal response, or failure means no execution. Switching modes never approves a pending request; the next call uses the new mode. The Deny feedback's final provider-visible tool_result is preserved.

### Shell snapshot deduplication (withdrawn)

The session shell owner initializes selection before the first real input; existing values are not overwritten by setting hot-updates, and cold restore recovers the persisted selection before execution. Switching Git Bash/CMD during an approval is not a product path, so executor matching and handlers reuse that selection directly — no per-call shell clone/freeze.

Q&A answers are not operation rewrites: when the original request's trusted `sideEffectScope=userInteraction` is answered by the broker, `modifiedInput` means the answer was filled in — validate and run the handler without re-initiating the Q&A; Hook input rewrites still re-judge. Purpose comes from the existing permission decision, source from the executor's responder race; answer payloads cannot self-declare exemption. No new protocol/persistence fields. Desktop continuous and mobile replayable consume the same request terminal state.

Mode values flow through contracts/shared strict schema, V4 submission/command, CLI/TUI menus, session save/restore, automation, and Enter/ExitPlanMode. Desktop/CLI run version-matched in-package; no old-runtime capability probing. A real configuration/submission failure still blocks silent execution. The existing options wire shape is reused; new cross-boundary fields require strict schemas.

## Subtask inheritance

Centralized derivation: when parent=guarded, an ordinary/Explore/nested-subagent child whose original mode is yolo becomes guarded; everything else is unchanged. Dynamic workflow (dwf) subagents inherit the launching session's permission mode (not only guarded): at run creation `run-launched` records `subagentPermissionMode` (e.g. `"guarded"`), and all subagents of that run (including after resume/restart) run with it; under guarded, dangerous commands reach the user via the parent session's broker as `user-once`, with the origin naming the subagent (`docs/dynamic-workflow/launch.md` "Permissions inside a run"). Old `/workflow` expert/script children remain excluded and keep internal yolo without dangerous-command approval; no workflow start/resume may switch a guarded parent task to yolo. Explicit plan/edit is kept; existing yolo automations are unchanged — only automations that themselves select guarded enable it. When nobody is online but the broker/runtime is alive, pending is kept awaiting online approval; timeout/cancel/process exit never converts to allow.

The current baseline sets `subagents.enabled=false` for ordinary subagent runtime, so ordinary children creating children has no reachable execution path; no nesting capability is added. The derivation function keeps composable semantics.

## Unified approval lifecycle

Synchronous broker registration is the default contract; protocol brokers needing async preparation expose a `registered` completion signal on the returned Promise. The executor waits for it before publishing events; the signal holds no authorization or pending copy — it only states the broker's registration table can respond. Cancellations/failures before registration completes must still close out; a late registration completion must not publish an ended request.

Implementations wrapping another broker (e.g. a subtask routing to the parent session's broker) must explicitly forward the inner `registered` using the contract's intersection type; identity passthrough ("happens to return the same Promise object") is not allowed, or any `async`/`.then` rewrite silently drops the signal and falls back to the synchronous-registration assumption.

Within one tool call, the first judgment and the post-Hook-rewrite re-judgment share one `preparedContext` (mode, bashShellSelection, workingDirectory snapshot); the re-judgment must not fall back to a reduced runtimeScope/cwd-only context, or the guarded matcher silently fails on the rewrite path.

The standalone requestUserOnce pipeline and recursive resolveToolPermission re-entry are replaced: one executor drives preparation, judgment, registration/publishing, waiting, response conversion, and terminal state. A Hook rewrite only re-prepares/re-judges without re-running the executed Hook chain; a broker-approved modification only re-prepares without re-judging. The broker owns pending; the executor owns this execution's snapshot; no new protocol state copies.

```text
prepare(mode,input,cwd; sessionShell) -> decide -> allow/deny
                                  |
                                 ask -> register -> publish -> response -> close
                                                               |            |
                              broker approval/answer -> validate -> execute |
                                           Hook rewrite <-------------------+
                                              |
                                         prepare -> decide -> new requestId
```

Request purpose comes from trusted permission capabilities; response source from the real responder; broker answers only complete the interaction while Hook modifications remain request rewrites. First model validation keeps its original error feedback; every Hook/broker modification goes through normalize + schema without re-invoking ToolEntry.validateInput afterwards. Tool semantic pre-checks run only on the first model input, before PreToolUse; handler-level validation is unchanged. An approval without modification executes the original snapshot; a Hook rewrite closes the old ID first, then judges the new input; a broker-approved modified input closes the original request and directly executes the new snapshot without asking again. Dangerous requests can never be persisted as authorized. Cancel, timeout, no broker, illegal response, and infrastructure errors all mean no execution, keeping the existing structured error types — never disguised as user denial. Every request emits exactly one terminal state; when visible it must already be registered; late/duplicate responses cannot approve a new ID.

### Semantics of approve-after-broker-modification

For Guarded only: allow/modify + modifiedInput is a single-use approval of the final input, not a proposal awaiting review. The responder race's source decides; a Hook cannot self-report broker origin via response fields to bypass re-judging. Other modes' existing modifiedInput acceptance, Hook deny/ask re-judging, Q&A completion, initial tool prohibition, and handler validation are unchanged; no UI edit entry, change prompts, protocol fields, or persistence are added. CLI/broker stays the only pending owner; desktop-continuous and mobile replayable routing is unchanged.

Guarded execution requests use the existing strict mode field. A guarded configuration failure at creation blocks firstInput; an empty session applies the mode via the existing createSession.config and returns the original ACK — no follow-up mode probing. Real mode switches use the existing strict commands; the Host adds no firstInput.mode completion. Desktop continuous and mobile replayable consume the same CLI authority; a mobile disconnect does not cancel a live runtime request. After a CLI restart, hydration keeps the existing cancelled/interrupted semantics without reviving old execution nodes.

The matcher, mode passthrough, and ordinary-subagent routing are kept; the shared approval core was replaced; workflow-child inheritance was withdrawn. The accepted test endpoint is: correct task visible → user response → original request closed → handler runs 0/1 times → provider tool_result — a mock broker being called is not a substitute.

## UI Surface Matrix / State Owners

| Scenario        | Entry / shared source                   | Authority and submission                        | Must stay isolated                            |
| --------------- | --------------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| Mode selection  | V4 Composer/mobile/TUI/CLI mode catalog | draft or runtime.mode, existing submit commands | Other tasks and defaults                      |
| Automation mode | Existing edit/create settings           | automation record → runtime                     | No write-back to the current conversation     |
| Approval        | V4/TUI/broker options                   | CLI pending/requestId → executor                | UI computes no danger; no project persistence |
| Mobile recovery | shared-host projection                  | Existing owner routing                          | replayable does not replace continuous        |

The broker owns pending; the executor owns the input snapshot; sessionStore owns project rules; projections are derived facts. `workspaceIdentity?.trim() || workspacePath` is the identity key; execution uses workspacePath. No second state/queue.

Hook-rewrite confirmation replacement (Desktop `desktop-continuous` E2E contract): the model asks to write A, the PermissionRequest Hook rewrites to B after a barrier release; once the old request closes, B must re-confirm with a new requestId in the same tool call's composer dock. A late approval of A delivered after B is visible must not execute B. CLI/broker stays the sole authorization owner; the test only observes the DOM, records real protocol IDs, and delays the original client packet. The case stays in manual-review/pending under DCA-V1-06; it does not cover mobile replayable, Windows, or Guarded broker-modified approval (covered by protocol integration tests). On-screen: the tool history row keeps showing the model's original A while the approval card below shows B — that production display behavior is unchanged.

## Feature Relationships

| rank           | Shared start and direct chain                                  | Depth            |
| -------------- | -------------------------------------------------------------- | ---------------- |
| must-inspect   | Bash AST → ToolEntry → PermissionService → permission-flow     | 2-3              |
| must-inspect   | mode schema/catalog → submission/command → runtime/persistence | 2                |
| must-inspect   | workflow/subagent factory → child mode/executor                | 2                |
| should-inspect | broker/event → buildProtocolPermissionOptions → V4/TUI         | 2                |
| invariant-only | continuous/replayable/workspace identity                       | 1                |
| evidence-only  | existing permission/BPR/PVD tests                              | not new coverage |

## Dimensions / Pruning / Accepted Cases

Dimensions: mode×match, mode×child, input version×response, shell×grammar, surface×recovery. Pruned: no full-script or implicit-environment simulation, no full flags×platform×provider GUI permutations. `unknown` never adds ask.

DCA-V1-01/03..08 became guarded contract cases; 02 keeps PowerShell pruned; 09..12 restored the Git/rsync extensions; 13..15 are mode passthrough, inheritance, and original-yolo comparisons; 19..25 are the batch-deletion classes. Accepted is not covered; unrun evidence does not inherit old state.

DCA-V1-13 accepted sub-scenario (menu replacement): the menu shows no Edit and offers Guarded/YOLO; after picking Guarded the existing dangerous-command deny loop still holds; historical edit keeps its schema, config projection, Composer/automation echo and runtime policy; alias mapping does not drift either way. Menu UI reuses the existing pending E2E.

## Implementation / E2E Handoff

1. Spec/catalog/matrix/tool-chain first; failing tests precede production implementation.
2. Mode chain → matcher → shared approval → multi-surface projection, without rewriting the prefix registry.
3. Every rule needs at least one real rejection loop; approval paths use isolated directories/controlled handlers. Check handler counts, file/rule stores, and the final provider tool_result.
4. New cases start as manual-review/pending; case-local synthetic fixtures state why; ordinary fast-text and cancel/late-response use controlled timing. Files live under `.zcode-e2e/<case>`. Promotion only after manual review.
5. Windows Git Bash/CMD needs real run evidence; without a runner it is explicitly listed as unverified. Mobile recovery tests never impersonate physical-network E2E.
6. Run targeted unit/integration, CLI typecheck, desktop typecheck:e2e, pnpm typecheck/lint, architecture check, coverage audit.

## Open verification items

- Windows Git Bash/CMD: limited parser unit tests only; no real Windows shell evidence.
- Mobile/restart: real protocol/registry/projection and cancellation verified; mobile disconnect-reconnect, multi-device races, and real Runtime restart hydration loops are not run.
- Real automation scheduling: record persistence, protocol passthrough, and live-broker pending-while-offline verified; the full scheduler → Host → CLI loop with post-login approve/deny is not.
- Queued execution: creation-config-failure zero-execution, SQLite cold restore, and queue mode retention/promotion asserted; no full queued auto-consumption into a dangerous handler run.
- Guarded-approval E2E recording: recording is a manual-review artifact, not a precondition; it activates only with `ZCODE_E2E_MANUAL_REVIEW=1` (encoder via `ZCODE_E2E_FFMPEG_PATH`/PATH); default replay keeps screenshots, interaction traces, and all business assertions without creating video.

Reproduction (current formal paths):

```sh
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-guarded.json pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/conversation-session-guarded.test.ts'
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec './test/e2e/conversation-session/conversation-session-guarded.test.ts'
pnpm --filter @zcode/bootstrap exec vitest run --no-file-parallelism tests/guarded-interaction-lifecycle.test.ts tests/guarded-permission-options.test.ts tests/guarded-projection.test.ts tests/guarded-workflow.test.ts tests/automation-port.test.ts tests/v4-native-session-mgmt.test.ts tests/v4-native-model-config.test.ts tests/v4-native-interaction-background.test.ts tests/workflow-effective-selection.test.ts tests/session-selection-cold-resume.test.ts tests/v4-native-queue.test.ts
pnpm typecheck
pnpm --filter @zcode/desktop typecheck:e2e
pnpm --filter @zcode/core --filter @zcode/bootstrap --filter @zcode/cli --filter @zcode/tui typecheck
pnpm lint
pnpm architecture:check --changed
pnpm audit:conversation-session-coverage
```
