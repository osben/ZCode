import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * Credential management service
 *
 * Provides key-value credential reads and writes.
 * The implementation (host process) handles encrypted storage details;
 * the consumer (renderer) calls it through RPC without knowing the storage location.
 * A backup receipt can be shown after the user confirms a recovery.
 */
export interface ICredentialService {
  /** 只读检测整份容器；不把普通 IO 错误或单字段解密失败当作损坏。 */
  inspectStore(): Promise<{ status: "healthy" } | { status: "corrupt"; fingerprint: string }>;
  /** 用户明确确认后提交损坏指纹；在原锁内备份、核验并重建，旧指纹只返回 changed。 */
  recoverStore(
    fingerprint: string,
  ): Promise<{ status: "changed" } | { status: "recovered"; backupPath: string }>;
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const ICredentialService = createServiceDescriptor<ICredentialService>(
  ServiceChannels.Credential,
);

export function scopeCredentialServiceForRpc(
  service: ICredentialService,
  localDesktopRecovery: boolean,
): ICredentialService {
  if (localDesktopRecovery) return service;
  const rejectRecovery = async (): Promise<never> => {
    throw Object.assign(
      new Error("Credential store recovery is only available from local Desktop"),
      {
        kind: "feature_disabled" as const,
      },
    );
  };
  // clientMode 和可自领的 host ticket 都不是恢复授权。所有 RPC 默认只读写，
  // 唯一本机 Desktop MessagePort 发布点显式放行，避免新网络入口漏设限制。
  return {
    load: service.load.bind(service),
    save: service.save.bind(service),
    delete: service.delete.bind(service),
    inspectStore: rejectRecovery,
    recoverStore: rejectRecovery,
  };
}
