import type { CodingPlanStatus } from "./constants.js";

export interface CodingPlanStatusPanelViewState {
  displayStatus: CodingPlanStatus;
  actionStatus: CodingPlanStatus;
  balanceStatus: CodingPlanStatus;
  loginLoading: boolean;
}

export function resolveCodingPlanStatusPanelViewState({
  status,
  loginPending,
}: {
  status: CodingPlanStatus;
  loginPending: boolean;
}): CodingPlanStatusPanelViewState {
  if (!loginPending) {
    return buildStableCodingPlanStatusPanelViewState(status, false);
  }

  if (status === "purchased" || status === "notPurchased") {
    // Both states come from a resolved entitlement snapshot. During background refresh, keep showing
    // the cached result and only retain the loading indicator so details do not flicker between old data and checking.
    return buildStableCodingPlanStatusPanelViewState(status, true);
  }

  return {
    // Login pending and entitlement-query checking have different meanings.
    // The login status copy should reflect checking, but the button must keep its pre-click state and show a spinner;
    // the Start Plan balance card must not appear early during login pending.
    displayStatus: "checking",
    actionStatus: status,
    balanceStatus: status,
    loginLoading: true,
  };
}

function buildStableCodingPlanStatusPanelViewState(
  status: CodingPlanStatus,
  loginLoading: boolean,
): CodingPlanStatusPanelViewState {
  return {
    displayStatus: status,
    actionStatus: status,
    balanceStatus: status,
    loginLoading,
  };
}
