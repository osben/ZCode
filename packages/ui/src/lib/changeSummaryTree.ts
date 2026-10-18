export interface ChangeSummaryTreeInputFile {
  path: string;
  relativePath: string;
  added: number;
  removed: number;
}

export type ChangeSummaryTreeRow<T extends ChangeSummaryTreeInputFile> =
  | {
      kind: "folder";
      /** Full workspace-relative directory path; stable key for collapse state. */
      id: string;
      /** Compacted label, e.g. "packages/ui/src". */
      name: string;
      depth: number;
      added: number;
      removed: number;
      fileCount: number;
    }
  | { kind: "file"; file: T; name: string; depth: number };

interface FolderNode<T extends ChangeSummaryTreeInputFile> {
  id: string;
  name: string;
  folders: Map<string, FolderNode<T>>;
  files: { file: T; name: string }[];
}

function createFolder<T extends ChangeSummaryTreeInputFile>(
  id: string,
  name: string,
): FolderNode<T> {
  return { id, name, folders: new Map(), files: [] };
}

function sumFolder<T extends ChangeSummaryTreeInputFile>(
  node: FolderNode<T>,
): { added: number; removed: number; fileCount: number } {
  let added = 0;
  let removed = 0;
  let fileCount = node.files.length;
  for (const { file } of node.files) {
    added += file.added;
    removed += file.removed;
  }
  for (const child of node.folders.values()) {
    const sum = sumFolder(child);
    added += sum.added;
    removed += sum.removed;
    fileCount += sum.fileCount;
  }
  return { added, removed, fileCount };
}

function compareNames(a: string, b: string): number {
  return a.localeCompare(b);
}

function emitFolder<T extends ChangeSummaryTreeInputFile>(
  node: FolderNode<T>,
  depth: number,
  collapsed: ReadonlySet<string>,
  rows: ChangeSummaryTreeRow<T>[],
) {
  // Compact single-child folder chains (a folder holding only one folder and no files).
  let current = node;
  let name = node.name;
  while (current.files.length === 0 && current.folders.size === 1) {
    const [only] = current.folders.values();
    if (!only) {
      break;
    }
    current = only;
    name = `${name}/${only.name}`;
  }

  rows.push({
    kind: "folder",
    id: current.id,
    name,
    depth,
    ...sumFolder(current),
  });
  if (collapsed.has(current.id)) {
    return;
  }
  emitChildren(current, depth + 1, collapsed, rows);
}

function emitChildren<T extends ChangeSummaryTreeInputFile>(
  node: FolderNode<T>,
  depth: number,
  collapsed: ReadonlySet<string>,
  rows: ChangeSummaryTreeRow<T>[],
) {
  for (const child of [...node.folders.values()].sort((a, b) => compareNames(a.name, b.name))) {
    emitFolder(child, depth, collapsed, rows);
  }
  for (const entry of [...node.files].sort((a, b) => compareNames(a.name, b.name))) {
    rows.push({ kind: "file", file: entry.file, name: entry.name, depth });
  }
}

/**
 * Builds depth-annotated rows for a nested folder tree. Folders sort before files, single-child
 * folder chains are compacted, and descendants of folders listed in `collapsed` are omitted.
 * Root-level files render at depth 0 without a folder row.
 */
export function buildChangeSummaryTree<T extends ChangeSummaryTreeInputFile>(
  files: readonly T[],
  collapsed: ReadonlySet<string> = new Set(),
): ChangeSummaryTreeRow<T>[] {
  const root = createFolder<T>("", "");
  for (const file of files) {
    const segments = file.relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
    const fileName = segments.pop() ?? file.relativePath;
    let node = root;
    for (const segment of segments) {
      let child = node.folders.get(segment);
      if (!child) {
        child = createFolder<T>(node.id ? `${node.id}/${segment}` : segment, segment);
        node.folders.set(segment, child);
      }
      node = child;
    }
    node.files.push({ file, name: fileName });
  }

  const rows: ChangeSummaryTreeRow<T>[] = [];
  emitChildren(root, 0, collapsed, rows);
  return rows;
}
