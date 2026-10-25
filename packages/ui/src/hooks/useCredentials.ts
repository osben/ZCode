/**
 * useCredentials — credential-service hooks
 */
import { useCallback } from "react";
import { useServices } from "./useServices.js";

/** Base hook for credential management. */
export function useCredentials() {
  const { credentialService } = useServices();

  const load = useCallback((key: string) => credentialService.load(key), [credentialService]);
  const save = useCallback(
    (key: string, value: string) => credentialService.save(key, value),
    [credentialService],
  );
  const del = useCallback((key: string) => credentialService.delete(key), [credentialService]);

  return { load, save, delete: del };
}

/** Convenience hook for the active provider's access_token. */
export function useAuthToken() {
  const { credentialService, oauthService } = useServices();

  const getToken = useCallback(async () => {
    const activeProvider = await oauthService.getActiveProvider();
    if (!activeProvider) {
      return null;
    }

    const namespacedToken = await credentialService.load(`oauth:${activeProvider}:access_token`);
    if (namespacedToken) {
      return namespacedToken;
    }

    // Accounts created before multi-provider support stored only auth_token.
    // Add a fallback read for bigmodel only so token reads do not briefly fail after an upgrade.
    if (activeProvider === "bigmodel") {
      return credentialService.load("auth_token");
    }

    return null;
  }, [credentialService, oauthService]);
  const setToken = useCallback(
    async (token: string) => {
      const activeProvider = await oauthService.getActiveProvider();
      if (!activeProvider) {
        throw new Error("当前没有 active provider，无法写入 auth token");
      }
      await credentialService.save(`oauth:${activeProvider}:access_token`, token);
    },
    [credentialService, oauthService],
  );
  const clearToken = useCallback(async () => {
    const activeProvider = await oauthService.getActiveProvider();
    if (!activeProvider) {
      return;
    }
    await credentialService.delete(`oauth:${activeProvider}:access_token`);
    if (activeProvider === "bigmodel") {
      await credentialService.delete("auth_token");
    }
  }, [credentialService, oauthService]);

  return { getToken, setToken, clearToken };
}
