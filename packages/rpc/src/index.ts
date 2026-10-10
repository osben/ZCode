/**
 * IPC Framework — unified exports
 *
 * Architecture overview (bottom to top):
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │  Layer 6: Remote connection                                    │
 * │  RemoteAuthorityResolver → SocketFactory → PersistentProtocol │
 * │  → IPCClient → channel.call()                                │
 * ├──────────────────────────────────────────────────────────────┤
 * │  Layer 5: ProxyChannel automatic service proxy                 │
 * │  fromService(service) ↔ toService(channel)                   │
 * ├──────────────────────────────────────────────────────────────┤
 * │  Layer 4: IPCServer(1:N) / IPCClient(1:1 bidirectional)       │
 * │  Connection management, routing, multicast                    │
 * ├──────────────────────────────────────────────────────────────┤
 * │  Layer 3: ChannelServer / ChannelClient                      │
 * │  Channel-based RPC (call/listen)                              │
 * ├──────────────────────────────────────────────────────────────┤
 * │  Layer 2: IMessagePassingProtocol                            │
 * │  send(buffer) / onMessage: Event<buffer>                     │
 * ├──────────────────────────────────────────────────────────────┤
 * │  Layer 1: Serialization (VQL + type tags)                     │
 * │  serialize() / deserialize()                                  │
 * ├──────────────────────────────────────────────────────────────┤
 * │  Layer 0: Foundation                                           │
 * │  Event / Emitter / Disposable / VSBuffer / CancellationToken │
 * └──────────────────────────────────────────────────────────────┘
 */

// Layer 0: Foundation
export {
  type IDisposable,
  toDisposable,
  DisposableStore,
  Event,
  Emitter,
  Relay,
  EventMultiplexer,
  type CancellationToken,
  CancellationTokenSource,
} from "./foundation.js";

export { VSBuffer } from "./buffer.js";

// Layer 1: Serialization
export {
  type IReader,
  type IWriter,
  BufferReader,
  BufferWriter,
  serialize,
  deserialize,
} from "./serialization.js";

// Layer 2: Transport protocol
export {
  type IMessagePassingProtocol,
  type ConnectionFlowControl,
  type MessagePortFlowControl,
  type MessagePortFlowState,
  type MessagePortPayload,
  type ISocket,
  ChunkStream,
  SocketProtocol,
  ProtocolMessageType,
  ProtocolMessage,
  MessagePortProtocol,
  type MessagePortLike,
  createQueuePair,
} from "./protocol.js";
export { PersistentProtocol, type PersistentProtocolOptions } from "./persistent-protocol.js";

// Layer 3: Channel RPC
export {
  type IChannel,
  type IServerChannel,
  type IChannelServer,
  type IChannelClient,
  ChannelServer,
  ChannelClient,
  getDelayedChannel,
} from "./channels.js";

// Layer 4: Connection management
export {
  type ClientConnectionEvent,
  type Client,
  type IConnectionHub,
  type IClientRouter,
  IPCServer,
  IPCClient,
  StaticRouter,
} from "./ipc.js";

// Layer 5: Service proxy
export { ProxyChannel } from "./proxy-channel.js";

// Logging middleware — decorates ChannelServer/ChannelClient to log RPC calls consistently
export {
  type RPCLogger,
  LoggingChannelServer,
  LoggingChannelClient,
} from "./logging-middleware.js";

export {
  type NetworkTransportKind,
  type NetworkObservation,
  type NetworkTelemetrySink,
  setNetworkTelemetrySink,
  emitNetworkTelemetryObservation,
  NetworkTelemetryChannelServer,
  NetworkTelemetryChannelClient,
} from "./network-telemetry-middleware.js";

// Layer 6: Remote
export {
  RemoteConnectionType,
  WebSocketRemoteConnection,
  ManagedRemoteConnection,
  type RemoteConnection,
  type ResolvedAuthority,
  type IRemoteAuthorityResolver,
  RemoteAuthorityResolverService,
  type ISocketFactory,
  RemoteSocketFactoryService,
  type IURITransformer,
  type SimpleURI,
  createURITransformer,
  RemoteAgentConnection,
  type RemoteConnectionState,
} from "./remote.js";
