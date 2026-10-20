import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getModelProviderFamilySpec,
  type CodingPlanStaticTeamProduct,
  type EnterpriseCodingPlanPricingResponse,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { logger } from "@/logger.js";
import {
  resolveEnterpriseCodingPlanProductList,
  type EnterpriseCodingPlanProductDisplay,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import { normalizeErrorMessage } from "@/settings/model-provider-section/useCodingPlanProducts.js";

interface EnterpriseCodingPlanProductsState {
  snapshot: EnterpriseCodingPlanProductsSnapshot | null;
  loading: boolean;
  error: string | null;
}

export interface EnterpriseCodingPlanProductsSnapshot {
  productList: EnterpriseCodingPlanProductDisplay[];
  raw: EnterpriseCodingPlanPricingResponse;
  authenticated: boolean;
  /** The static catalog controls the purchase banner; do not use live pricing to fabricate products missing from the catalog. */
  staticProductIds?: string[];
}

export function shouldRetainEnterprisePricingSnapshotForRefresh(
  snapshot: EnterpriseCodingPlanProductsSnapshot | null,
  authenticated: boolean,
): boolean {
  return snapshot?.authenticated === authenticated;
}

export function resolveEnterprisePricingFailureSnapshot({
  currentSnapshot,
  authenticated,
  staticProducts,
  family = "bigmodel",
}: {
  currentSnapshot: EnterpriseCodingPlanProductsSnapshot | null;
  authenticated: boolean;
  staticProducts: CodingPlanStaticTeamProduct[] | undefined;
  family?: ProviderFamilyDomain;
}): EnterpriseCodingPlanProductsSnapshot | null {
  if (shouldRetainEnterprisePricingSnapshotForRefresh(currentSnapshot, authenticated)) {
    return currentSnapshot;
  }
  if (!Array.isArray(staticProducts)) {
    return null;
  }
  const raw: EnterpriseCodingPlanPricingResponse = { productList: [] };
  return {
    raw,
    productList: tagEnterpriseProductsFamily(
      resolveEnterpriseCodingPlanProductList(staticProducts, raw.productList),
      family,
    ),
    authenticated,
  };
}

/** Tag enterprise-plan items with their family (zai / bigmodel). Downstream visibility functions (such as appendSubscribedTeamPlanItems) need the family to find the matching codingPlanItem and team-key prefix; the original list has no family field, so deriving only from bigmodelCodingPlan leaves Zai team plans unrenderable. */
function tagEnterpriseProductsFamily(
  products: EnterpriseCodingPlanProductDisplay[],
  family: ProviderFamilyDomain,
): EnterpriseCodingPlanProductDisplay[] {
  return products.map((product) => ({ ...product, family }));
}

/** The old hook served only the bigmodel family: getStaticTeamProducts hardcoded the bigmodelCodingPlan bucket, and getEnterprisePricing did not receive a family. After making the Zai family symmetrical, this hook accepts a family parameter:
 * - read the static bucket by family (zaiCodingPlan / bigmodelCodingPlan)
 * - pass family to service.getEnterprisePricing
 */
export function useEnterpriseCodingPlanProducts({
  enabled,
  authenticated,
  family = "bigmodel",
  staticOnly = false,
}: {
  enabled: boolean;
  /** For the unauthenticated purchase banner, read only the public static catalog; do not request live pricing. */
  staticOnly?: boolean;
  authenticated: boolean;
  family?: ProviderFamilyDomain;
}) {
  const services = useOptionalServices();
  const service = services?.codingPlanSubscriptionService;
  const authScope = useZCodeStoreWithDefault(
    (state) => (state.user ? state.user.id + ":" + state.authSessionSeq : "signed-out"),
    "unscoped",
  );
  // 原因：鉴权布尔值不能区分两个账号或同账号重新登录，旧目录必须按完整身份隔离。
  const scope = useMemo(() => ({}), [service, family, authenticated, authScope, staticOnly]);
  const owner = useRef({ scope, enabled, mounted: true });
  owner.current = { scope, enabled, mounted: true };
  const codingPlanProviderId = getModelProviderFamilySpec(family).individualCodingPlanProviderId;
  const [owned, setOwned] = useState<{ scope: object; state: EnterpriseCodingPlanProductsState }>({
    scope,
    state: {
      snapshot: null,
      loading: enabled,
      error: null,
    },
  });
  // 渲染时立即隔离，不能等 effect 清理，否则登出仍会暴露一帧旧组织。
  const state =
    owned.scope === scope ? owned.state : { snapshot: null, loading: enabled, error: null };
  const setState = useCallback(
    (
      next:
        | EnterpriseCodingPlanProductsState
        | ((state: EnterpriseCodingPlanProductsState) => EnterpriseCodingPlanProductsState),
    ) => {
      if (owner.current.scope !== scope || !owner.current.mounted) return;
      setOwned((previous) => ({
        scope,
        state:
          typeof next === "function"
            ? next(
                previous.scope === scope
                  ? previous.state
                  : { snapshot: null, loading: enabled, error: null },
              )
            : next,
      }));
    },
    [scope, enabled],
  );

  const refresh = useCallback(
    async (_options?: { force?: boolean }) => {
      if (!enabled) {
        setState((current) => ({
          snapshot: current.snapshot,
          loading: false,
          error: null,
        }));
        return;
      }
      if (!service) {
        setState({
          snapshot: null,
          loading: false,
          error: "service_unavailable",
        });
        return;
      }

      setState((current) => ({
        // Switching between enterprise/personal or refreshing authentication should not replace the plan area with a full loading screen;
        // retain the previous enterprise-plan data so refresh state appears only on the refresh button and individual cards.
        // But public-pricing and authenticated-pricing fields have different semantics; discard old data when the auth source changes,
        // or the Coding Plan upgrade list will keep showing unauthenticated plan results.
        snapshot: shouldRetainEnterprisePricingSnapshotForRefresh(current.snapshot, authenticated)
          ? current.snapshot
          : null,
        loading: true,
        error: null,
      }));

      try {
        // The static catalog is display configuration; pricing is authoritative for subscription identity and live prices.
        // Request them independently so a missing new config field in a rollout does not block recovery of an already-purchased Team Plan.
        const [staticResult, pricingResult] = await Promise.allSettled([
          service.getStaticTeamProducts(),
          staticOnly
            ? Promise.resolve<EnterpriseCodingPlanPricingResponse>({ productList: [] })
            : service.getEnterprisePricing({ authenticated, family }),
        ]);
        // 原因：登出、family 或服务切换后，旧网络响应不能复活上一个身份的目录。
        if (owner.current.scope !== scope || !owner.current.enabled || !owner.current.mounted)
          return;
        const staticProducts =
          staticResult.status === "fulfilled"
            ? Object.prototype.hasOwnProperty.call(staticResult.value, codingPlanProviderId)
              ? staticResult.value[codingPlanProviderId]
              : undefined
            : undefined;
        const raw: EnterpriseCodingPlanPricingResponse =
          pricingResult.status === "fulfilled" ? pricingResult.value : { productList: [] };
        const pricingError = pricingResult.status === "rejected" ? pricingResult.reason : null;
        if (pricingError) {
          const message = normalizeErrorMessage(pricingError);
          setState((current) => ({
            // A pricing refresh failure means live state is unknown; do not replace the previous valid subscription identity/prices
            // under the same auth state with the static catalog or an empty list. Show a static disabled card only on the first failure.
            snapshot: resolveEnterprisePricingFailureSnapshot({
              currentSnapshot: current.snapshot,
              authenticated,
              staticProducts,
              family,
            }),
            loading: false,
            error: message,
          }));
          if (!isRemoteWorkspaceDisconnectedError(pricingError)) {
            logger.warn("[useEnterpriseCodingPlanProducts] 读取企业实时定价失败", {
              authenticated,
              error: message,
            });
          }
          return;
        }
        setState({
          snapshot: {
            raw,
            staticProductIds: staticProducts?.map((product) => product.productId) ?? [],
            productList: tagEnterpriseProductsFamily(
              resolveEnterpriseCodingPlanProductList(staticProducts, raw.productList),
              family,
            ),
            authenticated,
          },
          loading: false,
          error: pricingError ? normalizeErrorMessage(pricingError) : null,
        });
        if (
          staticResult.status === "rejected" &&
          !isRemoteWorkspaceDisconnectedError(staticResult.reason)
        ) {
          logger.warn("[useEnterpriseCodingPlanProducts] 读取团队静态配置失败，回退实时 pricing", {
            authenticated,
            error: normalizeErrorMessage(staticResult.reason),
          });
        }
      } catch (error) {
        const message = normalizeErrorMessage(error);
        // The remote workspace shell may render briefly before its attachment is bound; errors from the disconnected proxy at this point are
        // an expected initialization wait and should not masquerade as a pricing failure. Keep warn for real RPC errors.
        if (!isRemoteWorkspaceDisconnectedError(error)) {
          logger.warn("[useEnterpriseCodingPlanProducts] 读取企业 Coding Plan 套餐失败", {
            authenticated,
            error: message,
          });
        }
        setState((current) => ({
          // If an enterprise pricing request fails and clears the snapshot directly,
          // the Team Plan page shows only “No programming plans available,” leaving users unable to distinguish an API failure from no products.
          // Keep the previous visible plans and explicitly throw the error to the UI, so a recoverable refresh failure does not masquerade as an empty list.
          snapshot: shouldRetainEnterprisePricingSnapshotForRefresh(current.snapshot, authenticated)
            ? current.snapshot
            : null,
          loading: false,
          error: message,
        }));
      }
    },
    [authenticated, codingPlanProviderId, enabled, family, service, staticOnly, scope, setState],
  );

  useEffect(() => {
    owner.current.mounted = true;
    void refresh();
    return () => {
      owner.current.mounted = false;
    };
  }, [refresh]);

  return useMemo(
    () => ({
      ...state,
      refresh,
    }),
    [refresh, state],
  );
}
