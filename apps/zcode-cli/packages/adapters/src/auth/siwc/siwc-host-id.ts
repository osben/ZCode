import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ZCODE_DATA_BASE_DIR_ENV_KEY = "ZCODE_DATA_BASE_DIR";
const SIWC_HOST_ID_FILE_NAME = "siwc-host-id.txt";

export interface SiwcHostIdResolution {
  /** urn:uuid: URI; stable per host, reused across sign-ins, not a secret. */
  readonly hostId: string;
  readonly path: string;
  readonly created: boolean;
}

export interface SiwcHostIdOptions {
  readonly baseDir?: string;
  readonly env?: Record<string, string | undefined>;
  readonly filePath?: string;
  /** Injectable for tests. */
  readonly generateUuid?: () => string;
}

/**
 * Resolve the stable per-host SIWC agent id. Generated once as a urn:uuid: URI and persisted
 * (plain text, 0600) next to the shared credentials; reused for every later sign-in.
 */
export async function resolveSiwcHostId(
  options: SiwcHostIdOptions = {},
): Promise<SiwcHostIdResolution> {
  const path = options.filePath ?? resolveSiwcHostIdFilePath(options);
  try {
    const existing = (await readFile(path, "utf-8")).trim();
    if (existing) {
      return { hostId: existing, path, created: false };
    }
  } catch (error) {
    if (!isENOENT(error)) throw error;
  }
  const generateUuid = options.generateUuid ?? randomUUID;
  const hostId = `urn:uuid:${generateUuid()}`;
  // The .zcode/v2 directory usually exists already (shared credentials); create it when it
  // does not so first-run login never fails on a missing parent directory.
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${hostId}\n`, { encoding: "utf-8", mode: 0o600 });
  return { hostId, path, created: true };
}

export function resolveSiwcHostIdFilePath(options: SiwcHostIdOptions = {}): string {
  if (options.filePath) return resolveUserPath(options.filePath);
  const env = options.env ?? process.env;
  const baseDir = options.baseDir ?? env[ZCODE_DATA_BASE_DIR_ENV_KEY] ?? homedir();
  return join(resolveUserPath(baseDir), ".zcode", "v2", SIWC_HOST_ID_FILE_NAME);
}

function isENOENT(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function resolveUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return resolve(value);
}
