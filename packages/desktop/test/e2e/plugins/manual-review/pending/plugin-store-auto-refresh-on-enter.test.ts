import { clearAppData, clickTestIdByDom } from "../../../helpers/desktop-app.js";
import { TID_SETTINGS_BACK_BUTTON } from "@zcode/shared";
import {
  PLUGIN_CDN_ZIP_MARKETPLACE_ID,
  PLUGIN_STORE_AUTO_REFRESH_STALE_LAST_UPDATED,
} from "../../../helpers/plugin-cdn-zip-marketplace.js";
import {
  capturePluginManualReview,
  getPluginOverview,
  hasPluginControl,
  openPluginSettings,
  requirePluginManualReview,
  waitForPluginControl,
  waitForPluginSettingsScope,
} from "../../../helpers/plugin-management-lifecycle.js";

// Hits the real public CDN: same as PLM-LC-007b, refresh wait is 180s.
// How to run (verified locally on 2026-09-08):
//   ZCODE_E2E_MANUAL_REVIEW=1 ZCODE_E2E_MANUAL_REVIEW_HOLD_MS=180000 \
//   E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json \
//   pnpm --filter @zcode/desktop test:e2e:serial -- --spec <this file>
// - manual-review's default capture mode attaches an MITM packet-capture proxy to the agent; the agent's marketplace fetch does not trust its CA,
//   so the official marketplace refresh fails with "unable to get local issuer certificate"; an explicit replay fixture restores direct connections for the worker.
// - The wdio mocha timeout is a config-level 120s hard cap; this.timeout inside the case has no effect, so extra budget must come from HOLD_MS.
const CDN_REFRESH_TIMEOUT_MS = 180000;
const NO_REFRESH_SETTLE_MS = 5000;

function readOfficialLastUpdated(
  overview: Awaited<ReturnType<typeof getPluginOverview>>,
): string | undefined {
  return overview.marketplaces.find((item) => item.id === PLUGIN_CDN_ZIP_MARKETPLACE_ID)
    ?.lastUpdated;
}

describe("PLM-LC-019 Desktop plugin store auto refresh on enter (real official CDN)", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("官方市场刷新时间过期时，进入商店页不点刷新也会自动刷新，重进则命中节流", async function () {
    requirePluginManualReview();

    // The wdio seed writes the official marketplace lastUpdated as an ancient time with pluginCount>0, necessarily outside the throttle window.
    expect(readOfficialLastUpdated(await getPluginOverview())).toBe(
      PLUGIN_STORE_AUTO_REFRESH_STALE_LAST_UPDATED,
    );
    const enteredAt = Date.now();

    await openPluginSettings();
    let refreshedLastUpdated: string | undefined;
    let official: Awaited<ReturnType<typeof getPluginOverview>>["marketplaces"][number] | undefined;
    await browser
      .waitUntil(
        async () => {
          official = (await getPluginOverview()).marketplaces.find(
            (item) => item.id === PLUGIN_CDN_ZIP_MARKETPLACE_ID,
          );
          // A failed refresh is persisted as refreshFailure; fail directly with the diagnostic instead of idling until timeout.
          if (official?.refreshFailure) {
            throw new Error(
              `Official marketplace auto refresh failed: ${JSON.stringify(official.refreshFailure)}`,
            );
          }
          refreshedLastUpdated = official?.lastUpdated;
          return (
            refreshedLastUpdated !== undefined &&
            refreshedLastUpdated !== PLUGIN_STORE_AUTO_REFRESH_STALE_LAST_UPDATED
          );
        },
        {
          timeout: CDN_REFRESH_TIMEOUT_MS,
          interval: 2000,
          timeoutMsg: "Entering the plugin store did not auto refresh the official marketplace",
        },
      )
      .catch((error: unknown) => {
        // On timeout, carry the official marketplace record along too, making it easy to tell "never triggered" from "triggered but persistence failed".
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; official=${JSON.stringify(official)}`,
        );
      });
    if (!refreshedLastUpdated) throw new Error("Official marketplace lastUpdated missing");
    // Allow second-level clock skew between the agent/renderer.
    expect(Date.parse(refreshedLastUpdated)).toBeGreaterThanOrEqual(enteredAt - 60_000);
    expect(await hasPluginControl("plugin-store-error")).toBe(false);
    await capturePluginManualReview("PLM-LC-019", "auto-refreshed-on-enter");

    // Just refreshed: leaving and re-entering the store page hits the 10-minute window, so it does not refresh again.
    // The re-entry path matches conversation-session-plugin-marketplace-installed-roundtrip: back from the store top bar
    // to the settings page → exit settings → re-enter via the "Plugin Marketplace" sidebar item, ensuring PluginStorePage truly remounts.
    await clickTestIdByDom("desktop-top-nav-back");
    await waitForPluginSettingsScope("user");
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await clickTestIdByDom("plugin-store-sidebar-open");
    await waitForPluginControl("plugin-store-root", {}, 30000);
    await browser.pause(NO_REFRESH_SETTLE_MS);
    expect(readOfficialLastUpdated(await getPluginOverview())).toBe(refreshedLastUpdated);
  });
});
