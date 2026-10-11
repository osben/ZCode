import { MessagePortProtocol, ChannelClient } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";
import { isRendererProductionBuild } from "./rendererLoggingEnv.js";

function logMessagePortDebug(message: string): void {
  // Renderer connection logs are disabled in production to avoid synchronous console overhead during startup and reconnection.
  if (isRendererProductionBuild()) {
    return;
  }
  console.log(message);
}

export interface MessagePortServiceConnection {
  services: IServiceAccessor;
  dispose: (reason?: Error) => void;
}

/**
 * Create a MessagePort service connection with an explicit lifecycle.
 *
 * When a scoped remote session is replaced, release both ChannelClient and the underlying port.
 * Otherwise, pending RPC calls on the old attachment cannot settle and continue to occupy the deduplication state above.
 */
export function createMessagePortServiceConnection(
  port: MessagePort,
): MessagePortServiceConnection {
  logMessagePortDebug("[messageport] creating protocol and client...");
  const protocol = new MessagePortProtocol(port);
  const client = new ChannelClient(protocol);
  client.onDidInitialize(() => {
    logMessagePortDebug("[messageport] ChannelClient received Initialize from server");
  });
  logMessagePortDebug("[messageport] client created, waiting for Initialize...");

  const services = new RemoteServiceAccess(client);
  let disposed = false;
  return {
    services,
    dispose: (reason?: Error) => {
      if (disposed) {
        return;
      }
      disposed = true;
      client.dispose(reason);
      protocol.disconnect();
    },
  };
}

/**
 * Connect to a service through MessagePort.
 *
 * In Desktop mode, utilityProcess (or a remote proxy in the main process) exposes ChannelServer
 * through MessagePort, and the renderer uses this function to establish a ChannelClient connection.
 */
export function connectViaMessagePort(port: MessagePort): IServiceAccessor {
  return createMessagePortServiceConnection(port).services;
}
