import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import type { SiwcPlanAccountStatus, SiwcPlanAccountsStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Badge } from "@/components/ui/badge.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { CHATGPT_PLAN_PROVIDER_LOGO } from "@/lib/chatgptPlanProvider.js";
import { ProviderLogo } from "./ProviderLogo.js";

const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const LOGIN_POLL_INTERVAL_MS = 1_500;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const FIRST_RUN_MODAL_STORAGE_KEY = "zcode.chatgptPlan.firstRunModalShown";

/**
 * ChatGPT plan detail page (official OpenAI SIWC token sharing).
 *
 * Multi-account: lists every signed-in ChatGPT account with its consent state; "Continue with
 * ChatGPT" adds another account (OpenAI shows its account chooser), "Re-connect" re-authorizes
 * an identity-only account, and each row signs out independently. Self-contained on purpose:
 * the ChatGPT plan is an identity domain independent of the zai/bigmodel connection machinery,
 * so login/status/logout ride the dedicated IOAuthService SIWC methods.
 */
export function ChatGptPlanDetail() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { oauthService } = useServices();
  const [status, setStatus] = useState<SiwcPlanAccountsStatus | null>(null);
  const [loginPending, setLoginPending] = useState(false);
  const [signOutPending, setSignOutPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFirstRunModal, setShowFirstRunModal] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A new flow supersedes the old poll timer; this ref releases the old flow's pending UI too.
  const activeFlowPendingRef = useRef<((active: boolean) => void) | null>(null);
  // Every started flow takes a generation; a superseded flow must never touch the shared poll
  // timer or pending state again (e.g. its openExternal resolving late would otherwise cancel
  // the newer flow's poll and strand the newer flow's spinner forever).
  const flowGenerationRef = useRef(0);
  const disposedRef = useRef(false);

  // Only the newest status read writes, so a slow read never overwrites a later sign-in or sign-out.
  const statusSequenceRef = useRef(0);
  const refreshStatus = useCallback(async () => {
    const sequence = ++statusSequenceRef.current;
    const next = await oauthService.getChatGptPlanStatus();
    if (!disposedRef.current && sequence === statusSequenceRef.current) setStatus(next);
  }, [oauthService]);

  useEffect(() => {
    disposedRef.current = false;
    void refreshStatus().catch((caught: unknown) => {
      logger.error("[ChatGptPlanDetail] status load failed", { error: caught });
    });
    return () => {
      disposedRef.current = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    };
  }, [refreshStatus]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Open-browser-then-poll skeleton for the SIWC login: the service starts the flow, the browser
  // lands on the loopback callback, and the UI polls until the grant settles, times out, or fails.
  const runBrowserGrantFlow = useCallback(
    async <T extends unknown>(flow: {
      start: () => Promise<{ authorizeUrl: string }>;
      poll: () => Promise<T | null>;
      setPending: (active: boolean) => void;
      fallbackError: (caught: unknown) => string;
      onSettled?: (completion: T) => void | Promise<void>;
    }) => {
      setError(null);
      const generation = ++flowGenerationRef.current;
      activeFlowPendingRef.current?.(false);
      activeFlowPendingRef.current = flow.setPending;
      flow.setPending(true);
      try {
        const start = await flow.start();
        if (disposedRef.current || flowGenerationRef.current !== generation) return;
        await platform.openExternal(start.authorizeUrl);
        if (disposedRef.current || flowGenerationRef.current !== generation) return;
        const deadline = Date.now() + LOGIN_TIMEOUT_MS;
        stopPolling();
        const poll = async () => {
          if (disposedRef.current || flowGenerationRef.current !== generation) return;
          try {
            const completion = await flow.poll();
            if (disposedRef.current || flowGenerationRef.current !== generation) return;
            if (!completion) {
              if (Date.now() >= deadline) {
                pollTimerRef.current = null;
                flow.setPending(false);
                setError(intl.formatMessage({ id: "settings.modelProvider.chatgpt.timeout" }));
                return;
              }
              pollTimerRef.current = setTimeout(() => void poll(), LOGIN_POLL_INTERVAL_MS);
              return;
            }
            pollTimerRef.current = null;
            flow.setPending(false);
            await flow.onSettled?.(completion);
          } catch (caught) {
            // A superseded flow's late poll rejection must not surface as the newer flow's
            // error banner nor clear the newer flow's poll timer.
            if (disposedRef.current || flowGenerationRef.current !== generation) return;
            pollTimerRef.current = null;
            flow.setPending(false);
            setError(flow.fallbackError(caught));
          }
        };
        pollTimerRef.current = setTimeout(() => void poll(), LOGIN_POLL_INTERVAL_MS);
      } catch (caught) {
        if (disposedRef.current || flowGenerationRef.current !== generation) return;
        flow.setPending(false);
        setError(flow.fallbackError(caught));
      }
    },
    [intl, platform, stopPolling],
  );

  const startLogin = useCallback(
    async (options: { reauthAccountKey?: string } = {}) => {
      await runBrowserGrantFlow({
        start: () =>
          oauthService.startChatGptPlanLogin(
            options.reauthAccountKey ? { reauthAccountKey: options.reauthAccountKey } : {},
          ),
        poll: () => oauthService.pollChatGptPlanLogin(),
        setPending: setLoginPending,
        fallbackError: (caught) =>
          caught instanceof Error
            ? caught.message
            : intl.formatMessage({ id: "settings.modelProvider.chatgpt.loginFailed" }),
        onSettled: async (completion) => {
          if (
            completion.newUser &&
            completion.planUsageEntitled &&
            !localStorage.getItem(FIRST_RUN_MODAL_STORAGE_KEY)
          ) {
            localStorage.setItem(FIRST_RUN_MODAL_STORAGE_KEY, "1");
            setShowFirstRunModal(true);
          }
          // The login itself has completed; a status refresh failure must not surface as
          // a login error (the stored account simply appears after the next status read).
          await refreshStatus().catch((refreshError: unknown) => {
            logger.error("[ChatGptPlanDetail] status refresh failed", { error: refreshError });
          });
        },
      });
    },
    [intl, oauthService, refreshStatus, runBrowserGrantFlow],
  );

  const signOut = useCallback(
    async (accountKey: string) => {
      setError(null);
      setSignOutPending(accountKey);
      try {
        await oauthService.logoutChatGptPlan(accountKey);
        await refreshStatus();
      } catch (caught) {
        if (!disposedRef.current)
          setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setSignOutPending(null);
      }
    },
    [oauthService, refreshStatus],
  );

  const accounts = status?.accounts ?? [];
  const reconnectAccounts = status?.reconnectRequired ?? [];
  const addAccountLabelId = accounts.length
    ? "settings.modelProvider.chatgpt.addAccount"
    : "settings.modelProvider.chatgpt.continueWithChatgpt";

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3">
        <ProviderLogo logo={CHATGPT_PLAN_PROVIDER_LOGO} className="size-8" />
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

      <div className="flex flex-col gap-3">
        {accounts.map((account) => (
          <AccountRow
            key={account.accountKey}
            account={account}
            intl={intl}
            loginPending={loginPending}
            signOutPending={signOutPending === account.accountKey}
            onSignOut={() => void signOut(account.accountKey)}
            onReconnect={() => void startLogin({ reauthAccountKey: account.accountKey })}
            onManageUsage={() => void platform.openExternal(CHATGPT_USAGE_URL)}
          />
        ))}
        {reconnectAccounts.map((account) => (
          // specs/chatgpt-plan-signin.md "Reconnect required": the sign-in expired or was revoked.
          <div
            key={account.accountKey}
            data-testid="chatgpt-plan-reconnect-row"
            className="rounded-lg border border-warning/40 bg-warning-surface p-4"
          >
            <div className="flex flex-col gap-3">
              <p className="text-ui-sm font-medium">
                {account.user.email ?? account.user.displayName ?? account.accountKey}
              </p>
              <p role="status" className="text-ui-sm text-foreground">
                {intl.formatMessage({ id: "settings.modelProvider.chatgpt.reconnectRequired" })}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  disabled={loginPending}
                  onClick={() => void startLogin({ reauthAccountKey: account.accountKey })}
                >
                  {intl.formatMessage({ id: "settings.modelProvider.chatgpt.signInAgain" })}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={signOutPending === account.accountKey}
                  onClick={() => void signOut(account.accountKey)}
                >
                  {intl.formatMessage({ id: "settings.modelProvider.chatgpt.removeAccount" })}
                </Button>
              </div>
            </div>
          </div>
        ))}
        {accounts.length === 0 && reconnectAccounts.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-4">
            <p className="text-ui-sm text-muted-foreground">
              {intl.formatMessage({ id: "settings.modelProvider.chatgpt.notSignedIn" })}
            </p>
          </div>
        ) : null}
        <div>
          <Button
            type="button"
            disabled={loginPending}
            onClick={() => void startLogin()}
            className="bg-black text-white hover:bg-black/85 dark:bg-white dark:text-black dark:hover:bg-white/85"
          >
            {loginPending ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <ProviderLogo logo={CHATGPT_PLAN_PROVIDER_LOGO} className="size-4" />
            )}
            {loginPending
              ? intl.formatMessage({ id: "settings.modelProvider.chatgpt.waiting" })
              : intl.formatMessage({ id: addAccountLabelId })}
          </Button>
        </div>
      </div>

      {/* Shared Dialog: Escape, backdrop click and focus trapping come with it (shown once). */}
      <Dialog open={showFirstRunModal} onOpenChange={setShowFirstRunModal}>
        <DialogContent className="max-w-sm">
          <div className="flex justify-center">
            <ProviderLogo logo={CHATGPT_PLAN_PROVIDER_LOGO} className="size-10" />
          </div>
          <DialogHeader>
            <DialogTitle className="text-center">
              {intl.formatMessage({ id: "settings.modelProvider.chatgpt.firstRun.title" })}
            </DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "settings.modelProvider.chatgpt.firstRun.body" })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-center">
            <Button type="button" onClick={() => setShowFirstRunModal(false)}>
              {intl.formatMessage({ id: "settings.modelProvider.chatgpt.firstRun.gotIt" })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface AccountRowProps {
  readonly account: SiwcPlanAccountStatus;
  readonly intl: ReturnType<typeof useZCodeIntl>["intl"];
  /** Any login (add or reconnect) is in flight; only one pending login is allowed. */
  readonly loginPending: boolean;
  readonly signOutPending: boolean;
  readonly onSignOut: () => void;
  readonly onReconnect: () => void;
  readonly onManageUsage: () => void;
}

function AccountRow({
  account,
  intl,
  loginPending,
  signOutPending,
  onSignOut,
  onReconnect,
  onManageUsage,
}: AccountRowProps) {
  const displayName = account.user?.email ?? account.user?.displayName ?? account.accountKey;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3">
        <p className="min-w-0 truncate text-ui-sm">
          {intl.formatMessage(
            { id: "settings.modelProvider.chatgpt.signedInAs" },
            { name: displayName },
          )}
        </p>
        {account.planUsageEntitled ? (
          <p className="text-ui-sm text-muted-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.chatgpt.entitled" })}
          </p>
        ) : (
          <p className="text-ui-sm text-muted-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.chatgpt.notEntitled" })}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" disabled={signOutPending} onClick={onSignOut}>
            {signOutPending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            {intl.formatMessage({ id: "settings.modelProvider.chatgpt.signOut" })}
          </Button>
          {account.planUsageEntitled ? null : (
            <Button type="button" variant="outline" disabled={loginPending} onClick={onReconnect}>
              {intl.formatMessage({ id: "settings.modelProvider.chatgpt.reconnect" })}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onManageUsage}>
            {intl.formatMessage({ id: "settings.modelProvider.chatgpt.manageUsage" })}
          </Button>
        </div>
      </div>
    </div>
  );
}
