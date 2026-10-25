import { useEffect, useRef } from "react";
import type { PluginUiModelContext } from "../domain/pluginUiModelContext.js";
import { buildPluginUiImageFileName } from "../domain/pluginUiImageBlocks.js";

export interface PluginUiContextImagesPort {
  addAttachmentFiles(files: File[]): string[];
  removeAttachment(id: string): void;
}

function decodeBase64(dataBase64: string): ArrayBuffer {
  const binary = atob(dataBase64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

/**
 * Materializes image blocks from plugin contexts into composer image attachments (the same upload path
 * as pasting screenshots). Attachment ids per context are recorded here: when the same instance sends
 * updateModelContext again (same id, new object) or the user removes the context, the old attachments
 * are revoked with it. After sending, the composer itself cleans up attachments by frozen id; the
 * revocation here is a no-op for ids already cleaned up.
 */
export function usePluginUiContextImages(
  contexts: readonly PluginUiModelContext[],
  port: PluginUiContextImagesPort,
): void {
  const materialized = useRef(new Map<string, { context: PluginUiModelContext; ids: string[] }>());
  const portRef = useRef(port);
  portRef.current = port;
  useEffect(() => {
    const seen = new Set<string>();
    for (const context of contexts) {
      seen.add(context.id);
      const existing = materialized.current.get(context.id);
      if (existing?.context === context) continue;
      if (existing) {
        for (const id of existing.ids) portRef.current.removeAttachment(id);
        materialized.current.delete(context.id);
      }
      const images = context.images ?? [];
      if (images.length === 0) continue;
      const files = images.map(
        (image, index) =>
          new File(
            [decodeBase64(image.dataBase64)],
            buildPluginUiImageFileName(context.pluginId, index, image.mimeType),
            {
              type: image.mimeType,
            },
          ),
      );
      materialized.current.set(context.id, {
        context,
        ids: portRef.current.addAttachmentFiles(files),
      });
    }
    for (const [id, entry] of materialized.current) {
      if (seen.has(id)) continue;
      for (const attachmentId of entry.ids) portRef.current.removeAttachment(attachmentId);
      materialized.current.delete(id);
    }
  }, [contexts]);
}
