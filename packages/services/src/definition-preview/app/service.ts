import {
  definitionPreviewReadParamsSchema,
  definitionPreviewRefSchema,
  type DefinitionPreviewReadResult,
  type DefinitionPreviewRef,
  type DefinitionPreviewResolveResult,
  type DefinitionPreviewTreeEntry,
} from "@zcode/shared/definition-preview";
import type { IDefinitionPreviewService } from "../contract.js";
import {
  agentCandidates,
  commandCandidates,
  selectCandidate,
  skillCandidates,
  toWireCandidate,
  type CandidateSelection,
  type DefinitionCandidate,
} from "../domain/candidates.js";
import { parseDefinitionRelativePath } from "../domain/relativePath.js";
import type { DefinitionCatalogPort, DefinitionFilesPort } from "./ports.js";

export interface DefinitionPreviewAppPorts {
  catalog: DefinitionCatalogPort;
  files: DefinitionFilesPort;
  onRejected?: (reason: string) => void;
}

/**
 * Stateless: every call re-resolves the ref from the catalogs and re-derives the root, so reads
 * are idempotent and a stale ref can never reach a root the Host did not just discover.
 */
export function createDefinitionPreviewApp(
  ports: DefinitionPreviewAppPorts,
): IDefinitionPreviewService {
  async function listCandidates(ref: DefinitionPreviewRef): Promise<DefinitionCandidate[]> {
    const target = {
      workspacePath: ref.workspacePath,
      ...(ref.workspaceIdentity ? { workspaceIdentity: ref.workspaceIdentity } : {}),
    };
    switch (ref.kind) {
      case "skill":
        return skillCandidates(await ports.catalog.listSkills(target), ref.name);
      case "subagent":
        return agentCandidates(await ports.catalog.listAgents(target), ref.name);
      case "command":
        return commandCandidates(await ports.catalog.listCommands(target), ref.name);
      case "plugin":
        // Plugin roots arrive in slice 4; until then the kind resolves to not found.
        return [];
    }
  }

  async function select(ref: DefinitionPreviewRef): Promise<CandidateSelection | null> {
    return selectCandidate(await listCandidates(ref), ref.hintPath);
  }

  return {
    async resolve(rawRef: DefinitionPreviewRef): Promise<DefinitionPreviewResolveResult> {
      const ref = definitionPreviewRefSchema.parse(rawRef);
      const selection = await select(ref);
      if (!selection) return { status: "not_found" };
      const { winner } = selection;
      let tree: DefinitionPreviewTreeEntry[];
      let truncated = false;
      if (winner.singleFile) {
        if (!(await ports.files.isRegularFile(winner.rootPath))) return { status: "not_found" };
        tree = [{ relativePath: winner.entryRelativePath, kind: "file" }];
      } else {
        const listing = await ports.files.listTree(winner.rootPath);
        if (!listing) return { status: "not_found" };
        tree = listing.tree;
        truncated = listing.truncated;
      }
      return {
        status: "found",
        definition: {
          ...toWireCandidate(winner),
          ...(winner.description ? { description: winner.description } : {}),
          rootPath: winner.rootPath,
          entryRelativePath: winner.entryRelativePath,
          singleFile: winner.singleFile,
          userOwned: winner.userOwned,
        },
        tree,
        truncated,
        shadowed: selection.shadowed.map(toWireCandidate),
        ...(selection.movedFrom ? { movedFrom: selection.movedFrom } : {}),
      };
    },

    async readFile(rawParams): Promise<DefinitionPreviewReadResult> {
      const params = definitionPreviewReadParamsSchema.parse(rawParams);
      const segments = parseDefinitionRelativePath(params.relativePath);
      if (!segments) {
        ports.onRejected?.("invalid relative path");
        return { status: "rejected" };
      }
      const selection = await select(params.ref);
      if (!selection) return { status: "not_found" };
      const { winner } = selection;
      if (winner.singleFile) {
        // A single-file definition exposes exactly one child: its own basename.
        if (segments.length !== 1 || segments[0] !== winner.entryRelativePath) {
          ports.onRejected?.("path outside single-file definition");
          return { status: "rejected" };
        }
        return ports.files.readSingleFile(winner.rootPath);
      }
      const result = await ports.files.readFile(winner.rootPath, segments);
      if (result.status === "rejected") ports.onRejected?.("confinement check failed");
      return result;
    },
  };
}
