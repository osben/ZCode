import { describe, expect, it } from "vitest";
import { gitRemoteUrlToRepository, gitRemoteUrlToWebUrl } from "../src/gitRemoteWebUrl.js";

describe("gitRemoteUrlToWebUrl", () => {
  it("converts supported remote syntaxes and preserves nested repository paths", () => {
    expect(gitRemoteUrlToWebUrl("git@github.com:osben/ZCode.git")).toBe(
      "https://github.com/osben/ZCode",
    );
    expect(gitRemoteUrlToWebUrl("github.com:osben/ZCode.git")).toBe(
      "https://github.com/osben/ZCode",
    );
    expect(gitRemoteUrlToWebUrl("ssh://git@gitlab.example.com:2222/group/subgroup/repo.git")).toBe(
      "https://gitlab.example.com/group/subgroup/repo",
    );
    expect(gitRemoteUrlToWebUrl("http://github.com/osben/ZCode/")).toBe(
      "https://github.com/osben/ZCode",
    );
    expect(gitRemoteUrlToWebUrl("git://github.com/osben/ZCode.git")).toBe(
      "https://github.com/osben/ZCode",
    );
  });

  it("normalizes only the host and rejects values without a repository path", () => {
    expect(gitRemoteUrlToWebUrl("  git@GitHub.com:osben/ZCode.git  ")).toBe(
      "https://github.com/osben/ZCode",
    );
    for (const value of [
      "",
      "not a url",
      "https://github.com",
      "git@github.com",
      "/tmp/repo",
      "C:/Users/osben/ZCode",
      "C:\\Users\\osben\\ZCode",
      "C:relative-repo",
    ]) {
      expect(gitRemoteUrlToWebUrl(value)).toBeNull();
    }
  });

  it("handles remotes with long trailing slash runs", () => {
    const trailingSlashes = "/".repeat(50_000);

    expect(gitRemoteUrlToWebUrl(`https://github.com/osben/ZCode${trailingSlashes}`)).toBe(
      "https://github.com/osben/ZCode",
    );
  });

  it("maps GitHub SSH-over-443 remotes to the canonical web host", () => {
    expect(gitRemoteUrlToWebUrl("ssh://git@ssh.github.com:443/osben/ZCode.git")).toBe(
      "https://github.com/osben/ZCode",
    );
  });
});

describe("gitRemoteUrlToRepository", () => {
  it("parses owner and name from supported remote syntaxes", () => {
    expect(gitRemoteUrlToRepository("git@github.com:osben/ZCode.git")).toEqual({
      host: "github.com",
      owner: "osben",
      name: "ZCode",
    });
    expect(gitRemoteUrlToRepository("https://github.com/zai-org/ZCode")).toEqual({
      host: "github.com",
      owner: "zai-org",
      name: "ZCode",
    });
    expect(gitRemoteUrlToRepository("ssh://git@ssh.github.com:443/osben/ZCode.git")).toEqual({
      host: "github.com",
      owner: "osben",
      name: "ZCode",
    });
    expect(gitRemoteUrlToRepository("ghe.example.com:org/repo.git")).toEqual({
      host: "ghe.example.com",
      owner: "org",
      name: "repo",
    });
  });

  it("keeps the last segment as the name for nested group paths", () => {
    expect(gitRemoteUrlToRepository("git@gitlab.example.com:group/subgroup/repo.git")).toEqual({
      host: "gitlab.example.com",
      owner: "group",
      name: "repo",
    });
  });

  it("returns null for unparsable remotes", () => {
    for (const value of ["", "not a url", "https://github.com", "C:\\Users\\osben\\ZCode"]) {
      expect(gitRemoteUrlToRepository(value)).toBeNull();
    }
  });
});
