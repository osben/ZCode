/**
 * Layer 6: Remote connection abstraction
 *
 * This layer lets VS Code connect to file systems over SSH, Docker, and WSL.
 *
 * Core concepts:
 * 1. RemoteAuthority: a string such as "ssh+myserver" identifies a remote environment
 * 2. RemoteAuthorityResolver: registered by an extension to resolve an authority to a connection address
 * 3. RemoteSocketFactory: creates a socket based on the connection type
 * 4. URITransformer: converts file paths between the client and server
 *
 * Connection setup:
 *   authority "ssh+myserver"
 *       ↓ (RemoteAuthorityResolver)
 *   { host: "1.2.3.4", port: 8080, token: "xxx" }
 *       ↓ (RemoteSocketFactory)
 *   ISocket (TCP/WebSocket)
 *       ↓ (PersistentProtocol)
 *   IMessagePassingProtocol (with ACK + reconnection)
 *       ↓ (IPCClient)
 *   Remote channels are now available!
 */

import { Emitter, IDisposable, toDisposable } from "./foundation.js";
import { ISocket } from "./protocol.js";
import { PersistentProtocol } from "./persistent-protocol.js";
import { IPCClient } from "./ipc.js";

// ============================================================================
// Remote Authority
// ============================================================================

/**
 * Remote connection type
 */
export enum RemoteConnectionType {
  WebSocket = 0,
  Managed = 1,
}

/**
 * WebSocket connection: connects directly to host:port
 */
export class WebSocketRemoteConnection {
  readonly type = RemoteConnectionType.WebSocket;
  constructor(
    public readonly host: string,
    public readonly port: number,
  ) {}

  toString(): string {
    return `WebSocket(${this.host}:${this.port})`;
  }
}

/**
 * Managed connection: references an established connection (such as a tunnel) by ID
 */
export class ManagedRemoteConnection {
  readonly type = RemoteConnectionType.Managed;
  constructor(public readonly id: number) {}

  toString(): string {
    return `Managed(${this.id})`;
  }
}

export type RemoteConnection = WebSocketRemoteConnection | ManagedRemoteConnection;

/** Resolved remote address. */
export interface ResolvedAuthority {
  readonly authority: string;
  readonly connectTo: RemoteConnection;
  readonly connectionToken: string | undefined;
}

// ============================================================================
// Remote Authority Resolver
// ============================================================================

/**
 * IRemoteAuthorityResolver resolves an authority string to an actual connection address.
 *
 * In VS Code, this interface is implemented by remote extensions:
 * - The Remote-SSH extension registers a resolver for type "ssh"
 * - The Remote-WSL extension registers a resolver for type "wsl"
 * - Dev Containers registers a resolver for type "dev-container"
 *
 * Each remote type knows how to resolve its authority and return a connectable address.
 */
export interface IRemoteAuthorityResolver {
  resolve(authority: string): Promise<ResolvedAuthority>;
}

/**
 * RemoteAuthorityResolverService manages multiple resolvers.
 */
export class RemoteAuthorityResolverService {
  private resolvers = new Map<string, IRemoteAuthorityResolver>();

  /** Register a resolver for an authority type. */
  registerResolver(type: string, resolver: IRemoteAuthorityResolver): IDisposable {
    this.resolvers.set(type, resolver);
    return toDisposable(() => this.resolvers.delete(type));
  }

  /**
   * Resolve an authority.
   * @param authority For example, "ssh+myserver" or "wsl+Ubuntu".
   */
  async resolveAuthority(authority: string): Promise<ResolvedAuthority> {
    // Extract the type from the authority: ssh+myserver → ssh
    const plusIndex = authority.indexOf("+");
    const type = plusIndex >= 0 ? authority.substring(0, plusIndex) : authority;

    const resolver = this.resolvers.get(type);
    if (!resolver) {
      throw new Error(`No resolver registered for remote type: ${type}`);
    }

    return resolver.resolve(authority);
  }
}

// ============================================================================
// Remote Socket Factory
// ============================================================================

/**
 * ISocketFactory creates a socket connection of a specific type.
 */
export interface ISocketFactory<T extends RemoteConnectionType = RemoteConnectionType> {
  supports(connectTo: RemoteConnection & { type: T }): boolean;
  connect(connectTo: RemoteConnection & { type: T }, path: string, query: string): Promise<ISocket>;
}

/**
 * RemoteSocketFactoryService manages socket factories for different connection types.
 *
 * Design pattern: Strategy
 * - The Node.js environment registers NodeSocketFactory (TCP socket)
 * - The browser environment registers BrowserSocketFactory (WebSocket)
 * - Each RemoteConnectionType can have multiple factories; supports() selects one
 */
export class RemoteSocketFactoryService {
  private readonly factories: Map<RemoteConnectionType, ISocketFactory[]> = new Map();

  register<T extends RemoteConnectionType>(type: T, factory: ISocketFactory<T>): IDisposable {
    if (!this.factories.has(type)) {
      this.factories.set(type, []);
    }
    this.factories.get(type)!.push(factory as ISocketFactory);
    return toDisposable(() => {
      const list = this.factories.get(type);
      if (list) {
        const idx = list.indexOf(factory as ISocketFactory);
        if (idx >= 0) {
          list.splice(idx, 1);
        }
      }
    });
  }

