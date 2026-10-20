import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { Locale } from "@zcode/shared";
import { DEFAULT_LOCALE, FALLBACK_UI_LOCALE, isLocale, resolveSystemLocale } from "@zcode/shared";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";
import ukUA from "@/i18n/locales/uk-UA.js";
import { logger } from "@/logger.js";
import { reportReactErrorToArms } from "@/lib/reactErrorArmsTelemetry.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { AlertTriangleIcon, RefreshCw } from "lucide-react";

interface AppErrorBoundaryProps {
  children: ReactNode;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  /**
   * Exceptions caught by a React error boundary do not bubble to window.onerror, so monitoring SDKs do not receive them by default.
   * Hosts such as Desktop can provide this callback to forward exceptions caught by React error boundaries to the monitoring SDK.
   */
  onCaughtReactError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface AppErrorBoundaryState {
  error: Error | null;
  componentStack: string;
}

export type ScopedErrorBoundaryVariant = "panel" | "inline" | "compact" | "silent";

interface ScopedErrorBoundaryProps {
  children: ReactNode;
  scope: string;
  resetKeys?: readonly unknown[];
  variant?: ScopedErrorBoundaryVariant;
  className?: string;
  onReset?: () => void;
  onCaughtReactError?: (error: Error, errorInfo: ErrorInfo, scope: string) => void;
}

const LOCALE_PREFERENCE_KEY = "zcode-locale-preference";

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown error");
}

function serializeErrorForLog(error: Error): {
  name: string;
  message: string;
  stack?: string;
} {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
}

const BOUNDARY_MESSAGES = {
  "zh-CN": zhCN,
  "en-US": enUS,
  "uk-UA": ukUA,
} satisfies Record<Locale, Record<string, string>>;

function resolveBoundaryLocale(): Locale {
  if (typeof localStorage !== "undefined" && typeof localStorage.getItem === "function") {
    try {
      const storedPreference = localStorage.getItem(LOCALE_PREFERENCE_KEY);
      if (isLocale(storedPreference)) {
        return storedPreference;
      }
    } catch {
      // In the Node test environment, localStorage may exist but lack full functionality or be unreadable
      // (for example, it may be a placeholder or throw during reads). Without a fallback, the error boundary could crash again while rendering its fallback,
      // leaving the user with a blank screen. Catch storage-layer errors here and continue with navigator / the default language.
    }
  }

  if (typeof navigator !== "undefined") {
    return resolveSystemLocale(navigator.language, FALLBACK_UI_LOCALE);
  }

  return DEFAULT_LOCALE;
}

function formatBoundaryMessage(id: string): string {
  const locale = resolveBoundaryLocale();
  // Match createIntl: when the current locale is missing a key (for example, uk is not fully translated), fall back to English instead of showing the ID.
  return BOUNDARY_MESSAGES[locale]?.[id] ?? enUS[id] ?? id;
}

function haveResetKeysChanged(
  previousKeys: readonly unknown[] = [],
  nextKeys: readonly unknown[] = [],
): boolean {
  if (previousKeys.length !== nextKeys.length) {
    return true;
  }

  return previousKeys.some((previousKey, index) => !Object.is(previousKey, nextKeys[index]));
}

