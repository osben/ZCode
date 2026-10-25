/**
 * usePlatform — provide IPlatformService through React Context
 *
 * Access platform operations (native dialogs, window lifecycle, etc.) through this hook
 * instead of calling window.zcode directly.
 */
import { createContext, useContext, useCallback, type ReactNode } from "react";
import type { IPlatformService, RemoteTarget } from "@zcode/shared";

const PlatformContext = createContext<IPlatformService | null>(null);

export function PlatformProvider({
  platform,
  children,
}: {
  platform: IPlatformService;
  children: ReactNode;
}) {
  return <PlatformContext.Provider value={platform}>{children}</PlatformContext.Provider>;
}

export function usePlatform(): IPlatformService {
  const ctx = useOptionalPlatform();
  if (!ctx) {
    throw new Error("usePlatform 必须在 PlatformProvider 内使用");
  }
  return ctx;
}

export function useOptionalPlatform(): IPlatformService | null {
  const ctx = useContext(PlatformContext);
  return ctx;
}

/** Convenience hook for choosing a directory. */
export function useSelectDirectory() {
  const platform = usePlatform();
  return useCallback(() => platform.selectDirectory(), [platform]);
}

/** Convenience hook for connecting remotely. */
export function useConnectRemote() {
  const platform = usePlatform();
  return useCallback(
    async (options: RemoteTarget, requestId?: string) => {
      const result = await platform.connectRemote(options, requestId);
      if (!result.success) {
        throw new Error(result.error || "Connection failed");
      }
    },
    [platform],
  );
}
