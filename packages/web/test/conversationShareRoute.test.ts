import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isConversationSharePath,
  resolveConversationShareCodeFromPath,
} from "../src/share/conversationShareRoute.js";
import { resolveConversationShareRouteLocale } from "../src/share/conversationSharePreviewClient.js";

describe("conversation share route", () => {
  it("recognizes share paths without taking over remote routes", () => {
    expect(isConversationSharePath("/cn/share")).toBe(true);
    expect(isConversationSharePath("/cn/share/share-1")).toBe(true);
    expect(isConversationSharePath("/share")).toBe(true);
    expect(isConversationSharePath("/share/share-1")).toBe(true);
    expect(isConversationSharePath("/remote/v4")).toBe(false);
    expect(isConversationSharePath("/sharegate/x")).toBe(false);
  });

  it("英文站的裸 /share/ 不再被拒绝，两种前缀都能解析出 code", () => {
    // Previously /share/<code> went through isRejectedConversationSharePath and
    // rendered not_found directly, meaning the English share page did not exist
    // at all.
    expect(resolveConversationShareCodeFromPath("/cn/share/share-1")).toBe("share-1");
    expect(resolveConversationShareCodeFromPath("/share/share-1")).toBe("share-1");
    expect(resolveConversationShareCodeFromPath("/cn/share/share-1/extra")).toBeNull();
    expect(resolveConversationShareCodeFromPath("/share/")).toBeNull();
  });

  it("页面语言由路径前缀决定", () => {
    expect(resolveConversationShareRouteLocale("/cn/share/share-1")).toBe("zh-CN");
    expect(resolveConversationShareRouteLocale("/share/share-1")).toBe("en-US");
  });

  it("结果物计数跟随语言，不再中英混排", () => {
    // Bug root cause: the source hardcoded English artifact/artifacts with a
    // handwritten plural, so the Chinese page rendered
    // "2026年9月3日 11:55 · 1 artifact".
    const source = readFileSync("packages/web/src/share/ConversationShareLandingPage.tsx", "utf8");
    expect(source).toContain("artifactCountOne");
    expect(source).toContain("artifactCountOther");
    expect(source).toContain("{count} 个结果物");
    expect(source).not.toContain("artifact{artifactCount === 1");
  });

  it("英文分享 OAuth callback 与中文 callback 走同一回调页面", () => {
    const mainSource = readFileSync("packages/web/src/main.tsx", "utf8");
    const authSource = readFileSync("packages/web/src/auth/webAuthService.ts", "utf8");
    const stateSource = readFileSync("packages/web/src/auth/oauthStateCodec.ts", "utf8");
    expect(mainSource).toContain('"/share/callback"');
    expect(authSource).toContain('"/share/callback"');
    expect(stateSource).toContain('"/share/callback"');
    expect(stateSource).toContain("const SHARE_PATH_PATTERN");
    expect(stateSource).toContain("cn\\/share|share");
  });

  it("分享页同步 html lang 与浏览器标签标题", () => {
    // index.html is fixed to lang="en"; without syncing, the Chinese share page
    // reports the wrong language to accessibility tools and browser translation.
    // document.title was never set before, so the tab only showed index.html's
    // generic title.
    const source = readFileSync("packages/web/src/main.tsx", "utf8");
    expect(source).toContain("document.documentElement.lang = routeLocale");
    expect(source).toMatch(/document\.title =\s*routeLocale === "zh-CN"/u);
  });

  it("dev server base 不能写死 /cn/share/，否则英文路由本地不可达", () => {
    // Bug root cause: the dev script hardcoded --base=/cn/share/, so Vite only
    // served that prefix and requests to /share/<code> were rejected outright
    // by the dev server ("server is configured with a public base URL of
    // /cn/share/").
    const source = readFileSync("scripts/dev-web-share-env.mjs", "utf8");
    expect(source).toContain('"--base=/"');
    expect(source).not.toContain('"--base=/cn/share/"');
  });

  it("continue-help 横幅与正文同宽，下载链接不带 /download", () => {
    const source = readFileSync("packages/web/src/share/ConversationShareLandingPage.tsx", "utf8");
    // Bug root cause 1: the banner was a direct child of ShareContentRail
    // without ShareContentInset, missing px-4 / @md:px-6 and rendering wider
    // than both the timestamp row above and the body below.
    expect(source).toMatch(
      /showContinueHelp \? \(\s*(?:\/\/[^\n]*\n\s*)*<ShareContentInset>/u,
    );
    // Bug root cause 2: the site home page is itself the download entry, so the
    // /download path is a 404.
    expect(source).toContain('const ZCODE_DOWNLOAD_URL = "https://zcode.z.ai"');
    expect(source).not.toContain("zcode.z.ai/download");
  });
});
