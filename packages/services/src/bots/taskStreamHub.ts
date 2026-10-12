interface Disposable {
  dispose(): void;
}

/** Each task has exactly one live stream; receivers consume on their own serially, and one failing channel does not block the others. */
export function createBotTaskStreamHub<Event>() {
  const streams = new Map<
    string,
    {
      upstream: Disposable;
      listeners: Map<string, (event: Event) => Promise<void> | void>;
    }
  >();
  return {
    add(
      taskKey: string,
      targetKey: string,
      subscribe: (listener: (event: Event) => Promise<void>) => Disposable,
      listener: (event: Event) => Promise<void> | void,
    ): Disposable {
      let stream = streams.get(taskKey);
      if (!stream) {
        const listeners = new Map<string, (event: Event) => Promise<void> | void>();
        const upstream = subscribe(async (event) => {
          await Promise.allSettled([...listeners.values()].map(async (receive) => receive(event)));
        });
        stream = { listeners, upstream };
        streams.set(taskKey, stream);
      }
      stream.listeners.set(targetKey, listener);
      const current = stream;
      return {
        dispose() {
          if (current.listeners.get(targetKey) !== listener) return;
          current.listeners.delete(targetKey);
          if (current.listeners.size === 0) {
            current.upstream.dispose();
            if (streams.get(taskKey) === current) streams.delete(taskKey);
          }
        },
      };
    },
    dispose() {
      for (const stream of streams.values()) {
        stream.listeners.clear();
        stream.upstream.dispose();
      }
      streams.clear();
    },
  };
}
