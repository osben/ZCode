/**
 * Layer 0: Foundation
 * - IDisposable / DisposableStore: resource lifecycle management
 * - Event / Emitter: event system
 * - CancellationToken: cancellation token
 *
 * These are the foundation of the IPC framework; all higher-level modules depend on them.
 */

// ============================================================================
// Disposable - resource disposal pattern
// ============================================================================

export interface IDisposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): IDisposable {
  return { dispose: once(fn) };
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (!called) {
      called = true;
      fn();
    }
  };
}

/**
 * DisposableStore collects multiple IDisposable instances and disposes them together.
 * Almost every class in VS Code has a DisposableStore to manage its child resources.
 */
export class DisposableStore implements IDisposable {
  private items = new Set<IDisposable>();
  private isDisposed = false;

  add<T extends IDisposable>(item: T): T {
    if (this.isDisposed) {
      console.warn("Adding to a disposed DisposableStore");
      item.dispose();
      return item;
    }
    this.items.add(item);
    return item;
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    for (const item of this.items) {
      item.dispose();
    }
    this.items.clear();
  }
}

// ============================================================================
// Event System
// ============================================================================

/**
 * Event<T> is a function signature: it takes a listener and returns an IDisposable for unsubscribing.
 * This is the core type for event flow throughout the IPC framework.
 */
export type Event<T> = (listener: (e: T) => void) => IDisposable;

export namespace Event {
  /** An event that never fires. */
  export const None: Event<any> = () => ({ dispose() {} });

  /** Fires once and then automatically unsubscribes. */
  export function once<T>(event: Event<T>): Event<T> {
    return (listener) => {
      let fired = false;
      const disposable = event((e) => {
        if (!fired) {
          fired = true;
          disposable.dispose();
          listener(e);
        }
      });
      return disposable;
    };
  }

  /** Convert an event to a Promise and unsubscribe automatically after it resolves. */
  export function toPromise<T>(event: Event<T>): Promise<T> {
    return new Promise((resolve) => once(event)(resolve));
  }

  /** Filter an event. */
  export function filter<T>(event: Event<T>, fn: (e: T) => boolean): Event<T> {
    return (listener) =>
      event((e) => {
        if (fn(e)) {
          listener(e);
        }
      });
  }

  /** Map an event. */
  export function map<T, R>(event: Event<T>, fn: (e: T) => R): Event<R> {
    return (listener) => event((e) => listener(fn(e)));
  }
}

/**
 * Emitter<T> emits events.
 *
 * Key design:
 * - onWillAddFirstListener: fires when the first subscriber arrives (lazy resource initialization)
 * - onDidRemoveLastListener: fires when the last subscriber leaves (resource cleanup)
 *
 * This "lazy subscription" mechanism is essential to the IPC framework—
 * ChannelClient's requestEvent uses it to implement
 * "send EventListen only when someone is listening; send EventDispose when nobody is listening."
 */
export class Emitter<T> implements IDisposable {
  private listeners = new Set<(e: T) => void>();
  private disposed = false;
  private options?: EmitterOptions;

  constructor(options?: EmitterOptions) {
    this.options = options;
  }

  get event(): Event<T> {
    return (listener: (e: T) => void) => {
      if (this.disposed) {
        return { dispose() {} };
      }

      const isFirst = this.listeners.size === 0;
      this.listeners.add(listener);

      if (isFirst) {
        this.options?.onWillAddFirstListener?.();
      }

      return toDisposable(() => {
        this.listeners.delete(listener);
        if (this.listeners.size === 0) {
          this.options?.onDidRemoveLastListener?.();
        }
      });
    };
  }

  fire(event: T): void {
    if (this.disposed) {
      return;
    }
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

interface EmitterOptions {
  onWillAddFirstListener?: () => void;
  onDidRemoveLastListener?: () => void;
}

/**
 * Relay is an "event relay" that can switch its input source dynamically.
 * Used by getDelayedChannel: create the Relay first, then switch its input after the channel promise resolves.
 */
export class Relay<T> implements IDisposable {
  private emitter = new Emitter<T>();
  private inputDisposable: IDisposable = { dispose() {} };

  readonly event = this.emitter.event;

  set input(event: Event<T>) {
    this.inputDisposable.dispose();
    this.inputDisposable = event((e) => this.emitter.fire(e));
  }

  dispose(): void {
    this.inputDisposable.dispose();
    this.emitter.dispose();
  }
}

/**
 * EventMultiplexer aggregates multiple event sources into one event.
 * IPCServer's getMulticastEvent uses it to aggregate same-named events from all clients.
 */
export class EventMultiplexer<T> implements IDisposable {
  private readonly emitter = new Emitter<T>();
  private readonly disposables: IDisposable[] = [];

  readonly event = this.emitter.event;

  add(event: Event<T>): IDisposable {
    const d = event((e) => this.emitter.fire(e));
    this.disposables.push(d);
    return d;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.emitter.dispose();
  }
}

// ============================================================================
// CancellationToken
// ============================================================================

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested: Event<void>;
}

export namespace CancellationToken {
  export const None: CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: Event.None,
  };
}

export class CancellationTokenSource implements IDisposable {
  private _token?: CancellationToken;
  private emitter = new Emitter<void>();
  private _isCancelled = false;

  get token(): CancellationToken {
    if (!this._token) {
      this._token = {
        isCancellationRequested: false,
        onCancellationRequested: this.emitter.event,
      };
    }
    return this._token;
  }

  cancel(): void {
    if (!this._isCancelled) {
      this._isCancelled = true;
      this.emitter.fire();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
