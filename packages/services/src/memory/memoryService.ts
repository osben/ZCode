import type { Memory, MemoryConfig } from "@zcode/shared";
import { PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE } from "./memory.js";
import {
  type IMemoryService,
  type ProjectMemoryFileSummary,
  type ProjectMemoryWorkspaceSummary,
} from "./memory.js";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
  readProjectMemoryFileFromStableHandle,
  readProjectMemoryFileWithStableHandle,
} from "#src/memory/projectMemoryStableRead.js";
import {
  type ProjectMemoryFrontmatterMeta,
  parseProjectMemoryFrontmatter,
  readProjectMemoryFrontmatterHead,
} from "#src/memory/projectMemoryFrontmatter.js";
import { getZCodeDataRootDir } from "#src/paths.js";
import { readProjectMemoryIndexLineCount } from "#src/memory/projectMemoryIndexContent.js";

const PROJECT_MEMORY_INDEX_FILE_NAME = "MEMORY.md";
const PROJECT_MEMORY_DIRECTORY_NAME = "memory";
const PROJECT_KEY_SUFFIX_PATTERN = /^(.*)-[a-f0-9]{16}$/i;

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isProjectMemoryFileChangedError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE
  );
}

function getProjectMemoriesRoot(): string {
  return join(getZCodeDataRootDir(), "cli", "memories", "projects");
}

function isValidPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    basename(value) === value &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function isProjectMemoryFileName(fileName: string): boolean {
  return (
    fileName === PROJECT_MEMORY_INDEX_FILE_NAME ||
    (fileName.endsWith(".md") && fileName !== PROJECT_MEMORY_INDEX_FILE_NAME)
  );
}

function resolveWorkspaceLabel(workspaceId: string): string {
  const slug = PROJECT_KEY_SUFFIX_PATTERN.exec(workspaceId)?.[1];
  return slug?.trim() || workspaceId;
}

async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

// The index budget chip compares against the CLI injection line limit (MEMORY_INDEX_LINE_LIMIT in
// apps/zcode-cli/packages/core/src/memory/index-content.ts), so the count must cover the whole
// index file; the frontmatter head-scan bound only guards per-file metadata extraction.
async function requirePlainDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Project Memory directory is not a regular directory: ${path}`);
  }
}

async function requireProjectMemoriesRoot(): Promise<string> {
  const projectsRoot = getProjectMemoriesRoot();
  // Checking only the workspace subdirectory would allow a projectsRoot symlink to make list/read follow paths outside the local data directory.
  await requirePlainDirectory(projectsRoot);
  return projectsRoot;
}

async function requireExactProjectMemoryFile(
  memoryRoot: string,
  fileName: string,
): Promise<string> {
  const memoryEntries = await readdir(memoryRoot, { withFileTypes: true });
  const fileEntry = memoryEntries.find((entry) => entry.name === fileName);
  const requestedFilePath = join(memoryRoot, fileName);
  if (!fileEntry) {
    // Pass through the original ENOENT when the file truly does not exist; reject only when a case-insensitive alias would match.
    await lstat(requestedFilePath);
    throw new Error(`Project Memory file name does not match exactly: ${fileName}`);
  }
  if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) {
    throw new Error(`Project Memory file is not a regular file: ${fileName}`);
  }
  return requestedFilePath;
}

async function assertContainedProjectMemoryPath(
  projectsRoot: string,
  targetPath: string,
): Promise<void> {
  const projectsRootRealPath = await realpath(projectsRoot);
  const targetRealPath = await realpath(targetPath);
  const relativePath = relative(projectsRootRealPath, targetRealPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Project Memory path is outside the local profile: ${targetPath}`);
  }
}

function compareProjectMemoryFiles(
  left: ProjectMemoryFileSummary,
  right: ProjectMemoryFileSummary,
): number {
  if (left.kind !== right.kind) {
    return left.kind === "index" ? -1 : 1;
  }
  return left.name.localeCompare(right.name, "en");
}

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function getUserMemoryDir(): string {
  return join(resolveUserHomeDir(), ".claude", "memory");
}

/**
 * Get the memory file name for the agent.
 */
function getMemoryFileName(_agentId: string): string {
  // Only MEMORY.md is supported for now; extend later by agent type.
  return "MEMORY.md";
}

