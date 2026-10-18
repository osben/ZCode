import { describe, expect, it } from "vitest";
import {
  FORK_SETTING_KEYS,
  forkAppSettingsPatchSchema,
  forkAppSettingsSchema,
  splitForkSettingsPatch,
} from "../src/forkAppSettings.js";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

describe("app settings", () => {
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
      appSettingsPatchSchema.parse({ integratedTerminalShell: { mode: "auto" } })
        .integratedTerminalShell,
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
      appSettingsPatchSchema.parse({ webRemoteControlLastEnabledContext: context })
        .webRemoteControlLastEnabledContext,
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
