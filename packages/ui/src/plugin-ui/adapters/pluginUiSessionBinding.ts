import type {
  PluginUiSessionScope,
  PluginUiSessionActions,
  PluginUiSessionCommandPort,
} from "@/plugin-ui/contract.js";
import { buildPluginUiImageFileName } from "../domain/pluginUiImageBlocks.js";

/** Session actions translate to a uniform ACK; state and send configuration stay owned by the original session entry. */
export function createPluginUiSessionActions(
  _scope: PluginUiSessionScope,
  port: PluginUiSessionCommandPort,
): PluginUiSessionActions {
  return {
    async sendFollowUp({ prompt, source, images }) {
      // S3: upload images first to get refs (same path as pasting screenshots); if an upload fails, send nothing.
      const attachments = [];
      for (const [index, image] of (images ?? []).entries()) {
        attachments.push(
          await port.uploadAttachment({
            fileName: buildPluginUiImageFileName(
              source.kind === "pluginUi" ? source.pluginId : "gen-ui",
              index,
              image.mimeType,
            ),
            mime: image.mimeType,
            dataBase64: image.dataBase64,
          }),
        );
      }
      const result = await port.sendText(prompt, {
        source,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      // Fix: the original send entry returns undefined after a normal ACK; a sent message must not be misreported as failed.
      if (result === "blocked" || result === "confirmationRequired")
        throw new Error("Session is not ready to accept input");
    },
  };
}
