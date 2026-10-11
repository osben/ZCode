import type { BrowserViewCloseTabNotification } from "@zcode/shared";
import type { BrowserGuestExecutionContext } from "./browserGuestManager.js";

/** Build the owner-scope subset needed for a main→renderer close notification; the renderer does not need the rest of the execution context. */
export type BrowserCloseTabNotificationOwner = Pick<
  BrowserGuestExecutionContext,
  "workspaceKey" | "sessionId" | "remoteSessionId"
>;

/**
 * Convert a main-side tab owner into a close notification that the renderer can route.
 *
 * The old payload contained only tabId, so the renderer could search only the side-pane state for
 * the currently active workspace. If the user had switched workspaces, the notification was silently
 * dropped, leaving a ghost tab in the original workspace's persistent state. Including owner scope
 * lets the renderer locate the right workspace side pane and remove the tab from memory.
 *
 * Keep this as a pure function so unit tests can cover field mapping. If it lived inline in the
 * manager-construction callback in `index.ts`, the Electron entry point would not be unit-tested and
 * `closeTabFromRenderer` would bypass it with `notifyRenderer=false`, leaving the Agent close-notification
 * payload without test coverage.
 *
 * owner may be omitted: internal paths such as recovery-orphan have only tabId, so the renderer then
 * falls back to the "current workspace only" behavior.
 */
export function buildBrowserViewCloseTabNotification(
  tabId: string,
  owner?: BrowserCloseTabNotificationOwner,
): BrowserViewCloseTabNotification {
  if (!owner) return { tabId };
  return {
    tabId,
    workspaceKey: owner.workspaceKey,
    sessionId: owner.sessionId,
    // Only remote workspaces have remoteSessionId. For local workspaces, omit the field instead of
    // setting it to undefined, because the renderer distinguishes scope by whether
    // `payload.remoteSessionId` exists.
    ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
  };
}
