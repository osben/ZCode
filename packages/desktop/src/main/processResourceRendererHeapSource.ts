/**
 * Main-window renderer heap sample source (fourth registry entry).
 *
 * Every 60 seconds, the renderer reads `performance.memory` and sends it one-way to main through the
 * preload bridge as part of the same reading used for local diagnostic logs. Store the latest
 * reading here; the next 10-second tick adds it to the complete `renderer_main` role sample as
 * `heap_used_kb_mean` / `heap_used_kb_peak`.
 *
 * Collect heap only: main's `getAppMetrics()` is the sole source for renderer CPU and RSS.
 * Mixing 60-second readings into a 10-second series would distort `sample_count` and statistics.
 * Each reading contributes one heap sample and is cleared on delivery; do not reuse old values as current facts.
 *
 * Determine ownership only from the sending webContents: only the main window is `renderer_main`.
 * Discard samples from Resource Manager/about/DevTools/`<webview>` guests; they are classified as
 * `chromium_other` or `renderer_guest` and do not carry heap according to the role definition table.
 */

import { ipcMain } from "electron";
import { PlatformChannels, rendererHeapSampleSchema } from "@zcode/shared";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";
import { isMainApplicationWindowWebContents } from "./resourceManagerWindow.js";

/** Sender webContents ID → undelivered heap reading (KB). */
const pendingHeapUsedKb = new Map<number, number>();

/**
 * Main-side trust boundary: payloads come from the renderer and are validated against a `strict`
 * schema. Drop invalid messages (missing fields, wrong types, or extra fields such as paths) without throwing.
 */
function ingestRendererHeapSample(webContentsId: number, raw: unknown): void {
  if (!isMainApplicationWindowWebContents(webContentsId)) {
    return;
  }
  const parsed = rendererHeapSampleSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  pendingHeapUsedKb.set(webContentsId, parsed.data.heapUsedKb);
}

/** Main-side endpoint for the preload bridge: listen only for one-way send; do not expose invoke. */
export function registerRendererHeapSampleIpc(): void {
  // Allow only one listener on this channel; repeated registration must not duplicate sample ingestion.
  ipcMain.removeAllListeners(PlatformChannels.ReportRendererHeapSample);
  ipcMain.on(PlatformChannels.ReportRendererHeapSample, (event, payload: unknown) => {
    ingestRendererHeapSample(event.sender.id, payload);
  });
}

export const rendererHeapProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "renderer_heap",
  sample(context) {
    // Remove the reading before delivery so an error cannot leave an old value for the next tick.
    const arrivedHeapUsedKb = [...pendingHeapUsedKb.values()];
    pendingHeapUsedKb.clear();
    if (arrivedHeapUsedKb.length === 0) {
      return;
    }
    /**
     * With multiple windows, take the maximum among readings received in this tick. This is not the
     * RSS "maximum across all processes in the same tick": each window's 60-second timer has its own
     * phase, so a 10-second tick usually receives readings from only some windows. Therefore
     * `heap_used_kb_peak` is the maximum per window and `heap_used_kb_mean` is the mixed average of
     * readings across windows. Heap is an additional 60-second dimension; do not retain old readings
     * (the other side of clearing them on delivery).
     */
    context.addRoleHeapSample("renderer_main", Math.max(...arrivedHeapUsedKb));
  },
  reset() {
    pendingHeapUsedKb.clear();
  },
};
