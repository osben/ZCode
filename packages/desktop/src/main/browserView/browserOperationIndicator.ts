interface BrowserOperationResultLike {
  ok?: unknown;
  meta?: unknown;
  tab?: unknown;
}

/**
 * Only commands that explicitly open, show, activate, or change the viewport may rebuild the renderer size baseline.
 * Ordinary navigate/locator/screenshot commands must return false; otherwise they can swallow a real user resize in the same operation cycle.
 */
export function browserOperationResetsResizeBaseline(command: unknown): boolean {
  if (!command || typeof command !== "object") return false;
  const method = Reflect.get(command, "method");
  if (method === "browserVisibilitySet") return Reflect.get(command, "visible") === true;
  return ["activateTab", "browserViewportReset", "browserViewportSet", "newTab"].includes(
    String(method),
  );
}

function readTabId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const tabId = Reflect.get(value, "tabId");
  return typeof tabId === "string" && tabId.length > 0 ? tabId : undefined;
}

/**
 * At browser-command start, prefer an explicit tabId. For new/default-tab calls without one,
 * read the manager-resolved tab identity from the successful result; the UI must not guess it.
 */
export function resolveBrowserOperationTabId(
  command: unknown,
  result?: BrowserOperationResultLike,
): string | undefined {
  const requestedTabId = readTabId(command);
  if (requestedTabId) return requestedTabId;
  if (result?.ok !== true) return undefined;
  return readTabId(result.meta) ?? readTabId(result.tab);
}
