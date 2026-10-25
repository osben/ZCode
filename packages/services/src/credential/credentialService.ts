import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, backupCorruptFile, withFileLock } from "@zcode/shared/node";
import {
  credentialKeySchema,
  credentialRecordSchema,
  credentialValueSchema,
  formatZodError,
  isCredentialDecryptError,
} from "@zcode/shared";
import type { ICredentialService } from "./credential.js";
import {
  createCredentialCipherProvider,
  type CredentialCipherProvider,
} from "./providers/credentialCipherProvider.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";

/**
 * Credential storage path
 *
 * The persisted format is still JSON, but values are encrypted before writing and decrypted automatically when read.
 * This can later switch to Electron safeStorage (Keychain) for key management;
 * then the host process will need to request encrypt/decrypt from the main process.
 */
const logger = createServiceLogger("credentialService");

function getCredentialsDir() {
  return getAppConfigDir();
}

function getCredentialsFile() {
  return join(getCredentialsDir(), "credentials.json");
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function readAll(credentialsFile = getCredentialsFile()): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(credentialsFile, "utf-8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read ZCode credentials: ${credentialsFile}`, { cause: error });
  }

  try {
    const rawValue = JSON.parse(raw);
    const result = credentialRecordSchema.safeParse(rawValue);
    if (!result.success) {
      throw new Error(formatZodError(result.error));
    }
    return result.data;
  } catch (error) {
    // Treating corrupted JSON/schema as an empty store and continuing to save would erase other OAuth and login credentials.
    // Preserve the corrupted-file evidence and propagate the error; do not overwrite automatically.
    const backupPath = await backupCorruptFile(credentialsFile).catch(() => undefined);
    // Service-layer logs must go through the leveled logger so corrupted-credential warnings follow
    // the same production persistence/collection policy without recording credential contents.
    logger.warn(undefined, "read failed; refusing to overwrite corrupt credential store", {
      backupPath,
      credentialsFile,
    });
    throw new Error(`ZCode credentials are corrupt: ${credentialsFile}`, { cause: error });
  }
}

async function writeAll(credentialsFile: string, data: Record<string, string>): Promise<void> {
  // The credential path was previously bound to homedir() at module load,
  // so Windows tests continued writing to the real user directory after changing HOME, breaking isolation.
  await atomicWritePrivateTextFile(credentialsFile, `${JSON.stringify(data, null, 2)}\n`);
}

interface CredentialServiceDependencies {
  cipherProvider?: CredentialCipherProvider;
  /** Host-private notification that persistence succeeded; not exposed through the Renderer/RPC credential interface. */
  onDidMutate?: (event: { operation: "save" | "delete"; key: string }) => void;
}

/** Host 私有缓存恢复能力，不进入 Renderer 的 ICredentialService 契约。 */
export interface LocalCredentialService extends ICredentialService {
  recoverUnreadable(key: string, assertCurrent: () => void): Promise<string | null>;
  save(key: string, value: string, assertCurrent?: () => void): Promise<void>;
  delete(key: string, assertCurrent?: () => void): Promise<void>;
}

export function createCredentialService(
  dependencies: CredentialServiceDependencies = {},
): LocalCredentialService {
  const cipherProvider = dependencies.cipherProvider ?? createCredentialCipherProvider();

  return {
    async recoverUnreadable(key, assertCurrent) {
      const validatedKey = credentialKeySchema.parse(key);
      const credentialsFile = getCredentialsFile();
      let deleted = false;
      const value = await withFileLock(credentialsFile, async () => {
        assertCurrent();
        const creds = await readAll(credentialsFile);
        assertCurrent();
        const rawValue = creds[validatedKey];
        if (rawValue === undefined) return null;
        try {
          return cipherProvider.decrypt(rawValue);
        } catch (error) {
          if (!isCredentialDecryptError(error)) throw error;
        }
        // 缓存复核与删除必须共用跨进程锁；分别 load/delete 会误删另一窗口已修复的记录。
        // 此处仅处理调用方明确标记的派生缓存，不能因缓存损坏清理有效 OAuth 登录。
        assertCurrent();
        delete creds[validatedKey];
        await writeAll(credentialsFile, creds);
        deleted = true;
        return null;
      });
      if (deleted) dependencies.onDidMutate?.({ operation: "delete", key: validatedKey });
      return value;
    },

    async load(key: string): Promise<string | null> {
      const validatedKey = credentialKeySchema.parse(key);
      const creds = await readAll();
      const rawValue = creds[validatedKey];
      if (rawValue === undefined) {
        return null;
      }

      return cipherProvider.decrypt(rawValue);
    },

    async save(key: string, value: string, assertCurrent?: () => void): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      const validatedValue = credentialValueSchema.parse(value);
      const encryptedValue = cipherProvider.encrypt(validatedValue);
      const credentialsFile = getCredentialsFile();
      // The desktop host and CLI adapter are separate processes, so an in-process queue cannot prevent lost updates during whole-file
      // read-modify-write. The shared directory lock must cover the full read, update, and atomic-replace operation.
      await withFileLock(credentialsFile, async () => {
        const creds = await readAll(credentialsFile);
        // 请求可能在等待文件锁时失效，不能只依赖调用方进入 IO 前的代次检查。
        assertCurrent?.();
        creds[validatedKey] = encryptedValue;
        await writeAll(credentialsFile, creds);
      });
      dependencies.onDidMutate?.({ operation: "save", key: validatedKey });
    },

    async delete(key: string, assertCurrent?: () => void): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      const credentialsFile = getCredentialsFile();
      await withFileLock(credentialsFile, async () => {
        const creds = await readAll(credentialsFile);
        assertCurrent?.();
        delete creds[validatedKey];
        await writeAll(credentialsFile, creds);
      });
      dependencies.onDidMutate?.({ operation: "delete", key: validatedKey });
    },
  };
}
