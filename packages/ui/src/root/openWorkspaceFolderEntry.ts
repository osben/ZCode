import { logger } from "@/logger.js";

export async function openFolderFromWorkspaceEntry({
  selectDirectory,
  openDirectoryBrowser,
  preferDirectoryBrowser = false,
  onSelectProject,
}: {
  selectDirectory?: () => Promise<string | null>;
  openDirectoryBrowser?: () => void;
  preferDirectoryBrowser?: boolean;
  onSelectProject: (path: string) => void;
}) {
  if (preferDirectoryBrowser) {
    if (!openDirectoryBrowser) {
      logger.warn("[openWorkspaceFolderEntry] directory browser preferred but unavailable");
      return;
    }
    // Web/server roots have no system directory picker; continuing to call selectDirectory would only return null.
    // Switch explicitly to the server-side directory browser so the user selects a path on the target host.
    logger.info("[openWorkspaceFolderEntry] opening service directory browser...");
    openDirectoryBrowser();
    return;
  }

  if (!selectDirectory) {
    return;
  }

  logger.info("[openWorkspaceFolderEntry] calling selectDirectory...");
  try {
    const dir = await selectDirectory();
    logger.info("[openWorkspaceFolderEntry] selectDirectory returned:", dir);
    if (dir) {
      onSelectProject(dir);
    } else {
      logger.info("[openWorkspaceFolderEntry] user cancelled or dir is null");
    }
  } catch (err) {
    logger.error("[openWorkspaceFolderEntry] selectDirectory threw:", err);
  }
}
