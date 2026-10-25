/** Compatibility facade; process ownership is shared by stdio and ACP runtimes. */
export {
  verifyWindowsProcessIdentityAsync,
  filterCurrentProcessIdentitiesAsync,
  captureProcessTreeSnapshotAsync,
  captureExitedRootDescendantsSnapshotAsync,
} from "@zcode/shared/node";
