import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { V4RowTranslationError } from "./fork-edit-retry.js";

async function setRowPinned(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setRowPinned"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "setRowPinned",
  );
  if (
    !resolution?.ok ||
    !resolution.messageId ||
    (resolution.row.kind !== "assistantText" && resolution.row.kind !== "userInput")
  ) {
    throw new V4RowTranslationError("setRowPinned", payload.target.rowId);
  }
  if (!host.setRowPinned) {
    throw new Error("fault.command.rowPinUnsupported");
  }
  await host.setRowPinned(record.app.sessionId, {
    entityId: payload.target.entityId,
    messageId: resolution.messageId,
    pinned: payload.pinned,
  });
  return undefined;
}

export const rowPinHandlers = { setRowPinned };
