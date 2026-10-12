import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { capabilityGroups } from "@/data/productCapabilityMap.js";

const devDocsRoot = process.cwd();
const ownershipDataPath = resolve(
  devDocsRoot,
  "src/data/productCapabilityOwnership.ts",
);
const capabilityMapInteractionFiles = [
  "src/capability-map/CapabilityMapView.tsx",
  "src/capability-map/CapabilityMapDetail.tsx",
  "src/capability-map/CapabilityMapFlowElements.tsx",
  "src/capability-map/capabilityMapTypes.ts",
].map((path) => resolve(devDocsRoot, path));

describe("能力图不承载具体人员分工", () => {
  it("只保留角色型 owner，不在能力群数据中写入具体人名", () => {
    // The real-names blacklist was removed before open-sourcing; replaced with a
    // positive constraint: an owner must be a role description of the form
    // "<duty>负责人（<Role> Owner）", which real personal names cannot satisfy.
    const roleOwnerPattern = /^\S.*负责人（[A-Za-z][A-Za-z &-]* Owner）$/;

    for (const group of capabilityGroups) {
      expect(group.owner).toMatch(roleOwnerPattern);
    }
  });

  it("不保留人员职责数据或人员选择交互", async () => {
    await expect(access(ownershipDataPath)).rejects.toThrow();
    const interactionSources = (
      await Promise.all(
        capabilityMapInteractionFiles.map((path) => readFile(path, "utf8")),
      )
    ).join("\n");

    expect(interactionSources).not.toMatch(
      /CapabilityOwnershipPanel|maintainer|responsibilityKind/,
    );
  });
});
