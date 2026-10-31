import { copyFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolve, join } from "node:path";
import { resolveE2EScheduledSpecFiles } from "#e2e/helpers/e2e-spec-resolution";

import {
  hasRequiredSshE2EEnvironment,
  isSshFormalSpec,
  isExplicitE2ESpecSelection,
  MANUAL_REVIEW_SPEC_GLOB,
  resolveEnvironmentGatedFormalSpecExcludes,
} from "../scripts/e2e-formal-spec-selection.mjs";

describe("desktop E2E environment-gated formal spec admission", () => {
  it("loads public admission rules without the internal remote harness", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "e2e-public-admission-"));
    try {
      const scripts = join(fixture, "packages/desktop/scripts");
      await mkdir(scripts, { recursive: true });
      for (const file of [
        "e2e-formal-spec-selection.mjs",
        "e2e-remote-target-specs.json",
        "r3-remote-spec-inventory.mjs",
      ]) {
        await copyFile(resolve("packages/desktop/scripts", file), join(scripts, file));
      }
      const admission = await import(
        pathToFileURL(join(scripts, "e2e-formal-spec-selection.mjs")).href
      );
      expect(
        admission.resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false }),
      ).toContain("./test/e2e/conversation-session/conversation-session-r3-model-switch.test.ts");
      expect(
        admission.isSshFormalSpec(
          "./test/e2e/conversation-session/conversation-session-remote-offline-icons.test.ts",
        ),
      ).toBe(false);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("excludes every manual-review domain from the default recursive glob", () => {
    const scheduled = resolveE2EScheduledSpecFiles({
      baseDir: resolve("packages/desktop"),
      specs: ["./test/e2e/**/*.test.ts"],
      exclude: [MANUAL_REVIEW_SPEC_GLOB],
    });
    expect(scheduled).toContain("test/e2e/smoke.test.ts");
    expect(scheduled.some((spec) => spec.includes("/manual-review/"))).toBe(false);
  });

  it.each(["bots", "settings", "feedback"])(
    "keeps explicit %s candidates discoverable",
    async (domain) => {
      const fixture = await mkdtemp(join(tmpdir(), "e2e-spec-discovery-"));
      try {
        // After promotion a domain may have no candidates; discovery rules must use an isolated fixture instead of relying on a pending spec remaining in the repo.
        const directory = join(fixture, "test/e2e", domain, "manual-review/pending");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "example.test.ts"), "");
        const scheduled = resolveE2EScheduledSpecFiles({
          baseDir: fixture,
          specs: [`./test/e2e/${domain}/manual-review/**/*.test.ts`],
          exclude: [],
        });
        expect(scheduled).toEqual([`test/e2e/${domain}/manual-review/pending/example.test.ts`]);
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );

  it("applies environment gates to formal globs but keeps exact-file runs fail-closed", () => {
    const glob = ["./test/e2e/conversation-session/*.test.ts"];
    // This verifies the canonical formal target; real candidates may stay pending, and a directory fallback must not change the gate input.
    const file = ["./test/e2e/conversation-session/conversation-session-r3-model-switch.test.ts"];
    expect(isExplicitE2ESpecSelection(glob)).toBe(false);
    expect(isExplicitE2ESpecSelection([])).toBe(false);
    expect(isExplicitE2ESpecSelection(file)).toBe(true);
    expect(
      resolveEnvironmentGatedFormalSpecExcludes({
        env: {},
        targeted: isExplicitE2ESpecSelection(glob),
      }),
    ).toContain(file[0]);
    expect(
      resolveEnvironmentGatedFormalSpecExcludes({
        env: {},
        targeted: isExplicitE2ESpecSelection(file),
      }),
    ).toEqual([]);
  });

  it("gates promoted remote targets while retaining local offline coverage", () => {
    expect(
      isSshFormalSpec(
        "./test/e2e/conversation-session/conversation-session-r3-model-switch.test.ts",
      ),
    ).toBe(true);
    expect(
      isSshFormalSpec(
        "./test/e2e/conversation-session/conversation-session-chat-remote-folder.test.ts",
      ),
    ).toBe(true);
    expect(
      isSshFormalSpec(
        "./test/e2e/conversation-session/conversation-session-remote-offline-icons.test.ts",
      ),
    ).toBe(false);
    expect(isSshFormalSpec("./test/e2e/bots/bot-r3-workspace-identity.test.ts")).toBe(false);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false })).toContain(
      "./test/e2e/conversation-session/conversation-session-r3-model-switch.test.ts",
    );
  });

  it("excludes real SSH specs from default runs without complete credentials", () => {
    expect(hasRequiredSshE2EEnvironment({})).toBe(false);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: false })).toContain(
      "./test/e2e/conversation-session/conversation-session-ssh-remote*.test.ts",
    );
  });

  it("keeps explicit SSH runs fail-closed and admits configured default runs", () => {
    const env = {
      ZCODE_E2E_SSH_HOST: "ssh.example.test",
      ZCODE_E2E_SSH_USERNAME: "root",
      ZCODE_E2E_SSH_PASSWORD: "secret-from-test-env",
    };
    expect(hasRequiredSshE2EEnvironment(env)).toBe(true);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env, targeted: false })).toEqual([]);
    expect(resolveEnvironmentGatedFormalSpecExcludes({ env: {}, targeted: true })).toEqual([]);
  });
});
