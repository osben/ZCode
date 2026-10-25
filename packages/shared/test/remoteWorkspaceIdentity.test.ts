// Remote workspace identity parsing (duality contract with the UI's buildRemoteWorkspaceIdentity format).
// Consumer: the workspaceId of CLI v4 createSession (remote panes pass identity in split view phase 2).
import { describe, expect, it } from "vitest";
import {
  buildRemoteWorkspaceIdentity,
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  rebaseRemoteWorkspaceIdentity,
} from "../src/remote-workspace-identity.js";

describe("parseRemoteWorkspaceIdentity", () => {
  it("统一构造 SSH/WSL/Docker/Server workspace identity", () => {
    expect(
      buildRemoteWorkspaceIdentity("/work/demo", {
        kind: "ssh",
        host: "DEV.INTERNAL",
        port: 22,
        username: "developer",
      }),
    ).toBe("remote:ssh:dev.internal:22:developer:/work/demo");
    expect(
      buildRemoteWorkspaceIdentity("/work/demo", {
        kind: "wsl",
        distro: "Ubuntu",
        user: "dev",
      }),
    ).toBe("remote:wsl:Ubuntu:dev:/work/demo");
    expect(
      buildRemoteWorkspaceIdentity("/work/demo", {
        kind: "docker",
        container: "demo",
      }),
    ).toBe("remote:docker:demo:/work/demo");
    expect(
      buildRemoteWorkspaceIdentity("/work/demo", {
        kind: "server",
        url: "https://remote.example.com/ws",
        serverId: "Server A",
      }),
    ).toBe("remote:server:server-a:/work/demo");
  });

  it("ssh：remote:ssh:<host>:<port>:<username>:<path>", () => {
    expect(parseRemoteWorkspaceIdentity("remote:ssh:dev.example.com:22:root:/srv/app")).toEqual({
      kind: "ssh",
      workspacePath: "/srv/app",
    });
    // A path containing ":" (legal in posix) is not truncated
    expect(parseRemoteWorkspaceIdentity("remote:ssh:host:2222:dev:/data/a:b")).toEqual({
      kind: "ssh",
      workspacePath: "/data/a:b",
    });
  });

  it("wsl / docker：单段 authority + path", () => {
    expect(parseRemoteWorkspaceIdentity("remote:wsl:Ubuntu-22.04:/home/dev/ws")).toEqual({
      kind: "wsl",
      workspacePath: "/home/dev/ws",
    });
    expect(parseRemoteWorkspaceIdentity("remote:docker:my-container:/workspace")).toEqual({
      kind: "docker",
      workspacePath: "/workspace",
    });
  });

  it("wsl：显式 user 属于 authority，解析后只返回真实 workspacePath", () => {
    expect(
      parseRemoteWorkspaceIdentity("remote:wsl:Ubuntu-24.04:dev:/home/dev/coding/DEMO-ERP-NEW"),
    ).toEqual({
      kind: "wsl",
      workspacePath: "/home/dev/coding/DEMO-ERP-NEW",
    });
    expect(parseRemoteWorkspaceIdentity("remote:wsl:Ubuntu-24.04:dev:/data/a:b")).toEqual({
      kind: "wsl",
      workspacePath: "/data/a:b",
    });
  });

  it("根路径与规范化形态（构造侧保证 path 以 / 开头）", () => {
    expect(parseRemoteWorkspaceIdentity("remote:wsl:default:/")).toEqual({
      kind: "wsl",
      workspacePath: "/",
    });
  });

  it("非远程/非法输入返回 null（调用方回落本地 workspacePath 语义）", () => {
    // Local absolute paths
    expect(parseRemoteWorkspaceIdentity("/Users/dev/ws")).toBeNull();
    expect(parseRemoteWorkspaceIdentity("C:\\ws\\a")).toBeNull();
    // Same prefix but unknown kind
    expect(parseRemoteWorkspaceIdentity("remote:ftp:host:/x")).toBeNull();
    // Not enough authority segments
    expect(parseRemoteWorkspaceIdentity("remote:ssh:host:22:/x")).toBeNull();
    expect(parseRemoteWorkspaceIdentity("remote:wsl:/x")).toBeNull();
    expect(parseRemoteWorkspaceIdentity("remote:wsl:Ubuntu-24.04:user:relative/x")).toBeNull();
    // Path does not start with "/" (non-canonical form)
    expect(parseRemoteWorkspaceIdentity("remote:docker:c:relative/x")).toBeNull();
    // Empty segments
    expect(parseRemoteWorkspaceIdentity("remote::host:22:u:/x")).toBeNull();
    expect(parseRemoteWorkspaceIdentity("remote:")).toBeNull();
    expect(parseRemoteWorkspaceIdentity("")).toBeNull();
  });

  it("isRemoteWorkspaceIdentity 与 parse 判定一致", () => {
    expect(isRemoteWorkspaceIdentity("remote:ssh:host:22:root:/srv/app")).toBe(true);
    expect(isRemoteWorkspaceIdentity("/Users/dev/ws")).toBe(false);
  });
});

describe("rebaseRemoteWorkspaceIdentity", () => {
  it("keeps the authority and re-points the path at a worktree of the same remote", () => {
    const parent = buildRemoteWorkspaceIdentity("/home/dev/repo", {
      kind: "ssh",
      host: "devbox",
      port: 22,
      username: "dev",
    });
    const rebased = rebaseRemoteWorkspaceIdentity(parent, "/home/dev/repo/.worktrees/feature-a/");
    expect(rebased).toBe("remote:ssh:devbox:22:dev:/home/dev/repo/.worktrees/feature-a");
    expect(parseRemoteWorkspaceIdentity(rebased!)).toEqual({
      kind: "ssh",
      workspacePath: "/home/dev/repo/.worktrees/feature-a",
    });
  });

  it("handles WSL identities with an explicit user and server identities", () => {
    expect(rebaseRemoteWorkspaceIdentity("remote:wsl:Ubuntu:dev:/work/demo", "/work/demo-wt")).toBe(
      "remote:wsl:Ubuntu:dev:/work/demo-wt",
    );
    expect(rebaseRemoteWorkspaceIdentity("remote:server:lab:/work/demo", "/work/demo/wt")).toBe(
      "remote:server:lab:/work/demo/wt",
    );
  });

  it("returns null for non-remote identities so callers open by path alone", () => {
    expect(rebaseRemoteWorkspaceIdentity("", "/Users/dev/repo-wt")).toBeNull();
    expect(rebaseRemoteWorkspaceIdentity("/Users/dev/repo", "/Users/dev/repo-wt")).toBeNull();
  });
});
