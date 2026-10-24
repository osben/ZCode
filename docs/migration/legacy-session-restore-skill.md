# Legacy Session Restore Skill

## Background

Legacy ZCode session records are backed up under `~/.zcode-bak/v2/sessions`. The current ZCode stores real
session/message/part data in `~/.zcode/cli/db/db.sqlite` and uses `~/.zcode/v2/tasks-index.sqlite` as the app-side
task list index. To restore history the user picks a legacy agent, then a workspace, then a conversation.

## Goals

- A workspace skill `restore-legacy-sessions` guides the Agent through selection and verification before restore.
- A read-only scan script lists candidates in three layers: agent, workspace, conversation.
- Each candidate shows the legacy snapshot state, the new CLI DB state and the task-index state, avoiding
  duplicate imports.
- The skill defaults to dry-run/planning; before any write the target scope and a rollback backup must be
  confirmed.

## Non-goals

- Do not restart any legacy runtime.
- Do not migrate legacy task stream/queue/owner state into the relay or main process.
- The scan script never writes `db.sqlite` or `tasks-index.sqlite`.

## Data mapping

- Legacy source: `~/.zcode-bak/v2/sessions/{workspaceHash}/{legacyTaskId}.json`.
- The new session prefers the stable session id in the legacy snapshot, falling back to the legacy task id.
- Legacy snapshot ID: `meta.taskId`.
- Workspace isolation key: `workspaceIdentity?.trim() || workspacePath`.
- CLI DB hit: `session.id = restoredTaskId`.
- task-index hit: `tasks.task_id = restoredTaskId and tasks.workspace_path = workspacePath`.
- The restored runtime provider is always `glm`. The snapshot's `meta.provider` only records historical origin
  and is not written to task-index `provider` or CLI message `providerID`.
- Legacy restore does not write task-index `migration_source` or `meta_json.migrationSource`; that field is
  only for the Claude Code native import line (`claudeCode`), so no unmodeled `legacy-session` semantics appear.
- task-index `meta_json.taskId` must equal `restoredTaskId` (not the legacy `meta.taskId`), otherwise the UI
  reads the legacy task id from meta.
- The CLI DB must get both `message` and `part` rows. The detail page rebuilds visible text and tool-call order
  from `part`; with only `message.data.content` the task opens but the history area is blank.

## Skill workflow

By default only the backup source `~/.zcode-bak/v2/sessions` is scanned; destinations remain the current
`~/.zcode/cli/db/db.sqlite` and `~/.zcode/v2/tasks-index.sqlite`. To inspect the original directory pass
`--legacy-dir ~/.zcode/v2/sessions` explicitly.

1. Scan agents:
   `node .agents/skills/restore-legacy-sessions/scripts/scan-legacy-sessions.mjs agents`
2. After the user picks an agent, scan workspaces:
   `node .agents/skills/restore-legacy-sessions/scripts/scan-legacy-sessions.mjs workspaces --agent glm`
3. After the user picks a workspace, scan conversations:
   `node .agents/skills/restore-legacy-sessions/scripts/scan-legacy-sessions.mjs conversations --agent glm --workspace /path/to/workspace`
4. Dry-run classification of the selected conversation:
   - `ready`: present in both CLI DB and task-index.
   - `needs-cli-db`: task-index has it but the CLI DB lacks the session; rebuild the real session from the
     legacy snapshot.
   - `needs-task-index`: CLI DB has it but task-index lacks the index; add the index.
   - `needs-full-import`: missing in both; full import.
5. After confirming a single conversation, run the restore script:
   `node .agents/skills/restore-legacy-sessions/scripts/restore-conversation.mjs --snapshot ~/.zcode-bak/v2/sessions/<workspaceHash>/<legacyTaskId>.json`

## Safety constraints

- Back up both databases (`tasks-index.sqlite` and `db.sqlite`) before writing.
- Re-runs must be idempotent: an existing real session is not overwritten over the user's later conversation.
- task-index updates keep existing `pinned`, `archived`, `deleted`, `title_overridden`.
- On task-index conflict updates, clear any `migration_source` wrongly written by an old restore flow and keep
  `provider = "glm"`.
- CLI DB restore writes at least one `text` part per legacy message; assistant messages also keep the tool
  parts that can be mapped and get the previous user message's `parentID`.
- UI / remote restore code must not spread `web-remote-replayable` recovery semantics into the desktop
  `desktop-continuous` main path.

## Verification

- The scan script prints the agent, workspace and conversation lists on the default paths.
- JSON output parses with `jq`.
- The skill structure passes `quick_validate.py`.
- Run `pnpm typecheck` and `pnpm lint` after changes.
