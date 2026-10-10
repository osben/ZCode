/* eslint-disable max-lines -- The entitlement hook centralizes caching, shared in-flight requests, polling, and Team Plan context; any future split must preserve the refresh strategy. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  UsageEntitlementSnapshot,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@zcode/shared";
import type { IUsageStatsService } from "@zcode/services";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useStableAccountAccess } from "@/hooks/useStableAccountAccess.js";
import { logger } from "@/logger.js";
import {
  readCachedUsageEntitlementSnapshot,
  writeCachedUsageEntitlementSnapshot,
} from "@/lib/usageEntitlementCache.js";
import {
  hasSharedEntitlementFailure,
  buildEntitlementFreshnessKey,
  beginSharedEntitlementRequest,
  publishSharedEntitlementSnapshot,
  readSharedEntitlementSnapshot,
  recordSharedEntitlementAccess,
  recordSharedEntitlementFailure,
  shouldDeferSharedEntitlementRefresh,
  shouldDeferSharedEntitlementAccess,
  shouldUseSharedEntitlementSnapshot,
  subscribeSharedEntitlementSnapshot,
  USAGE_ENTITLEMENT_ACCESS_REFRESH_MS,
  type UsageEntitlementRefreshReason,
  type UsageEntitlementRequestOptions,
} from "@/lib/usageEntitlementRefreshPolicy.js";

interface UsageEntitlementState {
  snapshot: UsageEntitlementSnapshot | null;
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: UsageEntitlementState = {
  snapshot: null,
  loading: false,
  error: null,
};

const USAGE_ENTITLEMENT_REFRESH_TIMEOUT_MS = 20_000;

export interface UsageEntitlementRefreshOptions {
  silent?: boolean;
  force?: boolean;
  reason?: UsageEntitlementRefreshReason;
}

const entitlementInflightRequests = new WeakMap<
  IUsageStatsService,
  Map<string, Promise<UsageEntitlementSnapshot>>
>();

function getSharedEntitlementSnapshot(params: {
  usageStatsService: IUsageStatsService;
  options: UsageEntitlementRequestOptions;
  requestKey: string;
}): Promise<UsageEntitlementSnapshot> {
  let serviceRequests = entitlementInflightRequests.get(params.usageStatsService);
  if (!serviceRequests) {
    serviceRequests = new Map();
    entitlementInflightRequests.set(params.usageStatsService, serviceRequests);
  }

  const requestKey = params.requestKey;
  const inflight = serviceRequests.get(requestKey);
  if (inflight) {
    return inflight;
  }

  // The sidebar, toolbar, Settings, and Usage page can all read the same Coding Plan entitlement
  // during startup or when Settings opens. Production logs showed 12 identical quota RPCs in one
  // minute, directly slowing the renderer. Merge in-flight requests by service instance and request
  // parameters while preserving each component's own state update semantics.
  const upstreamRequest = params.usageStatsService.getEntitlementSnapshot({
    ...(params.options.invalidateBalanceCache ? { invalidateBalanceCache: true } : {}),
    includeSubscription: params.options.includeSubscription,
    preferredProviderId: params.options.preferredProviderId,
    accountAccess: params.options.accountAccess,
    allowDisabledPreferredProvider: params.options.allowDisabledPreferredProvider,
    requirePreferredProvider: params.options.requirePreferredProvider,
    allowEnvApiKey: params.options.allowEnvApiKey,
  });
  const request = withUsageEntitlementTimeout(upstreamRequest).finally(() => {
    if (serviceRequests.get(requestKey) !== request) {
      return;
    }
    serviceRequests.delete(requestKey);
    if (serviceRequests.size === 0) {
      entitlementInflightRequests.delete(params.usageStatsService);
    }
  });
  serviceRequests.set(requestKey, request);
  return request;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return String(error);
}

function createUsageEntitlementTimeoutError(timeoutMs: number): Error {
  return new Error(`usage_entitlement_request_timeout:${timeoutMs}`);
}

function withUsageEntitlementTimeout<T>(
  request: Promise<T>,
  timeoutMs = USAGE_ENTITLEMENT_REFRESH_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(createUsageEntitlementTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([request, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

export interface UseUsageEntitlementOptions {
  enabled?: boolean;
  includeSubscription?: boolean;
  preferredProviderId?: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  allowDisabledPreferredProvider?: boolean;
  requirePreferredProvider?: boolean;
  allowEnvApiKey?: boolean;
  cacheKey?: string;
  refreshOnMount?: boolean;
  mountRefreshReason?: "initial" | "access";
}

export function useUsageEntitlement(options: UseUsageEntitlementOptions = {}) {
  const services = useOptionalBaseWorkspaceServices();
  return useUsageEntitlementWithService(services?.usageStatsService, options);
}

export function useUsageEntitlementWithService(
  usageStatsService: IUsageStatsService | undefined,
  options: UseUsageEntitlementOptions = {},
) {
  const [state, setState] = useState<UsageEntitlementState>(INITIAL_STATE);
  const requestVersionRef = useRef(0);
  const activeFreshnessKeyRef = useRef<string | null>(null);
  const latestSnapshotRef = useRef<UsageEntitlementSnapshot | null>(null);
  // Web/SSR may render only the sidebar or Settings entry without mounting ServiceProvider.
  // Fall back to an empty snapshot so a missing service context does not block the entire UI through
  // the Usage banner.
  const enabled = (options.enabled ?? true) && Boolean(usageStatsService);
  const includeSubscription = options.includeSubscription ?? false;
  const preferredProviderId = options.preferredProviderId;
  // Parsing the Provider Settings schema creates an equivalent new object each time;
  // do not restart the entitlement request when only its reference changes.
  const accountAccess = useStableAccountAccess(options.accountAccess);
  const allowDisabledPreferredProvider = options.allowDisabledPreferredProvider === true;
  const requirePreferredProvider = options.requirePreferredProvider === true;
  const allowEnvApiKey = options.allowEnvApiKey;
  const cacheKey = options.cacheKey?.trim() ?? "";
  const refreshOnMount = options.refreshOnMount ?? false;
  const mountRefreshReason = options.mountRefreshReason ?? "initial";
  const requestOptions = useMemo(
    () =>
      ({
        includeSubscription,
        preferredProviderId,
        accountAccess,
        allowDisabledPreferredProvider,
        requirePreferredProvider,
        allowEnvApiKey,
      }) satisfies UsageEntitlementRequestOptions,
    [
      allowDisabledPreferredProvider,
      accountAccess,
      allowEnvApiKey,
      includeSubscription,
      preferredProviderId,
      requirePreferredProvider,
    ],
  );
  const freshnessKey = useMemo(
    () =>
      buildEntitlementFreshnessKey({
        cacheKey,
        options: requestOptions,
      }),
    [cacheKey, requestOptions],
  );

  const refresh = useCallback(
    async (refreshOptions: UsageEntitlementRefreshOptions = {}) => {
      if (!enabled || !usageStatsService) {
        return;
      }
      const reason = refreshOptions.reason ?? "manual";
      const sharedSnapshot =
        refreshOptions.force === true
          ? null
          : reason === "initial"
            ? shouldUseSharedEntitlementSnapshot({
                freshnessKey,
                intervalMs: Number.POSITIVE_INFINITY,
                now: Date.now(),
                usageStatsService,
              })
            : reason === "access"
              ? shouldUseSharedEntitlementSnapshot({
                  freshnessKey,
                  // Context hover, the plan card, and opening the Usage page can read the same quota
                  // within a short period. Access refreshes must share a one-minute window so repeated
                  // hovers do not multiply quota RPCs.
                  intervalMs: USAGE_ENTITLEMENT_ACCESS_REFRESH_MS,
                  now: Date.now(),
                  usageStatsService,
                })
              : null;
      if (sharedSnapshot) {
        setState({
          snapshot: sharedSnapshot,
          loading: false,
          error: null,
        });
        latestSnapshotRef.current = sharedSnapshot;
        return;
      }
      if (
        refreshOptions.force !== true &&
        reason === "access" &&
        shouldDeferSharedEntitlementAccess({
          freshnessKey,
          now: Date.now(),
          usageStatsService,
        })
      ) {
        setState((current) => ({ ...current, loading: false }));
        return;
      }
      if (
        refreshOptions.force !== true &&
        (reason === "initial" || reason === "access") &&
        shouldDeferSharedEntitlementRefresh({
          freshnessKey,
          now: Date.now(),
          usageStatsService,
        })
      ) {
        setState((current) => ({
          ...current,
          loading: false,
        }));
        return;
      }

      const sharedRequest = beginSharedEntitlementRequest({
        usageStatsService,
        freshnessKey,
        invalidate: reason === "purchase",
      });
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      if (reason === "access") {
        recordSharedEntitlementAccess({
          freshnessKey,
          now: Date.now(),
          usageStatsService,
        });
      }
      logger.debug("[useUsageEntitlement] 开始读取权益信息", {
        reason,
        includeSubscription,
        preferredProviderId,
        accountAccess,
        cacheKey,
        freshnessKey,
      });
      setState((current) => ({
        snapshot: current.snapshot,
        // When the Plan Card has a short-TTL cache, entering the provider only needs a background
        // entitlement refresh. Setting loading to true would move the card from its cached state back
        // to checking, making every visit look like a reload.
        loading: refreshOptions.silent && current.snapshot ? false : true,
        error: null,
      }));

      try {
        const snapshot = await getSharedEntitlementSnapshot({
          usageStatsService,
          requestKey: sharedRequest.requestKey,
          options:
            reason === "purchase"
              ? { ...requestOptions, invalidateBalanceCache: true }
              : requestOptions,
        });
        if (requestVersionRef.current !== requestVersion || !sharedRequest.isCurrent()) {
          return;
        }
        publishSharedEntitlementSnapshot({
          usageStatsService,
          freshnessKey,
          snapshot,
        });
        logger.debug("[useUsageEntitlement] 权益信息已更新", {
          reason,
          providerId: snapshot.provider?.id ?? null,
          scope: snapshot.context?.scope ?? null,
          organizationId: snapshot.context?.organizationId ?? null,
          projectId: snapshot.context?.projectId ?? null,
          cacheKey,
          freshnessKey,
        });
        latestSnapshotRef.current = snapshot;
        setState({
          snapshot,
          loading: false,
          error: null,
        });
        writeCachedUsageEntitlementSnapshot({ cacheKey, snapshot });
      } catch (error) {
        if (requestVersionRef.current !== requestVersion || !sharedRequest.isCurrent()) {
          return;
        }
        recordSharedEntitlementFailure({
          usageStatsService,
          freshnessKey,
        });
        const message = getErrorMessage(error);
        logger.warn("[useUsageEntitlement] 读取权益信息失败", {
          includeSubscription,
          error: message,
        });
        if (
          !latestSnapshotRef.current?.subscription?.details.length &&
          !(refreshOptions.silent && latestSnapshotRef.current)
        ) {
          latestSnapshotRef.current = null;
        }
        setState((current) => {
          if (
            current.snapshot &&
            (refreshOptions.silent || current.snapshot.subscription?.details.length)
          ) {
            return {
              // Preserve the last successful result if a background refresh or a manual refresh for
              // a confirmed subscription fails. Otherwise, network instability would move the Plan
              // Card from an available state to empty/error.
              snapshot: current.snapshot,
              loading: false,
              error: message,
            };
          }
          return {
            // If a query fails after switching between BigModel and Z.AI, keeping the old snapshot
            // would make the banner/popover show the previous provider. Clear the snapshot on error
            // to avoid displaying stale branding and quota.
            snapshot: null,
            loading: false,
            error: message,
          };
        });
      }
    },
    [cacheKey, enabled, freshnessKey, requestOptions, usageStatsService],
  );

  useEffect(() => {
    if (!enabled || !usageStatsService) {
      return;
    }
    return subscribeSharedEntitlementSnapshot({
      usageStatsService,
      freshnessKey,
      listener: (snapshot, error) => {
        latestSnapshotRef.current = snapshot;
        setState({
          snapshot,
          loading: false,
          error: error ?? null,
        });
      },
    });
  }, [enabled, freshnessKey, usageStatsService]);

  useEffect(() => {
    if (!enabled) {
      setState({
        // Queries are temporarily disabled when Coding Plan has no API Key or while switching providers.
        // Keeping the previous snapshot would make the UI show the old account's plan status and could
        // make an entry without a key appear queryable.
        snapshot: null,
        loading: false,
        error: null,
      });
      activeFreshnessKeyRef.current = null;
      latestSnapshotRef.current = null;
      return;
    }

    const freshnessKeyChanged = activeFreshnessKeyRef.current !== freshnessKey;
    if (freshnessKeyChanged) {
      // After switching Team Plan projects, the previous team's active snapshot can cause the initial
      // refresh to be skipped by the freshness policy, leaving Settings showing that team's usage.
      // When the freshness key changes, invalidate the old request and snapshot first, then start
      // the refresh from the new team's cache/shared snapshot.
      requestVersionRef.current += 1;
      activeFreshnessKeyRef.current = freshnessKey;
      latestSnapshotRef.current = null;
      setState(INITIAL_STATE);
    }

    const cachedSnapshot = readCachedUsageEntitlementSnapshot({ cacheKey });
    const sharedSnapshot = usageStatsService
      ? readSharedEntitlementSnapshot({ usageStatsService, freshnessKey })
      : null;
    const initialSnapshot = sharedSnapshot ?? cachedSnapshot;
    if (initialSnapshot) {
      // When opening Settings, Coding Plan status does not need to wait for the quota API to return
      // before showing as active. First display the short-TTL cache for the same provider fingerprint,
      // then let refresh correct the actual entitlement in the background.
      setState({
        snapshot: initialSnapshot,
        loading: false,
        error:
          usageStatsService && hasSharedEntitlementFailure({ usageStatsService, freshnessKey })
            ? "usage_entitlement_refresh_failed"
            : null,
      });
      latestSnapshotRef.current = initialSnapshot;
    }

    if (refreshOnMount) {
      void refresh({
        silent: Boolean(initialSnapshot),
        force: mountRefreshReason === "initial" && !initialSnapshot,
        reason: mountRefreshReason,
      });
    }
  }, [
    cacheKey,
    enabled,
    freshnessKey,
    refresh,
    refreshOnMount,
    mountRefreshReason,
    usageStatsService,
  ]);

  return {
    snapshot: state.snapshot,
    loading: state.loading,
    error: state.error,
    refresh,
  };
}
