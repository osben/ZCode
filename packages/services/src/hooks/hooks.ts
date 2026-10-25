import type { Hook, ZCodeWorkspaceHookTrustGrantResult } from "@zcode/shared";
import type { WorkspaceHookBundleSnapshotData } from "@zcode/shared/workspace-hook-discovery";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IHooksService {
  /**
   * Load hook configuration for the workspace.
   */
  loadHooks(params: {
    workspaceIdentity?: string;
    workspacePath: string;
    /** Source Settings 的 user scope 只读取用户目录，禁止把锚点路径当成项目。 */
    scope?: "all" | "user";
  }): Promise<{
    hooks: Hook[];
    hooksEnabled: boolean;
    workspaceHookSnapshot?: WorkspaceHookBundleSnapshotData;
    /** True when the trust store is corrupted or unreadable (fail closed: treat every hook as not persistently trusted). */
    trustStoreCorrupt?: boolean;
  }>;

  /**
   * Save hook configuration.
   */
  saveHooks(params: {
    workspaceIdentity?: string;
    workspacePath: string;
    scope?: "all" | "user";
    hooks: Hook[];
  }): Promise<void>;

  /**
   * Pre-trust a workspace hook without a task or session.
   * The implementation must forward to the Agent authority to rediscover the canonical snapshot; services and UI must not write to the store directly.
   */
  grantWorkspaceHookTrust?(params: {
    workspaceIdentity?: string;
    workspacePath: string;
    bundleDigest: string;
    hookDeclarationDigest: string;
  }): Promise<ZCodeWorkspaceHookTrustGrantResult>;
}

export const IHooksService = createServiceDescriptor<IHooksService>(ServiceChannels.Hooks);
