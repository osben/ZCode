import { createHash, randomBytes } from "node:crypto";
import { link, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "../node/privateFilePersistence.js";
import type { CredentialKeyStore } from "./contract.js";

// Upstream 3.18.2 (reconstructed): key fingerprints, the Linux private-secret publisher and the
// data-directory key share. Split from systemCredentialCipher.ts only to keep each file small.

export const SOURCE_FILE = "credential-source";
export const OS_SOURCE = "os\n";
const KEY_BYTES = 32;
const OS_CIPHERTEXT_PREFIX = "enc:v2:os:";
const FINGERPRINT_PATTERN = /^[a-f0-9]{24}$/;
export const ENCODED_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function keyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function encodedKeyFingerprint(encoded: string): string | null {
  return ENCODED_KEY_PATTERN.test(encoded)
    ? keyFingerprint(Buffer.from(encoded, "base64url"))
    : null;
}

async function readOsKeyFingerprints(filePath: string): Promise<Set<string>> {
  const raw = await readFile(filePath, "utf8").catch((error) => {
    if ((error as { code?: string }).code === "ENOENT") return "";
    throw error;
  });
  const fingerprints = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    return fingerprints;
  }
  if (!parsed || typeof parsed !== "object") return fingerprints;
  for (const value of Object.values(parsed)) {
    if (typeof value !== "string" || !value.startsWith(OS_CIPHERTEXT_PREFIX)) continue;
    const fingerprint = value.slice(OS_CIPHERTEXT_PREFIX.length).split(":")[0];
    if (fingerprint && FINGERPRINT_PATTERN.test(fingerprint)) fingerprints.add(fingerprint);
  }
  return fingerprints;
}

async function isOsSourcePinned(filePath: string): Promise<boolean> {
  const pinned = await readFile(join(dirname(filePath), SOURCE_FILE), "utf8").catch((error) => {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  });
  return pinned === OS_SOURCE;
}

/** Write fully to a temporary file, then publish exclusively; a racing creator keeps its file. */
export async function publishPrivateSecretFile(secretPath: string): Promise<void> {
  const temporary = `${secretPath}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, randomBytes(KEY_BYTES).toString("base64url"), {
      mode: 0o600,
      flag: "wx",
    });
    await link(temporary, secretPath).catch((error) => {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    });
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface ShareOsKeyParams {
  /** Resolved source credentials path. */
  sourcePath: string;
  /** Resolved credentials path under the copied data root. */
  targetPath: string;
  target: CredentialKeyStore;
  loadSourceKey(): Promise<{ key: Buffer; source: "os" | "env" }>;
  unavailable(): Error;
}

/**
 * The OS keyring entry is keyed by the credentials path; a copied data directory needs the same key
 * under its new path, or every copied enc:v2:os: value becomes undecryptable after the move.
 */
export async function shareOsKeyWithCopiedCredentials(params: ShareOsKeyParams): Promise<void> {
  const { sourcePath, targetPath, target, unavailable } = params;
  if (targetPath === sourcePath) return;
  const [sourceFingerprints, targetFingerprints, sourcePinned, targetPinned] = await Promise.all([
    readOsKeyFingerprints(sourcePath),
    readOsKeyFingerprints(targetPath),
    isOsSourcePinned(sourcePath),
    isOsSourcePinned(targetPath),
  ]);
  let expected: string | null;
  if (targetFingerprints.size === 1) {
    const [only] = targetFingerprints;
    if (!only || !sourceFingerprints.has(only)) return;
    expected = only;
  } else if (targetFingerprints.size === 0 && targetPinned && sourcePinned) {
    expected = null;
  } else {
    return;
  }
  const existing = await target.get().catch(() => {
    throw unavailable();
  });
  const existingFingerprint = existing === null ? null : encodedKeyFingerprint(existing);
  if (existingFingerprint !== null && (expected === null || existingFingerprint === expected)) {
    return;
  }
  const { key, source } = await params.loadSourceKey();
  if (source !== "os" || (expected !== null && keyFingerprint(key) !== expected)) return;
  const encoded = key.toString("base64url");
  await withFileLock(`${targetPath}.keyring`, async () => {
    try {
      const current = await target.get();
      if (current === encoded) return;
      if (current !== null) throw unavailable();
      await target.set(encoded);
      if ((await target.get()) !== encoded) throw unavailable();
    } catch {
      throw unavailable();
    }
  });
}
