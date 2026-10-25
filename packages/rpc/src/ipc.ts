/**
 * Layer 4: Connection management — IPCServer and IPCClient
 *
 * ChannelServer/ChannelClient implement RPC for a single connection.
 * IPCServer/IPCClient build connection management on top:
 *
 * - IPCServer (1:N): one server accepts multiple client connections,
 *   creating an independent ChannelServer + ChannelClient for each connection.
 *   A Router can select the target client for calls.
 *
 * - IPCClient (1:1 bidirectional): acts as both client and server,
 *   calling remote channels and registering its own channels for remote calls.
 *
 * Key protocol: the first message sent after a client connects is ctx (context/client ID),
 * which the server uses to identify the client.
 */

import {
  Event,
  Emitter,
  IDisposable,
  DisposableStore,
  CancellationToken,
  EventMultiplexer,
} from "./foundation.js";
import { BufferReader, BufferWriter, serialize, deserialize } from "./serialization.js";
import { IMessagePassingProtocol } from "./protocol.js";
import {
  IChannel,
  IServerChannel,
  IChannelServer,
  IChannelClient,
  ChannelServer,
  ChannelClient,
  getDelayedChannel,
} from "./channels.js";

// ============================================================================
// Connection interfaces
// ============================================================================

/** Client connection event. */
export interface ClientConnectionEvent {
  protocol: IMessagePassingProtocol;
  readonly onDidClientDisconnect: Event<void>;
}

/** Client identifier. */
export interface Client<TContext> {
  readonly ctx: TContext;
}

/** Connection = client identifier + bidirectional channel. */
interface Connection<TContext> extends Client<TContext> {
  readonly channelServer: ChannelServer<TContext>;
  readonly channelClient: ChannelClient;
}

/** Connection hub — exposes all active connections. */
export interface IConnectionHub<TContext> {
  readonly connections: Connection<TContext>[];
  readonly onDidAddConnection: Event<Connection<TContext>>;
  readonly onDidRemoveConnection: Event<Connection<TContext>>;
}

/** Router — selects a target client in a multi-client scenario. */
export interface IClientRouter<TContext = string> {
  routeCall(
    hub: IConnectionHub<TContext>,
    command: string,
    arg?: any,
    cancellationToken?: CancellationToken,
  ): Promise<Client<TContext>>;
  routeEvent(hub: IConnectionHub<TContext>, event: string, arg?: any): Promise<Client<TContext>>;
}

// ============================================================================
// IPCServer — one-to-many server
// ============================================================================

/**
 * IPCServer is the "brain" of the communication architecture.
 *
 * It is all of the following:
 * - IChannelServer: registers channels for client calls
 * - IRoutingChannelClient: can call client channels in reverse (Router selects the target)
 * - IConnectionHub: exposes all active connections and connection add/remove events
 *
 * Workflow:
 * 1. Listen for the onDidClientConnect event.
 * 2. After a client connects, wait for the first message (ctx = client ID).
 * 3. Create an independent ChannelServer + ChannelClient for each connection.
 * 4. Push registered channels to the new connection's ChannelServer.
 */
