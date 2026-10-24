import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sourceServerConnectionStateSnapshotSchema,
  type ConnectionProfile,
  type RemoteTarget,
} from "@zcode/shared";
import {
  createSourceServerTransportAdapter,
  type SourceServerTransportAdapter,
} from "@zcode/server/source-server";
import type { IRemoteBackend, KnownHostsFiles, SSHHostKeyFailure } from "@zcode/server/remote";
import { normalizeSSHConnectError } from "@zcode/server/remote/sshAuth.js";
import type { IServiceAccessor } from "@zcode/services";
import { SourceServerConnectionManager } from "../src/host/sourceServerConnectionManager.js";

const profileId = "0b6f6d1e-5d0c-4b8e-9f43-2b7f2b3f6a11";
const profile: ConnectionProfile = {
  profileId,
  transport: "ssh",
  target: { kind: "ssh", host: "dev.example", port: 2222, username: "alice" },
  createdAt: 1,
};
const target: RemoteTarget = profile.target;

// Fake key material only; never a real host key.
const observedKey: SSHHostKeyFailure = {
  kind: "unknown",
  host: "dev.example",
  port: 2222,
  keyType: "ssh-ed25519",
  publicKey: Buffer.from("fake-host-key-blob").toString("base64"),
  fingerprint: "SHA256:fakeFingerprintForTests",
};

function hostKeyError(hostKey: SSHHostKeyFailure): Error {
  return Object.assign(new Error("SSH host key is not in known_hosts"), {
    code: hostKey.kind === "unknown" ? "remote-host-key-unknown" : "remote-host-key-changed",
    retryable: false,
    hostKey,
  });
}

function createFailingAdapter(error: Error): SourceServerTransportAdapter {
  return {
    kind: "ssh",
    probe: vi.fn(async () => {
      throw error;
    }),
    installOrUpdate: vi.fn(),
    ensureDaemon: vi.fn(),
    openChannel: vi.fn(async () => new PassThrough()),
    exec: vi.fn(),
    createFileTransfer: vi.fn(() => ({ exec: vi.fn(), upload: vi.fn(async () => {}) })),
  };
}

