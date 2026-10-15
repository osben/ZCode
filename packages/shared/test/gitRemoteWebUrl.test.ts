import { describe, expect, it } from "vitest";
import { gitRemoteUrlToWebUrl } from "../src/gitRemoteWebUrl.js";

describe("gitRemoteUrlToWebUrl", () => {
  it("converts supported remote syntaxes and preserves nested repository paths", () => {
    expect(gitRemoteUrlToWebUrl("git@github.com:osben/ZCode.git")).toBe(
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
    for (const value of ["", "not a url", "https://github.com", "git@github.com", "/tmp/repo"]) {
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
