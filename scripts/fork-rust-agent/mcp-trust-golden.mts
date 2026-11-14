// Golden fixtures for zcode-rs workspace MCP trust (specs/fork-rust-agent-parity.md, "Workspace MCP trust").
// Runs Node's own authority on fixture workspaces and records what Rust must reproduce: the declaration digest,
// source paths, sanitized display and the store bytes Node writes. HOME points at a temporary directory, so the
// real ~/.zcode is never read or written.
//
//   pnpm exec tsx scripts/fork-rust-agent/mcp-trust-golden.mts
//
// Writes packages/rust-cli/crates/cli/tests/fixtures/mcp-trust-golden.json. The workspace path is recorded as-is (the
// digest covers it); Rust rebuilds the workspaces under its own temporary directory and compares the
// path-independent parts with `<WS>` in place of the path.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const output = join(root, "packages/rust-cli/crates/cli/tests/fixtures/mcp-trust-golden.json");

type Files = Record<string, unknown>;

// Each case: project files (relative path → JSON value or raw text), user config, optional identity.
const cases: Array<{ name: string; files: Files; user?: unknown; identity?: string }> = [
  {
    name: "project",
    files: {
      ".zcode/config.json": {
        mcp: {
          servers: {
            alpha: {
              env: { Z_KEY: "ü✓\u0001", A_TOKEN: "secret value" },
              cwd: "tools",
              args: ["server.js", "--api-key", "sk-123", "--flag"],
              command: "node",
              type: "stdio",
            },
            beta: {
              command: "python",
              environment: { X: "1" },
              enable: false,
              enabled: true,
              timeout: 5,
            },
            gamma: {
              type: "remote",
              url: "https://user:pass@example.com/mcp?token=abc#frag",
              http_headers: { Authorization: "Bearer x" },
            },
            delta: {
              type: "sse",
              url: "http://localhost:9/sse",
              oauth: { type: "client_credentials", clientId: "c", clientSecret: "s" },
              protocolVersion: "legacy",
              alwaysLoad: true,
              timeoutMs: 1500,
              isolation: "workspace",
            },
            eps: { url: "https://x.test/mcp" },
            bad: { type: "stdio" },
            zeta: { command: "/usr/bin/env", args: ["TOKEN=abc", "run"], startup_timeout_sec: 3 },
            shadowed: { command: "project-only" },
          },
        },
      },
      "zcode.json": {
        mcp: { servers: { alpha2: { command: "deno", cwd: ".", args: [] } } },
      },
    },
    user: { mcp: { servers: { shadowed: { command: "user-wins" } } } },
  },
  {
    // Node's project merge assigns `mcp` before merging servers, so only the last file with an `mcp` key counts.
    name: "first-file-only",
    files: {
      "zcode.json": { mcp: { servers: { early: { command: "node", cwd: "bin" } } } },
      ".zcode/config.json": { permission: { mode: "default" } },
    },
  },
  {
    // Absolute cwd values are kept verbatim by Node (no normalization), relative ones are resolved.
    name: "absolute-cwd",
    files: {
      "zcode.json": {
        mcp: {
          servers: {
            abs: { command: "node", cwd: "/tmp/x/../y/" },
            rel: { command: "node", cwd: "./a/../b/" },
          },
        },
      },
    },
  },
  {
    name: "identity",
    files: {
      ".zcode/config.json": { mcp: { servers: { one: { command: "node", args: ["a.js"] } } } },
    },
    identity: "remote:golden-host",
  },
  {
    name: "fallback",
    files: {
      ".zcode/config.json": { permission: { mode: "default" } },
      ".agents/mcp.json": {
        mcpServers: {
          fb: { command: "npx", args: ["-y", "pkg"], cwd: "sub" },
          broken: { type: "stdio" },
          remote: { type: "http", url: "https://fb.test/mcp", headers: { "X-Api-Key": "k" } },
        },
      },
    },
  },
  {
    name: "invalid-blocks-fallback",
    files: {
      ".zcode/config.json": { mcp: { servers: { nope: { type: "stdio" } } } },
      ".agents/mcp.json": { mcpServers: { fb: { command: "npx" } } },
    },
  },
  {
    name: "unreadable",
    files: {
      ".zcode/config.json": "{ not json",
      ".agents/mcp.json": { mcpServers: { fb: { command: "npx" } } },
    },
  },
];