describe("SourceServerConnectionManager host key trust", () => {
  let dir: string;
  let knownHostsFiles: KnownHostsFiles;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "zcode-host-key-trust-"));
    knownHostsFiles = { userFile: join(dir, ".ssh", "known_hosts"), globalFiles: [] };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function createManager(error: Error) {
    return new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn() },
      createAdapter: () => createFailingAdapter(error),
      knownHostsFiles,
    });
  }

  it("publishes the unknown key's type and fingerprint and keeps it for the trust step", async () => {
    const manager = createManager(hostKeyError(observedKey));
    try {
      await expect(manager.connect({ profile, target })).rejects.toMatchObject({
        code: "remote-host-key-unknown",
      });
      const state = manager.getStateByProfile(profileId);
      expect(state).toMatchObject({
        state: "failed",
        errorCode: "remote-host-key-unknown",
        retryable: false,
        hostKeyPreview: { keyType: "ssh-ed25519", fingerprint: observedKey.fingerprint },
      });
      expect(JSON.stringify(state)).not.toContain(observedKey.publicKey);
      // The snapshot crosses strict RPC schemas; the preview must parse.
      expect(sourceServerConnectionStateSnapshotSchema.parse(state)).toEqual(state);
    } finally {
      manager.dispose();
    }
  });

  it("trusts only the fingerprint that was shown and appends it to known_hosts", async () => {
    const manager = createManager(hostKeyError(observedKey));
    try {
      await manager.connect({ profile, target }).catch(() => undefined);
      await expect(manager.trustHostKey(profileId, "SHA256:other")).rejects.toMatchObject({
        code: "remote-host-key-unknown",
      });
      await manager.trustHostKey(profileId, observedKey.fingerprint);
      expect(await readFile(knownHostsFiles.userFile, "utf8")).toBe(
        `[dev.example]:2222 ssh-ed25519 ${observedKey.publicKey}\n`,
      );
      expect(manager.getStateByProfile(profileId).hostKeyPreview).toBeUndefined();
      // The pending key is consumed; a second trust needs a new connect attempt.
      await expect(manager.trustHostKey(profileId, observedKey.fingerprint)).rejects.toMatchObject({
        code: "remote-host-key-unknown",
      });
    } finally {
      manager.dispose();
    }
  });

  it("does not write a key whose pending trust was invalidated while the write waited", async () => {
    const manager = createManager(hostKeyError(observedKey));
    const lockPath = `${knownHostsFiles.userFile}.zcode-lock`;
    try {
      await manager.connect({ profile, target }).catch(() => undefined);
      // Another window's Host holds the known_hosts lock, so the trust waits; meanwhile the profile is removed.
      await mkdir(join(dir, ".ssh"), { recursive: true });
      await writeFile(lockPath, "other-host");
      const trusting = manager.trustHostKey(profileId, observedKey.fingerprint);
      const assertion = expect(trusting).rejects.toMatchObject({ code: "remote-host-key-unknown" });
      manager.removeProfile(profileId);
      await unlink(lockPath);
      await assertion;
      await expect(readFile(knownHostsFiles.userFile, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      manager.dispose();
    }
  });

  it("a changed key offers no trust step and stops as not retryable", async () => {
    const manager = createManager(hostKeyError({ ...observedKey, kind: "changed" }));
    try {
      await expect(manager.connect({ profile, target })).rejects.toMatchObject({
        code: "remote-host-key-changed",
      });
      const state = manager.getStateByProfile(profileId);
      expect(state).toMatchObject({ errorCode: "remote-host-key-changed", retryable: false });
      expect(state.hostKeyPreview).toBeUndefined();
      await expect(manager.trustHostKey(profileId, observedKey.fingerprint)).rejects.toMatchObject({
        code: "remote-host-key-unknown",
      });
    } finally {
      manager.dispose();
    }
  });

  it("a later attempt that fails for another reason drops the pending key", async () => {
    const errors = [hostKeyError(observedKey), new Error("connect ECONNREFUSED")];
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn() },
      createAdapter: () => ({
        ...createFailingAdapter(new Error("unused")),
        probe: vi.fn(async () => {
          throw errors.shift();
        }),
      }),
      knownHostsFiles,
    });
    try {
      await manager.connect({ profile, target }).catch(() => undefined);
      await manager.connect({ profile, target }).catch(() => undefined);
      await expect(manager.trustHostKey(profileId, observedKey.fingerprint)).rejects.toMatchObject({
        code: "remote-host-key-unknown",
      });
    } finally {
      manager.dispose();
    }
  });

  it("finds the key through the real transport adapter probe chain", async () => {
    // normalizeSSHConnectError is what SSHBackend raises when its verifier refuses the key.
    const refused = normalizeSSHConnectError(new Error("Host denied (verification failed)"), {
      hostKeyFailure: observedKey,
    });
    const backend = {
      exec: vi.fn(async () => {
        throw refused;
      }),
      dispose: vi.fn(),
    } as unknown as IRemoteBackend;
    const manager = new SourceServerConnectionManager({
      directory: { recordHandshake: vi.fn() },
      createAdapter: (kind) =>
        createSourceServerTransportAdapter(kind, { createBackend: async () => backend }),
      knownHostsFiles,
    });
    try {
      await expect(manager.connect({ profile, target })).rejects.toMatchObject({
        code: "remote-host-key-unknown",
      });
      expect(manager.getStateByProfile(profileId).hostKeyPreview).toEqual({
        keyType: "ssh-ed25519",
        fingerprint: observedKey.fingerprint,
      });
    } finally {
      manager.dispose();
    }
  });

  it.each(["unknown", "changed"] as const)(
    "stops automatic recovery when a reconnect meets a %s host key",
    async (kind) => {
      vi.useFakeTimers();
      try {
        let probeCount = 0;
        const adapter: SourceServerTransportAdapter = {
          ...createFailingAdapter(new Error("unused")),
          probe: vi.fn(async () => {
            probeCount += 1;
            if (probeCount > 1) throw hostKeyError({ ...observedKey, kind });
            return { platform: "linux", arch: "x64", installed: true, installedVersion: "3.8.0" };
          }),
          ensureDaemon: vi.fn(async () => ({ port: 43123, ingressToken: "token" })),
        };
        const closeHandlers: Array<(event: { code: number; reason: string }) => void> = [];
        const compatibility = {
          schemaVersion: 1,
          productVersion: "3.8.0",
          minCompatibleVersion: "3.8.0",
        };
        const manager = new SourceServerConnectionManager({
          directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
          createAdapter: () => adapter,
          connectServer: vi.fn(
            async (options: { onClose?: (event: { code: number; reason: string }) => void }) => {
              closeHandlers.push(options.onClose ?? (() => undefined));
              return {
                serverInfo: {
                  serverId: "3cd4f9da-cd79-426c-9d70-75f36e9f6a87",
                  version: "3.8.0",
                  protocolVersion: 1,
                  authRequired: true,
                  workspaces: [],
                  compatibility,
                  identity: { osUser: "alice", hostname: "devbox" },
                  migration: { failedPathCount: 0 },
                  capabilities: { desktopContinuous: true, websocketRpc: true },
                },
                services: {} as IServiceAccessor,
                dispose: vi.fn(),
              };
            },
          ),
          compatibilityManifest: compatibility,
          knownHostsFiles,
        });
        await manager.connect({ profile, target });
        closeHandlers[0]?.({ code: 1006, reason: "network lost" });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(manager.getStateByProfile(profileId)).toMatchObject({
          state: "failed",
          errorCode: `remote-host-key-${kind}`,
          retryable: false,
        });
        await vi.advanceTimersByTimeAsync(4_000 + 8_000 + 2 * 60_000);
        expect(adapter.probe).toHaveBeenCalledTimes(2);
        manager.dispose();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
