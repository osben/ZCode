/**
 * useOAuth — OAuth login-flow hook
 *
 * Responsible only for starting login and managing UI state.
 * OAuth callbacks are observed by the persistent Root/App layer, not by this hook.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { OAuthProviderId, OAuthProviderMeta } from "@zcode/shared";
import { isBuiltinOAuthProvider, resolveSafeTelemetryHostname } from "@zcode/shared";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LoginEntryPurpose } from "@/store/index.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { logger } from "@/logger.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";

type OAuthStatus = "idle" | "waiting" | "error";

export function useOAuth() {
  const { oauthService } = useServices();
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<OAuthStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<OAuthProviderMeta[]>([]);
  const [activeProvider, setActiveProvider] = useState<OAuthProviderId | null>(null);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [pendingProvider, setPendingProvider] = useState<OAuthProviderId | null>(null);
  // The URL that was opened in the browser. Kept only while waiting so the login screen can offer
  // "Copy login link" when the browser did not open; every terminal transition clears it.
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const loginAttemptRef = useRef(0);
  const providerRefreshRef = useRef(0);
  const setOAuthPollingActive = useZCodeStore((state) => state.setOAuthPollingActive);

  const refreshProviders = useCallback(async () => {
    const refresh = ++providerRefreshRef.current;
    const isCurrent = () => providerRefreshRef.current === refresh;
    try {
      setLoadingProviders(true);
      const providerList = await oauthService.getProviders();
      if (!isCurrent()) return;
      setProviders(providerList);

      try {
        const active = await oauthService.getActiveProvider();
        if (!isCurrent()) return;
        setActiveProvider(active);
      } catch (err) {
        if (!isCurrent()) return;
        // 账号读取失败不代表渠道不可用；保留已取得的元数据，只清空本地账号投影。
        // 不在 UI 清理或重建凭据，避免把整库损坏、IO 故障当作可恢复的单条密文。
        logger.warn("[useOAuth] 加载 active provider 失败，保留登录渠道:", err);
        setActiveProvider(null);
      }
    } catch (err) {
      if (!isCurrent()) return;
      logger.error("[useOAuth] 加载 provider 列表失败:", err);
      setProviders([]);
      setActiveProvider(null);
    } finally {
      if (isCurrent()) setLoadingProviders(false);
    }
  }, [oauthService]);

  useEffect(() => {
    void refreshProviders();
    // 迟到的成功、失败和 finally 均不能覆盖新服务实例或已卸载界面的状态。
    return () => {
      providerRefreshRef.current += 1;
    };
  }, [refreshProviders]);

  const startLogin = useCallback(
    async (provider: OAuthProviderId, options: { purpose?: LoginEntryPurpose } = {}) => {
      const loginAttempt = ++loginAttemptRef.current;
      try {
        setStatus("waiting");
        setError(null);
        setPendingProvider(provider);
        setAuthorizeUrl(null);

        const {
          authorizeUrl: startedAuthorizeUrl,
          state,
          provider: startedProvider,
        } = await oauthService.startOAuthWithPolling(provider);

        if (loginAttemptRef.current !== loginAttempt) {
          return;
        }

        setAuthorizeUrl(startedAuthorizeUrl);
        platform.registerOAuthState({ state, provider: startedProvider });
        setOAuthPollingActive(isBuiltinOAuthProvider(startedProvider));
        platform.openExternal(startedAuthorizeUrl);
        void reportAppTelemetryEvent(
          platform,
          {
            elementName: "app_login_ck",
            eventRegion: "app",
            eventType: "ck",
            eventExtraDetail: {
              // The authorization URL contains state/credential parameters; telemetry records only the hostname while the browser uses the full URL above.
              login_url: resolveSafeTelemetryHostname(startedAuthorizeUrl),
            },
          },
          "useOAuth",
        );

        logger.info("[useOAuth] OAuth 流程已启动，等待浏览器回调", {
          provider: startedProvider,
          purpose: options.purpose ?? "app-login",
        });
      } catch (err) {
        // Failure from an older init may arrive after a newer login succeeds; it must not stop the new flow's polling or overwrite its UI.
        if (loginAttemptRef.current !== loginAttempt) {
          return;
        }
        logger.error("[useOAuth] 启动 OAuth 失败:", err);
        setOAuthPollingActive(false);
        setAuthorizeUrl(null);
        setStatus("error");
        // An OAuth startup failure is still a login failure; do not show raw server/platform errors to the user.
        // Render a localized message instead of exposing provider/token details on the login page.
        setError(intl.formatMessage({ id: "login.oauth.loginFailure" }));
        setPendingProvider(null);
      }
    },
    [intl, oauthService, platform, setOAuthPollingActive],
  );

  const cancel = useCallback(
    async (provider?: OAuthProviderId) => {
      loginAttemptRef.current += 1;
      setAuthorizeUrl(null);
      await oauthService.cancelPending(provider);
      setOAuthPollingActive(false);
      setStatus("idle");
      setError(null);
      setPendingProvider(null);
    },
    [oauthService, setOAuthPollingActive],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setPendingProvider(null);
    setAuthorizeUrl(null);
  }, []);

  /** Called by the Root/App callback listener to update UI state. */
  const setOAuthError = useCallback((message: string) => {
    setStatus("error");
    setError(message);
    setPendingProvider(null);
    setAuthorizeUrl(null);
  }, []);

  const setOAuthSuccess = useCallback(async () => {
    setStatus("idle");
    setError(null);
    setPendingProvider(null);
    setAuthorizeUrl(null);
    await refreshProviders();
  }, [refreshProviders]);

  return {
    startLogin,
    cancel,
    reset,
    status,
    error,
    authorizeUrl,
    providers,
    activeProvider,
    loadingProviders,
    pendingProvider,
    refreshProviders,
    setOAuthError,
    setOAuthSuccess,
  };
}
