// Computer Use Helper macOS permission service — services-side descriptor registration.
//
// As part of the single-package merge the type definitions + functional helpers
// (CuaPermissionStatus, CuaPermissionStatusResult, isCuaPermissionStatusAvailable,
// shouldRunCuaScreenCaptureProbe, ICuaPermissionService interface, etc.) moved
// to @zcode/zcode-cua/src/broker/ports.ts. The descriptor registration itself stays in
// services (host control plane — depends on services' createServiceDescriptor
// + @zcode/shared ServiceChannels), so services internal callers (node.ts,
// accessor.ts, services/index.ts) and ui consumers (via @zcode/services root
// export) keep importing `ICuaPermissionService` from this exact path.
//
// The producer owns only the type contract; services continues to create the VALUE descriptor
// through createServiceDescriptor, avoiding a reverse dependency from the producer to the RPC/service registry.

import { ServiceChannels } from "@zcode/shared";

import { createServiceDescriptor } from "../descriptors.js";

// Type layer — type-only imports from the consolidated package (erased by TS
// at compile time; Vite never resolves @zcode/zcode-cua for these).
import type {
  CuaPermissionState,
  CuaPermissionStatus,
  CuaPermissionStatusUnavailable,
  CuaPermissionStatusResult,
  CuaPermissionStatusQueryOptions,
  CuaPermissionRestartResult,
  CuaPermissionRestartOptions,
  ICuaPermissionService as BrokerICuaPermissionService,
} from "@zcode/zcode-cua/broker";

// Re-export types for consumers.
export type {
  CuaPermissionState,
  CuaPermissionStatus,
  CuaPermissionStatusUnavailable,
  CuaPermissionStatusResult,
  CuaPermissionStatusQueryOptions,
  CuaPermissionRestartResult,
  CuaPermissionRestartOptions,
};

// Reuse the value predicate only through the producer's pure ports subpath. Do not import it from the Node-only broker barrel,
// or the renderer bundle would include process/node:path/node:crypto; do not duplicate the implementation,
// or the privacy contract about whether omitting options actively captures the screen would drift again.
export {
  isCuaPermissionStatusAvailable,
  shouldRunCuaScreenCaptureProbe,
} from "@zcode/zcode-cua/broker/ports";

export interface ICuaPermissionService extends BrokerICuaPermissionService {}

export const ICuaPermissionService = createServiceDescriptor<BrokerICuaPermissionService>(
  ServiceChannels.CuaPermission,
);
