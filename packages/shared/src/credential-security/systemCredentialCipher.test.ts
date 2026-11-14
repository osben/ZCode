import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialKeyStore } from "./contract.js";

type CipherModule = typeof import("./systemCredentialCipher.js");

// The fallback flag and the default key cache are module state; each test loads a fresh module.
async function loadModule(): Promise<CipherModule> {
  vi.resetModules();
  return import("./systemCredentialCipher.js");
}

function memoryStore(initial: string | null = null): CredentialKeyStore & { value: string | null } {
  const store = {
    value: initial,
    async get() {
      return store.value;
    },
    async set(value: string) {
      store.value = value;
    },
  };
  return store;
}

function failingStore(): CredentialKeyStore {
  return {
    get: () => Promise.reject(new Error("secret service unavailable")),
    set: () => Promise.reject(new Error("secret service unavailable")),
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-cipher-fork-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("private-file key fallback (upstream 3.18.2)", () => {
  it("creates a private credential-secret when the keyring fails for a brand-new key", async () => {
    const mod = await loadModule();
    const onFallback = vi.fn();
    expect(mod.enablePrivateFileKeyFallback({ onFallback })).toBe(true);
    const filePath = join(root, "credentials.json");
    const cipher = mod.createSystemCredentialCipher({
      filePath,
      env: {},
      keyStore: failingStore(),
    });

    const sealed = await cipher.encrypt("secret-value");

    expect(sealed.startsWith("enc:v2:env:")).toBe(true);
    expect(await cipher.decrypt(sealed)).toBe("secret-value");
    expect(onFallback).toHaveBeenCalledTimes(1);
    const secret = await stat(join(root, "credential-secret"));
    if (process.platform !== "win32") expect(secret.mode & 0o777).toBe(0o600);
  });

  it("keeps failing when the directory is pinned to the OS keyring", async () => {
    const mod = await loadModule();
    mod.enablePrivateFileKeyFallback();
    await writeFile(join(root, "credential-source"), "os\n");
    const cipher = mod.createSystemCredentialCipher({
      filePath: join(root, "credentials.json"),
      env: {},
      keyStore: failingStore(),
    });

    await expect(cipher.encrypt("value")).rejects.toMatchObject({
      code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
    });
    await expect(stat(join(root, "credential-secret"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps failing when OS-sealed data already exists", async () => {
    const mod = await loadModule();
    mod.enablePrivateFileKeyFallback();
    const filePath = join(root, "credentials.json");
    await writeFile(filePath, JSON.stringify({ k: `enc:v2:os:${"a".repeat(24)}:payload` }));
    const cipher = mod.createSystemCredentialCipher({
      filePath,
      env: {},
      keyStore: failingStore(),
    });

    await expect(cipher.encrypt("value")).rejects.toMatchObject({
      code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
    });
    await expect(stat(join(root, "credential-secret"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is off unless enabled", async () => {
    const mod = await loadModule();
    const cipher = mod.createSystemCredentialCipher({
      filePath: join(root, "credentials.json"),
      env: {},
      keyStore: failingStore(),
    });

    await expect(cipher.encrypt("value")).rejects.toMatchObject({
      code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
    });
  });

  it("refuses to enable after a key was cached", async () => {
    const mod = await loadModule();
    // A default credential-secret fills the shared key cache without touching the real keyring.
    await writeFile(join(root, "credential-secret"), "s".repeat(40), { mode: 0o600 });
    const cipher = mod.createSystemCredentialCipher({
      filePath: join(root, "credentials.json"),
      env: {},
    });
    await cipher.encrypt("value");

    expect(mod.enablePrivateFileKeyFallback()).toBe(false);
  });
});

describe("shareKeyWithCopiedCredentials (upstream 3.18.2)", () => {
  async function sealedSource(mod: CipherModule) {
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    const filePath = join(sourceDir, "credentials.json");
    const store = memoryStore();
    const cipher = mod.createSystemCredentialCipher({ filePath, env: {}, keyStore: store });
    const sealed = await cipher.encrypt("token");
    await writeFile(filePath, JSON.stringify({ token: sealed }));
    return { cipher, store, sourceDir, sealed };
  }

  async function copyTo(sourceDir: string): Promise<string> {
    const targetDir = join(root, "target");
    await mkdir(targetDir);
    for (const name of ["credentials.json", "credential-source"]) {
      await writeFile(join(targetDir, name), await readFile(join(sourceDir, name)));
    }
    return join(targetDir, "credentials.json");
  }

  it("copies the source key to an empty target entry when fingerprints match", async () => {
    const mod = await loadModule();
    const { cipher, store, sourceDir, sealed } = await sealedSource(mod);
    const targetPath = await copyTo(sourceDir);
    const target = memoryStore();

    await cipher.shareKeyWithCopiedCredentials(targetPath, target);

    expect(target.value).toBe(store.value);
    const moved = mod.createSystemCredentialCipher({
      filePath: targetPath,
      env: {},
      keyStore: target,
    });
    expect(await moved.decrypt(sealed)).toBe("token");
  });

  it("skips a target whose ciphertexts were sealed with another key", async () => {
    const mod = await loadModule();
    const { cipher, sourceDir } = await sealedSource(mod);
    const targetPath = await copyTo(sourceDir);
    await writeFile(targetPath, JSON.stringify({ token: `enc:v2:os:${"b".repeat(24)}:payload` }));
    const target = memoryStore();

    await cipher.shareKeyWithCopiedCredentials(targetPath, target);

    expect(target.value).toBeNull();
  });

  it("leaves a target entry that already holds the same key", async () => {
    const mod = await loadModule();
    const { cipher, store, sourceDir } = await sealedSource(mod);
    const targetPath = await copyTo(sourceDir);
    const target = memoryStore(store.value);
    const set = vi.spyOn(target, "set");

    await cipher.shareKeyWithCopiedCredentials(targetPath, target);

    expect(set).not.toHaveBeenCalled();
  });

  it("fails instead of overwriting a target entry that holds a different key", async () => {
    const mod = await loadModule();
    const { cipher, sourceDir } = await sealedSource(mod);
    const targetPath = await copyTo(sourceDir);
    const other = Buffer.alloc(32, 7).toString("base64url");
    const target = memoryStore(other);

    await expect(cipher.shareKeyWithCopiedCredentials(targetPath, target)).rejects.toMatchObject({
      code: "CREDENTIAL_SECURE_STORAGE_UNAVAILABLE",
    });
    expect(target.value).toBe(other);
  });
});
