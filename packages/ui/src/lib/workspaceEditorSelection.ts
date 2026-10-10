import type { EditorInfo, OpenInEditorRemoteTarget, RemoteTarget } from "@zcode/shared";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";

const REMOTE_SSH_EDITOR_IDS = ["vscode", "vscode-insiders"];
const REMOTE_WSL_EDITOR_IDS = ["vscode", "vscode-insiders", "explorer"];

type WorkspaceEditorSelectionKind = "preferred" | "fallback" | "empty" | "explicit";

interface WorkspaceEditorSelectionState {
  availableEditors: EditorInfo[];
  selectedEditor: EditorInfo | null;
  selectionKind: Exclude<WorkspaceEditorSelectionKind, "explicit">;
}

export function resolveWorkspaceFileManagerEditor(
  availableEditors: EditorInfo[],
  remoteTarget?: RemoteTarget | OpenInEditorRemoteTarget,
): EditorInfo | null {
  // WSL Explorer supports UNC mapping, so “Open in Explorer” should reuse the same editor entry point as
  // “Open with → Explorer”; SSH/Docker still fail closed.
  if (remoteTarget?.kind !== "wsl") {
    return null;
  }
  return availableEditors.find((editor) => editor.id === "explorer") ?? null;
}

function filterEditorsByIdOrder(
  installedEditors: EditorInfo[],
  orderedIds: string[],
): EditorInfo[] {
  return orderedIds
    .map((id) => installedEditors.find((editor) => editor.id === id) ?? null)
    .filter((editor): editor is EditorInfo => editor !== null);
}

export function resolveWorkspaceEditorSelection({
  installedEditors,
  selectedEditorId,
  remoteTarget,
}: {
  installedEditors: EditorInfo[];
  selectedEditorId: string | null;
  remoteTarget?: RemoteTarget | OpenInEditorRemoteTarget;
}): WorkspaceEditorSelectionState {
  let availableEditors: EditorInfo[];

  if (remoteTarget?.kind === "ssh") {
    // An SSH workspace path exists only on the remote host; local apps such as Finder/Explorer/Terminal
    // cannot open `/root/...` directly, or they will land in a missing or incorrect local directory.
    availableEditors = filterEditorsByIdOrder(installedEditors, REMOTE_SSH_EDITOR_IDS);
  } else if (remoteTarget?.kind === "wsl") {
    // WSL workspacePath is a Linux path; only the VS Code Remote-WSL and Windows Explorer UNC
    // boundaries can consume it correctly. Other local editors must not receive `/home/...` as-is.
    availableEditors = filterEditorsByIdOrder(installedEditors, REMOTE_WSL_EDITOR_IDS);
  } else if (remoteTarget) {
    // Docker and other remote paths have no URI/UNC mapping that local editors can consume;
    // showing local apps would make them treat the Linux path as local, so fail closed at capability selection.
    availableEditors = [];
  } else {
    availableEditors = sortInstalledEditorsForOpenWith(installedEditors);
  }
  const preferredEditor =
    selectedEditorId === null
      ? null
      : (availableEditors.find((editor) => editor.id === selectedEditorId) ?? null);
  const fallbackEditor = availableEditors[0] ?? null;

  if (preferredEditor) {
    return {
      availableEditors,
      selectedEditor: preferredEditor,
      selectionKind: "preferred",
    };
  }

  return {
    availableEditors,
    selectedEditor: fallbackEditor,
    selectionKind: fallbackEditor ? "fallback" : "empty",
  };
}

export function shouldPersistWorkspaceEditorSelection(
  selectionKind: WorkspaceEditorSelectionKind,
): boolean {
  // An SSH workspace may automatically fall back to VS Code after local apps are filtered out.
  // This fallback is not an explicit user choice and must not overwrite the global editor preference for local workspaces.
  return selectionKind === "explicit";
}