  async connect(connectTo: RemoteConnection, path: string, query: string): Promise<ISocket> {
    const factories = this.factories.get(connectTo.type) || [];
    const factory = factories.find((f) => f.supports(connectTo as any));
    if (!factory) {
      throw new Error(`No socket factory found for ${connectTo}`);
    }
    return factory.connect(connectTo as any, path, query);
  }
}

// ============================================================================
// URI Transformer
// ============================================================================

/**
 * URI transformer — converts file paths between the client and server.
 *
 * Problem:
 * - The client identifies a remote file as vscode-remote://ssh+myserver/home/user/file.txt
 * - The server (on the remote machine) accesses the actual file as file:///home/user/file.txt
 *
 * Conversion rules:
 *   Client → server:
 *     vscode-remote://authority/path → file:///path
 *     file:///local/path → vscode-local:///local/path
 *
 *   Server → client:
 *     file:///path → vscode-remote://authority/path
 *     vscode-local:///local/path → file:///local/path
 */
export interface IURITransformer {
  /** Client URI → server URI. */
  transformIncoming(uri: SimpleURI): SimpleURI;
  /** Server URI → client URI. */
  transformOutgoing(uri: SimpleURI): SimpleURI;
}

/** Simplified URI representation. */
export interface SimpleURI {
  scheme: string;
  authority: string;
  path: string;
}

/**
 * Create a URI transformer.
 * @param remoteAuthority Remote authority string, for example "ssh+myserver".
 */
export function createURITransformer(remoteAuthority: string): IURITransformer {
  return {
    transformIncoming(uri: SimpleURI): SimpleURI {
      // vscode-remote://authority/path → file:///path
      if (uri.scheme === "vscode-remote" && uri.authority === remoteAuthority) {
        return { scheme: "file", authority: "", path: uri.path };
      }
      // file:///local → vscode-local:///local
      if (uri.scheme === "file") {
        return { scheme: "vscode-local", authority: "", path: uri.path };
      }
      return uri;
    },

    transformOutgoing(uri: SimpleURI): SimpleURI {
      // file:///path → vscode-remote://authority/path
      if (uri.scheme === "file") {
        return { scheme: "vscode-remote", authority: remoteAuthority, path: uri.path };
      }
      // vscode-local:///local → file:///local
      if (uri.scheme === "vscode-local") {
        return { scheme: "file", authority: "", path: uri.path };
      }
      return uri;
    },
  };
}

// ============================================================================
// Remote Agent Connection — connects all Remote abstractions
// ============================================================================

/**
 * Reconnection strategy
 */
const RECONNECT_DELAYS = [0, 5, 5, 10, 10, 10, 10, 10, 30]; // seconds

export interface RemoteConnectionState {
  type: "connected" | "reconnecting" | "disconnected";
}

/**
 * RemoteAgentConnection manages the full lifecycle of a remote connection.
 *
 * It connects the abstractions from the Remote layer:
 * 1. Resolve the address with RemoteAuthorityResolver
 * 2. Create a socket with RemoteSocketFactory
 * 3. Add reliability with PersistentProtocol
 * 4. Wrap it as IPCClient for upper layers
 * 5. Reconnect automatically after disconnection
 */
export class RemoteAgentConnection implements IDisposable {
  private protocol: PersistentProtocol | null = null;
  private client: IPCClient<string> | null = null;

  private readonly _onDidStateChange = new Emitter<RemoteConnectionState>();
  readonly onDidStateChange = this._onDidStateChange.event;

  constructor(
    private readonly authority: string,
    private readonly resolverService: RemoteAuthorityResolverService,
    private readonly socketFactory: RemoteSocketFactoryService,
  ) {}

  /**
   * Establish a connection and return IPCClient.
   */
  async connect(): Promise<IPCClient<string>> {
    // Step 1: Resolve the authority.
    const resolved = await this.resolverService.resolveAuthority(this.authority);

    // Step 2: Create the socket.
    const query = resolved.connectionToken ? `token=${resolved.connectionToken}` : "";
    const socket = await this.socketFactory.connect(resolved.connectTo, "/", query);

    // Step 3: Wrap it with PersistentProtocol (adds ACK and reconnection support).
    this.protocol = new PersistentProtocol(socket);

    // Step 4: Wrap it as IPCClient.
    this.client = new IPCClient(this.protocol, this.authority);

    // Step 5: Listen for disconnection and reconnect.
    this.protocol.onSocketClose(() => {
      this._onDidStateChange.fire({ type: "reconnecting" });
      this.reconnect(resolved, 0);
    });

    this._onDidStateChange.fire({ type: "connected" });
    return this.client;
  }

  private async reconnect(resolved: ResolvedAuthority, attempt: number): Promise<void> {
    if (attempt >= RECONNECT_DELAYS.length) {
      this._onDidStateChange.fire({ type: "disconnected" });
      return;
    }

    const delay = RECONNECT_DELAYS[attempt] * 1000;
    await new Promise((r) => setTimeout(r, delay));

    try {
      const query = resolved.connectionToken ? `token=${resolved.connectionToken}` : "";
      const newSocket = await this.socketFactory.connect(resolved.connectTo, "/", query);

      // Replace the socket; PersistentProtocol automatically replays unacknowledged messages.
      this.protocol!.replaceSocket(newSocket);
      this._onDidStateChange.fire({ type: "connected" });
    } catch {
      this.reconnect(resolved, attempt + 1);
    }
  }

  dispose(): void {
    this.client?.dispose();
    this.protocol?.dispose();
    this._onDidStateChange.dispose();
  }
}
