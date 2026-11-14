import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { Agent, ProxyAgent, WebSocket, fetch as undiciFetch, type Dispatcher } from "undici";

export interface HostApiNetworkOptions {
  httpProxy?: string;
  noProxy?: string;
  caCertPath?: string;
}

export interface HostWebSocketConnection {
  socket: WebSocket;
  /** 本次连接是否经 HTTP 代理（来自与 fetch 相同的选路结果） */
  viaProxy: boolean;
}

export interface HostApiNetworkTransport {
  fetch: typeof fetch;
  /**
   * 按与 fetch 相同的代理、No Proxy 与自定义 CA 建立 WebSocket（ws:// 按 http、wss:// 按 https 选路）。
   * 连接复用 fetch 的 dispatcher，transport 释放时随 dispatcher 一起关闭；配置无效时 fail-closed。
   */
  createWebSocket(url: string): Promise<HostWebSocketConnection>;
  dispose(): void;
  disposeAndWait(): Promise<void>;
}

type HostProxyRoute =
  | { kind: "direct"; noProxyMatched?: boolean }
  | { kind: "proxy"; proxyUrl: string }
  | { kind: "invalid"; reason: string };

export function mergeHostApiCaCertificates(
  customCa: string,
  defaultCa: readonly string[] = rootCertificates,
): string[] {
  // Node's tls.ca replaces rather than appends to the default root certificates. Supplying only the corporate proxy CA would remove the trust chain
  // for public certificates that have not been re-signed by the proxy, so the Node default roots must also be retained.
  return [...defaultCa, customCa];
}

