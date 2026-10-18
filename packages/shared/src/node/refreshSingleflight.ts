/** Coalesce account reads without letting a cached read satisfy a forced refresh. */
export class RefreshSingleflight<T> {
  private readonly flights = new Map<string, { promise: Promise<T>; refreshed: boolean }>();

  resolve(
    key: string,
    force: boolean,
    run: (markRefreshed: () => void) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const wait = <R>(promise: Promise<R>): Promise<R> => {
      if (!signal) return promise;
      if (signal.aborted) return Promise.reject(signal.reason);
      return new Promise<R>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
    };
    const existing = this.flights.get(key);
    if (existing) {
      return wait(existing.promise).then((result) =>
        force && !existing.refreshed ? this.resolve(key, true, run, signal) : result,
      );
    }
    const flight = { refreshed: false, promise: undefined as unknown as Promise<T> };
    flight.promise = Promise.resolve()
      .then(() =>
        run(() => {
          flight.refreshed = true;
        }),
      )
      .finally(() => {
        if (this.flights.get(key) === flight) this.flights.delete(key);
      });
    this.flights.set(key, flight);
    return wait(flight.promise);
  }
}
