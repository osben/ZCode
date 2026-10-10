/**
 * useServices — provides IServiceAccessor through React Context.
 *
 * Replaces prop drilling so components can access services directly through useServices().
 */
import { createContext, useContext, type ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";

const ServiceContext = createContext<IServiceAccessor | null>(null);

export function ServiceProvider({
  services,
  children,
}: {
  services: IServiceAccessor;
  children: ReactNode;
}) {
  return <ServiceContext.Provider value={services}>{children}</ServiceContext.Provider>;
}

export function useServices(): IServiceAccessor {
  const ctx = useContext(ServiceContext);
  if (!ctx) {
    throw new Error("useServices 必须在 ServiceProvider 内使用");
  }
  return ctx;
}

export function useOptionalServices(): IServiceAccessor | null {
  return useContext(ServiceContext);
}