function normalizeProxyUrl(value: string): string | undefined {
  const candidate = /^\w[\w+.-]*:\/\//.test(value) ? value : `http://${value}`;
  try {
    const url = new URL(candidate);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function matchesNoProxy(url: URL, value: string | undefined): boolean {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return (value ?? "").split(/[\s,]+/).some((rawRule) => {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) return false;
    if (rule === "*") return true;

    const ruleWithoutScheme = rule.replace(/^[a-z][a-z\d+.-]*:\/\//, "");
    const [ruleHost = "", rulePort] = ruleWithoutScheme.split(":");
    const normalizedHost = ruleHost.replace(/^\*\.?/, "").replace(/^\./, "");
    if (!normalizedHost) return false;
    const hostMatches = host === normalizedHost || host.endsWith(`.${normalizedHost}`);
    return hostMatches && (!rulePort || rulePort === port);
  });
}

export function resolveHostProxyForUrl(
  requestUrl: string | URL,
  options: HostApiNetworkOptions,
): HostProxyRoute {
  let url: URL;
  try {
    url = typeof requestUrl === "string" ? new URL(requestUrl) : requestUrl;
  } catch {
    return { kind: "direct" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "direct" };
  }
  if (matchesNoProxy(url, options.noProxy)) {
    return { kind: "direct", noProxyMatched: true };
  }
  const configuredProxy = options.httpProxy?.trim();
  if (!configuredProxy) {
    return { kind: "direct" };
  }
  const proxyUrl = normalizeProxyUrl(configuredProxy);
  return proxyUrl
    ? { kind: "proxy", proxyUrl }
    : { kind: "invalid", reason: "Configured Host proxy URL is invalid" };
}

interface HostApiNetworkTransportDependencies {
  createDispatcher?: typeof createDispatcher;
  fetchWithDispatcher?: (
    input: string,
    init: Omit<RequestInit, "dispatcher"> & { dispatcher: Dispatcher },
  ) => Promise<Response>;
}

export function createHostApiNetworkTransport(
  resolveOptions: () => Promise<HostApiNetworkOptions>,
  dependencies: HostApiNetworkTransportDependencies = {},
): HostApiNetworkTransport {
  // Host is a separate Node process, so Electron Session.setProxy does not affect its globalThis.fetch.
  // Inject a dispatcher per request at the NodeApiClient boundary to avoid globally redirecting other raw fetch calls such as telemetry.
  let optionsPromise: Promise<HostApiNetworkOptions> | undefined;
  const dispatcherPromises = new Map<string, Promise<Dispatcher>>();
  let disposed = false;
  let generation = 0;
  let pendingDispatcherCreations = 0;
  let resolveDispatcherCreations: (() => void) | undefined;
  let dispatcherCreationsDone: Promise<void> | undefined;
  const lateDisposePromises: Promise<void>[] = [];
  let disposePromise: Promise<void> | undefined;
  let disposeMode: "close" | "destroy" | undefined;
  const dispatcherFactory = dependencies.createDispatcher ?? createDispatcher;
  const fetchWithDispatcher =
    dependencies.fetchWithDispatcher ??
    ((input, init) => undiciFetch(input, init as never) as unknown as Promise<Response>);

  /**
   * 返回请求应使用的 dispatcher；dispatcher 为 undefined 表示直连且无自定义 CA，沿用默认网络栈。
   * viaProxy 是本次选路结果，调用方据此区分代理导致的失败，不再自行解析代理设置。
   */
  const resolveDispatcher = async (
    requestUrl: string,
  ): Promise<{ dispatcher?: Dispatcher; viaProxy: boolean }> => {
    if (disposed) {
      throw new Error("Host API network transport has been disposed");
    }
    const requestGeneration = generation;
    if (!optionsPromise) {
      // A settings-read failure affects only the current request; clear the rejected promise so a transient IPC/startup race
      // does not permanently block the Host API, while still preventing the failed request from falling back to a direct connection.
      optionsPromise = resolveOptions().catch((error: unknown) => {
        optionsPromise = undefined;
        throw error;
      });
    }
    const options = await optionsPromise;
    if (disposed || generation !== requestGeneration) {
      throw new Error("Host API network transport has been disposed");
    }
    const route = resolveHostProxyForUrl(requestUrl, options);
    if (route.kind === "invalid") {
      throw new Error(route.reason);
    }
    if (route.kind === "direct" && !options.caCertPath) {
      return { viaProxy: false };
    }

    const dispatcherKey = `${route.kind}:${route.kind === "proxy" ? route.proxyUrl : "direct"}:${options.caCertPath ?? ""}`;
    let dispatcherPromise = dispatcherPromises.get(dispatcherKey);
    if (!dispatcherPromise) {
      if (disposed) {
        throw new Error("Host API network transport has been disposed");
      }
      const dispatcherGeneration = generation;
      pendingDispatcherCreations += 1;
      dispatcherPromise = dispatcherFactory(route, options.caCertPath);
      dispatcherPromises.set(dispatcherKey, dispatcherPromise);
      void dispatcherPromise
        .then((dispatcher) => {
          if (
            (disposed || generation !== dispatcherGeneration) &&
            dispatcherPromises.get(dispatcherKey) === dispatcherPromise
          ) {
            dispatcherPromises.delete(dispatcherKey);
            const cleanupPromise = Promise.resolve(
              disposeMode === "close" ? dispatcher.close() : dispatcher.destroy(),
            ).catch(() => {});
            lateDisposePromises.push(cleanupPromise);
          }
        })
        .catch(() => {});
      const markDispatcherCreationDone = () => {
        pendingDispatcherCreations -= 1;
        if (pendingDispatcherCreations === 0) {
          resolveDispatcherCreations?.();
          resolveDispatcherCreations = undefined;
        }
      };
      void dispatcherPromise.then(markDispatcherCreationDone, markDispatcherCreationDone);
      dispatcherPromise.catch(() => {
        // A temporary I/O failure reading settings/CA affects only the current request; clear the rejected dispatcher so one startup race
        // does not permanently block this route, while keeping the failed request fail-closed instead of falling back to a direct connection.
        if (dispatcherPromises.get(dispatcherKey) === dispatcherPromise) {
          dispatcherPromises.delete(dispatcherKey);
        }
      });
    }
    const dispatcher = await dispatcherPromise;
    if (disposed || generation !== requestGeneration) {
      throw new Error("Host API network transport has been disposed");
    }
    return { dispatcher, viaProxy: route.kind === "proxy" };
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const { dispatcher } = await resolveDispatcher(requestUrl);
    if (!dispatcher) {
      return globalThis.fetch(input as Parameters<typeof fetch>[0], init);
    }
    return fetchWithDispatcher(
      input as unknown as string,
      {
        ...init,
        dispatcher,
      } as Omit<RequestInit, "dispatcher"> & { dispatcher: Dispatcher },
    );
  };

  const startDispose = (mode: "close" | "destroy"): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposed = true;
    generation += 1;
    disposeMode = mode;
    // The dispatcher cannot be cached only in a closure without a Host owner; connection pools and
    // keep-alive sockets could survive after a window/remote Host is recreated. Snapshot the current single-flight Promise during release so an initializing dispatcher
    // is also disposed when it completes; use destroy for synchronous shutdown and close for shutdown that waits.
    const pendingDispatchers = [...dispatcherPromises.values()];
    dispatcherPromises.clear();
    if (pendingDispatcherCreations > 0) {
      dispatcherCreationsDone = new Promise<void>((resolve) => {
        resolveDispatcherCreations = resolve;
      });
    }
    disposePromise = (async () => {
      await Promise.allSettled(
        pendingDispatchers.map(async (dispatcherPromise) => {
          const dispatcher = await dispatcherPromise;
          if (mode === "close") {
            await dispatcher.close();
          } else {
            await dispatcher.destroy();
          }
        }),
      );
      await dispatcherCreationsDone;
      await Promise.all(lateDisposePromises);
    })();
    return disposePromise;
  };

  // 修复原因：语音输入的 WebSocket 曾用 Node 全局 WebSocket 直连，绕过用户配置的代理和 CA，
  // 在只能经代理出网的环境里 ticket 能申请成功、音频连接却失败。改为与 fetch 共用选路和 dispatcher。
  const createWebSocket = async (url: string): Promise<HostWebSocketConnection> => {
    const routeUrl = new URL(url);
    if (routeUrl.protocol === "ws:") routeUrl.protocol = "http:";
    else if (routeUrl.protocol === "wss:") routeUrl.protocol = "https:";
    else throw new Error(`Unsupported WebSocket URL protocol: ${routeUrl.protocol}`);
    const { dispatcher, viaProxy } = await resolveDispatcher(routeUrl.href);
    const socket = dispatcher ? new WebSocket(url, { dispatcher }) : new WebSocket(url);
    return { socket, viaProxy };
  };

  return {
    fetch,
    createWebSocket,
    dispose() {
      void startDispose("destroy");
    },
    disposeAndWait() {
      return startDispose("close");
    },
  };
}

async function createDispatcher(
  route: Exclude<HostProxyRoute, { kind: "invalid" }>,
  caCertPath: string | undefined,
): Promise<Dispatcher> {
  const customCa = caCertPath ? await readFile(caCertPath, "utf8") : undefined;
  const ca = customCa ? mergeHostApiCaCertificates(customCa) : undefined;
  if (route.kind === "proxy") {
    return new ProxyAgent({
      uri: route.proxyUrl,
      proxyTls: ca ? { ca } : undefined,
      requestTls: ca ? { ca } : undefined,
    });
  }
  return new Agent({ connect: ca ? { ca } : undefined });
}
