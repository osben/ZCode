import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * Credential management service
 *
 * Provides key-value credential reads and writes.
 * The implementation (host process) handles encrypted storage details;
 * the consumer (renderer) calls it through RPC without knowing the storage location.
 */
export interface ICredentialService {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const ICredentialService = createServiceDescriptor<ICredentialService>(
  ServiceChannels.Credential,
);
