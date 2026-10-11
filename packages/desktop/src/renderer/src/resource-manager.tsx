import { createRoot } from "react-dom/client";
import type {
  NetworkCaptureBridge,
  ResourceUsageSnapshot,
  StorageManagementBridge,
} from "@zcode/shared";
import "@zcode/ui/styles.css";
import {
  applyTheme,
  migrateThemeSelection,
  THEME_PALETTE_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "@zcode/ui/useTheme";
import {
  ResourceManagerApp,
  ZCodeIntlProvider,
  applyUiFontSizePx,
  loadUiFontSizePx,
  subscribeToUiFontSizeStorageChanges,
} from "@zcode/ui";

declare global {
  interface Window {
    resourceManager?: {
      getSnapshot: () => Promise<ResourceUsageSnapshot>;
      setSamplingActive: (active: boolean) => void;
      storage?: StorageManagementBridge;
      network?: NetworkCaptureBridge;
    };
  }
}

const savedTheme = migrateThemeSelection(
  localStorage.getItem(THEME_STORAGE_KEY),
  localStorage.getItem(THEME_PALETTE_STORAGE_KEY),
);
applyTheme(savedTheme.mode, savedTheme.palette);

// The resource manager does not create the main window's Zustand store, so text-ui-* cannot automatically
// get the persisted baseline. Apply it explicitly before the first screen and sync through storage events
// afterward, without changing html font-size or connecting to the business Host.
applyUiFontSizePx(loadUiFontSizePx());
subscribeToUiFontSizeStorageChanges();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    // Reuse the language preference written to localStorage by the main window. Do not connect to
    // settingService and create another RPC for this independent window.
    <ZCodeIntlProvider>
      <ResourceManagerApp
        setSamplingActive={window.resourceManager?.setSamplingActive}
        getSnapshot={
          window.resourceManager ? () => window.resourceManager!.getSnapshot() : undefined
        }
        storage={window.resourceManager?.storage}
        network={window.resourceManager?.network}
      />
    </ZCodeIntlProvider>,
  );
}
