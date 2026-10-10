/**
 * ServiceDescriptor — identifies a service by channel name and associates types through generics.
 *
 * Uses TypeScript's support for an interface and const with the same name (types and values are in different namespaces),
 * allowing callers to use one name for both the service type and its runtime descriptor.
 */

export interface ServiceDescriptor<T> {
  readonly channelName: string;
  /** Phantom type — used only for type inference; does not exist at runtime. */
  readonly _brand?: T;
}

export function createServiceDescriptor<T>(channelName: string): ServiceDescriptor<T> {
  return { channelName };
}
