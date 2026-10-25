/** Compatibility facade; process ownership is shared by stdio and ACP runtimes. */
export {
  filterCurrentProcessIdentities,
  captureProcessTreeSnapshot,
  captureProcessGroupSnapshot,
  captureExitedRootDescendantsSnapshot,
} from "@zcode/shared/node";
