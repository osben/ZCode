import { useCallback } from "react";
import { resolveIncognitoDefaults, type IncognitoCapabilities } from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/**
 * Reads the Settings «Incognito» defaults on demand (specs/incognito-session.md). Optional services
 * keep the composer usable in harnesses without a ServiceProvider: they start locked down.
 */
export function useIncognitoDefaultsReader(): () => Promise<IncognitoCapabilities> {
  const services = useOptionalServices();
  return useCallback(async () => {
    try {
      const settings = await services?.settingService.get();
      return resolveIncognitoDefaults(settings?.incognitoDefaults);
    } catch (error) {
      logger.warn("Incognito defaults unavailable; using lockdown", { error });
      return resolveIncognitoDefaults(undefined);
    }
  }, [services]);
}