function ErrorFallback({
  error,
  componentStack,
  onReset,
  onReload,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
}: {
  error: Error;
  componentStack: string;
  onReset: () => void;
  onReload: () => void;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}) {
  const errorSummary = error.message.trim() || formatBoundaryMessage("appError.unknown");

  return (
    <DesktopWindowFrame
      title={formatBoundaryMessage("appError.title")}
      isDesktop={isDesktop}
      isMacDesktop={isMacDesktop}
      isWindowsDesktop={isWindowsDesktop}
    >
      <div className="flex h-full min-h-0 justify-center overflow-y-auto p-6">
        <div
          role="alert"
          // Error messages and component stacks can be very long. The outer container used to prevent scrolling, pushing content outside the viewport,
          // so users could not read the full stack or reach the “Retry / Refresh” buttons. Anchor the fallback card to the top
          // and add vertical scrolling to the outer container so every action remains accessible even in a small window.
          className="w-full max-w-xl self-start rounded-3xl border border-destructive/20 bg-surface-alt p-6 shadow-sm"
        >
          <div className="flex size-10 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
            <AlertTriangleIcon className="size-5" />
          </div>

          <h1 className="mt-4 text-lg font-semibold text-foreground">
            {formatBoundaryMessage("appError.title")}
          </h1>
          <p className="mt-2 text-ui-base leading-6 text-on-surface-muted">
            {formatBoundaryMessage("appError.description")}
          </p>

          <div className="mt-4 rounded-2xl border border-border bg-background px-3 py-2 font-mono text-ui-base leading-5 text-on-surface-muted">
            {errorSummary}
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button type="button" onClick={onReset}>
              {formatBoundaryMessage("appError.retry")}
            </Button>
            <Button type="button" variant="outline" onClick={onReload}>
              <RefreshCw />
              {formatBoundaryMessage("appError.reload")}
            </Button>
          </div>

          <p className="mt-4 text-ui-base leading-5 text-on-surface-muted">
            {formatBoundaryMessage("appError.hint")}
          </p>

          {componentStack ? (
            <details className="mt-4 rounded-2xl border border-border bg-background px-3 py-2">
              <summary className="cursor-pointer text-ui-base font-medium text-on-surface-muted">
                {formatBoundaryMessage("appError.details")}
              </summary>
              <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words text-ui-base leading-5 text-on-surface-muted">
                {/* Expanding the component stack can make it grow sharply; constrain the pre height and scroll it independently
                    so details cannot fill the screen and push the main actions out of view. */}
                {componentStack.trim()}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </DesktopWindowFrame>
  );
}

function ScopedErrorFallback({
  error,
  componentStack,
  onReset,
  onReload,
  variant = "panel",
  className,
}: {
  error: Error;
  componentStack: string;
  onReset: () => void;
  onReload: () => void;
  variant?: ScopedErrorBoundaryVariant;
  className?: string;
}) {
  if (variant === "silent") {
    return null;
  }

  const errorSummary = error.message.trim() || formatBoundaryMessage("appError.unknown");
  const isCompact = variant === "compact";
  const showDetails = variant !== "compact";

  if (isCompact) {
    return (
      <div
        role="alert"
        className={cn(
          "flex min-h-10 items-center gap-2 border-border bg-surface px-3 py-2",
          className,
        )}
      >
        <AlertTriangleIcon className="size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-base font-medium text-foreground">
            {formatBoundaryMessage("appError.sectionTitle")}
          </p>
          <p className="truncate font-mono text-ui-base text-foreground-subtle">{errorSummary}</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={onReset}>
          {formatBoundaryMessage("appError.sectionRetry")}
        </Button>
      </div>
    );
  }

  const content = (
    <>
      <div className="flex size-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
        <AlertTriangleIcon className="size-4" />
      </div>
      <h2 className="mt-3 text-ui-base font-medium text-foreground">
        {formatBoundaryMessage("appError.sectionTitle")}
      </h2>
      <p className="mt-1 text-ui-base leading-5 text-foreground-subtle">
        {formatBoundaryMessage("appError.sectionDescription")}
      </p>
      <div className="mt-3 rounded-lg border border-border bg-background px-3 py-2 font-mono text-ui-base leading-5 text-foreground-subtle">
        {errorSummary}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={onReset}>
          {formatBoundaryMessage("appError.sectionRetry")}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onReload}>
          <RefreshCw />
          {formatBoundaryMessage("appError.reload")}
        </Button>
      </div>
      <p className="mt-3 text-ui-base leading-5 text-foreground-subtle">
        {formatBoundaryMessage("appError.sectionHint")}
      </p>
      {showDetails && componentStack ? (
        <details className="mt-3 rounded-lg border border-border bg-background px-3 py-2">
          <summary className="cursor-pointer text-ui-base font-medium text-foreground-subtle">
            {formatBoundaryMessage("appError.details")}
          </summary>
          <pre className="mt-2 max-h-[32vh] overflow-auto whitespace-pre-wrap break-words text-ui-base leading-5 text-foreground-subtle">
            {componentStack.trim()}
          </pre>
        </details>
      ) : null}
    </>
  );

  if (variant === "inline") {
    return (
      <div
        role="alert"
        className={cn("w-full rounded-xl border border-destructive/20 bg-surface p-4", className)}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        "flex h-full min-h-0 items-center justify-center overflow-auto bg-background p-4",
        className,
      )}
    >
      <div className="w-full max-w-md rounded-xl border border-destructive/20 bg-surface p-4 shadow-sm">
        {content}
      </div>
    </div>
  );
}