/**
 * Create a Memory service instance.
 */
export function createMemoryService(): IMemoryService {
  async function loadMemory(params: {
    workspacePath: string;
    agentId: string;
  }): Promise<{ memory: Memory | null }> {
    const { agentId } = params;

    try {
      const fileName = getMemoryFileName(agentId);
      const memoryDir = getUserMemoryDir();

      // Read directly from the user-level ~/.claude/memory directory.
      const filePath = join(memoryDir, fileName);
      try {
        const content = await readFile(filePath, "utf-8");
        return {
          memory: {
            content: content || "",
            enabled: true,
          },
        };
      } catch {
        // File does not exist; return null.
        return { memory: null };
      }
    } catch (error) {
      console.error("Failed to load memory:", error);
      return { memory: null };
    }
  }

  async function saveMemory(params: {
    workspacePath: string;
    agentId: string;
    config: MemoryConfig;
  }): Promise<void> {
    const { agentId, config } = params;

    try {
      // Save directly to the user-level ~/.claude/memory directory.
      const memoryDir = getUserMemoryDir();
      await mkdir(memoryDir, { recursive: true });

      const fileName = getMemoryFileName(agentId);
      const filePath = join(memoryDir, fileName);
      await writeFile(filePath, config.content, "utf-8");
    } catch (error) {
      console.error("Failed to save memory:", error);
      throw error;
    }
  }

  async function clearMemory(params: { workspacePath: string; agentId: string }): Promise<void> {
    const { agentId } = params;

    try {
      const fileName = getMemoryFileName(agentId);
      const memoryDir = getUserMemoryDir();
      const filePath = join(memoryDir, fileName);

      try {
        await writeFile(filePath, "", "utf-8");
      } catch {
        // File does not exist; ignore the error.
      }
    } catch (error) {
      console.error("Failed to clear memory:", error);
      throw error;
    }
  }

  async function getUserMemoryDirectory(): Promise<{ path: string }> {
    const memoryDir = getUserMemoryDir();
    try {
      await mkdir(memoryDir, { recursive: true });
    } catch {
      // Directory already exists.
    }
    return { path: memoryDir };
  }

  async function listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]> {
    let projectsRoot: string;
    let projectEntries;
    try {
      projectsRoot = await requireProjectMemoriesRoot();
      projectEntries = await readdir(projectsRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    const workspaces: ProjectMemoryWorkspaceSummary[] = [];
    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) {
        continue;
      }

      const workspaceId = projectEntry.name;
      const workspaceRoot = join(projectsRoot, workspaceId);
      const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
      if (!(await isPlainDirectory(workspaceRoot)) || !(await isPlainDirectory(memoryRoot))) {
        continue;
      }

      let memoryEntries;
      try {
        memoryEntries = await readdir(memoryRoot, { withFileTypes: true });
      } catch (error) {
        // The Memory Agent may delete a directory after the check; the catalog snapshot skips only workspaces that have disappeared.
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }
      const files: ProjectMemoryFileSummary[] = [];
      for (const memoryEntry of memoryEntries) {
        if (
          !memoryEntry.isFile() ||
          memoryEntry.isSymbolicLink() ||
          !isProjectMemoryFileName(memoryEntry.name)
        ) {
          continue;
        }

        const filePath = join(memoryRoot, memoryEntry.name);
        const isIndex = memoryEntry.name === PROJECT_MEMORY_INDEX_FILE_NAME;
        let frontmatterMeta: ProjectMemoryFrontmatterMeta = {};
        let lineCount: number | undefined;
        try {
          const snapshot = await readProjectMemoryFileWithStableHandle({
            fileName: memoryEntry.name,
            filePath,
            validatePath: async () => {
              await requireProjectMemoriesRoot();
              await requirePlainDirectory(workspaceRoot);
              await requirePlainDirectory(memoryRoot);
              await requireExactProjectMemoryFile(memoryRoot, memoryEntry.name);
              await assertContainedProjectMemoryPath(projectsRoot, filePath);
            },
            readContent: async (handle) => {
              let frontmatterHead: string | undefined;
              try {
                frontmatterHead = await readProjectMemoryFrontmatterHead(handle);
              } catch {
                // An unreadable frontmatter head degrades to a catalog row without YAML metadata.
              }
              let indexContent: string | undefined;
              if (isIndex) {
                try {
                  indexContent = await handle.readFile({ encoding: "utf-8" });
                } catch {
                  // An unreadable index body omits only its optional line-count chip.
                }
              }
              return { frontmatterHead, indexContent };
            },
          });
          if (snapshot.content.frontmatterHead !== undefined) {
            try {
              frontmatterMeta = parseProjectMemoryFrontmatter(snapshot.content.frontmatterHead);
            } catch {
              // Missing or malformed YAML renders the file without meta.
            }
          }
          if (snapshot.content.indexContent !== undefined) {
            lineCount = readProjectMemoryIndexLineCount(snapshot.content.indexContent);
          }
          files.push({
            name: memoryEntry.name,
            path: filePath,
            kind: isIndex ? "index" : "item",
            size: snapshot.size,
            updatedAt: snapshot.updatedAt,
            ...(frontmatterMeta.description ? { description: frontmatterMeta.description } : {}),
            ...(frontmatterMeta.type ? { type: frontmatterMeta.type } : {}),
            ...(lineCount === undefined ? {} : { lineCount }),
          });
        } catch (error) {
          // A file removed or replaced during enumeration is omitted rather than exposing stale or external metadata.
          if (isNotFoundError(error) || isProjectMemoryFileChangedError(error)) {
            continue;
          }
          throw error;
        }
      }

      if (files.length === 0) {
        continue;
      }

      files.sort(compareProjectMemoryFiles);
      workspaces.push({
        id: workspaceId,
        label: resolveWorkspaceLabel(workspaceId),
        updatedAt: Math.max(...files.map((file) => file.updatedAt)),
        files,
      });
    }

    workspaces.sort(
      (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id, "en"),
    );
    return workspaces;
  }

  async function readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<{ content: string; updatedAt: number }> {
    if (
      !isValidPathSegment(params.workspaceId) ||
      !isValidPathSegment(params.fileName) ||
      !isProjectMemoryFileName(params.fileName)
    ) {
      throw new Error("Invalid Project Memory path");
    }

    const projectsRoot = await requireProjectMemoriesRoot();
    const workspaceRoot = join(projectsRoot, params.workspaceId);
    const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
    await requirePlainDirectory(workspaceRoot);
    await requirePlainDirectory(memoryRoot);

    // Bugfix: on a case-insensitive filesystem, a requested name could match a disk file with different casing and bypass the catalog allowlist.
    const filePath = await requireExactProjectMemoryFile(memoryRoot, params.fileName);
    return readProjectMemoryFileFromStableHandle({
      fileName: params.fileName,
      filePath,
      validatePath: async () => {
        await requireProjectMemoriesRoot();
        await requirePlainDirectory(workspaceRoot);
        await requirePlainDirectory(memoryRoot);
        await requireExactProjectMemoryFile(memoryRoot, params.fileName);
        await assertContainedProjectMemoryPath(projectsRoot, filePath);
      },
    });
  }

  async function getProjectMemoryDirectory(params: {
    workspaceId: string;
  }): Promise<{ path: string }> {
    if (!isValidPathSegment(params.workspaceId)) {
      throw new Error("Invalid Project Memory path");
    }

    const projectsRoot = await requireProjectMemoriesRoot();
    const workspaceRoot = join(projectsRoot, params.workspaceId);
    const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
    // Bugfix: on a case-insensitive filesystem, a requested name could match a disk directory with different casing and bypass the catalog allowlist.
    const projectEntries = await readdir(projectsRoot, { withFileTypes: true });
    const projectEntry = projectEntries.find((entry) => entry.name === params.workspaceId);
    if (!projectEntry) {
      await lstat(workspaceRoot);
      throw new Error(
        `Project Memory workspace name does not match exactly: ${params.workspaceId}`,
      );
    }
    await requirePlainDirectory(workspaceRoot);
    await requirePlainDirectory(memoryRoot);
    await assertContainedProjectMemoryPath(projectsRoot, memoryRoot);
    return { path: memoryRoot };
  }

  return {
    loadMemory,
    saveMemory,
    clearMemory,
    getUserMemoryDirectory,
    listProjectMemories,
    readProjectMemoryFile,
    getProjectMemoryDirectory,
  };
}