export class IPCServer<TContext = string>
  implements IChannelServer<TContext>, IConnectionHub<TContext>, IDisposable
{
  private channels = new Map<string, IServerChannel<TContext>>();
  private _connections = new Set<Connection<TContext>>();

  private readonly _onDidAddConnection = new Emitter<Connection<TContext>>();
  readonly onDidAddConnection = this._onDidAddConnection.event;

  private readonly _onDidRemoveConnection = new Emitter<Connection<TContext>>();
  readonly onDidRemoveConnection = this._onDidRemoveConnection.event;

  private readonly disposables = new DisposableStore();

  get connections(): Connection<TContext>[] {
    return [...this._connections];
  }

  constructor(onDidClientConnect: Event<ClientConnectionEvent>) {
    this.disposables.add(
      onDidClientConnect(({ protocol, onDidClientDisconnect }) => {
        // Wait for the first message from the client: ctx (client identity).
        const onFirstMessage = Event.once(protocol.onMessage);

        this.disposables.add(
          onFirstMessage((msg) => {
            const reader = new BufferReader(msg);
            const ctx = deserialize(reader) as TContext;

            // Create an independent ChannelServer and ChannelClient for this connection.
            const channelServer = new ChannelServer(protocol, ctx);
            const channelClient = new ChannelClient(protocol);

            // Push registered channels to the new connection.
            this.channels.forEach((channel, name) => channelServer.registerChannel(name, channel));

            const connection: Connection<TContext> = { channelServer, channelClient, ctx };
            this._connections.add(connection);
            this._onDidAddConnection.fire(connection);

            // Clean up when the client disconnects.
            this.disposables.add(
              onDidClientDisconnect(() => {
                channelServer.dispose();
                channelClient.dispose();
                this._connections.delete(connection);
                this._onDidRemoveConnection.fire(connection);
              }),
            );
          }),
        );
      }),
    );
  }

  /**
   * Get a client's channel (for reverse calls).
   *
   * When there are multiple clients, use a router or filter to select a target:
   * - router: implement IClientRouter for custom routing logic
   * - filter: a simple filter function that selects a matching client at random
   */
  getChannel<T extends IChannel>(
    channelName: string,
    routerOrFilter: IClientRouter<TContext> | ((client: Client<TContext>) => boolean),
  ): T {
    const that = this;
    const isFilter = typeof routerOrFilter === "function";

    return {
      call(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<any> {
        let connectionPromise: Promise<Client<TContext>>;

        if (isFilter) {
          const match = that.connections.find(routerOrFilter as (c: Client<TContext>) => boolean);
          connectionPromise = match
            ? Promise.resolve(match)
            : Event.toPromise(
                Event.filter(
                  that.onDidAddConnection,
                  routerOrFilter as (c: Client<TContext>) => boolean,
                ),
              );
        } else {
          connectionPromise = (routerOrFilter as IClientRouter<TContext>).routeCall(
            that,
            command,
            arg,
            cancellationToken,
          );
        }

        const channelPromise = connectionPromise.then((c) =>
          (c as Connection<TContext>).channelClient.getChannel(channelName),
        );

        return getDelayedChannel(channelPromise).call(command, arg, cancellationToken);
      },
      listen(event: string, arg?: any): Event<any> {
        if (isFilter) {
          return that.getMulticastEvent(
            channelName,
            routerOrFilter as (c: Client<TContext>) => boolean,
            event,
            arg,
          );
        }

        const channelPromise = (routerOrFilter as IClientRouter<TContext>)
          .routeEvent(that, event, arg)
          .then((c) => (c as Connection<TContext>).channelClient.getChannel(channelName));

        return getDelayedChannel(channelPromise).listen(event, arg);
      },
    } as T;
  }

  /** Aggregate same-named events from all matching clients into one event. */
  private getMulticastEvent<T>(
    channelName: string,
    filter: (c: Client<TContext>) => boolean,
    eventName: string,
    arg: any,
  ): Event<T> {
    const that = this;
    let disposables: DisposableStore | undefined;

    const emitter = new Emitter<T>({
      onWillAddFirstListener: () => {
        disposables = new DisposableStore();
        const multiplexer = new EventMultiplexer<T>();

        const onAdd = (connection: Connection<TContext>) => {
          const channel = connection.channelClient.getChannel(channelName);
          const event = channel.listen<T>(eventName, arg);
          multiplexer.add(event);
        };

        that.connections.filter(filter).forEach(onAdd);
        disposables.add(Event.filter(that.onDidAddConnection, filter)(onAdd));
        disposables.add(multiplexer.event((e) => emitter.fire(e)));
        disposables.add(multiplexer);
      },
      onDidRemoveLastListener: () => {
        disposables?.dispose();
        disposables = undefined;
      },
    });

    return emitter.event;
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channels.set(channelName, channel);

    // Push to all connected clients.
    for (const connection of this._connections) {
      connection.channelServer.registerChannel(channelName, channel);
    }
  }

  dispose(): void {
    this.disposables.dispose();
    for (const connection of this._connections) {
      connection.channelClient.dispose();
      connection.channelServer.dispose();
    }
    this._connections.clear();
    this.channels.clear();
    this._onDidAddConnection.dispose();
    this._onDidRemoveConnection.dispose();
  }
}

// ============================================================================
// IPCClient — one-to-one, bidirectional
// ============================================================================

/**
 * IPCClient is bidirectional:
 * - It can call remote channels (IChannelClient).
 * - It can register its own channels for remote calls (IChannelServer).
 *
 * The first message sends ctx (its own identity), so the server can identify the client.
 */
export class IPCClient<TContext = string>
  implements IChannelClient, IChannelServer<TContext>, IDisposable
{
  private channelClient: ChannelClient;
  private channelServer: ChannelServer<TContext>;

  constructor(protocol: IMessagePassingProtocol, ctx: TContext) {
    // First message: send this client's identity.
    const writer = new BufferWriter();
    serialize(writer, ctx);
    protocol.send(writer.buffer);

    this.channelClient = new ChannelClient(protocol);
    this.channelServer = new ChannelServer(protocol, ctx);
  }

  getChannel<T extends IChannel>(channelName: string): T {
    return this.channelClient.getChannel(channelName);
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channelServer.registerChannel(channelName, channel);
  }

  dispose(): void {
    this.channelClient.dispose();
    this.channelServer.dispose();
  }
}

// ============================================================================
// StaticRouter — simple router
// ============================================================================

/**
 * Routes to a client based on a static condition.
 * Example: new StaticRouter(ctx => ctx === 'main-window')
 */
export class StaticRouter<TContext = string> implements IClientRouter<TContext> {
  constructor(private fn: (ctx: TContext) => boolean | Promise<boolean>) {}

  async routeCall(hub: IConnectionHub<TContext>): Promise<Client<TContext>> {
    return this.route(hub);
  }

  async routeEvent(hub: IConnectionHub<TContext>): Promise<Client<TContext>> {
    return this.route(hub);
  }

  private async route(hub: IConnectionHub<TContext>): Promise<Client<TContext>> {
    for (const connection of hub.connections) {
      if (await Promise.resolve(this.fn(connection.ctx))) {
        return connection;
      }
    }
    // Wait for a new connection.
    await Event.toPromise(hub.onDidAddConnection);
    return this.route(hub);
  }
}
