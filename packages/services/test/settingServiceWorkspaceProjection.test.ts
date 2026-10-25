import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  while (tempHomes.length > 0) {
    const home = tempHomes.pop();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

async function createAssembly(): Promise<{
  service: Awaited<
    ReturnType<typeof import("../src/setting/settingService.js").createSettingServiceWithMigrations>
  >["service"];
  setWorkspaceProjection: Awaited<
    ReturnType<typeof import("../src/setting/settingService.js").createSettingServiceWithMigrations>
  >["setWorkspaceProjection"];
  settingsFile: string;
}> {
  const home = mkdtempSync(join(tmpdir(), "zcode-setting-projection-"));
  tempHomes.push(home);
  process.env.HOME = home;
  vi.resetModules();
  const mod = await import("../src/setting/settingService.js");
  const assembly = mod.createSettingServiceWithMigrations();
  return {
    service: assembly.service,
    setWorkspaceProjection: assembly.setWorkspaceProjection,
    settingsFile: join(home, ".zcode", "v2", "setting.json"),
  };
}

describe("settings service workspace projection with fork sidecar", () => {
  it("keeps fork-owned keys out of setting.json and in get() after a projected write", async () => {
    const { service, setWorkspaceProjection, settingsFile } = await createAssembly();
    setWorkspaceProjection(async () => ({
      lastActiveWorkspace: { kind: "local", workspacePath: "/projected/workspace" },
      recentProjects: ["/projected/workspace"],
    }));

    await service.update({ memoryIndexAsContext: true });
    await service.update({ recentProjects: ["/a"] });

    const settings = await service.get();
    expect(settings.memoryIndexAsContext).toBe(true);
    expect(settings.lastActiveWorkspace).toMatchObject({ workspacePath: "/projected/workspace" });

    const onDisk = JSON.parse(readFileSync(settingsFile, "utf-8")) as Record<string, unknown>;
    expect(onDisk).not.toHaveProperty("memoryIndexAsContext");
  });

  it("bumps providerFamilyDomainUpdatedAt on each connection-mapping write and rejects a stale version", async () => {
    const { service } = await createAssembly();

    // Connection-mapping writes require a CAS version (upstream rule). An unset version is the 0 baseline.
    await service.update(
      { providerFamilyConnectionSelections: {} },
      { providerFamilyDomainUpdatedAt: 0 },
    );
    const first = (await service.get()).providerFamilyDomainUpdatedAt ?? 0;
    expect(first).toBeGreaterThan(0);

    await service.update(
      { providerFamilyConnectionSelections: {} },
      { providerFamilyDomainUpdatedAt: first },
    );
    const second = (await service.get()).providerFamilyDomainUpdatedAt ?? 0;
    expect(second).toBeGreaterThan(first);

    await expect(
      service.update(
        { providerFamilyConnectionSelections: {} },
        { providerFamilyDomainUpdatedAt: first },
      ),
    ).rejects.toThrow("Account connection settings changed");
  });
});
