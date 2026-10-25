import type { IFileService } from "@zcode/services";
import { WORKSPACE_FILE_ENTRIES_CHUNK_SIZE } from "@zcode/shared/workspaceFileEntriesCodec";

/**
 * Fetch the columnar packed string for the workspace file index in chunks.
 * A single large RPC message (65 MB) takes 4.6–6.3 seconds to reassemble into frames on the renderer side, creating a long main-thread task;
 * input freezes. Chunking (~4 MB per chunk) and yielding to the event loop with setTimeout(0) between chunks lets the main thread process
 * only a small chunk (~50 ms) at a time, so typing events can run between them. Total time is unchanged, but the UI never freezes.
 */
export async function fetchWorkspaceFileEntriesPacked(
  fileService: Pick<IFileService, "listWorkspaceFilesLength" | "listWorkspaceFilesRange">,
  rootPath: string,
): Promise<string> {
  const totalLength = await fileService.listWorkspaceFilesLength({ rootPath });
  let packed = "";
  for (let offset = 0; offset < totalLength; offset += WORKSPACE_FILE_ENTRIES_CHUNK_SIZE) {
    const chunk = await fileService.listWorkspaceFilesRange({
      rootPath,
      offset,
      length: WORKSPACE_FILE_ENTRIES_CHUNK_SIZE,
    });
    packed += chunk;
    // Yield between chunks so queued input/render tasks can run before processing the next chunk.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return packed;
}
