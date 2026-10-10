/**
 * useTokenRefresh — token refresh hook (mounted at the app root).
 *
 * Mount in the Root or App component so 401 refresh works at all times.
 * Listen for global 401 events and refresh the token through oauthService.refreshToken.
 */
import { useCallback } from "react";
import { logger } from "../logger.js";
import { useServices } from "./useServices.js";

export function useTokenRefresh() {
  const { oauthService } = useServices();

  /** Try to refresh the token; return false on failure. */
  const tryRefresh = useCallback(async (): Promise<boolean> => {
    try {
      await oauthService.refreshToken();
      logger.info("[useTokenRefresh] token 刷新成功");
      return true;
    } catch (err) {
      logger.error("[useTokenRefresh] token 刷新失败:", err);
      return false;
    }
  }, [oauthService]);

  /** Clear credentials for all providers. */
  const clearCredentials = useCallback(async () => {
    await oauthService.logoutAll();
  }, [oauthService]);

  return { tryRefresh, clearCredentials };
}
