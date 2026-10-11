// Each RPC service proxy has one attachment; perform hello/clientHello only once and let all
// conversation/sessions-index transports share the Promise to prevent duplicate handshakes on concurrent initial subscriptions.
import type { IZCodeAgentService } from "@zcode/services";
import {
  V4_WIRE_PROTOCOL_VERSION,
  helloMessageSchema,
  hostSupportsWorkflowRunDeltas,
  type ClientHello,
  type HelloMessage,
} from "@zcode/shared/zcode-protocol-v4";
import { getV4ClientId } from "@/v4/commandFactory.js";

type AgentV4HandshakeService = Pick<
  IZCodeAgentService,
  "helloConversationV4" | "initializeConversationV4"
>;

const handshakes = new WeakMap<object, Promise<HelloMessage>>();
export function ensureAgentV4ConnectionHandshake(
  service: AgentV4HandshakeService,
): Promise<HelloMessage> {
  const key = service as object;
  const existing = handshakes.get(key);
  if (existing) return existing;

  const handshake = (async () => {
    const hello = helloMessageSchema.parse(await service.helloConversationV4());
    // Declaration of `workflowRunDeltas` is **one-way**: the client may echo it only after Host advertises it in hello.
    // clientHello capabilities use `.strict()`, so sending an unknown key to an older Host makes the entire
    // clientHello fail parsing and prevents the connection — this does not degrade gracefully; the whole session pane becomes unavailable.
    const capabilities: NonNullable<ClientHello["capabilities"]> = {
      workspaceHookReviewUi: true,
      ...(hostSupportsWorkflowRunDeltas(hello.capabilities) ? { workflowRunDeltas: true } : {}),
    };
    await service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      // Handshake and commandFactory previously generated separate page clientIds, so the facade
      // could not verify that the command envelope belonged to the bound client. Reuse the persisted V4 clientId in both.
      clientId: getV4ClientId(),
      clientKind: hello.clientMode === "desktop-continuous" ? "desktop" : "web",
      appVersion: "unknown",
      capabilities,
    });
    return hello;
  })();
  handshakes.set(key, handshake);
  void handshake.catch(() => {
    if (handshakes.get(key) === handshake) handshakes.delete(key);
  });
  return handshake;
}
