import { ProxyChannel, type IChannelServer } from "@zcode/rpc";
import type { ServiceDescriptor } from "./descriptors.js";

export interface ServiceExposurePolicy {
  readonly allowedChannels: ReadonlySet<string>;
}

/**
 * ServiceCollection — service registry
 *
 * Used by the server to register service instances and expose them through ChannelServer.
 */
export class ServiceCollection {
  private readonly _services = new Map<string, unknown>();

  register<T>(descriptor: ServiceDescriptor<T>, instance: T): this {
    this._services.set(descriptor.channelName, instance);
    return this;
  }

  get<T>(descriptor: ServiceDescriptor<T>): T {
    const instance = this._services.get(descriptor.channelName);
    if (!instance) {
      throw new Error(`Service not registered: ${descriptor.channelName}`);
    }
    return instance as T;
  }

  getOptional<T>(descriptor: ServiceDescriptor<T>): T | undefined {
    return this._services.get(descriptor.channelName) as T | undefined;
  }

  /** Expose all registered services as channels. */
  exposeOnChannelServer(
    server: IChannelServer,
    overrides: ReadonlyMap<string, unknown> = new Map(),
    exposurePolicy?: ServiceExposurePolicy,
  ): void {
    for (const [channelName, instance] of this._services) {
      if (exposurePolicy && !exposurePolicy.allowedChannels.has(channelName)) continue;
      const exposed = overrides.get(channelName) ?? instance;
      server.registerChannel(
        channelName,
        ProxyChannel.fromService(exposed as Record<string, unknown>),
      );
    }
  }
}
