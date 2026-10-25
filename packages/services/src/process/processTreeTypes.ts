/** Compatibility facade; process ownership is shared by stdio and ACP runtimes. */
export {
  type ProcessTreeTerminatorLogger,
  type WindowsTaskkillRequest,
  type WindowsTaskkillResult,
  type WindowsTaskkillRunner,
  type ProcessTreeTerminatorOptions,
  type ProcessIdentity,
  type ProcessTreeOwnershipResolution,
  type ProcessTreeTerminationResult,
  type ProcessTreeSnapshot,
  type ProcessTreeTerminatorWaitOptions,
} from "@zcode/shared/node";