async function main(): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "mcp-trust-golden-"));
  const home = join(scratch, "home");
  await mkdir(join(home, ".zcode", "cli"), { recursive: true });
  process.env.HOME = home;
  // Loaded after HOME is set: the store path and config defaults read it.
  const { createWorkspaceMcpTrust } = await import(
    join(root, "apps/zcode-cli/packages/bootstrap/src/workspace-mcp-trust/index.ts")
  );
  const results: unknown[] = [];
  try {
    for (const item of cases) {
      const workspace = join(scratch, item.name, "ws");
      await mkdir(join(workspace, ".git"), { recursive: true });
      for (const [relative, value] of Object.entries(item.files)) {
        const path = join(workspace, relative);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
      }
      const userConfigPath = join(home, ".zcode", "cli", "config.json");
      await writeFile(userConfigPath, JSON.stringify(item.user ?? {}));
      const authority = createWorkspaceMcpTrust({
        workingDirectory: workspace,
        ...(item.identity ? { workspaceIdentity: item.identity } : {}),
        userConfigPath,
        env: { HOME: home },
      });
      const reviews = await authority.inspect();
      results.push({
        name: item.name,
        files: item.files,
        user: item.user ?? {},
        identity: item.identity ?? null,
        workspace,
        reviews,
      });
    }
    // Node's store bytes after one grant, a second grant and a revoke of the first.
    const project = results[0] as {
      workspace: string;
      reviews: Record<string, { declarationDigest: string }>;
    };
    const userConfigPath = join(home, ".zcode", "cli", "config.json");
    await writeFile(userConfigPath, JSON.stringify(cases[0]!.user));
    const authority = createWorkspaceMcpTrust({
      workingDirectory: project.workspace,
      userConfigPath,
      env: { HOME: home },
    });
    await authority.decide("alpha", project.reviews.alpha!.declarationDigest, true);
    await authority.decide("gamma", project.reviews.gamma!.declarationDigest, true);
    await authority.decide("alpha", project.reviews.alpha!.declarationDigest, false);
    let changed = "accepted";
    try {
      await authority.decide("gamma", "0".repeat(64), true);
    } catch (error) {
      changed = error instanceof Error ? error.message : String(error);
    }
    // What `mcp/list` admits from a Host DTO: Node converts it and re-digests it against the declaration.
    const { protocolMcpServersToRuntimeMcpConfig } = await import(
      join(root, "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/protocol-mcp-config.ts")
    );
    await authority.decide("alpha", project.reviews.alpha!.declarationDigest, true);
    const dtos = [
      {
        name: "alpha",
        scope: "workspace",
        command: "node",
        args: ["server.js", "--api-key", "sk-123", "--flag"],
        env: [
          { name: "Z_KEY", value: "ü✓\u0001" },
          { name: "A_TOKEN", value: "secret value" },
        ],
        cwd: "tools",
      },
      {
        name: "gamma",
        scope: "workspace",
        type: "http",
        url: "https://user:pass@example.com/mcp?token=abc#frag",
        headers: [{ name: "Authorization", value: "Bearer x" }],
      },
      {
        name: "gamma",
        type: "http",
        url: "https://user:pass@example.com/mcp?token=abc#frag",
        headers: [{ name: "Authorization", value: "Bearer changed" }],
      },
      {
        name: "delta",
        scope: "workspace",
        type: "sse",
        url: "http://localhost:9/sse",
        headers: [],
      },
      { name: "outside", command: "node", args: [], env: [] },
      { name: "mine", scope: "user", command: "node", args: [], env: [] },
    ];
    const dtoAllows = [];
    for (const dto of dtos) {
      const converted = protocolMcpServersToRuntimeMcpConfig([dto])!.servers[dto.name]!;
      dtoAllows.push({ dto, converted, allows: await authority.allows(dto.name, converted) });
    }
    await authority.decide("alpha", project.reviews.alpha!.declarationDigest, false);
    const store = await readFile(
      join(home, ".zcode", "security", "workspace-mcp-trust-v1.json"),
      "utf8",
    );
    const after = await authority.inspect();
    await writeFile(
      output,
      `${JSON.stringify(
        {
          cases: results,
          store: { text: store, gammaTrusted: after.gamma?.trusted ?? null, staleDigest: changed },
          dtoAllows,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
