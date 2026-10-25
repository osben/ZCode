import type { AccountProviderUnavailableReason } from "@zcode/shared/account-provider-state";

/**
 * Why the account is unavailable; answers only "why is it unavailable?"
 *
 * After the provider refactor, the UI could see only availability=unavailable + entitled=false,
 * flattening "not logged in," "not connected," "credential retrieval/validation failed," and "server explicitly reports no plan entitlement" into one state.
 * As a result, a logged-in user without a plan appeared as "not connected." Include the reason in State so the UI does not need
 * a second request to infer it (unavailable providers do not run entitlement queries again).
 */
export type { AccountProviderUnavailableReason } from "@zcode/shared/account-provider-state";

/**
 * Live account facts, not a config Overlay, and not written to user settings.
 * current means it matches the current account access context: Start may be true alongside the current paid plan; Off-Peak does not define this field.
 */
export interface AccountProviderState {
  readonly availability: "available" | "pending" | "unavailable" | "unknown";
  readonly entitled: boolean;
  /** Meaningful only when availability === "unavailable"; unknown means the reason could not be determined this run. */
  readonly unavailableReason?: AccountProviderUnavailableReason;
  readonly current?: boolean;
  /** Account/connection identity for this snapshot, used only to isolate state changes; not persisted and contains no credentials. */
  readonly connectionKey?: string;
  /** Unix seconds; same unit as billing effective_at. */
  readonly effectiveAt?: number;
}

export type AccountProviderStates = Readonly<Record<string, AccountProviderState>>;
