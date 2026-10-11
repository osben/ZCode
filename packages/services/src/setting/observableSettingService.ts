import type { AppSettings } from "@zcode/shared";
import type { ISettingService } from "./setting.js";

export interface SettingServiceUpdatedEvent {
  readonly keys: readonly (keyof AppSettings)[];
}

export interface ObservableSettingService extends ISettingService {
  onDidUpdate(listener: (event: SettingServiceUpdatedEvent) => void): () => void;
}

/**
 * Add post-commit notifications to the Host settings service without expanding the Setting RPC contract.
 * Do not publish an event if the underlying update fails.
 */
export function createObservableSettingService(base: ISettingService): ObservableSettingService {
  const listeners = new Set<(event: SettingServiceUpdatedEvent) => void>();
  return {
    ...base,
    onDidUpdate(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async update(patch, expectedAccountSettings): Promise<void> {
      if (expectedAccountSettings) await base.update(patch, expectedAccountSettings);
      else await base.update(patch);
      const keys = Object.freeze(Object.keys(patch) as (keyof AppSettings)[]);
      if (keys.length === 0) return;
      const event = Object.freeze({ keys });
      for (const listener of listeners) listener(event);
    },
  };
}
