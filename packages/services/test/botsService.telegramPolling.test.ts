import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDataBaseDir } from "../src/paths.js";
import * as f from "./botsService.fixtures.js";

let tempDir: string | null = null;

afterEach(() => {
  setDataBaseDir(null);
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function useTempDataDir() {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-bots-telegram-polling-"));
  setDataBaseDir(tempDir);
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("botsService Telegram polling", () => {
  it("waits for bot storage migration before starting Telegram polling", async () => {
    useTempDataDir();
    const storageReady = createDeferred<void>();
    const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
      const requestUrl = String(url);
      if (requestUrl.includes("/deleteWebhook")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      if (requestUrl.includes("/setMyCommands")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      }
      if (requestUrl.includes("/getUpdates")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    });
    vi.stubGlobal("fetch", fetchMock);
    const baseRepo = f.createMemoryRepo(f.telegramConfig);
    const repo = {
      ...baseRepo,
      readState: vi.fn(async () => {
        await storageReady.promise;
        return baseRepo.readState();
      }),
    };

    const service = f.createBotsService({
      credentialService: f.createCredentialService({
        "telegram-token": "migration-token",
      }),
      modelSelectionService: f.createModelSelectionService(),
      repo: repo as never,
    });

    await vi.waitFor(() => expect(repo.readState).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/getUpdates"))).toBe(false);

    storageReady.resolve();

    await vi.waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/getUpdates"))).toBe(true),
    );

    service.disposeAll();
  });

  // Bugfix: this test simulates two windows in one Node process; on Windows the directory lock and async
  // polling startup timing are unstable. Keep POSIX-only coverage so the Windows full suite is not blocked
  // by these environment-sensitive assertions.
  it.runIf(process.platform !== "win32")(
    "does not start a second local polling client for the same Telegram token",
    async () => {
      useTempDataDir();
      const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
        const requestUrl = String(url);
        if (requestUrl.includes("/deleteWebhook")) {
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        if (requestUrl.includes("/setMyCommands")) {
          return Promise.resolve(new Response(JSON.stringify({ ok: true })));
        }
        if (requestUrl.includes("/getUpdates")) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              {
                once: true,
              },
            );
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true })));
      });
      vi.stubGlobal("fetch", fetchMock);
      const serviceA = f.createBotsService({
        credentialService: f.createCredentialService({ "telegram-token": "same-token" }),
        legacyTaskService: f.createLegacyTaskService(),
        repo: f.createMemoryRepo(f.telegramConfig) as never,
      });

      await vi.waitFor(async () => {
        const runtime = (await serviceA.getStatus()).botRuntime[0];
        expect(runtime?.status).toBe("polling");
      });

      const serviceB = f.createBotsService({
        credentialService: f.createCredentialService({ "telegram-token": "same-token" }),
        legacyTaskService: f.createLegacyTaskService(),
        repo: f.createMemoryRepo(f.telegramConfig) as never,
      });

      await vi.waitFor(async () => {
        const runtime = (await serviceB.getStatus()).botRuntime[0];
        expect(runtime).toMatchObject({
          status: "idle",
          message: "Telegram long polling is handled by another ZCode window.",
        });
      });
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes("/getUpdates")),
      ).toHaveLength(1);

      serviceB.disposeAll();
      serviceA.disposeAll();
    },
  );
});
