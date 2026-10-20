import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotsRepo } from "../src/bots/repo.js";
import { setDataBaseDir } from "../src/paths.js";
import * as f from "./botsService.fixtures.js";

const LEGACY_REMOTE_KEY = "remote:server:test-owner:/tmp/workspace";
const PROJECT_ID = JSON.stringify(["remote:server:test-owner", "project-0"]);
const actor = {
  provider: "webhook" as const,
  botId: "webhook-1",
  providerUserId: "user-1",
  chatType: "private" as const,
};

function legacyContext(overrides: Record<string, unknown> = {}) {
  return {
    botId: "webhook-1",
    workspacePath: "/tmp/workspace",
    workspaceIdentity: LEGACY_REMOTE_KEY,
    workspaceId: LEGACY_REMOTE_KEY,
    mode: "draft",
    activeTaskId: null,
    updatedAt: 1,
    ...overrides,
  };
}

describe("Bot persisted project identity migration", () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bot-identity-"));
    setDataBaseDir(root);
    dir = join(root, ".zcode", "v2");
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    setDataBaseDir(null);
    await rm(root, { recursive: true, force: true });
  });

  async function writeLegacyFiles(allowedWorkspaces: string[], state: unknown = undefined) {
    const config = {
      ...f.baseConfig,
      bots: [{ ...f.baseConfig.bots[0]!, providerUserId: "user-1", allowedWorkspaces }],
    };
    await writeFile(join(dir, "bot-config.v3.json"), JSON.stringify(config, null, 2));
    await writeFile(
      join(dir, "bot-state.v3.json"),
      JSON.stringify(state ?? { version: 3, bots: { "webhook-1": legacyContext() } }, null, 2),
    );
  }

  /** Builds a file-backed service; `/workspace` reads the bot context, which runs the migration first. */
  function startService(projectServices: Record<string, unknown> = {}) {
    const service = f.createBotsService({
      credentialService: f.createCredentialService({ "secret-1": "secret" }),
      legacyTaskService: f.createLegacyTaskService(),
      settingService: f.createSettingService({ lastWorkspaceSession: [] }),
      repo: new BotsRepo() as never,
      ...(projectServices as object),
    } as never);
    return {
      service,
      run: async () => {
        await service.handleInboundMessage({ botId: "webhook-1", text: "/workspace", actor });
        await service.disposeAllAndWait();
      },
    };
  }

  async function readJson(name: string): Promise<any> {
    return JSON.parse(await readFile(join(dir, name), "utf8"));
  }

  async function exists(name: string): Promise<boolean> {
    return access(join(dir, name)).then(
      () => true,
      () => false,
    );
  }

  it("migrates a legacy remote key and context to [hostId, projectId] and keeps a pre-migration backup", async () => {
    await writeLegacyFiles([LEGACY_REMOTE_KEY]);
    const originalConfig = await readFile(join(dir, "bot-config.v3.json"), "utf8");
    const originalState = await readFile(join(dir, "bot-state.v3.json"), "utf8");

    await startService().run();

    const config = await readJson("bot-config.v3.json");
    expect(config.bots[0].allowedWorkspaces).toEqual([PROJECT_ID]);
    const state = await readJson("bot-state.v3.json");
    expect(state.bots["webhook-1"]).toMatchObject({
      hostId: "remote:server:test-owner",
      projectId: "project-0",
      workspaceId: PROJECT_ID,
      workspacePath: "/tmp/workspace",
      workspaceIdentity: LEGACY_REMOTE_KEY,
    });
    // The rollback copies hold exactly the pre-migration bytes.
    expect(await readFile(join(dir, "bot-config.v3.pre-project-identity.json"), "utf8")).toBe(
      originalConfig,
    );
    expect(await readFile(join(dir, "bot-state.v3.pre-project-identity.json"), "utf8")).toBe(
      originalState,
    );
  });

  it("is idempotent: a second run writes nothing and never replaces the backup", async () => {
    await writeLegacyFiles([LEGACY_REMOTE_KEY]);
    await startService().run();
    const migratedConfig = await readFile(join(dir, "bot-config.v3.json"), "utf8");
    const migratedState = await readFile(join(dir, "bot-state.v3.json"), "utf8");
    const backupBefore = await readFile(
      join(dir, "bot-config.v3.pre-project-identity.json"),
      "utf8",
    );

    await startService().run();

    expect(await readFile(join(dir, "bot-config.v3.json"), "utf8")).toBe(migratedConfig);
    expect(await readFile(join(dir, "bot-state.v3.json"), "utf8")).toBe(migratedState);
    expect(await readFile(join(dir, "bot-config.v3.pre-project-identity.json"), "utf8")).toBe(
      backupBefore,
    );
  });

  it("keeps an unknown remote key verbatim and never maps it onto a same-path project of another Host", async () => {
    const unknownKey = "remote:server:unknown-owner:/tmp/workspace";
    await writeLegacyFiles([unknownKey], { version: 3, bots: {} });

    await startService().run();

    const config = await readJson("bot-config.v3.json");
    expect(config.bots[0].allowedWorkspaces).toEqual([unknownKey]);
    expect(await exists("bot-config.v3.pre-project-identity.json")).toBe(false);
  });

  it("does not widen authorization when one legacy key matches two projects", async () => {
    await writeLegacyFiles([LEGACY_REMOTE_KEY]);
    const duplicated = f.createBotProjectServices([
      { workspacePath: "/tmp/workspace", workspaceIdentity: LEGACY_REMOTE_KEY },
      { workspacePath: "/tmp/workspace", workspaceIdentity: LEGACY_REMOTE_KEY },
    ]);

    await startService(duplicated).run();

    const config = await readJson("bot-config.v3.json");
    expect(config.bots[0].allowedWorkspaces).toEqual([LEGACY_REMOTE_KEY]);
    const state = await readJson("bot-state.v3.json");
    // Ambiguous: no project is chosen, so the context keeps the legacy workspace id.
    expect(state.bots["webhook-1"].projectId).toBeNull();
    expect(state.bots["webhook-1"].workspaceId).toBe(LEGACY_REMOTE_KEY);
  });

  it("leaves a legacy context without a matching project unbound and writes no backup", async () => {
    const unknownIdentity = "remote:server:unknown-owner:/tmp/elsewhere";
    await writeLegacyFiles(["*"], {
      version: 3,
      bots: {
        "webhook-1": legacyContext({
          workspacePath: "/tmp/elsewhere",
          workspaceIdentity: unknownIdentity,
          workspaceId: unknownIdentity,
        }),
      },
    });

    await startService().run();

    const state = await readJson("bot-state.v3.json");
    expect(state.bots["webhook-1"].projectId).toBeNull();
    expect(state.bots["webhook-1"].workspaceId).toBe(unknownIdentity);
    expect(await exists("bot-state.v3.pre-project-identity.json")).toBe(false);
  });
});
