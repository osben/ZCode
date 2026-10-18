import {
  LSP_METHOD_CONFIGURATION,
  LSP_METHOD_REGISTER_CAPABILITY,
  LSP_METHOD_UNREGISTER_CAPABILITY,
  LSP_METHOD_WORK_DONE_PROGRESS_CREATE,
  LSP_METHOD_WORKSPACE_FOLDERS,
  LSP_JSON_RPC_METHOD_NOT_FOUND,
} from "./constants.js";
import { JsonRpcResponseError } from "./json-rpc.js";
import type { LspWorkspaceFolder } from "./client-capabilities.js";

interface Registration {
  method: string;
  registerOptions?: unknown;
}

/**
 * Dynamic capability registrations for one server process. The server's `capabilities` view merges these,
 * so a late `textDocument/diagnostic` registration is visible as `diagnosticProvider`.
 */
export class LspDynamicRegistry {
  private readonly registrations = new Map<string, Registration>();

  register(items: unknown): void {
    for (const item of asArray(items)) {
      const record = asRecord(item);
      if (typeof record.id !== "string" || typeof record.method !== "string") continue;
      this.registrations.set(record.id, {
        method: record.method,
        registerOptions: record.registerOptions,
      });
    }
  }

  /** LSP spells this field `unregisterations`; accept the corrected spelling too. */
  unregister(items: unknown): void {
    for (const item of asArray(items)) {
      const record = asRecord(item);
      if (typeof record.id === "string") this.registrations.delete(record.id);
    }
  }

  hasMethod(method: string): boolean {
    for (const registration of this.registrations.values()) {
      if (registration.method === method) return true;
    }
    return false;
  }

  /** Register options of the first dynamic registration for `method`; undefined when there is none. */
  optionsFor(method: string): { options: unknown } | undefined {
    for (const registration of this.registrations.values()) {
      if (registration.method === method) {
        return { options: registration.registerOptions ?? {} };
      }
    }
    return undefined;
  }
}

export interface ServerRequestContext {
  settings: unknown;
  workspaceFolders: LspWorkspaceFolder[];
  registry: LspDynamicRegistry;
}

/** Answers server-to-client requests. Unknown methods get JSON-RPC -32601. */
export function handleServerRequest(
  context: ServerRequestContext,
  method: string,
  params: unknown,
): unknown {
  switch (method) {
    case LSP_METHOD_CONFIGURATION:
      return asArray(asRecord(params).items).map((item) =>
        lookupSettingsSection(context.settings, asRecord(item).section),
      );
    case LSP_METHOD_REGISTER_CAPABILITY:
      context.registry.register(asRecord(params).registrations);
      return null;
    case LSP_METHOD_UNREGISTER_CAPABILITY: {
      const record = asRecord(params);
      context.registry.unregister(record.unregisterations ?? record.unregistrations);
      return null;
    }
    case LSP_METHOD_WORK_DONE_PROGRESS_CREATE:
      return null;
    case LSP_METHOD_WORKSPACE_FOLDERS:
      return context.workspaceFolders;
    default:
      throw new JsonRpcResponseError(
        LSP_JSON_RPC_METHOD_NOT_FOUND,
        `client does not implement ${method}`,
      );
  }
}

/** Dot-path lookup (`typescript.format.enable`). Missing sections answer null; no section means all settings. */
export function lookupSettingsSection(settings: unknown, section: unknown): unknown {
  if (section === undefined || section === null || section === "") {
    return settings ?? null;
  }
  if (typeof section !== "string") return null;
  let current: unknown = settings;
  for (const segment of section.split(".")) {
    const record = asRecord(current);
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return null;
    current = record[segment];
  }
  return current ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
