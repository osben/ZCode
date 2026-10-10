import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ZCodeSessionFile, ZCodeTaskMeta } from "@zcode/shared";
import { getLegacyTaskSessionSnapshotPath } from "#src/paths.js";
import {
  parseLegacyTaskSessionFile,
  type LegacyTaskSessionFile,
} from "#src/session/legacyTaskSessionFile.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;

export function buildSearchableTextFromMessages(messages: ZCodeSessionFile["messages"]): string {
  const parts: string[] = [];
  let total = 0;
  for (const message of messages) {
    const content = message.content.trim();
    if (!content) {
      continue;
    }
    const next = total > 0 ? `\n${content}` : content;
    if (total + next.length > TASK_SEARCH_TEXT_MAX_CHARS) {
      parts.push(next.slice(0, TASK_SEARCH_TEXT_MAX_CHARS - total));
      break;
    }
    parts.push(next);
    total += next.length;
  }
  return parts.join("");
}

async function writeSessionFileAtomic(
  filePath: string,
  sessionFile: LegacyTaskSessionFile,
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  const serialized = JSON.stringify(sessionFile, null, 2);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tempPath, `${serialized}\n`, "utf-8");
  await rename(tempPath, filePath);
}

export async function persistImportedClaudeTask(params: {
  taskIndexRepo: TaskIndexRepo;
  sessionFile: LegacyTaskSessionFile;
  /** Write only when the import target workspace matches the filtered workspace, so the current tab's identity is not applied to another path. */
  workspaceIdentity?: string;
}): Promise<ZCodeTaskMeta> {
  const parsed = parseLegacyTaskSessionFile(params.sessionFile);
  const meta: LegacyTaskSessionFile["meta"] = {
    ...parsed.meta,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
  };
  const indexMeta: ZCodeTaskMeta = {
    ...meta,
    // The SQLite task index mode column is still NOT NULL; keep the imported snapshot at its filtered default.
    mode: meta.mode ?? "build",
  };

  await writeImportedClaudeTaskSnapshot({ sessionFile: { ...parsed, meta } });
  return params.taskIndexRepo.syncTaskMeta({
    meta: indexMeta,
    // If the user deletes or archives an imported session and then imports it again, the old index row retains archived/deleted state.
    // Reimporting means restoring the session to the list, so explicitly clear its hidden state here.
    archived: false,
    deleted: false,
    searchableText: buildSearchableTextFromMessages(parsed.messages),
  });
}

export async function writeImportedClaudeTaskSnapshot(params: {
  sessionFile: LegacyTaskSessionFile;
}): Promise<void> {
  const parsed = parseLegacyTaskSessionFile(params.sessionFile);
  const filePath = getLegacyTaskSessionSnapshotPath(
    parsed.meta.workspacePath,
    parsed.meta.taskId,
    parsed.meta.workspaceIdentity,
  );

  // After legacy ACP was retired, importClaudeSessions became a stub, so imports copied jsonl files without writing
  // ~/.zcode/v2/sessions/{hash}/{taskId}.json. Real ZCode sessions now handle continued conversations; the legacy snapshot
  // is saved only as a filtered migration backup to prevent the Claude source runtime from contaminating the current model selection.
  await writeSessionFileAtomic(filePath, parsed);
}
