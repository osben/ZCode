import { useCallback, useEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import type { SiwcPlanStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import { ProviderLogo } from "./ProviderLogo.js";

const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const LOGIN_POLL_INTERVAL_MS = 1_500;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const FIRST_RUN_MODAL_STORAGE_KEY = "zcode.chatgptPlan.firstRunModalShown";

/**
 * ChatGPT plan detail page (official OpenAI SIWC token sharing).
 *
 * Self-contained on purpose: the ChatGPT plan is an identity domain independent of the
 * zai/bigmodel connection machinery, so login/status/logout ride the dedicated
 * IOAuthService SIWC methods instead of the coding-plan flow.
 */
export function ChatGptPlanDetail() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { oauthService } = useServices();
  const [status, setStatus] = useState<SiwcPlanStatus | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFirstRunModal, setShowFirstRunModal] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    void oauthService
      .getChatGptPlanStatus()
      .then((next) => {
        if (!disposedRef.current) setStatus(next);
      })
      .catch((caught: unknown) => {
        logger.error("[ChatGptPlanDetail] status load failed", { error: caught });
      });
    return () => {
      disposedRef.current = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [oauthService]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const startLogin = useCallback(async () => {
    setError(null);
    setLoginPending(true);
    try {
      const start = await oauthService.startChatGptPlanLogin();
      await platform.openExternal(start.authorizeUrl);
      if (disposedRef.current) return;
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      stopPolling();
      const poll = async () => {
        if (disposedRef.current) return;
        try {
          const completion = await oauthService.pollChatGptPlanLogin();
          if (disposedRef.current) return;
          if (!completion) {
            if (Date.now() >= deadline) {
              pollTimerRef.current = null;
              setLoginPending(false);
              setError(intl.formatMessage({ id: "settings.modelProvider.chatgpt.timeout" }));
              return;
            }
            pollTimerRef.current = setTimeout(() => void poll(), LOGIN_POLL_INTERVAL_MS);
            return;
          }
          pollTimerRef.current = null;
          setLoginPending(false);
          setStatus({
            signedIn: completion.signedIn,
            planUsageEntitled: completion.planUsageEntitled,
            user: completion.user,
          });
          if (
            completion.newUser &&
            completion.planUsageEntitled &&
            !localStorage.getItem(FIRST_RUN_MODAL_STORAGE_KEY)
          ) {
            localStorage.setItem(FIRST_RUN_MODAL_STORAGE_KEY, "1");
            setShowFirstRunModal(true);
          }
        } catch (caught) {
          if (disposedRef.current) return;
          pollTimerRef.current = null;
          setLoginPending(false);
          setError(
            caught instanceof Error
              ? caught.message
              : intl.formatMessage({ id: "settings.modelProvider.chatgpt.loginFailed" }),
          );
        }
      };
      pollTimerRef.current = setTimeout(() => void poll(), LOGIN_POLL_INTERVAL_MS);
    } catch (caught) {
      if (disposedRef.current) return;
      setLoginPending(false);
      setError(
        caught instanceof Error
          ? caught.message
          : intl.formatMessage({ id: "settings.modelProvider.chatgpt.loginFailed" }),
      );
    }
  }, [intl, oauthService, platform, stopPolling]);

  const signOut = useCallback(async () => {
    setError(null);
    try {
      await oauthService.logoutChatGptPlan();
      const next = await oauthService.getChatGptPlanStatus();
      if (!disposedRef.current) setStatus(next);
    } catch (caught) {
      if (!disposedRef.current) setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [oauthService]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3">
        <ProviderLogo logo={{ type: "builtin", key: "openai" }} className="size-8" />
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h2 className="text-ui-lg font-medium">ChatGPT Plan</h2>
            {/* Visual distinction from the API-key "OpenAI" provider: this one is plan-backed. */}
            <Badge variant="secondary">
              {intl.formatMessage({ id: "settings.modelProvider.chatgpt.badge.subscription" })}
            </Badge>
          </div>
          <p className="text-ui-sm text-muted-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.chatgpt.description" })}
          </p>
        </div>
      </header>

      {error ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="rounded-lg border border-border bg-card p-4">
        {status?.signedIn ? (
          <div className="flex flex-col gap-3">
            <p className="text-ui-sm">
              {intl.formatMessage(
                { id: "settings.modelProvider.chatgpt.signedInAs" },
                { name: status.user?.displayName ?? status.user?.subject ?? "" },
              )}
            </p>
            {status.planUsageEntitled ? (
              <p className="text-ui-sm text-muted-foreground">
                {intl.formatMessage({ id: "settings.modelProvider.chatgpt.entitled" })}
              </p>
            ) : (
              <p className="text-ui-sm text-muted-foreground">
                {intl.formatMessage({ id: "settings.modelProvider.chatgpt.notEntitled" })}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={() => void signOut()}>
                {intl.formatMessage({ id: "settings.modelProvider.chatgpt.signOut" })}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => void platform.openExternal(CHATGPT_USAGE_URL)}
              >
                {intl.formatMessage({ id: "settings.modelProvider.chatgpt.manageUsage" })}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-ui-sm text-muted-foreground">
              {intl.formatMessage({ id: "settings.modelProvider.chatgpt.notSignedIn" })}
            </p>
            <div>
              <Button
                type="button"
                disabled={loginPending}
                onClick={() => void startLogin()}
                className="bg-black text-white hover:bg-black/85 dark:bg-white dark:text-black dark:hover:bg-white/85"
              >
                {loginPending
                  ? intl.formatMessage({ id: "settings.modelProvider.chatgpt.waiting" })
                  : intl.formatMessage({
                      id: "settings.modelProvider.chatgpt.continueWithChatgpt",
                    })}
              </Button>
            </div>
          </div>
        )}
      </div>

      {showFirstRunModal ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="chatgpt-plan-first-run-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 text-card-foreground shadow-lg">
            <div className="mb-4 flex justify-center">
              <ProviderLogo logo={{ type: "builtin", key: "openai" }} className="size-10" />
            </div>
            <h3
              id="chatgpt-plan-first-run-title"
              className="mb-2 text-center text-ui-lg font-medium"
            >
              {intl.formatMessage({ id: "settings.modelProvider.chatgpt.firstRun.title" })}
            </h3>
            <p className="mb-5 text-ui-sm text-muted-foreground">
              {intl.formatMessage({ id: "settings.modelProvider.chatgpt.firstRun.body" })}
            </p>
            <div className="flex justify-center">
              <Button type="button" onClick={() => setShowFirstRunModal(false)}>
                {intl.formatMessage({ id: "settings.modelProvider.chatgpt.firstRun.gotIt" })}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
