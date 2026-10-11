import type { AgentRuntimeInternal } from "./internal.js";

// Do not store another copy of permission/queue state; record only recovery work where the transaction committed but the event has not yet been published.
export const unpublishedPermissionGrants = new WeakMap<
  AgentRuntimeInternal,
  {
    interactionId: string;
    recover: () => Promise<string>;
  }
>();

export async function recoverPendingPermissionGrant(runtime: AgentRuntimeInternal): Promise<void> {
  await unpublishedPermissionGrants.get(runtime)?.recover();
}
