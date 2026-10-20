import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FORK_SETTING_KEYS,
  forkAppSettingsPatchSchema,
  forkAppSettingsSchema,
  splitForkSettingsPatch,
} from "../src/forkAppSettings.js";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

describe("app settings", () => {
  it.each([undefined, false, true])("旧自动归档选择 %s 一次性关闭，保留天数", (enabled) => {
    const migrated = appSettingsSchema.parse({
      taskAutoArchiveEnabled: enabled,
      taskAutoArchiveOlderThanDays: 14,
    });
    expect(migrated).toMatchObject({
      taskAutoArchiveEnabled: false,
      taskAutoArchiveOlderThanDays: 14,
      taskAutoArchiveResetVersion: 1,
    });
    expect(appSettingsSchema.parse(migrated)).toEqual(migrated);
    const reopened = appSettingsSchema.parse({
      ...migrated,
      ...appSettingsPatchSchema.parse({ taskAutoArchiveEnabled: true }),
    });
    expect(reopened.taskAutoArchiveEnabled).toBe(true);
    expect(appSettingsSchema.parse(reopened)).toEqual(reopened);
  });

  it("defaults ToolSearch off and accepts only the three App modes", () => {
    expect(appSettingsSchema.parse({}).toolSearchMode).toBe("off");
    expect(appSettingsPatchSchema.parse({})).not.toHaveProperty("toolSearchMode");
    for (const mode of ["auto", "local", "off"]) {
      expect(appSettingsSchema.parse({ toolSearchMode: mode }).toolSearchMode).toBe(mode);
      expect(appSettingsPatchSchema.parse({ toolSearchMode: mode }).toolSearchMode).toBe(mode);
    }
    for (const mode of ["native", "invalid", true, null]) {
      expect(appSettingsPatchSchema.safeParse({ toolSearchMode: mode }).success).toBe(false);
    }
  });

  it("preserves an explicit startup reconnect preference while keeping old settings optional", () => {
    // 合同 §8.2：旧设置缺字段不触发迁移，Host/UI 继续按 true 解释；显式 false 必须通过完整 schema。
    const parsed = appSettingsSchema.parse({});
    expect(parsed.remoteStartupAutoReconnectEnabled).toBeUndefined();

    expect(
      appSettingsSchema.parse({ remoteStartupAutoReconnectEnabled: false })
        .remoteStartupAutoReconnectEnabled,
    ).toBe(false);

    expect(
      appSettingsPatchSchema.parse({ remoteStartupAutoReconnectEnabled: false })
        .remoteStartupAutoReconnectEnabled,
    ).toBe(false);

    expect(
      appSettingsPatchSchema.safeParse({
        remoteStartupAutoReconnectEnabled: "yes",
      }).success,
    ).toBe(false);
  });

  it("drops the removed global asset install mode preference", () => {
    const staleFullSettings = appSettingsSchema.parse({
      remoteDefaultAssetInstallMode: "remote-download",
    });
    expect("remoteDefaultAssetInstallMode" in staleFullSettings).toBe(false);

    const stalePatch = appSettingsPatchSchema.parse({
      remoteDefaultAssetInstallMode: "remote-download",
    });
    expect("remoteDefaultAssetInstallMode" in stalePatch).toBe(false);
  });

  it("round-trips Source-scoped conversation backing paths without extending strict project history", () => {
    const record = {
      "11111111-1111-4111-8111-111111111111": {
        workspacePath: "/home/dev/.zcode/workspace/default",
        lastResolvedAt: 123,
      },
    };
    expect(
      appSettingsSchema.parse({
        remoteConversationWorkspaceBySourceServerId: record,
      }).remoteConversationWorkspaceBySourceServerId,
    ).toEqual(record);
    expect(
      appSettingsPatchSchema.parse({
        remoteConversationWorkspaceBySourceServerId: record,
      }).remoteConversationWorkspaceBySourceServerId,
    ).toEqual(record);
    expect(
      appSettingsSchema.safeParse({
        remoteConversationWorkspaceBySourceServerId: {
          "11111111-1111-4111-8111-111111111111": {
            workspacePath: "/home/dev/.zcode/workspace/default",
            lastResolvedAt: -1,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("round-trips every structured Provider Family connection selection", () => {
    const selections = {
      zai: { kind: "individual-coding-plan" },
      bigmodel: {
        kind: "team-coding-plan",
        productId: "product-1",
        organizationId: "org-1",
        projectId: "project-1",
      },
    } as const;

    expect(
      appSettingsSchema.parse({ providerFamilyConnectionSelections: selections })
        .providerFamilyConnectionSelections,
    ).toEqual(selections);
    expect(
      appSettingsPatchSchema.parse({ providerFamilyConnectionSelections: selections })
        .providerFamilyConnectionSelections,
    ).toEqual(selections);
    expect(
      appSettingsPatchSchema.safeParse({
        providerFamilyConnectionSelections: {
          zai: { kind: "team-coding-plan", productId: "p", organizationId: "o" },
        },
      }).success,
    ).toBe(false);
  });

  it("defaults old remote open entries to project and preserves explicit conversation purpose", () => {
    const base = {
      kind: "remote",
      workspacePath: "/workspace/demo",
      target: { kind: "docker", container: "demo" },
      lastOpenedAt: 1,
      lastConnectionStatus: "connected",
    } as const;
    expect(
      appSettingsSchema.parse({ lastWorkspaceSession: [base] }).lastWorkspaceSession[0],
    ).toMatchObject({
      workspacePurpose: "project",
    });
    expect(
      appSettingsSchema.parse({
        lastWorkspaceSession: [{ ...base, workspacePurpose: "conversation" }],
      }).lastWorkspaceSession[0],
    ).toMatchObject({ workspacePurpose: "conversation" });
  });

  it("defaults and validates the human embedded Browser viewport preference", () => {
    expect(appSettingsSchema.parse({}).embeddedBrowserViewportPreference).toEqual({
      mode: "normal",
      viewport: { width: 393, height: 852 },
      zoom: "fit",
    });

    const preference = {
      mode: "responsive",
      viewport: { width: 412, height: 915 },
      zoom: "50",
    } as const;
    expect(
      appSettingsSchema.parse({ embeddedBrowserViewportPreference: preference })
        .embeddedBrowserViewportPreference,
    ).toEqual(preference);
    expect(
      appSettingsPatchSchema.parse({ embeddedBrowserViewportPreference: preference })
        .embeddedBrowserViewportPreference,
    ).toEqual(preference);

    for (const embeddedBrowserViewportPreference of [
      { ...preference, mode: "agent" },
      { ...preference, viewport: { width: 319, height: 915 } },
      { ...preference, viewport: { width: 412, height: 2161 } },
      { ...preference, zoom: "80" },
    ]) {
      expect(appSettingsPatchSchema.safeParse({ embeddedBrowserViewportPreference }).success).toBe(
        false,
      );
    }
  });

  it("drops only a damaged human Browser preference from stored settings", () => {
    const settings = appSettingsSchema.parse({
      locale: "en-US",
      recentProjects: ["/workspace/demo"],
      embeddedBrowserViewportPreference: {
        mode: "responsive",
        viewport: { width: "bad", height: 915 },
        zoom: "50",
      },
    });

    expect(settings.locale).toBe("en-US");
    expect(settings.recentProjects).toEqual(["/workspace/demo"]);
    expect(settings.embeddedBrowserViewportPreference).toEqual({
      mode: "normal",
      viewport: { width: 393, height: 852 },
      zoom: "fit",
    });
  });

  it("defaults ModelIO full retention to off and validates explicit boolean patches", () => {
    expect(appSettingsSchema.parse({}).modelIoFullRetentionEnabled).toBe(false);
    expect(
      appSettingsSchema.parse({ modelIoFullRetentionEnabled: true }).modelIoFullRetentionEnabled,
    ).toBe(true);
    expect(
      appSettingsPatchSchema.parse({ modelIoFullRetentionEnabled: false })
        .modelIoFullRetentionEnabled,
    ).toBe(false);
    expect(appSettingsPatchSchema.safeParse({ modelIoFullRetentionEnabled: "true" }).success).toBe(
      false,
    );
  });

  it("drops the removed CUA overlay/pip/background settings keys from stored configs", () => {
    // 2026-08-17 settings surface cleanup: the three keys were removed from the schema; old values in stored configs are
    // silently stripped by zod — no error, no round-trip (overlay/PiP is always true via the services assembly layer, see cuaGhostCursorSettingsWiring).
    const stale = appSettingsSchema.parse({
      cuaGhostCursorEnabled: false,
      cuaPipMode: false,
      cuaBackgroundMode: true,
    });
    expect("cuaGhostCursorEnabled" in stale).toBe(false);
    expect("cuaPipMode" in stale).toBe(false);
    expect("cuaBackgroundMode" in stale).toBe(false);
    expect(appSettingsPatchSchema.parse({ cuaPipMode: true })).toEqual({});
  });

  it("persists an explicit Windows integrated terminal shell selection", () => {
    const selection = {
      mode: "shell",
      dialect: "git-bash",
      id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
      label: "Git Bash",
      path: "C:\\Program Files\\Git\\bin\\bash.exe",
    } as const;

    expect(
      appSettingsSchema.parse({ integratedTerminalShell: selection }).integratedTerminalShell,
    ).toEqual(selection);
    expect(
      appSettingsPatchSchema.parse({ integratedTerminalShell: selection }).integratedTerminalShell,
    ).toEqual(selection);
  });

  it("accepts auto mode and rejects incomplete shell selections", () => {
    expect(
      appSettingsPatchSchema.parse({
        integratedTerminalShell: { mode: "auto" },
      }).integratedTerminalShell,
    ).toEqual({ mode: "auto" });

    expect(() =>
      appSettingsPatchSchema.parse({
        integratedTerminalShell: {
          mode: "shell",
          dialect: "git-bash",
          id: "git-bash",
          label: "Git Bash",
        },
      }),
    ).toThrow();
  });

  it("accepts desktop zoom levels within the supported window range", () => {
    expect(appSettingsSchema.parse({ desktopZoomLevel: 5 }).desktopZoomLevel).toBe(5);
    expect(appSettingsPatchSchema.parse({ desktopZoomLevel: -3 }).desktopZoomLevel).toBe(-3);

    expect(() => appSettingsSchema.parse({ desktopZoomLevel: 6 })).toThrow();
    expect(() => appSettingsPatchSchema.parse({ desktopZoomLevel: -4 })).toThrow();
  });

  it("accepts a bounded desktop main window size and maximized state", () => {
    const desktopWindowSize = { width: 1440, height: 900, maximized: true };

    expect(appSettingsSchema.parse({ desktopWindowSize }).desktopWindowSize).toEqual(
      desktopWindowSize,
    );
    expect(appSettingsPatchSchema.parse({ desktopWindowSize }).desktopWindowSize).toEqual(
      desktopWindowSize,
    );
    expect(() =>
      appSettingsPatchSchema.parse({
        desktopWindowSize: { width: 479, height: 900, maximized: false },
      }),
    ).toThrow();
    expect(
      appSettingsSchema.parse({
        desktopWindowSize: { width: 1440, height: 639, maximized: false },
      }).desktopWindowSize,
    ).toBeUndefined();
  });

  it("discards a damaged desktop window size without resetting other settings", () => {
    const settings = appSettingsSchema.parse({
      locale: "en-US",
      recentProjects: ["/workspace/demo"],
      desktopWindowSize: { width: "bad", height: 900, maximized: false },
    });

    expect(settings.locale).toBe("en-US");
    expect(settings.recentProjects).toEqual(["/workspace/demo"]);
    expect(settings.desktopWindowSize).toBeUndefined();
  });

  it("defaults desktop Chromium hardware acceleration to enabled and accepts explicit patches", () => {
    expect(appSettingsSchema.parse({}).desktopChromiumHardwareAccelerationEnabled).toBe(true);
    expect(
      appSettingsSchema.parse({
        desktopChromiumHardwareAccelerationEnabled: false,
      }).desktopChromiumHardwareAccelerationEnabled,
    ).toBe(false);
    expect(
      appSettingsPatchSchema.parse({
        desktopChromiumHardwareAccelerationEnabled: true,
      }).desktopChromiumHardwareAccelerationEnabled,
    ).toBe(true);
    expect(() =>
      appSettingsPatchSchema.parse({
        desktopChromiumHardwareAccelerationEnabled: "false",
      }),
    ).toThrow();
  });

  it("discards a damaged voiceDictation value without resetting other settings", () => {
    // Non-critical preference: a damaged value or one written by a newer version should only discard itself, never fail parsing the whole settings.json.
    // voiceDictation is fork-owned storage (forkAppSettings), so the main setting.json schema strips it.
    const settings = appSettingsSchema.parse({
      locale: "en-US",
      recentProjects: ["/workspace/demo"],
      voiceDictation: { modelId: 42, idleUnloadMinutes: 60 },
    });

    expect(settings.locale).toBe("en-US");
    expect(settings.recentProjects).toEqual(["/workspace/demo"]);
    expect(settings.voiceDictation).toBeUndefined();

    // The sidecar read surface stays tolerant, and the patch surface stays strict: invalid values
    // must be rejected at save time instead of being silently swallowed.
    expect(
      forkAppSettingsSchema.parse({
        voiceDictation: { modelId: 42, idleUnloadMinutes: 60 },
      }).voiceDictation,
    ).toBeUndefined();
    expect(
      forkAppSettingsPatchSchema.safeParse({ voiceDictation: { pushToTalk: "yes" } }).success,
    ).toBe(false);
    expect(
      forkAppSettingsPatchSchema.parse({ voiceDictation: { modelId: "parakeet" } }).voiceDictation,
    ).toEqual({ modelId: "parakeet" });
  });

  it("accepts the feedback sound preferences and rejects out-of-range volume", () => {
    const fork = forkAppSettingsSchema.parse({
      voiceDictation: {
        modelId: "parakeet",
        feedbackSounds: true,
        feedbackVolume: 54,
        muteWhileRecording: true,
      },
    });
    expect(fork.voiceDictation).toEqual({
      modelId: "parakeet",
      feedbackSounds: true,
      feedbackVolume: 54,
      muteWhileRecording: true,
    });

    // Absent fields keep the effective defaults handled by the consumers (off / 70).
    expect(forkAppSettingsSchema.parse({}).voiceDictation).toBeUndefined();

    expect(
      forkAppSettingsPatchSchema.safeParse({ voiceDictation: { feedbackVolume: 101 } }).success,
    ).toBe(false);
    expect(
      forkAppSettingsPatchSchema.safeParse({ voiceDictation: { feedbackVolume: -1 } }).success,
    ).toBe(false);
    expect(
      forkAppSettingsPatchSchema.safeParse({ voiceDictation: { feedbackVolume: 70.5 } }).success,
    ).toBe(false);
  });

  it("stores dictation languages and the clipboard preference, dropping only a malformed languages value on read", () => {
    expect(
      forkAppSettingsSchema.parse({
        voiceDictation: {
          modelId: "parakeet",
          languages: ["uk", "en"],
          copyToClipboard: true,
          warmUpOnFocus: false,
        },
      }).voiceDictation,
    ).toEqual({
      modelId: "parakeet",
      languages: ["uk", "en"],
      copyToClipboard: true,
      warmUpOnFocus: false,
    });

    // One bad languages value must not wipe the other voice preferences.
    expect(
      forkAppSettingsSchema.parse({
        voiceDictation: { modelId: "parakeet", languages: "uk", pushToTalk: false },
      }).voiceDictation,
    ).toEqual({ modelId: "parakeet", pushToTalk: false });

    // Saving stays strict so a bad value is rejected instead of silently dropped.
    expect(
      forkAppSettingsPatchSchema.safeParse({ voiceDictation: { languages: ["uk", ""] } }).success,
    ).toBe(false);
    expect(
      forkAppSettingsPatchSchema.safeParse({ voiceDictation: { copyToClipboard: "yes" } }).success,
    ).toBe(false);
  });

  it("stores post-processing preferences and drops only an unknown provider on read", () => {
    expect(
      forkAppSettingsSchema.parse({
        voiceDictation: {
          modelId: "parakeet",
          postProcessEnabled: true,
          postProcessProvider: "apple-fm",
          postProcessPrompt: "Fix: {{text}}",
        },
      }).voiceDictation,
    ).toEqual({
      modelId: "parakeet",
      postProcessEnabled: true,
      postProcessProvider: "apple-fm",
      postProcessPrompt: "Fix: {{text}}",
    });

    // A provider written by a newer build must not wipe the other voice preferences.
    expect(
      forkAppSettingsSchema.parse({
        voiceDictation: { modelId: "parakeet", postProcessProvider: "some-future-provider" },
      }).voiceDictation,
    ).toEqual({ modelId: "parakeet" });

    // An over-long prompt (hand edit or a newer build with a higher limit) drops only itself.
    expect(
      forkAppSettingsSchema.parse({
        voiceDictation: { modelId: "parakeet", postProcessPrompt: "x".repeat(4001) },
      }).voiceDictation,
    ).toEqual({ modelId: "parakeet" });

    expect(
      forkAppSettingsPatchSchema.safeParse({ voiceDictation: { postProcessProvider: "other" } })
        .success,
    ).toBe(false);
    expect(
      forkAppSettingsPatchSchema.safeParse({
        voiceDictation: { postProcessPrompt: "x".repeat(4001) },
      }).success,
    ).toBe(false);
  });

  it("keeps every registered fork-owned key out of the upstream-shared setting.json schema", () => {
    // The upstream app shares setting.json with this fork and strips unknown keys on every write,
    // so a fork-only key placed in appSettingsObjectSchema instead of FORK_SETTING_KEYS would be
    // wiped by the next upstream write (this already deleted the selected dictation model once).
    const probe = Object.fromEntries(FORK_SETTING_KEYS.map((key) => [key, null]));
    const parsed = appSettingsSchema.parse(probe);
    for (const key of FORK_SETTING_KEYS) {
      expect(parsed).not.toHaveProperty(key);
    }

    // The patch splitter routes every registry key away from the base (setting.json) patch.
    const { forkPatch, basePatch } = splitForkSettingsPatch(
      Object.fromEntries(FORK_SETTING_KEYS.map((key) => [key, true])) as never,
    );
    expect(Object.keys(forkPatch).sort()).toEqual([...FORK_SETTING_KEYS].sort());
    expect(Object.keys(basePatch)).toEqual([]);
  });

  it("preserves localized pending post-update release notes", () => {
    const payload = {
      version: "3.1.4",
      title: "Release v3.1.4",
      markdown: "## 新功能\n- 中文说明",
      releaseDate: "2026-06-23T13:48:54.438Z",
      releaseNotesByLocale: {
        "zh-CN": {
          title: "ZCode v3.1.4",
          markdown: "## 新功能\n- 中文说明",
        },
        "en-US": {
          title: "ZCode v3.1.4",
          markdown: "## New Features\n- English notes",
        },
      },
    };

    expect(
      appSettingsSchema.parse({ pendingPostUpdateReleaseNotes: payload })
        .pendingPostUpdateReleaseNotes,
    ).toEqual(payload);
    expect(
      appSettingsPatchSchema.parse({ pendingPostUpdateReleaseNotes: payload })
        .pendingPostUpdateReleaseNotes,
    ).toEqual(payload);
  });

  it("persists only stable Web remote control startup context fields", () => {
    const context = {
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:ssh:host:/workspace/demo",
      initialTaskId: "task-1",
    };

    expect(
      appSettingsSchema.parse({ webRemoteControlLastEnabledContext: context })
        .webRemoteControlLastEnabledContext,
    ).toEqual(context);
    expect(
      appSettingsPatchSchema.parse({
        webRemoteControlLastEnabledContext: context,
      }).webRemoteControlLastEnabledContext,
    ).toEqual(context);
    expect(
      appSettingsPatchSchema.parse({
        webRemoteControlLastEnabledContext: {
          ...context,
          remoteSessionId: "ephemeral-session",
        },
      }).webRemoteControlLastEnabledContext,
    ).toEqual(context);
  });
});

// DWG-19 (docs/dynamic-workflow/launch.md "The user's choice"): the empty string is the sentinel for deleting a choice;
// an unknown value read from the file is treated as "follow" and must not corrupt reading the whole settings.
describe("dynamicWorkflowMode 设置（DWG-19）", () => {
  it("补丁接受三个模式与空串哨兵，拒绝其它值", () => {
    for (const value of ["disabled", "onDemand", "alwaysOn", ""]) {
      expect(appSettingsPatchSchema.parse({ dynamicWorkflowMode: value })).toEqual({
        dynamicWorkflowMode: value,
      });
    }
    expect(appSettingsPatchSchema.safeParse({ dynamicWorkflowMode: "bogus" }).success).toBe(false);
  });

  it("文件里的合法值原样读出，缺席保持缺席，未知值按跟随读成缺席", () => {
    expect(appSettingsSchema.parse({ dynamicWorkflowMode: "onDemand" }).dynamicWorkflowMode).toBe(
      "onDemand",
    );
    expect(appSettingsSchema.parse({}).dynamicWorkflowMode).toBeUndefined();
    expect(appSettingsSchema.parse({ dynamicWorkflowMode: "future" }).dynamicWorkflowMode).toBe(
      undefined,
    );
  });
});

describe("远程介绍回滚兼容", () => {
  // 冻结 e147c3b79a 的相关字段合同；不能复用新版预处理，否则会掩盖旧版拒绝 3 的问题。
  const previousSettingsSchema = z.object({
    remoteBoundaryOnboardingVersion: z.literal(2).optional(),
    recentProjects: z.array(z.string()).default([]),
    memoryEnabled: z.boolean().default(false),
  });

  it.each([undefined, 2])("新确认不扩展旧字段（原值 %s）", (legacyVersion) => {
    const patch = appSettingsPatchSchema.parse({ remoteBoundaryIntroAcknowledgedVersion: 1 });
    expect(patch).toEqual({ remoteBoundaryIntroAcknowledgedVersion: 1 });
    const written = appSettingsSchema.parse({
      recentProjects: ["/example/project"],
      memoryEnabled: true,
      remoteBoundaryOnboardingVersion: legacyVersion,
      ...patch,
    });
    const rollback = previousSettingsSchema.safeParse(written);
    expect(rollback.success).toBe(true);
    expect(rollback.data).toEqual({
      recentProjects: ["/example/project"],
      memoryEnabled: true,
      remoteBoundaryOnboardingVersion: legacyVersion,
    });
  });

  it("迁移已落盘的 3，同时保留原设置和明确确认事实", () => {
    const written = appSettingsSchema.parse({
      remoteBoundaryOnboardingVersion: 3,
      recentProjects: ["/example/project"],
      memoryEnabled: true,
    });
    expect(written).toMatchObject({
      remoteBoundaryOnboardingVersion: 2,
      remoteBoundaryIntroAcknowledgedVersion: 1,
      recentProjects: ["/example/project"],
      memoryEnabled: true,
    });
    expect(previousSettingsSchema.safeParse(written).success).toBe(true);
    expect(appSettingsSchema.parse(written)).toEqual(written);
  });

  it("旧 2 不代表新版已确认，补丁不能继续写 3", () => {
    expect(appSettingsSchema.parse({ remoteBoundaryOnboardingVersion: 2 })).not.toHaveProperty(
      "remoteBoundaryIntroAcknowledgedVersion",
    );
    expect(appSettingsPatchSchema.safeParse({ remoteBoundaryOnboardingVersion: 3 }).success).toBe(
      false,
    );
  });
});
