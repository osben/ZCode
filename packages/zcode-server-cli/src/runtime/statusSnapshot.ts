import { readFile, rename, writeFile } from "node:fs/promises";
import { serverStatusSchema, type ServerStatus } from "../contracts.js";
import { resolveServerLayout, type ServerLayout } from "./paths.js";

type PersistedStatusRead =
  | { state: "valid"; status: ServerStatus }
  | { state: "missing"; status: null }
  | { state: "invalid" | "unreadable"; status: null; error: unknown };

export async function readPersistedStatusDetailed(
  layout: ServerLayout,
): Promise<PersistedStatusRead> {
  // A missing file means offline; corrupt JSON/schema means the observation is untrustworthy. Do not collapse both into null,
  // or uninstall/stop could mistake "cannot confirm stopped" for "already stopped".
  let raw: string;
  try {
    raw = await readFile(layout.statusFile, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { state: "missing", status: null };
    }
    return { state: "unreadable", status: null, error };
  }
  try {
    return { state: "valid", status: serverStatusSchema.parse(JSON.parse(raw)) };
  } catch (error: unknown) {
    return { state: "invalid", status: null, error };
  }
}

export async function readPersistedStatus(
  layout = resolveServerLayout(),
): Promise<ServerStatus | null> {
  return (await readPersistedStatusDetailed(layout)).status;
}

export function createStatusPersister<T>(
  statusFile: string,
  getStatus: () => T,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let inFlight: Promise<void> = Promise.resolve();
  return async () => {
    // A single failed status write must not leave the write queue permanently rejected and cause all later lifecycle snapshots
    // to be lost; status.json is only an observation snapshot, so log a warning and continue the service lifecycle on failure.
    inFlight = inFlight
      .then(async () => {
        const temporary = `${statusFile}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(getStatus(), null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, statusFile);
      })
      .catch((error: unknown) => onError(error));
    await inFlight;
  };
}
