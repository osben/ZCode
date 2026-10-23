import type {
  DefinitionPreviewReadParams,
  DefinitionPreviewReadResult,
  DefinitionPreviewRef,
  DefinitionPreviewResolveResult,
} from "@zcode/shared/definition-preview";
import { createServiceDescriptor } from "../descriptors.js";

/** Runs on the workspace's executing Host; derives roots from its own discovery and confines reads. */
export interface IDefinitionPreviewService {
  resolve(ref: DefinitionPreviewRef): Promise<DefinitionPreviewResolveResult>;
  readFile(params: DefinitionPreviewReadParams): Promise<DefinitionPreviewReadResult>;
}

// Literal channel (as gen-ui does) keeps the upstream ServiceChannels table untouched.
export const DEFINITION_PREVIEW_CHANNEL = "definition-preview";
export const IDefinitionPreviewService = createServiceDescriptor<IDefinitionPreviewService>(
  DEFINITION_PREVIEW_CHANNEL,
);
