import type { AppSettings } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** Host-private assembly port: reads only the locally committed workspace directory, never settings or network. */
export type WorkspaceSettingsProjection = Pick<
  AppSettings,
  "lastActiveWorkspace" | "lastWorkspaceSession" | "recentProjects" | "lastActiveTabIndex"
>;

export interface ISettingService {
  get(): Promise<AppSettings>;
  /**
   * Full connection-mapping writes may pass the snapshot they read plus its version. When the version is
   * present, the service compares it inside the write lock and bumps providerFamilyDomainUpdatedAt.
   */
  update(
    patch: Partial<AppSettings>,
    expectedAccountSettings?: Pick<
      AppSettings,
      | "providerFamilyDomain"
      | "providerFamilyConnectionSelections"
      | "providerFamilyDomainUpdatedAt"
    >,
  ): Promise<void>;
  /** Change the data base directory: copy data from old → new location, then persist the setting. */
  updateDataBaseDir(newDir: string | undefined): Promise<void>;
  ensureDefaultProject(homedir: string): Promise<{ path: string; created: boolean }>;
}

export const ISettingService = createServiceDescriptor<ISettingService>(ServiceChannels.Setting);
