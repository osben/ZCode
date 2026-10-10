import type { TaskChatMessage as ChatMessage } from "@/lib/taskChatMessageTypes.js";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import type { IZCodeAgentService } from "@zcode/services";
import type { Locale } from "@zcode/shared";
import type { TaskListE2EActions } from "@/lib/taskListE2EActions.js";
import type { Theme } from "@/useTheme.js";
import { useEffect } from "react";

// Type declaration for import.meta.env injected by Vite
declare global {
  interface ImportMeta {
    env: { PROD: boolean; DEV: boolean; [key: string]: unknown };
  }
}

/**
 * Set of actions that E2E tests can call through window.__testActions.
 * Register only outside production to avoid exposing these actions in production.
 */
export interface TestActions extends TaskListE2EActions {
  /** Get the current theme */
  getTheme: () => string;
  /** Set the theme */
  setTheme: (theme: Theme) => void;
  /** Get the current language, only for cross-language display E2E tests */
  getLocale: () => Locale;
  /** Set the current language, only for cross-language display E2E tests */
  setLocale: (locale: Locale) => void;
  /** Inject mock messages for chat display */
  setChatMessages: (messages: ChatMessage[]) => void;
  /** Get the current number of mock messages */
  getChatMessageCount: () => number;
  /** E2E fetches the plugin overview through the real zcodeAgentService */
  getPluginsOverview: IZCodeAgentService["getPluginsOverview"];
  /** E2E adds a marketplace through the real zcodeAgentService */
  addPluginMarketplace: IZCodeAgentService["addPluginMarketplace"];
  /** E2E refreshes a marketplace through the real zcodeAgentService */
  updatePluginMarketplace: IZCodeAgentService["updatePluginMarketplace"];
  /** E2E installs a marketplace plugin through the real zcodeAgentService */
  installPlugin: IZCodeAgentService["installPlugin"];
  /** E2E triggers plugin discovery through the real zcodeAgentService */
  listPlugins: IZCodeAgentService["listPlugins"];
  /** E2E queries the Workspace/Session Plugin catalog through the real zcodeAgentService */
  getPluginReferenceCatalog: IZCodeAgentService["getPluginReferenceCatalog"];
}

declare global {
  interface Window {
    __testActions?: TestActions;
  }
}

/**
 * Register test actions on window.__testActions.
 * Skip registration only when import.meta.env.PROD is true (Vite environment).
 */
export function useTestActions(actions: TestActions) {
  useEffect(() => {
    // The E2E production renderer also needs the service entry; open it only with the dedicated bridge switch so it is not exposed in regular production builds.
    if (import.meta.env.PROD && !shouldExposeE2EStoreBridge()) return;
    window.__testActions = actions;
    return () => {
      actions.releaseTaskMembershipRefreshHold();
      delete window.__testActions;
    };
  }, [actions]);
}
