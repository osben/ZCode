import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { useSkillStore } from "@/store/skillStore.js";
import { useSubagentsStore } from "@/store/subagentsStore.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

declare global {
  interface Window {
    __skillStoreE2E?: typeof useSkillStore;
    __subagentsStoreE2E?: typeof useSubagentsStore;
    __whiteboardStoreE2E?: typeof useWhiteboardStore;
    __zcodeSessionStoreE2E?: typeof useZCodeSessionStore;
  }
}

export function registerE2EStoreBridges() {
  if (!shouldExposeE2EStoreBridge()) {
    return;
  }

  // Some E2E tests start from settings, error pages, or special routes that may not naturally import
  // the corresponding store module. Register it explicitly in the renderer bootstrap to keep preflight and test injection reliable.
  window.__zcodeSessionStoreE2E = useZCodeSessionStore;
  window.__skillStoreE2E = useSkillStore;
  window.__subagentsStoreE2E = useSubagentsStore;
  window.__whiteboardStoreE2E = useWhiteboardStore;
}
