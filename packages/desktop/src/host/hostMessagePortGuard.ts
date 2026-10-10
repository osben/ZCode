import { hostIncomingMessageSchema } from "@zcode/shared";

interface CloseableTransferredPort {
  close(): void;
}

interface HostIncomingMessageEventLike {
  data: unknown;
  ports: readonly CloseableTransferredPort[];
}

function closeTransferredPort(port: CloseableTransferredPort | undefined): void {
  try {
    port?.close();
  } catch {
    // Rejection cleanup is best effort; a close error must not hide the original schema/initialization error.
  }
}

/** If the schema is invalid, no ChannelServer will take over the transferred port, so close it here. */
export function parseHostIncomingMessageEvent(
  event: HostIncomingMessageEventLike,
): ReturnType<typeof hostIncomingMessageSchema.safeParse> {
  // In a clean pnpm install, zod may live in @zcode/shared's private node_modules. If the exported function relies on an inferred return type,
  // its .d.ts will reference a non-portable private ZodSafeParseResult path.
  const result = hostIncomingMessageSchema.safeParse(event.data);
  if (!result.success) {
    for (const port of event.ports) closeTransferredPort(port);
  }
  return result;
}

/** Reject and close AttachServicePort if it arrives before activeServices is ready, preventing a remote RPC from remaining pending forever. */
export function rejectUnavailableAttachedServicePort(
  port: CloseableTransferredPort,
  servicesReady: boolean,
): boolean {
  if (servicesReady) return false;
  closeTransferredPort(port);
  return true;
}
