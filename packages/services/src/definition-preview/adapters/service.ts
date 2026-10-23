import { createServiceLogger } from "../../logger/serviceLogger.js";
import { createDefinitionPreviewApp } from "../app/service.js";
import type { DefinitionCatalogPort } from "../app/ports.js";
import type { IDefinitionPreviewService } from "../contract.js";
import { createDefinitionFilesAdapter, type DefinitionFilesAdapterOptions } from "./files.js";

export interface CreateDefinitionPreviewServiceOptions {
  catalog: DefinitionCatalogPort;
  files?: DefinitionFilesAdapterOptions;
}

export function createDefinitionPreviewService(
  options: CreateDefinitionPreviewServiceOptions,
): IDefinitionPreviewService {
  const logger = createServiceLogger("definition-preview");
  return createDefinitionPreviewApp({
    catalog: options.catalog,
    files: createDefinitionFilesAdapter(options.files),
    // Paths stay out of logs: they may name the user's home directory and private projects.
    onRejected: (reason) => logger.warn(undefined, "Rejected definition preview read", { reason }),
  });
}
