import type { GitPaneFileChange } from "@/hooks/useGitRepository.js";

export interface GitPaneDirectoryRow {
  kind: "directory";
  runIndex: number;
  directory: string;
  fileCount: number;
  additions: number;
  deletions: number;
}

export interface GitPaneFileRow {
  kind: "file";
  change: GitPaneFileChange;
}

export type GitPaneRow = GitPaneDirectoryRow | GitPaneFileRow;

export function getChangeDirectory(change: GitPaneFileChange): string {
  const normalizedPath = change.workspaceRelativePath.replace(/\/+$/, "");
  const separatorIndex = normalizedPath.lastIndexOf("/");
  return separatorIndex === -1 ? "" : normalizedPath.slice(0, separatorIndex);
}

interface DirectoryRun {
  directory: string;
  section: GitPaneFileChange["section"];
  changes: GitPaneFileChange[];
}

// Changes arrive sorted by workspaceRelativePath inside each section, but a dataset
// (unstaged) flattens several sections, so the same directory can occur in multiple
// non-adjacent runs. Grouping is a presentation transform over consecutive runs only:
// a new header starts when the directory OR the section changes, so the flat list
// order is preserved exactly and groups never merge across a section boundary.
export function buildGitPaneRows(changes: readonly GitPaneFileChange[]): GitPaneRow[] {
  const rows: GitPaneRow[] = [];
  let run: DirectoryRun | null = null;
  let runIndex = 0;

  const flushRun = () => {
    if (!run) {
      return;
    }
    let additions = 0;
    let deletions = 0;
    for (const runChange of run.changes) {
      additions += runChange.added;
      deletions += runChange.removed;
    }
    rows.push({
      kind: "directory",
      runIndex: runIndex++,
      directory: run.directory,
      fileCount: run.changes.length,
      additions,
      deletions,
    });
    for (const runChange of run.changes) {
      rows.push({ kind: "file", change: runChange });
    }
    run = null;
  };

  for (const change of changes) {
    const directory = getChangeDirectory(change);
    if (!run || run.directory !== directory || run.section !== change.section) {
      flushRun();
      run = { directory, section: change.section, changes: [change] };
    } else {
      run.changes.push(change);
    }
  }
  flushRun();

  return rows;
}

// Flat mode is a one-to-one list of file rows, so flat row indices equal change indices and
// the flat list stays byte-identical to the pre-grouping Review list.
export function buildGitPaneDisplayRows(
  changes: readonly GitPaneFileChange[],
  groupByDirectory: boolean,
): GitPaneRow[] {
  if (groupByDirectory) {
    return buildGitPaneRows(changes);
  }
  return changes.map((change) => ({ kind: "file", change }));
}

/**
 * The checkbox is shown only when the list has rows to group and the list is settled.
 * useGitRepository keeps the previous dataset while a refresh is loading, so a non-empty
 * list alone does not mean the rows on screen are current.
 */
export function canShowGroupByDirectory(state: {
  changeCount: number;
  loading: boolean;
  error: string | null;
}): boolean {
  return state.changeCount > 0 && !state.loading && state.error === null;
}

export function getGitPaneRowIndexByPath(rows: readonly GitPaneRow[]): Map<string, number> {
  const indexByPath = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.kind === "file") {
      indexByPath.set(row.change.path, index);
    }
  });
  return indexByPath;
}
