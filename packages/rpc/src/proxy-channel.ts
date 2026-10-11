/**
 * Layer 5: ProxyChannel — automatic service proxy (the killer feature)
 *
 * This is a key abstraction behind VS Code developer productivity.
 *
 * Without ProxyChannel, you would need to hand-write an IServerChannel for every service:
 *   class FileServiceChannel implements IServerChannel {
 *     call(ctx, command, arg) {
 *       switch (command) {
 *         case 'readFile': return this.service.readFile(arg[0]);
 *         case 'writeFile': return this.service.writeFile(arg[0], arg[1]);
 *         // ... manually map every method
 *       }
 *     }
 *   }
 *
 * With ProxyChannel, one line does it:
 *   const channel = ProxyChannel.fromService(fileService);
 *   // Automatically maps all methods to call and all on* events to listen
 *
 * One line on the client as well:
 *   const fileService = ProxyChannel.toService<IFileService>(channel);
 *   await fileService.readFile(uri);  // Just like calling a local method!
 *
 * How it works:
 * - fromService: iterates over service properties; methods → call, on* events → listen
 * - toService: uses ES6 Proxy to intercept property access and dispatch to call/listen automatically
 */

import { Event, Emitter, IDisposable, DisposableStore } from "./foundation.js";
import { IChannel, IServerChannel } from "./channels.js";

// ============================================================================
// ProxyChannel
// ============================================================================

export namespace ProxyChannel {
  /**
   * Server: automatically wrap a service object as IServerChannel.
   *
   * Conventions:
   * - Properties beginning with on + an uppercase letter are treated as events (for example, onDidChange).
   * - Properties beginning with onDynamic + an uppercase letter are treated as dynamic events (methods that return an event when called).
   * - Other methods are treated as RPC methods.
   */
  export function fromService<TContext>(
    service: unknown,
    disposables?: DisposableStore,
  ): IServerChannel<TContext> {
    const handler = service as { [key: string]: unknown };

    // Pre-cache and buffer all events.
    const eventMap = new Map<string, Event<unknown>>();
    for (const key in handler) {
      if (isEvent(key) && !isDynamicEvent(key) && typeof handler[key] === "function") {
        // Buffer events so they are not lost even when nobody is subscribed.
        eventMap.set(key, bufferEvent(handler[key] as Event<unknown>));
      }
    }

    return {
      listen<T>(_ctx: TContext, event: string, arg?: any): Event<T> {
        // Check the cache first.
        const cached = eventMap.get(event);
        if (cached) {
          return cached as Event<T>;
        }

        const target = handler[event];
        if (typeof target === "function") {
          // Dynamic event: onDynamicXxx(arg) returns an Event.
          if (isDynamicEvent(event)) {
            return target.call(handler, arg);
          }
          // Lazily discovered event (a Proxy service may not expose it through for-in).
          if (isEvent(event)) {
            eventMap.set(event, bufferEvent(handler[event] as Event<unknown>));
            return eventMap.get(event) as Event<T>;
          }
        }

        throw new Error(`Event not found: ${event}`);
      },

      call<T>(_ctx: TContext, command: string, args?: any[]): Promise<T> {
        const target = handler[command];
        if (typeof target === "function") {
          let result = target.apply(handler, args || []);
          if (!(result instanceof Promise)) {
            result = Promise.resolve(result);
          }
          return result;
        }
        throw new Error(`Method not found: ${command}`);
      },
    };
  }

  /**
   * Client: wrap an IChannel as a type-safe service object.
   *
   * Use ES6 Proxy to intercept all property access:
   * - Accessing on* → channel.listen(propKey)
   * - Accessing anything else → return a function that becomes channel.call(propKey, args) when called
   */
  export function toService<T extends object>(
    channel: IChannel,
    options?: { context?: unknown },
  ): T {
    return new Proxy({} as T, {
      get(target: T, propKey: PropertyKey, receiver: object) {
        // React development mode, logging tools, and browser runtimes inspect built-in properties such as Symbol / then.
        // Previously, every unknown property was treated as an RPC member: reading Symbol.toStringTag threw,
        // while reading then made a regular service look thenable and broke remote workspace rerenders after directory selection.
        // These runtime-inspection properties should fall back to normal object semantics instead of going through RPC.
        if (typeof propKey === "symbol") {
          return Reflect.get(target as object, propKey, receiver);
        }

        if (typeof propKey === "string") {
          if (propKey === "then") {
            return undefined;
          }

          // Dynamic event.
          if (isDynamicEvent(propKey)) {
            return (arg: unknown) => channel.listen(propKey, arg);
          }

          // Regular event.
          if (isEvent(propKey)) {
            return channel.listen(propKey);
          }

          // Method call.
          return async (...args: unknown[]) => {
            // Optional: inject context as the first argument.
            const methodArgs = options?.context !== undefined ? [options.context, ...args] : args;
            return channel.call(propKey, methodArgs);
          };
        }

        return Reflect.get(target as object, propKey, receiver);
      },
    });
  }
}

// ============================================================================
// Helper functions
// ============================================================================

/** Match the onXxx event naming convention. */
function isEvent(name: string): boolean {
  return (
    name.length >= 3 &&
    name[0] === "o" &&
    name[1] === "n" &&
    name.charCodeAt(2) >= 65 && // A
    name.charCodeAt(2) <= 90
  ); // Z
}

/** Match the onDynamicXxx dynamic-event naming convention. */
function isDynamicEvent(name: string): boolean {
  return (
    name.length >= 10 &&
    name.startsWith("onDynamic") &&
    name.charCodeAt(9) >= 65 &&
    name.charCodeAt(9) <= 90
  );
}

/**
 * Buffer events so those emitted before subscription are not lost.
 * Queue events while there are no subscribers and flush as soon as one subscribes.
 */
function bufferEvent<T>(event: Event<T>): Event<T> {
  let buffer: T[] = [];
  let flushing = false;
  let listener: IDisposable | undefined;

  const emitter = new Emitter<T>({
    onWillAddFirstListener: () => {
      listener = event((e) => {
        if (flushing) {
          emitter.fire(e);
        } else {
          buffer.push(e);
        }
      });
    },
    onDidRemoveLastListener: () => {
      listener?.dispose();
      listener = undefined;
      buffer = [];
    },
  });

  // Flush the buffer as soon as a subscriber arrives.
  const originalEvent = emitter.event;
  return (listener_fn) => {
    const disposable = originalEvent(listener_fn);
    if (!flushing) {
      flushing = true;
      for (const item of buffer) {
        emitter.fire(item);
      }
      buffer = [];
    }
    return disposable;
  };
}
