import { basename } from "node:path";
import type { ResolvedLspServer } from "@zcode/contracts";
import { LSP_CLIENT_NAME, LSP_POSITION_ENCODING } from "./constants.js";
import { filePathToFileUri, pathApiFor, resolveWorkspaceFolder } from "./paths.js";

export interface LspWorkspaceFolder {
  uri: string;
  name: string;
}

/**
 * Client capabilities advertised to every server. Diagnostics are push-based (`publishDiagnostics` with
 * versions) and pull is advertised as dynamic registration only, because servers differ in what they accept.
 */
export const LSP_CLIENT_CAPABILITIES = {
  general: {
    positionEncodings: [LSP_POSITION_ENCODING],
  },
  textDocument: {
    synchronization: {
      dynamicRegistration: false,
      didSave: false,
    },
    publishDiagnostics: {
      versionSupport: true,
    },
    diagnostic: {
      dynamicRegistration: true,
    },
    definition: {},
    references: {},
    implementation: {},
    hover: {
      contentFormat: ["markdown", "plaintext"],
    },
    documentSymbol: {
      hierarchicalDocumentSymbolSupport: true,
    },
  },
  workspace: {
    configuration: true,
    workspaceFolders: true,
    didChangeWatchedFiles: {
      dynamicRegistration: false,
    },
    symbol: {},
  },
} as const;

export interface BuildInitializeParamsInput {
  server: ResolvedLspServer;
  workspacePath: string;
  platform: NodeJS.Platform;
  processId: number | null;
}

export interface LspInitializeParams {
  processId: number | null;
  clientInfo: { name: string };
  rootUri: string;
  rootPath: string;
  workspaceFolders: LspWorkspaceFolder[];
  initializationOptions?: unknown;
  capabilities: typeof LSP_CLIENT_CAPABILITIES;
}

export function buildInitializeParams(input: BuildInitializeParamsInput): LspInitializeParams {
  const { server, workspacePath, platform } = input;
  const folders: string[] = [workspacePath];
  if (server.workspaceFolder !== undefined) {
    const folder = resolveWorkspaceFolder(workspacePath, server.workspaceFolder, platform);
    if (folder !== workspacePath) folders.push(folder);
  }
  return {
    processId: input.processId,
    clientInfo: { name: LSP_CLIENT_NAME },
    rootUri: filePathToFileUri(workspacePath, platform),
    rootPath: workspacePath,
    workspaceFolders: folders.map((folder) => toWorkspaceFolder(folder, platform)),
    initializationOptions: server.initializationOptions,
    capabilities: LSP_CLIENT_CAPABILITIES,
  };
}

export function toWorkspaceFolder(
  absolutePath: string,
  platform: NodeJS.Platform,
): LspWorkspaceFolder {
  const name = basename(absolutePath) || pathApiFor(platform).sep;
  return { uri: filePathToFileUri(absolutePath, platform), name };
}