/**
 * AppErrorBoundary — React root-level error boundary
 *
 * If the renderer entry mounts ZCodeIntlProvider / Root directly with createRoot,
 * an error from a Provider or page component during render / lifecycle will cause React to unmount the entire tree,
 * leaving the user with a blank screen. Wrap the tree in a shared root boundary to turn exceptions into a recoverable fallback,
 * so the interface can at least offer a “Retry / Refresh” path and record the error in the shared UI log.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
    componentStack: "",
  };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      error: normalizeError(error),
      componentStack: "",
    };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    const normalizedError = normalizeError(error);
    logger.error(
      "[AppErrorBoundary] React subtree crashed:",
      // Error objects become {} when serialized across the preload logging bridge,
      // which loses key messages such as Maximum update depth. Expand the diagnostic fields explicitly here.
      serializeErrorForLog(normalizedError),
      errorInfo.componentStack,
    );
    this.props.onCaughtReactError?.(normalizedError, errorInfo);
    // React error boundaries intercept exceptions and stop them from bubbling to window.onerror, so the RUM Browser SDK does not receive them by default.
    // Forward them to the ARMS custom-event pipeline (the reporter is injected early at the renderer entry) to cover root-level render crashes.
    reportReactErrorToArms({
      error: normalizedError,
      componentStack: errorInfo.componentStack ?? "",
    });
    this.setState({ componentStack: errorInfo.componentStack ?? "" });
  }

  private handleReset = () => {
    this.setState({
      error: null,
      componentStack: "",
    });
  };

  private handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  override render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <ErrorFallback
        error={this.state.error}
        componentStack={this.state.componentStack}
        onReset={this.handleReset}
        onReload={this.handleReload}
        isDesktop={this.props.isDesktop}
        isMacDesktop={this.props.isMacDesktop}
        isWindowsDesktop={this.props.isWindowsDesktop}
      />
    );
  }
}

/**
 * ScopedErrorBoundary — local UI failure-isolation boundary
 *
 * With only a root error boundary, a render error in any workspace panel bubbles all the way to the root,
 * replacing the entire interface with a full-screen error page. Provide a reusable local boundary so the sidebar, chat,
 * terminal, and side pane can fail and recover independently, preventing a single component issue from disabling the whole window.
 */
export class ScopedErrorBoundary extends Component<
  ScopedErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    error: null,
    componentStack: "",
  };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      error: normalizeError(error),
      componentStack: "",
    };
  }

  override componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    const normalizedError = normalizeError(error);
    logger.error(
      `[ScopedErrorBoundary:${this.props.scope}] React subtree crashed:`,
      // Error objects serialize to {} across the preload logging bridge;
      // local boundaries must preserve message/stack to diagnose UI update loops.
      serializeErrorForLog(normalizedError),
      errorInfo.componentStack,
    );
    this.props.onCaughtReactError?.(normalizedError, errorInfo, this.props.scope);
    // Like the root boundary, scoped rendering errors do not bubble up to RUM. Report them by scope
    // so local crashes in sidebar/chat/terminal/settings are visible and diagnosable in RUM.
    reportReactErrorToArms({
      error: normalizedError,
      componentStack: errorInfo.componentStack ?? "",
      scope: this.props.scope,
    });
    this.setState({ componentStack: errorInfo.componentStack ?? "" });
  }

  override componentDidUpdate(previousProps: ScopedErrorBoundaryProps) {
    if (this.state.error && haveResetKeysChanged(previousProps.resetKeys, this.props.resetKeys)) {
      // If a local fallback is not cleared when the workspace/task/tab changes,
      // users still see the old error after leaving and returning to the affected area. Reset the boundary when resetKeys change
      // so the new isolated context can render again.
      this.setState({
        error: null,
        componentStack: "",
      });
    }
  }

  private handleReset = () => {
    this.setState({
      error: null,
      componentStack: "",
    });
    this.props.onReset?.();
  };

  private handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  override render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <ScopedErrorFallback
        error={this.state.error}
        componentStack={this.state.componentStack}
        onReset={this.handleReset}
        onReload={this.handleReload}
        variant={this.props.variant}
        className={this.props.className}
      />
    );
  }
}
