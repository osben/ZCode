import { createHash } from "node:crypto";
import {
  BASH_COMMAND_REGISTRY,
  type BashCommandRegistryNode,
} from "../src/tool/handlers/generated/bash-command-registry.js";
import { describe, expect, it } from "vitest";
import type { PermissionRuleset } from "@zcode/contracts";
import { PermissionService } from "../src/permission/service.js";
import { createBashPermissionRulePolicy } from "../src/tool/handlers/bash-command-permission-policy.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";

describe("Bash command permission rule policy", () => {
  it("preserves eager-baseline suggestions and decisions for every static alias path", () => {
    const hash = createHash("sha256");
    let count = 0;
    function visit(node: BashCommandRegistryNode, tokens: string[]) {
      for (const alias of node[0]) {
        const command = [...tokens, alias, "registry-parity-target"].join(" ");
        const policy = createBashPermissionRulePolicy(command);
        const rules = policy.suggestedPermissionUpdates.flatMap((update) => update.rules);
        const outcomes = (["allow", "ask", "deny"] as const).map((behavior) =>
          policy.evaluateRules(behavior, rules),
        );
        hash.update(JSON.stringify([command, policy.suggestedPermissionUpdates, outcomes]));
        hash.update("\n");
        count++;
        for (const child of node[3]) visit(child, [...tokens, alias]);
      }
    }
    for (const [name, node] of Object.entries(BASH_COMMAND_REGISTRY)) {
      visit([[name], node[1], node[2], node[3]], []);
    }
    expect(count).toBe(46_296);
    expect(hash.digest("hex")).toBe(
      "7cc1d6d66044159faad23a5906cf7272790d7bdc6e8f95c7907394ff5c7a29dc",
    );
  });

  it.each([
    ["pnpm run lint --fix", "pnpm run lint:*"],
    ["pnpm --dir /tmp/project run lint --fix", "pnpm run lint:*"],
    ["git -C packages/app push origin main", "git push:*"],
    ["python3 -m pytest tests/unit", "python3 -m pytest:*"],
    ["sudo -u build git push origin main", "sudo git push:*"],
    ["docker compose up --detach", "docker compose up:*"],
    ["FOO=bar pnpm run lint --fix", "FOO=bar pnpm run lint:*"],
  ])("resolves a stable prefix for %s", (command, expectedRuleContent) => {
    expect(ruleContents(command)).toEqual([expectedRuleContent]);
  });

  it.each([
    "curl https://example.com/archive.tgz",
    "rm -rf ./dist",
    "pnpm run lint > lint.txt",
    "pnpm run $(node choose-script.js)",
    "FOO=$BAR pnpm run lint",
  ])("falls back to an exact rule for %s", (command) => {
    expect(ruleContents(command)).toEqual([command]);
  });

  it("suggests independent compound rules and omits readonly invocations", () => {
    expect(ruleContents("ls && pnpm run lint --fix && git push origin main")).toEqual([
      "pnpm run lint:*",
      "git push:*",
    ]);
  });

  it("falls back to the whole exact command above the five-rule limit", () => {
    const command = ["a", "b", "c", "d", "e", "f"]
      .map((script) => `pnpm run ${script}`)
      .join(" && ");
    expect(ruleContents(command)).toEqual([command]);
  });

  it("requires every permission-requiring invocation to be allowed", () => {
    const command = "npm run test && rm -rf ./out";
    const partialRules: PermissionRuleset = {
      allow: [{ ruleContent: "npm run test:*", toolName: "Bash" }],
      version: 1,
    };
    expect(check(command, partialRules).decision).toBe("ask");

    const fullRules: PermissionRuleset = {
      allow: [
        { ruleContent: "npm run test:*", toolName: "Bash" },
        { ruleContent: "rm -rf ./out", toolName: "Bash" },
      ],
      version: 1,
    };
    expect(check(command, fullRules).decision).toBe("allow");
  });

  it("matches a persisted stable prefix after stripping transient global flags", () => {
    expect(
      check("pnpm --dir /tmp/project run lint -- --second", {
        allow: [{ ruleContent: "pnpm run lint:*", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("allow");
    expect(
      check("git -C packages/app push origin main", {
        allow: [{ ruleContent: "git push:*", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("allow");
  });

  it("applies deny and ask when any invocation matches", () => {
    const command = "npm run test && rm -rf ./out";
    expect(
      check(command, {
        deny: [{ ruleContent: "rm:*", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("deny");
    expect(
      check(command, {
        ask: [{ ruleContent: "npm run:*", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("ask");
  });

  it("keeps legacy exact, wildcard, prefix, and tool-only behavior without compound bypass", () => {
    expect(
      check("npm run test && rm -rf ./out", {
        allow: [{ ruleContent: "npm run test && rm -rf ./out", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("allow");
    expect(
      check("  pnpm run lint --fix  ", {
        allow: [{ ruleContent: "  pnpm run lint --fix  ", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("allow");
    expect(
      check("npm run test --watch", {
        allow: [{ ruleContent: "npm run:*", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("allow");
    expect(
      check("npm run test && rm -rf ./out", {
        allow: [{ ruleContent: "npm run:*", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("ask");
    expect(
      check("pnpm run lint --fix", {
        allow: [{ ruleContent: "pnpm *", toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("allow");
    expect(
      check("npm run test && rm -rf ./out", {
        allow: [{ toolName: "Bash" }],
        version: 1,
      }).decision,
    ).toBe("allow");
  });

  it("only lets an unsafe command match its complete exact rule", () => {
    const rules: PermissionRuleset = {
      allow: [
        { ruleContent: "pnpm run:*", toolName: "Bash" },
        { ruleContent: "pnpm run lint > lint.txt", toolName: "Bash" },
      ],
      version: 1,
    };
    expect(check("pnpm run lint > lint.txt", rules).decision).toBe("allow");
    expect(check("pnpm run lint > other.txt", rules).decision).toBe("ask");
  });
});

function ruleContents(command: string): Array<string | undefined> {
  const policy = createBashPermissionRulePolicy(command);
  return policy.suggestedPermissionUpdates.flatMap((update) =>
    update.rules.map((rule) => rule.ruleContent),
  );
}

function check(command: string, ruleset: PermissionRuleset) {
  const service = new PermissionService();
  return service.checkPermission(
    {
      input: { command },
      mode: "build",
      riskLevel: bashToolEntry.metadata.riskLevel,
      toolName: "Bash",
    },
    {
      ...bashToolEntry.metadata,
      permission: bashToolEntry.permission,
    },
    ruleset,
    createBashPermissionRulePolicy(command),
  );
}
