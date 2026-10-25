import { constants } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  botsConfigFileSchema,
  botsStateFileSchema,
  type BotContextState,
  type BotsConfigFile,
  type BotsStateFile,
} from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";
import {
  BOTS_CONFIG_FILE,
  BOTS_CONFIG_PRE_PROJECT_IDENTITY_FILE,
  BOTS_LEGACY_CONFIG_FILE,
  BOTS_LEGACY_STATE_FILE,
  BOTS_STATE_PRE_PROJECT_IDENTITY_FILE,
  BOTS_V2_STATE_FILE,
  BOTS_STATE_FILE,
  createDefaultBotsConfig,
} from "./config.js";
import { importLegacyBotConfig, importLegacyBotState } from "./storageMigration.js";

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWritePrivateTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export class BotsRepo {
  async readConfig(): Promise<BotsConfigFile> {
    const path = join(getAppConfigDir(), BOTS_CONFIG_FILE);
    return withFileLock(path, async () => {
      const current = await readOptionalJson(path);
      // Rollback compatibility: if v3 exists, use only v3. Surface corruption errors; never restore an old Bot or overwrite the user's newer changes.
      if (current !== undefined) return botsConfigFileSchema.parse(current);
      const legacy = await readOptionalJson(join(getAppConfigDir(), BOTS_LEGACY_CONFIG_FILE));
      const config = botsConfigFileSchema.parse(
        legacy === undefined ? createDefaultBotsConfig() : importLegacyBotConfig(legacy),
      );
      await writeJson(path, config);
      return config;
    });
  }

  async writeConfig(config: BotsConfigFile): Promise<BotsConfigFile> {
    const parsed = botsConfigFileSchema.parse(config);
    const path = join(getAppConfigDir(), BOTS_CONFIG_FILE);
    await withFileLock(path, () => writeJson(path, parsed));
    return parsed;
  }

  /**
   * Copies the current v3 config and state once, before the first project-identity rewrite.
   * An existing backup is never overwritten, so a later run cannot replace the true pre-migration copy.
   */
  async backupBeforeProjectIdentityMigration(): Promise<void> {
    const dir = getAppConfigDir();
    const pairs = [
      [BOTS_CONFIG_FILE, BOTS_CONFIG_PRE_PROJECT_IDENTITY_FILE],
      [BOTS_STATE_FILE, BOTS_STATE_PRE_PROJECT_IDENTITY_FILE],
    ] as const;
    for (const [source, backup] of pairs) {
      await withFileLock(join(dir, source), () =>
        copyFile(join(dir, source), join(dir, backup), constants.COPYFILE_EXCL).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          },
        ),
      );
    }
  }

  async readState(): Promise<BotsStateFile> {
    const path = join(getAppConfigDir(), BOTS_STATE_FILE);
    return withFileLock(path, () => this.readStateUnlocked(path));
  }

  private async readStateUnlocked(path: string): Promise<BotsStateFile> {
    const current = await readOptionalJson(path);
    if (current !== undefined) return botsStateFileSchema.parse(current);
    const v2 = await readOptionalJson(join(getAppConfigDir(), BOTS_V2_STATE_FILE));
    const legacy =
      v2 === undefined
        ? await readOptionalJson(join(getAppConfigDir(), BOTS_LEGACY_STATE_FILE))
        : v2;
    const state = botsStateFileSchema.parse(
      legacy === undefined ? { version: 3, bots: {} } : importLegacyBotState(legacy),
    );
    // Fix the migration result under the same file lock; later login/plan changes must not reinterpret the old identity.
    await writeJson(path, state);
    return state;
  }

  /** The file lock covers the whole read-modify-write, so two Bots or provider cursors cannot overwrite each other's context. */
  async updateContext(
    botId: string,
    update: (current: BotContextState | undefined) => BotContextState | undefined,
  ): Promise<BotContextState | undefined> {
    const path = join(getAppConfigDir(), BOTS_STATE_FILE);
    return withFileLock(path, async () => {
      const state = await this.readStateUnlocked(path);
      const next = update(state.bots[botId]);
      if (next) state.bots[botId] = next;
      else delete state.bots[botId];
      const parsed = botsStateFileSchema.parse(state);
      await writeJson(path, parsed);
      return parsed.bots[botId];
    });
  }

  async writeState(state: BotsStateFile): Promise<BotsStateFile> {
    const parsed = botsStateFileSchema.parse(state);
    const path = join(getAppConfigDir(), BOTS_STATE_FILE);
    await withFileLock(path, () => writeJson(path, parsed));
    return parsed;
  }
}
