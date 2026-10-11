import type { PrintPageToPdfResult } from "@zcode/shared";
import { PlatformChannels } from "@zcode/shared";
import { ipcMain } from "electron";

/** Serialize print requests for the same webContents to prevent duplicate Chromium print-pipeline invocations. */
const inFlightSenderIds = new Set<number>();

export function registerDesktopPrintToPdfIpcHandler(logger: {
  warn: (...args: unknown[]) => void;
}) {
  ipcMain.handle(PlatformChannels.PrintToPdf, async (event): Promise<PrintPageToPdfResult> => {
    const senderId = event.sender.id;
    if (inFlightSenderIds.has(senderId)) {
      return { success: false, error: "print_in_progress" };
    }
    inFlightSenderIds.add(senderId);
    try {
      const buffer = await event.sender.printToPDF({
        printBackground: true,
        // Page dimensions are determined entirely by @page CSS injected by the renderer; main does not accept renderer parameters.
        preferCSSPageSize: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });
      // Buffer may be a pooled view; copy it into an independent ArrayBuffer before structured cloning.
      const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      return { success: true, data };
    } catch (error) {
      logger.warn(
        `[print-to-pdf] 导出失败 error=${error instanceof Error ? error.message : String(error)}`,
      );
      return { success: false, error: "print_failed" };
    } finally {
      inFlightSenderIds.delete(senderId);
    }
  });
}
