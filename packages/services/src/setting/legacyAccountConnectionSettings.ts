import type {
  ProviderFamilyConnectionSelectionSettings,
  ProviderFamilyDomain,
} from "@zcode/shared";
import { readFile } from "node:fs/promises";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface LegacyTeamConnection {
  readonly family: ProviderFamilyDomain;
  readonly productId: string;
  readonly projectId: string;
}

/** Only the migrator interprets legacy keys; organization details are injected by the Host's read-only OAuth query. Remove after the legacy version is retired. */
export function readIncompleteLegacyTeamConnections(value: unknown): LegacyTeamConnection[] {
  if (!needsLegacyAccountConnectionMigration(value)) return [];
  const raw = record(value);
  const modes = record(raw.modelProviderFamilyModes);
  const keys = record(raw.modelProviderFamilySelectedKeys);
  return (["zai", "bigmodel"] as const).flatMap((family) => {
    if (modes[family] === "apiKey") return [];
    const prefix = `team-plan:builtin:${family}-coding-plan:`;
    const key = typeof keys[family] === "string" ? keys[family].trim() : "";
    if (!key.startsWith(prefix)) return [];
    try {
      const parts = key
        .slice(prefix.length)
        .split(":")
        .map((part) => decodeURIComponent(part).trim());
      if (parts.length !== 2 || parts.some((part) => !part)) return [];
      return [{ family, productId: parts[0]!, projectId: parts[1]! }];
    } catch {
      return [];
    }
  });
}

export async function readLegacyAccountConnectionSettingsFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  try {
    return record(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function needsLegacyAccountConnectionMigration(value: unknown): boolean {
  const raw = record(value);
  return (
    !Object.hasOwn(raw, "providerFamilyConnectionSelections") &&
    (Object.hasOwn(raw, "modelProviderFamilySelectedKeys") ||
      Object.hasOwn(raw, "modelProviderFamilyModes"))
  );
}

/** Import legacy connections only at the settings-file read boundary; runtime code must not interpret old navigation keys. */
export function migrateLegacyAccountConnectionSettings(value: unknown): unknown {
  if (!needsLegacyAccountConnectionMigration(value)) return value;
  const raw = record(value);
  const modes = record(raw.modelProviderFamilyModes);
  const keys = record(raw.modelProviderFamilySelectedKeys);
  const selections: ProviderFamilyConnectionSelectionSettings = {};
  for (const family of ["zai", "bigmodel"] as const) {
    // Provider config migration owns API instances; the legacy API mode is not an account plan.
    if (modes[family] === "apiKey") continue;
    const key = typeof keys[family] === "string" ? keys[family].trim() : "";
    if (key === `coding-plan:builtin:${family}-start-plan`) {
      selections[family] = { kind: "start-plan" };
    } else if (key === `coding-plan:builtin:${family}-coding-plan`) {
      selections[family] = { kind: "individual-coding-plan" };
    } else {
      const prefix = `team-plan:builtin:${family}-coding-plan:`;
      if (!key.startsWith(prefix)) continue;
      try {
        const parts = key
          .slice(prefix.length)
          .split(":")
          .map((part) => decodeURIComponent(part).trim());
        // A legacy project-only key cannot determine the organization; preserve the original field instead of fabricating a new Team identity.
        if (parts.length !== 3 || parts.some((part) => !part)) continue;
        const [productId, organizationId, projectId] = parts as [string, string, string];
        selections[family] = { kind: "team-coding-plan", productId, organizationId, projectId };
      } catch {
        // Corrupt encoding affects only this entry; it must not make all of setting.json fall back to defaults.
      }
    }
  }
  return { ...raw, providerFamilyConnectionSelections: selections };
}

/** Retain legacy fields only for rollback; do not expose them through AppSettings or use them in current runtime decisions. Remove after the legacy version is retired. */
export function retainLegacyAccountConnectionFields(value: unknown): Record<string, unknown> {
  const raw = record(value);
  return Object.fromEntries(
    ["modelProviderFamilyModes", "modelProviderFamilySelectedKeys"]
      .filter((key) => Object.hasOwn(raw, key))
      .map((key) => [key, raw[key]]),
  );
}
